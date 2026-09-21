import { supabase } from "./supabase.js";
import { kv } from "./idb.js";
import { seriesKey } from "./sort.js";

// Notas de saga: lo que no cabe en un libro concreto — si la saga está
// terminada, cuándo sale el próximo tomo, apuntes sueltos.
// Mismo patrón offline que la ficha: cache local + outbox que funde ediciones.
const CACHE = "series:cache";
const OUTBOX = "series:outbox";

/** Baja todas las notas y las cachea. Devuelve un Map por clave de saga. */
export async function load() {
  try {
    const { data, error } = await supabase.from("series_notes").select("*");
    if (error) throw error;
    await kv.put(CACHE, data).catch(() => {});
    return index(data);
  } catch {
    return index((await kv.get(CACHE)) || []);
  }
}

const index = (rows) => new Map(rows.map((r) => [r.series_key, r]));

/**
 * Guarda un cambio. `name` es la grafía a mostrar; la clave siempre sale
 * normalizada para que no se dupliquen las sagas por mayúsculas o acentos.
 */
export async function save(userId, name, patch) {
  const key = seriesKey(name);
  if (!key) return { queued: false };
  const row = { user_id: userId, series_key: key, series_name: name.trim(), ...patch };

  const cached = (await kv.get(CACHE)) || [];
  const hit = cached.find((r) => r.series_key === key);
  if (hit) Object.assign(hit, row);
  else cached.push(row);
  await kv.put(CACHE, cached).catch(() => {});

  const { error } = await supabase
    .from("series_notes").upsert(row, { onConflict: "user_id,series_key" })
    .then((r) => r, (err) => ({ error: err }));
  if (!error) return { queued: false };

  const box = (await kv.get(OUTBOX)) || [];
  const pending = box.find((o) => o.series_key === key);
  if (pending) Object.assign(pending, row);
  else box.push(row);
  await kv.put(OUTBOX, box);
  return { queued: true };
}

export async function flushOutbox(userId) {
  const box = (await kv.get(OUTBOX)) || [];
  if (!box.length) return 0;
  const left = [];
  for (const row of box) {
    const { error } = await supabase
      .from("series_notes").upsert({ ...row, user_id: userId }, { onConflict: "user_id,series_key" })
      .then((r) => r, (err) => ({ error: err }));
    if (error) left.push(row);
  }
  await kv.put(OUTBOX, left);
  return box.length - left.length;
}
