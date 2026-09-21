import { supabase, configured } from "./supabase.js";
import { getDevice, setDeviceName } from "./device.js";
import { createReadingSync } from "./sync.js";
import { createReader } from "./reader.js";
import * as lib from "./library.js";
import * as bm from "./bookmarks.js";
import { ensureCover, coverUrl, removeCover } from "./covers.js";
import { clearAll } from "./idb.js";
import { SORTERS, sortDocs, groupBySeries, seriesLabel, seriesKey } from "./sort.js";
import {
  toast, showLoading, setLoadingText, hideLoading, showScreen, timeAgo, formatBytes,
} from "./ui.js";

const $ = (id) => document.getElementById(id);
const device = getDevice();

let session = null;
let docs = [];
let current = null;          // {doc, reader, sync, numPages}
let suppressRecordUntil = 0; // evita re-mandar la posición que acabamos de restaurar
let activeShelf = "todos";   // colección seleccionada en la biblioteca
let docScreen = null;        // documento abierto en la ficha
let sortBy = "added-desc";   // orden de la estantería

const SORT_KEY = "pdfsync.sort";
const SHELVES = [
  { key: "todos", label: "Todos" },
  { key: "por_leer", label: "Por leer" },
  { key: "leyendo", label: "En lectura" },
  { key: "terminado", label: "Terminados" },
];
const shelfLabel = (key) => SHELVES.find((s) => s.key === key)?.label || "Por leer";

// ─────────────────────────────────────────────────────────────────────
// Arranque
// ─────────────────────────────────────────────────────────────────────
async function boot() {
  if (!configured) return showScreen("screen-setup");

  registerServiceWorker();
  wireAuth();
  wireLibrary();
  wireDocScreen();
  wireReader();
  wireNetwork();

  const { data } = await supabase.auth.getSession();
  session = data.session;
  supabase.auth.onAuthStateChange((_event, next) => {
    const changed = next?.user?.id !== session?.user?.id;
    session = next;
    if (changed) { docs = []; route(); }
  });

  addEventListener("hashchange", route);
  await route();
}

async function route() {
  if (!session) {
    await closeDoc();
    return showScreen("screen-auth");
  }
  const reading = location.hash.match(/^#\/doc\/([0-9a-f]{64})$/);
  if (reading) {
    if (current?.doc.doc_id === reading[1]) return;
    await openDoc(reading[1]);
    return;
  }

  await closeDoc();
  const info = location.hash.match(/^#\/info\/([0-9a-f]{64})$/);
  if (info) await showDocScreen(info[1]);
  else await showLibrary();
}

// ─────────────────────────────────────────────────────────────────────
// Auth (OTP por email: el código de 6 dígitos funciona dentro de la PWA,
// el magic link abriría Safari por fuera)
// ─────────────────────────────────────────────────────────────────────
function wireAuth() {
  const form = $("auth-form"), msg = $("auth-msg"), submit = $("auth-submit");
  let stage = "email";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    msg.className = "msg";
    try {
      if (stage === "email") {
        const email = $("auth-email").value.trim();
        // emailRedirectTo tiene que estar en la allow-list de Supabase
        // (Authentication → URL Configuration → Redirect URLs).
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: {
            shouldCreateUser: true,
            emailRedirectTo: location.origin + location.pathname,
          },
        });
        if (error) throw error;
        stage = "code";
        $("auth-code-row").hidden = false;
        $("auth-restart").hidden = false;
        submit.textContent = "Entrar con el código";
        msg.textContent = "Mail enviado a " + email;
        $("auth-code").focus();
      } else {
        const token = $("auth-code").value.trim();
        if (!token) {
          msg.textContent = "Abrí el link del mail, o pegá el código si te llegó uno.";
          return;
        }
        const { error } = await supabase.auth.verifyOtp({
          email: $("auth-email").value.trim(), token, type: "email",
        });
        if (error) throw error;
        msg.textContent = "";
      }
    } catch (err) {
      msg.className = "msg error";
      msg.textContent = err.message || "No pudimos completar el ingreso.";
    } finally {
      submit.disabled = false;
    }
  });

  $("auth-restart").addEventListener("click", () => {
    stage = "email";
    $("auth-code-row").hidden = true;
    $("auth-restart").hidden = true;
    $("auth-code").value = "";
    submit.textContent = "Enviar link";
    msg.textContent = "";
    $("auth-email").focus();
  });
}

// ─────────────────────────────────────────────────────────────────────
// Biblioteca
// ─────────────────────────────────────────────────────────────────────
function wireLibrary() {
  const input = $("file-input");
  $("btn-add").addEventListener("click", () => input.click());
  $("btn-add-2").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    if (input.files?.length) importFiles([...input.files]);
    input.value = "";
  });

  const dz = $("dropzone");
  for (const type of ["dragenter", "dragover"]) {
    dz.addEventListener(type, (e) => { e.preventDefault(); dz.classList.add("over"); });
  }
  for (const type of ["dragleave", "drop"]) {
    dz.addEventListener(type, () => dz.classList.remove("over"));
  }
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    const list = [...(e.dataTransfer?.files || [])].filter((f) => /pdf/i.test(f.type + f.name));
    if (list.length) importFiles(list);
  });

  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (saved && SORTERS[saved]) sortBy = saved;
  } catch { /* sin persistencia, arranca en el default */ }
  $("sort-select").value = sortBy;
  $("sort-select").addEventListener("change", (e) => {
    sortBy = e.target.value;
    try { localStorage.setItem(SORT_KEY, sortBy); } catch { /* da igual */ }
    renderLibrary();
  });

  $("btn-account").addEventListener("click", () => {
    const panel = $("account-panel");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      $("account-email").textContent = session?.user?.email || "";
      $("device-name").value = device.name;
      refreshCacheUsage();
    }
  });
  $("device-name").addEventListener("change", (e) => {
    const d = setDeviceName(e.target.value);
    e.target.value = d.name;
    device.name = d.name;
    toast("Este dispositivo ahora se llama " + d.name);
  });
  $("btn-clear-cache").addEventListener("click", async () => {
    await lib.clearCache(docs);
    await refreshCacheUsage();
    toast("Cache vaciado. Los PDF se vuelven a bajar del storage cuando los abras.");
  });
  $("btn-signout").addEventListener("click", async () => {
    await supabase.auth.signOut();
    await clearAll();               // en un dispositivo compartido no dejamos los PDF
    docs = [];
    location.hash = "";
  });
}

async function refreshCacheUsage() {
  const { bytes, count } = await lib.cacheUsage();
  $("cache-usage").textContent =
    `${formatBytes(bytes) || "0 kB"} en ${count} ${count === 1 ? "archivo" : "archivos"} · tope ${formatBytes(lib.cacheCap())}`;
}

async function showLibrary() {
  showScreen("screen-library");
  $("account-panel").hidden = true;
  const { docs: list, stale } = await lib.listDocuments();
  docs = list;
  renderLibrary();
  if (stale) toast("Sin conexión: mostrando la última lista que bajamos.");
  lib.pruneCache(docs).catch(() => {});
  if (!stale) {
    // Orden obligatorio: primero las filas de documents, que son las que las
    // FK de bookmarks y reading_state exigen que existan.
    lib.flushPendingDocs(session.user.id)
      .then((n) => { if (n) toast(`${n} ${n === 1 ? "documento sincronizado" : "documentos sincronizados"}.`); })
      .then(() => lib.flushMetaOutbox(session.user.id))
      .then(() => bm.flushOutbox())
      .catch(() => {});
    if (session) bm.pull(session.user.id).catch(() => {});
    // PDF que quedaron sin subir (import offline o subida fallida).
    for (const doc of docs.filter((d) => !d.storage_path)) {
      lib.uploadPending(doc, session.user.id)
        .then((updated) => { if (updated.storage_path) { doc.storage_path = updated.storage_path; } });
    }
  }
}

function renderLibrary() {
  renderHero();
  renderTabs();

  const filtered = activeShelf === "todos"
    ? docs
    : docs.filter((d) => (d.shelf || "por_leer") === activeShelf);
  const visible = sortDocs(filtered, sortBy);

  const ul = $("doc-list");
  ul.replaceChildren();
  $("library-empty").hidden = visible.length > 0;
  $("library-empty").textContent = docs.length
    ? `No hay nada en "${shelfLabel(activeShelf)}".`
    : "Todavía no agregaste ningún PDF.";
  $("shelf-count").textContent = visible.length
    ? `${visible.length} ${visible.length === 1 ? "documento" : "documentos"}`
    : "";

  // En modo saga la grilla se corta en grupos; en el resto va de una tirada.
  const runs = sortBy === "series"
    ? groupBySeries(filtered)
    : [{ name: null, docs: visible }];

  for (const run of runs) {
    if (run.name) {
      const head = document.createElement("li");
      head.className = "shelf-group";
      const name = document.createElement("b");
      name.textContent = run.name;
      const count = document.createElement("span");
      count.textContent = `${run.docs.length} ${run.docs.length === 1 ? "título" : "títulos"}`;
      head.append(name, count);
      ul.append(head);
    }
    for (const doc of run.docs) ul.append(buildCard(doc, run.name));
  }
}

/** Una tarjeta de la estantería. */
function buildCard(doc, seriesName = null) {
  {
    const li = document.createElement("li");
    li.className = "shelf-item";

    const open = document.createElement("button");
    open.className = "shelf-open";
    // La portada abre la ficha, no el lector: es el modelo de Goodreads, y
    // es donde viven la colección, las estrellas y la descripción.
    open.onclick = () => { location.hash = `#/info/${doc.doc_id}`; };

    const badge = document.createElement("div");
    badge.className = "shelf-badge";
    badge.textContent = activeShelf === "todos" ? shelfLabel(doc.shelf || "por_leer") : "";

    const title = document.createElement("div");
    title.className = "shelf-title";
    title.textContent = doc.title;

    const sub = document.createElement("div");
    sub.className = "shelf-sub";
    sub.textContent = describeShort(doc, seriesName);

    // El espacio de las estrellas se reserva siempre, tenga calificación o
    // no: si no, las tarjetas puntuadas crecen y el progreso deja de alinear.
    const stars = document.createElement("div");
    stars.className = "stars-slot";
    if (doc.rating) stars.append(buildStars(doc.rating));

    open.append(buildCover(doc), badge, title, sub, stars);
    const bar = buildProgress(doc);
    if (bar) open.append(bar);

    const del = document.createElement("button");
    del.className = "shelf-del";
    del.textContent = "✕";
    del.title = "Borrar";
    del.setAttribute("aria-label", `Borrar ${doc.title}`);
    del.onclick = (event) => { event.stopPropagation(); confirmDelete(doc); };

    li.append(open, del);
    return li;
  }
}

function renderTabs() {
  const counts = { todos: docs.length };
  for (const doc of docs) {
    const key = doc.shelf || "por_leer";
    counts[key] = (counts[key] || 0) + 1;
  }
  const bar = $("tabs");
  bar.replaceChildren();
  for (const { key, label } of SHELVES) {
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.role = "tab";
    btn.setAttribute("aria-selected", String(key === activeShelf));
    btn.textContent = label;
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = String(counts[key] || 0);
    btn.append(n);
    btn.onclick = () => { activeShelf = key; renderLibrary(); };
    bar.append(btn);
  }
}

/** El documento leído más recientemente encabeza la biblioteca. */
function renderHero() {
  const leidos = docs.filter((d) => d.state?.updated_at);
  const hero = $("hero");
  if (!leidos.length) { hero.hidden = true; return; }

  const doc = leidos.reduce((best, d) =>
    Date.parse(d.state.updated_at) > Date.parse(best.state.updated_at) ? d : best);

  hero.hidden = false;
  $("hero-title").textContent = doc.title;
  $("hero-sub").textContent = describe(doc);
  $("hero-cover").replaceWith(Object.assign(buildCover(doc), { id: "hero-cover" }));
  $("hero-progress").replaceChildren(...(buildProgress(doc)?.childNodes || []));
  $("hero-open").onclick = () => { location.hash = `#/doc/${doc.doc_id}`; };
}

/**
 * Portada: la primera página si ya la rasterizamos, y si no un placeholder
 * tipográfico con el título. El fallback es deliberado, no un hueco: un PDF
 * que vino de otro dispositivo todavía no tiene los bytes acá.
 */
function buildCover(doc) {
  const box = document.createElement("div");
  box.className = "cover";

  const fallback = document.createElement("div");
  fallback.className = "cover-fallback";
  const span = document.createElement("span");
  span.textContent = doc.title;
  fallback.append(span);
  box.append(fallback);

  coverUrl(doc.doc_id).then((url) => {
    if (!url || !box.isConnected) return;
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.loading = "lazy";
    box.replaceChildren(img);
  });
  return box;
}

function buildProgress(doc) {
  if (!doc.page_count) return null;
  const pct = doc.state
    ? Math.min(100, Math.round(((doc.state.page + 1) / doc.page_count) * 100))
    : 0;

  const row = document.createElement("div");
  row.className = "doc-progress";

  const bar = document.createElement("div");
  bar.className = "progress";
  bar.role = "progressbar";
  bar.ariaValueNow = String(pct);
  bar.ariaValueMin = "0";
  bar.ariaValueMax = "100";
  bar.setAttribute("aria-label", `Progreso de lectura de ${doc.title}`);
  const fill = document.createElement("i");
  fill.style.width = `${pct}%`;
  bar.append(fill);

  const label = document.createElement("span");
  label.className = "progress-pct" + (pct === 100 ? " done" : "");
  label.textContent = pct === 100 ? "leído" : `${pct}%`;

  row.append(bar, label);
  return row;
}

/** Estrellas. Volver a tocar la que ya está puesta la quita. */
function buildStars(value, onChange = null) {
  const box = document.createElement("div");
  box.className = "stars" + (onChange ? "" : " readonly small");
  if (!onChange) box.setAttribute("aria-label", `${value} de 5 estrellas`);
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("button");
    star.type = "button";
    star.className = i <= (value || 0) ? "on" : "";
    star.textContent = i <= (value || 0) ? "★" : "☆";
    if (onChange) {
      star.setAttribute("aria-label", i === value
        ? "Quitar calificación"
        : `${i} ${i === 1 ? "estrella" : "estrellas"}`);
      star.setAttribute("aria-pressed", String(i === value));
      star.onclick = () => onChange(value === i ? null : i);
    } else {
      star.setAttribute("aria-hidden", "true");
      star.tabIndex = -1;
    }
    box.append(star);
  }
  return box;
}

// ─────────────────────────────────────────────────────────────────────
// Ficha del documento
// ─────────────────────────────────────────────────────────────────────
function wireDocScreen() {
  $("doc-back").addEventListener("click", () => { location.hash = ""; });
  $("doc-read").addEventListener("click", () => {
    if (docScreen) location.hash = `#/doc/${docScreen.doc_id}`;
  });
  $("doc-delete").addEventListener("click", async () => {
    if (!docScreen) return;
    const doc = docScreen;
    if (!confirm(`¿Borrar "${doc.title}"? Se borra también la posición y los marcadores.`)) return;
    try {
      await lib.deleteDocument(doc, session.user.id);
      await removeCover(doc.doc_id);
      docs = docs.filter((d) => d.doc_id !== doc.doc_id);
      location.hash = "";
    } catch (err) {
      toast("No se pudo borrar: " + err.message, { variant: "error" });
    }
  });

  // 'change' y no 'input': guardamos al salir del campo, no en cada tecla.
  for (const el of document.querySelectorAll("[data-field]")) {
    el.addEventListener("change", () => {
      const raw = el.value.trim();
      if (raw === "") return saveField(el.dataset.field, null);
      // Un input number entrega string y la columna es real: la rechazaría.
      saveField(el.dataset.field, el.type === "number" ? Number(raw) : raw);
    });
  }
}

async function showDocScreen(docId) {
  if (!docs.length) {
    const { docs: list } = await lib.listDocuments();
    docs = list;
  }
  const doc = docs.find((d) => d.doc_id === docId);
  if (!doc) { toast("No encontramos ese documento.", { variant: "error" }); location.hash = ""; return; }

  docScreen = doc;
  showScreen("screen-doc");
  renderDocScreen();
}

function renderDocScreen() {
  const doc = docScreen;
  if (!doc) return;

  $("doc-cover").replaceWith(Object.assign(buildCover(doc), { id: "doc-cover" }));
  $("doc-shelf-badge").textContent = shelfLabel(doc.shelf || "por_leer");
  $("doc-heading").textContent = doc.title;
  $("doc-byline").textContent = [
    seriesLabel(doc),
    doc.author,
    doc.published_on ? new Date(doc.published_on + "T00:00").getFullYear() : null,
    doc.genre,
    doc.language,
    doc.page_count ? `${doc.page_count} págs.` : null,
  ].filter(Boolean).join(" · ") || "Sin datos todavía";
  $("doc-progress").replaceChildren(...(buildProgress(doc)?.childNodes || []));
  $("doc-read").textContent = doc.state ? "Continuar leyendo" : "Empezar a leer";

  for (const el of document.querySelectorAll("[data-field]")) {
    el.value = doc[el.dataset.field] ?? "";
  }
  $("f-rating").replaceChildren(
    ...buildStars(doc.rating, (next) => saveField("rating", next)).childNodes);
  $("f-rating").className = "stars";
}

async function saveField(field, value) {
  const doc = docScreen;
  if (!doc || doc[field] === value) return;

  const patch = { [field]: value };

  // Sin desplegable, "dune" y "Dune" son la misma saga pero se ven distinto.
  // Al guardar reusamos la grafía que ya exista, así la biblioteca converge
  // sola en una sin obligar a nadie a elegir de una lista.
  if (field === "series" && value) {
    const key = seriesKey(value);
    const previa = docs.find((d) => d.doc_id !== doc.doc_id && seriesKey(d.series) === key);
    if (previa) patch.series = previa.series.trim();
  }
  // Marcar terminado sin fecha: la ponemos nosotros, es lo que uno espera.
  if (field === "shelf" && value === "terminado" && !doc.finished_at) {
    patch.finished_at = new Date().toISOString().slice(0, 10);
  }
  Object.assign(doc, patch);
  renderDocScreen();

  const { queued } = await lib.updateDocument(session.user.id, doc.doc_id, patch);
  $("doc-saved").textContent = queued
    ? "Guardado acá. Se sincroniza cuando vuelva la conexión."
    : "Guardado.";
  setTimeout(() => { $("doc-saved").textContent = ""; }, 3000);
}

async function confirmDelete(doc) {
  if (!confirm(`¿Borrar "${doc.title}"? Se borra también la posición y los marcadores.`)) return;
  try {
    await lib.deleteDocument(doc, session.user.id);
    await removeCover(doc.doc_id);
    docs = docs.filter((d) => d.doc_id !== doc.doc_id);
    renderLibrary();
  } catch (err) {
    toast("No se pudo borrar: " + err.message, { variant: "error" });
  }
}

/**
 * Versión corta para la estantería: una sola línea, o las barras de progreso
 * dejan de alinear entre tarjetas y la grilla se lee como un serrucho.
 * El contexto completo (dispositivo, cuándo) va en el hero.
 */
function describeShort(doc, seriesName = null) {
  // seriesName llega desde el encabezado del grupo: si los datos traen
  // grafías viejas mezcladas, la tarjeta igual muestra la canónica.
  const saga = seriesName
    ? seriesLabel({ ...doc, series: seriesName })
    : seriesLabel(doc);
  if (doc.pending) return saga ? `${saga} · sin subir` : "sin subir";
  const estado = doc.state
    ? `pág. ${doc.state.page + 1}${doc.page_count ? ` de ${doc.page_count}` : ""}`
    : (doc.page_count ? `${doc.page_count} págs. · sin leer` : "sin leer");
  return saga ? `${saga} · ${estado}` : estado;
}

function describe(doc) {
  const size = formatBytes(doc.byte_size);
  const estado = doc.pending ? "sin subir" : !doc.storage_path ? "solo en este dispositivo" : "sin leer";
  if (!doc.state) return [doc.page_count ? `${doc.page_count} págs.` : "", size, estado].filter(Boolean).join(" · ");
  const where = `pág. ${doc.state.page + 1}${doc.page_count ? ` de ${doc.page_count}` : ""}`;
  const who = doc.state.device_id === device.id ? "acá" : (doc.state.device_name || "otro dispositivo");
  return `${where} · ${timeAgo(doc.state.updated_at)} · ${who}`;
}

async function importFiles(list) {
  showLoading("Importando…");
  try {
    for (const file of list) {
      setLoadingText(`${file.name}`);
      const result = await lib.importFile(file, session.user.id, (t) => setLoadingText(`${file.name} — ${t}`));
      if (result.pending) {
        toast(`"${result.title}" se guardó acá. Se sube solo cuando vuelva la conexión.`);
      } else if (!result.uploaded) {
        toast(`"${result.title}" quedó solo en este dispositivo: falló la subida.`, { variant: "error" });
      }
    }
    await showLibrary();
  } catch (err) {
    toast("No se pudo importar: " + (err.message || err), { variant: "error" });
  } finally {
    hideLoading();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Lector
// ─────────────────────────────────────────────────────────────────────
function wireReader() {
  $("btn-back").addEventListener("click", () => { location.hash = ""; });
  $("btn-zoom-in").addEventListener("click", () => current?.reader.zoomBy(1));
  $("btn-zoom-out").addEventListener("click", () => current?.reader.zoomBy(-1));
  $("zoom-select").addEventListener("change", (e) => {
    const value = e.target.value;
    current?.reader.setZoom(value.startsWith("fit") ? value : Number(value));
  });
  $("btn-bookmark").addEventListener("click", addBookmark);
  $("btn-bookmarks").addEventListener("click", async () => {
    const show = $("bookmarks-panel").hidden;
    closePanels();
    $("bookmarks-panel").hidden = !show;
    if (show) await renderBookmarks();
  });
  $("btn-search").addEventListener("click", () => {
    const show = $("search-panel").hidden;
    closePanels();
    $("search-panel").hidden = !show;
    if (show) $("search-input").focus();
  });
  $("search-form").addEventListener("submit", runSearch);
  $("page-input").addEventListener("change", (e) => {
    const n = Number(e.target.value);
    if (current && n >= 1 && n <= current.numPages) jumpTo(n - 1, 0);
  });
  $("viewer").addEventListener("keydown", (e) => {
    if (!current) return;
    const { page } = current.reader.currentPosition();
    if (e.key === "ArrowRight" || e.key === "PageDown") { jumpTo(page + 1, 0); e.preventDefault(); }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { jumpTo(page - 1, 0); e.preventDefault(); }
    if (e.key === "+" || e.key === "=") { current.reader.zoomBy(1); e.preventDefault(); }
    if (e.key === "-") { current.reader.zoomBy(-1); e.preventDefault(); }
    if (e.key === "0") { current.reader.setZoom("fit-width"); e.preventDefault(); }
  });
}

function closePanels() {
  $("bookmarks-panel").hidden = true;
  $("search-panel").hidden = true;
}

async function runSearch(event) {
  event.preventDefault();
  if (!current) return;
  const query = $("search-input").value.trim();
  const status = $("search-status");
  const list = $("search-results");
  list.replaceChildren();
  if (query.length < 2) { status.textContent = "Escribí al menos 2 caracteres."; return; }

  status.textContent = "Buscando…";
  const hits = await current.reader.search(query, (done, total) => {
    status.textContent = `Buscando… ${done}/${total}`;
  });
  const total = hits.reduce((n, h) => n + h.count, 0);
  status.textContent = total
    ? `${total} ${total === 1 ? "coincidencia" : "coincidencias"} en ${hits.length} ${hits.length === 1 ? "página" : "páginas"}`
    : "Sin coincidencias.";

  for (const hit of hits) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.className = "hit";
    const head = document.createElement("b");
    head.textContent = `Pág. ${hit.page + 1}${hit.count > 1 ? ` · ${hit.count} veces` : ""}`;
    const snippet = document.createElement("span");
    snippet.textContent = hit.snippet;
    btn.append(head, snippet);
    btn.onclick = () => { jumpTo(hit.page, 0); closePanels(); };
    li.append(btn);
    list.append(li);
  }
}

async function openDoc(docId) {
  await closeDoc();
  if (!docs.length) {
    const { docs: list } = await lib.listDocuments();
    docs = list;
  }
  const doc = docs.find((d) => d.doc_id === docId);
  if (!doc) {
    toast("No encontramos ese documento.", { variant: "error" });
    location.hash = "";
    return;
  }

  showLoading("Abriendo…");
  try {
    const blob = await lib.ensureFile(doc);
    lib.pruneCache(docs, docId).catch(() => {});
    ensureCover(docId, blob).catch(() => {});   // la primera vez que llega el PDF
    showScreen("screen-reader");
    $("reader-title").textContent = doc.title;
    closePanels();
    $("search-input").value = "";
    $("search-status").textContent = "";
    $("search-results").replaceChildren();

    const reader = createReader($("viewer"));
    const { numPages } = await reader.open(blob, {
      onProgress: (done, total) => setLoadingText(`Midiendo páginas ${done}/${total}`),
      onPosition: onReaderPosition,
      onZoom: updateZoomUI,
    });

    const sync = createReadingSync({
      docId, device,
      onRemote: handleRemote,
      onStatus: setSyncStatus,
      getPosition: () => reader.currentPosition(),
    });

    current = { doc, reader, sync, numPages };
    $("page-total").textContent = `de ${numPages}`;
    $("page-input").max = String(numPages);

    // Empezar a leer lo saca de "Por leer": pedirlo a mano sería burocracia.
    if ((doc.shelf || "por_leer") === "por_leer") {
      doc.shelf = "leyendo";
      lib.updateDocument(session.user.id, docId, { shelf: "leyendo" }).catch(() => {});
    }

    const initial = await sync.loadInitial();
    suppressRecordUntil = Date.now() + 600;
    reader.goTo(initial.page, initial.offset);
    updatePageIndicator(initial.page);
    sync.start();

    if (initial.source === "remote" && initial.row && initial.row.device_id !== device.id) {
      toast(`Seguimos desde la pág. ${initial.page + 1} (${initial.row.device_name || "otro dispositivo"}, ${timeAgo(initial.row.updated_at)})`);
    }
    renderBookmarks();
  } catch (err) {
    toast("No se pudo abrir: " + (err.message || err), { variant: "error" });
    location.hash = "";
  } finally {
    hideLoading();
  }
}

async function closeDoc() {
  if (!current) return;
  const { doc, reader, sync, numPages } = current;
  const position = reader.currentPosition();
  current = null;
  await sync.stop();
  reader.close();
  suggestFinished(doc, position, numPages);
}

/**
 * Al salir de la última página ofrecemos marcarlo terminado. No lo hacemos
 * solos: llegar al final puede ser hojear el índice o la bibliografía.
 */
function suggestFinished(doc, position, numPages) {
  if (!numPages || doc.shelf === "terminado") return;
  if (position.page < numPages - 1) return;
  toast(`Llegaste al final de "${doc.title}".`, {
    action: {
      label: "Marcar terminado",
      onClick: async () => {
        const patch = { shelf: "terminado", finished_at: new Date().toISOString().slice(0, 10) };
        Object.assign(doc, patch);
        await lib.updateDocument(session.user.id, doc.doc_id, patch);
        if (!$("screen-library").hidden) renderLibrary();
      },
    },
  });
}

function onReaderPosition(pos) {
  updatePageIndicator(pos.page);
  if (Date.now() < suppressRecordUntil) return;
  current?.sync.record(pos.page, pos.offset);
}

/**
 * Refleja el zoom real en el selector. Un porcentaje que no está en la lista
 * (el que sale de "ajustar al ancho", o de los botones) entra como opción
 * temporal, igual que el combo de Adobe.
 */
function updateZoomUI(info) {
  const select = $("zoom-select");
  let custom = select.querySelector("option[data-custom]");

  if (info.mode !== "percent") {
    custom?.remove();
    select.value = info.mode;
    return;
  }
  const exact = [...select.options]
    .find((o) => !o.dataset.custom && Math.round(Number(o.value) * 100) === info.percent);
  if (exact) {
    custom?.remove();
    select.value = exact.value;
    return;
  }
  if (!custom) {
    custom = document.createElement("option");
    custom.dataset.custom = "1";
    select.append(custom);
  }
  custom.value = String(info.percent / 100);
  custom.textContent = `${info.percent}%`;
  select.value = custom.value;
}

function updatePageIndicator(page) {
  const input = $("page-input");
  if (document.activeElement !== input) input.value = String(page + 1);
}

function jumpTo(page, offset) {
  if (!current) return;
  const clamped = Math.min(Math.max(0, page), current.numPages - 1);
  current.reader.goTo(clamped, offset);
  updatePageIndicator(clamped);
}

/**
 * Llegó una posición de otro dispositivo (por conflicto al escribir o por
 * realtime). NO saltamos solos: interrumpir la lectura de alguien porque el
 * iPad quedó abierto en otra página es peor que no sincronizar.
 */
function handleRemote(row, reason) {
  if (!current || row.doc_id !== current.doc.doc_id) return;
  const who = row.device_name || "Otro dispositivo";
  const verb = reason === "conflict" ? "quedó" : "está";
  toast(`${who} ${verb} en la pág. ${row.page + 1} (${timeAgo(row.updated_at)})`, {
    action: {
      label: "Ir",
      onClick: () => {
        suppressRecordUntil = Date.now() + 600;
        jumpTo(row.page, row.page_offset);
      },
    },
  });
}

function setSyncStatus(status) {
  const el = $("sync-status");
  el.classList.toggle("warn", status === "offline");
  el.textContent = { synced: "sincronizado", pending: "guardando…", offline: "sin conexión" }[status] || "";
}

// ─────────────────────────────────────────────────────────────────────
// Marcadores
// ─────────────────────────────────────────────────────────────────────
async function addBookmark() {
  if (!current) return;
  const { page, offset } = current.reader.currentPosition();
  await bm.add({
    userId: session.user.id,
    docId: current.doc.doc_id,
    page, offset,
    label: `Pág. ${page + 1}`,
  });
  toast(`Marcaste la pág. ${page + 1}`);
  if (!$("bookmarks-panel").hidden) await renderBookmarks();
}

async function renderBookmarks() {
  if (!current) return;
  const rows = await bm.listFor(current.doc.doc_id);
  const ul = $("bookmark-list");
  ul.replaceChildren();
  $("bookmarks-empty").hidden = rows.length > 0;

  for (const row of rows) {
    const li = document.createElement("li");
    const go = document.createElement("button");
    go.className = "link";
    go.textContent = row.label || `Pág. ${row.page + 1}`;
    go.onclick = () => {
      suppressRecordUntil = Date.now() + 600;
      jumpTo(row.page, row.page_offset);
      $("bookmarks-panel").hidden = true;
    };
    const del = document.createElement("button");
    del.className = "doc-del";
    del.textContent = "✕";
    del.setAttribute("aria-label", "Borrar marcador");
    del.onclick = async () => { await bm.remove(row.id); await renderBookmarks(); };
    li.append(go, del);
    ul.append(li);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Red / service worker
// ─────────────────────────────────────────────────────────────────────
function wireNetwork() {
  const badge = $("net-badge");
  const update = () => { badge.hidden = navigator.onLine; };
  addEventListener("online", async () => {
    update();
    if (!session) return;
    try {
      await lib.flushPendingDocs(session.user.id);   // primero, por las FK
      await lib.flushMetaOutbox(session.user.id);
      await bm.flushOutbox();
    } catch { /* se reintenta en la próxima visita a la biblioteca */ }
  });
  addEventListener("offline", update);
  update();
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

boot();
