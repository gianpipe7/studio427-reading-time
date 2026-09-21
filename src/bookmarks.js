import { supabase } from "./supabase.js";
import { kv, bookmarksStore } from "./idb.js";

// Sync incremental de marcadores: pull por updated_at (tombstones incluidos)
// y outbox local para lo que se creó/borró sin conexión.
const OUTBOX = "bm:outbox";
const EPOCH = "1970-01-01T00:00:00+00:00";

const sinceKey = (userId) => `bm:since:${userId}`;

/** Baja todo lo que cambió desde el último pull. Devuelve cuántas filas vinieron. */
export async function pull(userId) {
  const since = (await kv.get(sinceKey(userId))) || EPOCH;
  const { data, error } = await supabase
    .from("bookmarks")
    .select("*")
    .gt("updated_at", since)
    .order("updated_at", { ascending: true });
  if (error) throw error;

  let max = since;
  for (const row of data) {
    // El tombstone borra la copia local en vez de dejarla "revivir".
    if (row.deleted_at) await bookmarksStore.del(row.id);
    else await bookmarksStore.put(row);
    if (Date.parse(row.updated_at) > Date.parse(max)) max = row.updated_at;
  }
  await kv.put(sinceKey(userId), max);
  return data.length;
}

export async function listFor(docId) {
  const rows = await bookmarksStore.forDoc(docId);
  return rows.sort((a, b) => a.page - b.page || a.page_offset - b.page_offset);
}

export async function add({ userId, docId, page, offset, label }) {
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),       // id del cliente: crear offline y reintentar es idempotente
    user_id: userId,
    doc_id: docId,
    page,
    page_offset: offset,
    label: label || null,
  };
  await bookmarksStore.put({ ...row, created_at: now, updated_at: now, deleted_at: null });
  await send({ type: "add", row });
  return row;
}

export async function remove(id) {
  await bookmarksStore.del(id);
  await send({ type: "del", id, at: new Date().toISOString() });
}

async function send(op) {
  try {
    await apply(op);
  } catch {
    const box = (await kv.get(OUTBOX)) || [];
    box.push(op);
    await kv.put(OUTBOX, box);
  }
}

async function apply(op) {
  if (op.type === "add") {
    const { error } = await supabase.from("bookmarks").insert(op.row);
    // 23505 = ya existe: un reintento de la misma operación, no es un error.
    if (error && error.code !== "23505") throw error;
  } else {
    const { error } = await supabase
      .from("bookmarks").update({ deleted_at: op.at }).eq("id", op.id);
    if (error) throw error;
  }
}

/** Vacía el outbox. Se llama al recuperar conexión y al abrir la biblioteca. */
export async function flushOutbox() {
  const box = (await kv.get(OUTBOX)) || [];
  if (!box.length) return 0;
  const left = [];
  for (const op of box) {
    try { await apply(op); } catch { left.push(op); }
  }
  await kv.put(OUTBOX, left);
  return box.length - left.length;
}
