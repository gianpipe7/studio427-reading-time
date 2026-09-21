import { supabase, BUCKET } from "./supabase.js";
import { files, kv, CACHE_CAP_BYTES } from "./idb.js";
import { sha256Hex } from "./hash.js";
import { getDocument } from "./pdf.js";
import { coverFromPdf } from "./covers.js";

const CACHE_KEY = "docs:cache";
const PENDING_DOCS = "docs:pending";
const META_OUTBOX = "docs:meta";
const storagePathFor = (userId, docId) => `${userId}/${docId}.pdf`;

/**
 * Documentos del usuario con su posición de lectura pegada.
 * Si no hay red devolvemos el último listado cacheado, marcado como stale.
 */
export async function listDocuments() {
  try {
    const [docsRes, stateRes] = await Promise.all([
      supabase.from("documents").select("*").order("created_at", { ascending: false }),
      supabase.from("reading_state").select("*"),
    ]);
    if (docsRes.error) throw docsRes.error;
    if (stateRes.error) throw stateRes.error;

    const byId = new Map((stateRes.data || []).map((s) => [s.doc_id, s]));
    const docs = docsRes.data.map((d) => ({ ...d, state: byId.get(d.doc_id) || null }));
    await kv.put(CACHE_KEY, docs).catch(() => {});
    return { docs: await withPending(docs), stale: false };
  } catch {
    return { docs: await withPending((await kv.get(CACHE_KEY)) || []), stale: true };
  }
}

/** Agrega al listado los documentos importados sin conexión. */
async function withPending(docs) {
  const pending = (await kv.get(PENDING_DOCS)) || [];
  if (!pending.length) return docs;
  const known = new Set(docs.map((d) => d.doc_id));
  const extra = pending
    .filter((row) => !known.has(row.doc_id))
    .map((row) => ({ ...row, state: null, pending: true }));
  return [...extra, ...docs];
}

/**
 * Importa un PDF: hash → blob local → metadatos → fila en documents → storage.
 * El doc_id es el SHA-256 de los bytes, así que reimportar el mismo archivo
 * cae sobre la misma fila y conserva la posición de lectura.
 */
export async function importFile(file, userId, onProgress = () => {}) {
  if (file.type && file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) {
    throw new Error(`"${file.name}" no parece un PDF.`);
  }
  onProgress("Calculando hash…");
  const buffer = await file.arrayBuffer();
  const docId = await sha256Hex(buffer);

  // El Blob copia los bytes antes de que pdf.js se quede con el ArrayBuffer.
  const blob = new Blob([buffer], { type: "application/pdf" });
  await files.put(docId, blob);

  onProgress("Leyendo el PDF…");
  const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
  const meta = await pdf.getMetadata().catch(() => null);
  const title =
    meta?.info?.Title?.trim() || file.name.replace(/\.pdf$/i, "") || "Sin título";
  const pageCount = pdf.numPages;
  onProgress("Generando portada…");
  await coverFromPdf(docId, pdf);   // antes del destroy: no reabrimos el PDF
  pdf.destroy();

  onProgress("Guardando…");
  const row = {
    user_id: userId,
    doc_id: docId,
    title,
    page_count: pageCount,
    byte_size: file.size,
    storage_path: null,
    shelf: "por_leer",
  };

  // Reimportar el mismo archivo cae sobre la misma fila (el doc_id es el hash).
  // Un upsert ciego le pisaría el título editado, la colección y la
  // calificación, así que si ya existe solo tocamos lo técnico.
  const existing = await supabase
    .from("documents").select("doc_id").eq("user_id", userId).eq("doc_id", docId)
    .maybeSingle()
    .then((r) => r, (err) => ({ error: err }));

  const write = existing?.error
    ? { error: existing.error }
    : existing?.data
      ? await supabase.from("documents")
          .update({ page_count: pageCount, byte_size: file.size })
          .eq("user_id", userId).eq("doc_id", docId)
          .then((r) => r, (err) => ({ error: err }))
      : await supabase.from("documents").insert(row)
          .then((r) => r, (err) => ({ error: err }));
  const upsertError = write.error;

  if (upsertError) {
    // Sin conexión. El PDF ya está en IndexedDB, así que se puede leer; la
    // fila queda encolada porque reading_state y bookmarks tienen FK contra
    // documents y no pueden existir antes que ella.
    const pending = (await kv.get(PENDING_DOCS)) || [];
    if (!pending.some((r) => r.doc_id === docId)) pending.push(row);
    await kv.put(PENDING_DOCS, pending);
    return { ...row, pending: true, uploaded: false };
  }

  onProgress("Subiendo al storage…");
  const path = storagePathFor(userId, docId);
  const { error: uploadError } = await supabase.storage
    .from(BUCKET).upload(path, blob, { contentType: "application/pdf", upsert: true });

  if (uploadError) {
    // La fila queda con storage_path null: legible acá, todavía no en los otros.
    return { ...row, uploaded: false, uploadError };
  }
  await supabase.from("documents")
    .update({ storage_path: path }).eq("user_id", userId).eq("doc_id", docId);
  return { ...row, storage_path: path, uploaded: true };
}

/** Los bytes del PDF: del cache local, y si no está, del storage. */
export async function ensureFile(doc) {
  const local = await files.get(doc.doc_id);
  if (local) return local;
  if (!doc.storage_path) {
    throw new Error("Este PDF no se subió al storage, así que solo se abre en el dispositivo donde lo agregaste.");
  }
  const { data, error } = await supabase.storage.from(BUCKET).download(doc.storage_path);
  if (error) throw error;
  await files.put(doc.doc_id, data);
  return data;
}

/**
 * Sube las filas de documents que quedaron encoladas.
 *
 * Tiene que correr ANTES de vaciar la cola de posiciones y el outbox de
 * marcadores: las dos tablas tienen FK contra documents.
 */
export async function flushPendingDocs(userId) {
  const pending = (await kv.get(PENDING_DOCS)) || [];
  if (!pending.length) return 0;
  const left = [];
  for (const row of pending) {
    const { error } = await supabase
      .from("documents").upsert({ ...row, user_id: userId }, { onConflict: "user_id,doc_id" })
      .then((r) => r, (err) => ({ error: err }));
    if (error) left.push(row);
  }
  await kv.put(PENDING_DOCS, left);
  return pending.length - left.length;
}

/**
 * Guarda un cambio de la ficha (título, autor, colección, calificación…).
 * Si no hay red, los cambios del mismo documento se funden en una sola
 * operación encolada: reproducir cada tecleo no le sirve a nadie.
 */
export async function updateDocument(userId, docId, patch) {
  // El cache local se actualiza siempre, así un reload sin red muestra la edición.
  const cached = (await kv.get(CACHE_KEY)) || [];
  const hit = cached.find((d) => d.doc_id === docId);
  if (hit) { Object.assign(hit, patch); await kv.put(CACHE_KEY, cached); }

  const { error } = await supabase
    .from("documents").update(patch).eq("user_id", userId).eq("doc_id", docId)
    .then((r) => r, (err) => ({ error: err }));
  if (!error) return { queued: false };

  const box = (await kv.get(META_OUTBOX)) || [];
  const pending = box.find((o) => o.doc_id === docId);
  if (pending) Object.assign(pending.patch, patch);
  else box.push({ doc_id: docId, patch: { ...patch } });
  await kv.put(META_OUTBOX, box);
  return { queued: true };
}

/** Vacía la cola de ediciones de ficha. Va después de flushPendingDocs. */
export async function flushMetaOutbox(userId) {
  const box = (await kv.get(META_OUTBOX)) || [];
  if (!box.length) return 0;
  const left = [];
  for (const op of box) {
    const { error } = await supabase
      .from("documents").update(op.patch)
      .eq("user_id", userId).eq("doc_id", op.doc_id)
      .then((r) => r, (err) => ({ error: err }));
    if (error) left.push(op);
  }
  await kv.put(META_OUTBOX, left);
  return box.length - left.length;
}

/** Sube un PDF que quedó solo local (import sin conexión, o falló la subida). */
export async function uploadPending(doc, userId) {
  if (doc.storage_path) return doc;
  const blob = await files.get(doc.doc_id);
  if (!blob) return doc;
  const path = storagePathFor(userId, doc.doc_id);
  const { error } = await supabase.storage
    .from(BUCKET).upload(path, blob, { contentType: "application/pdf", upsert: true });
  if (error) return doc;
  await supabase.from("documents")
    .update({ storage_path: path }).eq("user_id", userId).eq("doc_id", doc.doc_id);
  return { ...doc, storage_path: path };
}

/**
 * Poda el cache de PDF hasta el tope, desalojando los menos usados.
 *
 * Un documento sin storage_path solo existe en este dispositivo: desalojarlo
 * lo perdería para siempre, así que queda protegido aunque sea el más viejo.
 */
export async function pruneCache(docs, currentDocId = null, cap = CACHE_CAP_BYTES) {
  const keep = docs.filter((d) => !d.storage_path).map((d) => d.doc_id);
  if (currentDocId) keep.push(currentDocId);
  return files.enforceQuota(cap, keep);
}

export const cacheUsage = () => files.usage();
export const cacheCap = () => CACHE_CAP_BYTES;

/** Vacía el cache, salvo lo que solo existe acá. */
export async function clearCache(docs) {
  await files.clear(docs.filter((d) => !d.storage_path).map((d) => d.doc_id));
}

/**
 * Borra el documento. El objeto del storage se borra PRIMERO: las FK con
 * cascade limpian reading_state y bookmarks, pero nadie limpia el bucket.
 */
export async function deleteDocument(doc, userId) {
  const pending = (await kv.get(PENDING_DOCS)) || [];
  if (pending.some((r) => r.doc_id === doc.doc_id)) {
    await kv.put(PENDING_DOCS, pending.filter((r) => r.doc_id !== doc.doc_id));
  }
  if (doc.storage_path) {
    await supabase.storage.from(BUCKET).remove([doc.storage_path]);
  }
  const { error } = await supabase.from("documents")
    .delete().eq("user_id", userId).eq("doc_id", doc.doc_id);
  if (error) throw error;
  await files.del(doc.doc_id).catch(() => {});
  await kv.del(`pos:${doc.doc_id}`).catch(() => {});
}
