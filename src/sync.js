import { supabase } from "./supabase.js";
import { kv } from "./idb.js";

const MIN_PUSH_MS = 2000;      // como mucho una escritura cada 2 s por dispositivo
const OFFSET_EPSILON = 0.02;   // scroll menor a esto dentro de la página: no vale la pena

/**
 * Sincroniza la posición de lectura de UN documento.
 *
 * El contrato con el servidor es la RPC save_reading_state: mandamos el
 * updated_at que vimos por última vez (`base`) y el UPDATE solo corre si
 * nadie movió la fila desde entonces. Siempre nos devuelve la fila
 * ganadora, así que un conflicto se resuelve en el mismo round-trip: si lo
 * que vuelve no es lo que mandamos, perdimos y ya tenemos la posición buena.
 *
 * @param {{docId: string, device: {id: string, name: string},
 *          onRemote: (row: object, reason: "conflict"|"realtime") => void,
 *          onStatus: (status: "synced"|"pending"|"offline") => void,
 *          getPosition?: () => {page: number, offset: number}}} opts
 */
export function createReadingSync({ docId, device, onRemote, onStatus, getPosition }) {
  const queueKey = `pos:${docId}`;

  let base = null;       // updated_at que vimos por última vez
  let pending = null;    // {page, offset} sin mandar
  let lastSent = null;   // última posición aceptada (o descartada por conflicto)
  let sending = false;
  let timer = null;
  let channel = null;
  let stopped = false;

  const status = (s) => onStatus?.(s);

  /** Posición inicial: lo que quedó en la cola local gana sobre el servidor. */
  async function loadInitial() {
    const queued = await kv.get(queueKey).catch(() => null);
    let row = null;
    try {
      const res = await supabase
        .from("reading_state").select("*").eq("doc_id", docId).maybeSingle();
      if (res.error) throw res.error;
      row = res.data;
    } catch {
      status("offline");
    }
    if (row) base = row.updated_at;

    if (queued) {
      // Escritura que quedó pendiente de una sesión offline. La reintentamos:
      // si el servidor ya avanzó, la RPC la rechaza y avisamos por toast.
      pending = { page: queued.page, offset: queued.offset };
      schedule(0);
      return { page: queued.page, offset: queued.offset, source: "local", row };
    }
    if (row) return { page: row.page, offset: row.page_offset, source: "remote", row };
    return { page: 0, offset: 0, source: "new", row: null };
  }

  /** Registra la posición actual. Barato: se puede llamar en cada scroll. */
  function record(page, offset) {
    if (stopped) return;
    const same = lastSent && lastSent.page === page
      && Math.abs(lastSent.offset - offset) < OFFSET_EPSILON;
    if (same) return;
    if (pending && pending.page === page
        && Math.abs(pending.offset - offset) < OFFSET_EPSILON) {
      pending.offset = offset;
      return;
    }
    pending = { page, offset };
    status("pending");
    schedule();
  }

  function schedule(delay = MIN_PUSH_MS) {
    if (timer !== null || stopped) return;
    timer = setTimeout(() => { timer = null; push(); }, delay);
  }

  async function push() {
    if (sending || !pending || stopped) return;
    const p = pending;
    pending = null;
    sending = true;
    try {
      const { data, error } = await supabase.rpc("save_reading_state", {
        p_doc_id: docId,
        p_page: p.page,
        p_page_offset: p.offset,
        p_device_id: device.id,
        p_device_name: device.name,
        p_base: base,
      });
      if (error) throw error;
      if (!data?.doc_id) throw new Error("respuesta vacía de save_reading_state");

      base = data.updated_at;
      lastSent = p;
      await kv.del(queueKey).catch(() => {});

      const accepted = data.device_id === device.id && data.page === p.page;
      if (accepted) {
        status("synced");
      } else {
        // Perdimos: otro dispositivo escribió después de nuestro `base`.
        // No reintentamos — el usuario decide si sigue esa posición.
        status("synced");
        onRemote?.(data, "conflict");
      }
    } catch {
      // Sin red (o el servidor falló): guardamos SOLO la última posición.
      // Reproducir todo el rastro de scroll no le sirve a nadie.
      if (!pending) pending = p;
      await kv.put(queueKey, { ...pending, at: Date.now() }).catch(() => {});
      status("offline");
    } finally {
      sending = false;
      if (pending) schedule();
    }
  }

  /** Manda ya lo que haya pendiente (al salir del lector, al ocultar la app). */
  async function flush() {
    // Releemos la posición en vez de confiar en el último evento de scroll:
    // con la pestaña oculta ese evento puede no haberse procesado todavía.
    const now = getPosition?.();
    if (now) record(now.page, now.offset);
    if (timer !== null) { clearTimeout(timer); timer = null; }
    await push();
  }

  function start() {
    channel = supabase
      .channel(`reading_state:${docId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "reading_state", filter: `doc_id=eq.${docId}` },
        ({ new: row }) => {
          if (!row?.doc_id) return;
          base = row.updated_at;
          if (row.device_id === device.id) return;  // eco de mi propia escritura
          onRemote?.(row, "realtime");
        },
      )
      .subscribe();

    addEventListener("online", onOnline);
    addEventListener("visibilitychange", onHide);
    addEventListener("pagehide", flush);
  }

  function onOnline() { if (pending) schedule(0); }
  function onHide() { if (document.visibilityState === "hidden") flush(); }

  async function stop() {
    await flush();
    stopped = true;
    removeEventListener("online", onOnline);
    removeEventListener("visibilitychange", onHide);
    removeEventListener("pagehide", flush);
    if (channel) { await supabase.removeChannel(channel); channel = null; }
  }

  return { loadInitial, record, flush, start, stop };
}
