import { covers } from "./idb.js";
import { getDocument } from "./pdf.js";

// Portada = primera página del PDF rasterizada. Es lo que convierte la
// biblioteca en una estantería en vez de un listado de archivos.
const WIDTH = 400;              // suficiente para una tarjeta en pantalla retina
const OBJECT_URLS = new Map();  // doc_id -> object URL vivo

/** Rasteriza la portada desde un documento ya abierto. */
export async function coverFromPdf(docId, pdf) {
  try {
    const page = await pdf.getPage(1);

    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    // Fondo blanco explícito: un PDF con fondo transparente saldría negro.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Sin rAF: el render de pdf.js lo usa internamente y se frena con la
    // pestaña oculta, que es justo cuando corre una importación de fondo.
    await page.render({ canvasContext: ctx, viewport, intent: "print" }).promise;

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) return null;
    await covers.put(docId, blob);
    return blob;
  } catch {
    return null;   // sin portada se cae al placeholder tipográfico
  }
}

/** Genera la portada si no existe. Devuelve el Blob, o null si falla. */
export async function ensureCover(docId, pdfBlob) {
  const cached = await covers.get(docId).catch(() => null);
  if (cached) return cached;
  if (!pdfBlob) return null;
  let pdf = null;
  try {
    pdf = await getDocument({ data: new Uint8Array(await pdfBlob.arrayBuffer()) }).promise;
    return await coverFromPdf(docId, pdf);
  } catch {
    return null;
  } finally {
    pdf?.destroy();
  }
}

/** URL estable para usar en un <img>. Se reusa entre renders de la lista. */
export async function coverUrl(docId) {
  if (OBJECT_URLS.has(docId)) return OBJECT_URLS.get(docId);
  const blob = await covers.get(docId).catch(() => null);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  OBJECT_URLS.set(docId, url);
  return url;
}

export function releaseCover(docId) {
  const url = OBJECT_URLS.get(docId);
  if (url) { URL.revokeObjectURL(url); OBJECT_URLS.delete(docId); }
}

/** Rehace la portada aunque ya exista (página 1 en blanco, PDF reemplazado). */
export async function regenerateCover(docId, pdfBlob) {
  await removeCover(docId);
  return ensureCover(docId, pdfBlob);
}

export async function removeCover(docId) {
  releaseCover(docId);
  await covers.del(docId).catch(() => {});
}
