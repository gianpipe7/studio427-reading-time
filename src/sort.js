// Órdenes de la estantería. Vive aparte de app.js para poder testearlo.
export const SORT_OPTIONS = ["added-desc", "added-asc", "title-asc", "title-desc", "series"];

/**
 * Clave de agrupación de sagas. Se normaliza a propósito: el campo es texto
 * libre (sin desplegable), así que "dune", "Dune" y "DUNE " tienen que caer
 * en el mismo grupo en vez de partirlo en tres.
 */
export const seriesKey = (name) =>
  (name || "").trim().toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

export const SORTERS = {
  // localeCompare con 'es' para que acentos y ñ caigan donde corresponde:
  // "Ñandú" va después de "Nube", no al final del alfabeto.
  "title-asc":  (a, b) => a.title.localeCompare(b.title, "es", { sensitivity: "base" }),
  "title-desc": (a, b) => b.title.localeCompare(a.title, "es", { sensitivity: "base" }),
  "added-desc": (a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0),
  "added-asc":  (a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0),
};

export function sortDocs(docs, key) {
  return [...docs].sort(SORTERS[key] || SORTERS["added-desc"]);
}

/**
 * Agrupa por saga para la vista de sagas. Dentro de cada saga manda el número
 * de orden; los que no lo tienen van al final por nombre. Devuelve
 * [{key, name, docs}], con los sueltos en un grupo final de key "".
 */
export function groupBySeries(docs) {
  const groups = new Map();
  const loose = [];
  for (const doc of docs) {
    const key = seriesKey(doc.series);
    if (!key) { loose.push(doc); continue; }
    if (!groups.has(key)) groups.set(key, { key, name: doc.series.trim(), docs: [] });
    groups.get(key).docs.push(doc);
  }
  const byIndex = (a, b) => {
    const ai = a.series_index, bi = b.series_index;
    if (ai == null && bi == null) return a.title.localeCompare(b.title, "es", { sensitivity: "base" });
    if (ai == null) return 1;
    if (bi == null) return -1;
    return ai - bi;
  };
  const out = [...groups.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
  for (const g of out) g.docs.sort(byIndex);
  if (loose.length) {
    out.push({ key: "", name: "Sin saga", docs: sortDocs(loose, "title-asc") });
  }
  return out;
}

/** "Dune #2" — lo que se muestra en la tarjeta y en la ficha. */
export function seriesLabel(doc) {
  if (!doc.series?.trim()) return null;
  const n = doc.series_index;
  return n == null ? doc.series.trim() : `${doc.series.trim()} #${Number(n) % 1 ? n : Math.round(n)}`;
}
