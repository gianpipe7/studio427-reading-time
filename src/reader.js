import { getDocument, TextLayer } from "./pdf.js";

const MAX_DPR = 2;            // más que esto es memoria tirada en pantallas retina
const RENDER_MARGIN = "150%"; // cuánto pre-renderizamos alrededor de lo visible
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5];
const MIN_SCALE = 0.1;
const MAX_SCALE = 6;

/**
 * Visor de scroll continuo sobre pdf.js.
 *
 * La posición es {page, offset} donde offset es la fracción [0,1) de scroll
 * DENTRO de la página — el mismo par que guarda reading_state, así que una
 * pantalla de iPhone y una de iPad caen en el mismo renglón del texto aunque
 * la página se renderice a distinto tamaño.
 */
export function createReader(viewer) {
  /** @type {import("../vendor/pdfjs/pdf.js").PDFDocumentProxy|null} */
  let pdf = null;
  let sizes = [];      // {width, height} a escala 1
  let tops = [];       // offsetTop real de cada página dentro del scroller
  let heights = [];    // alto renderizado de cada página
  let scale = 1;
  // "fit-width" | "fit-page" | número = escala absoluta, donde 1 es el tamaño
  // natural del PDF (1 punto = 1 píxel CSS), igual que el 100% de Adobe.
  let zoomMode = "fit-width";
  let observer = null;
  let onPosition = null;
  let onZoom = null;
  let rafPending = false;
  let resizeTimer = null;
  const tasks = new Map();       // page index -> RenderTask
  const textLayers = new Map();  // page index -> TextLayer
  const textCache = new Map();   // page index -> texto plano, para la búsqueda

  async function open(blob, opts = {}) {
    close();
    onPosition = opts.onPosition || null;
    onZoom = opts.onZoom || null;
    zoomMode = opts.zoom || "fit-width";
    const data = new Uint8Array(await blob.arrayBuffer());
    pdf = await getDocument({ data }).promise;

    // Medimos todas las páginas de una: si no, los placeholders arrancan con
    // el alto equivocado y el scroll salta cuando cada página se renderiza.
    sizes = new Array(pdf.numPages);
    const CHUNK = 12;
    for (let start = 0; start < pdf.numPages; start += CHUNK) {
      const batch = [];
      for (let i = start; i < Math.min(start + CHUNK, pdf.numPages); i++) {
        batch.push(pdf.getPage(i + 1).then((p) => {
          const vp = p.getViewport({ scale: 1 });
          sizes[i] = { width: vp.width, height: vp.height };
        }));
      }
      await Promise.all(batch);
      opts.onProgress?.(Math.min(start + CHUNK, pdf.numPages), pdf.numPages);
    }

    layout();
    viewer.addEventListener("scroll", onScroll, { passive: true });
    observeResize();
    return { numPages: pdf.numPages };
  }

  /**
   * Escala efectiva. Los modos "ajustar" se recalculan con el tamaño del
   * viewport; un porcentaje es absoluto y sobrevive al resize.
   */
  function computeScale() {
    const maxWidth = Math.max(...sizes.map((s) => s.width));
    const maxHeight = Math.max(...sizes.map((s) => s.height));
    // Piso de 1, no de 120: un piso alto hace que "ajustar al ancho" deje de
    // ajustar en viewports angostos. Para clientWidth 0 (pantalla oculta) ya
    // está MIN_SCALE, y el ResizeObserver rehace el layout al aparecer.
    const availW = Math.max(1, viewer.clientWidth - 24);
    const availH = Math.max(1, viewer.clientHeight - 24);
    if (zoomMode === "fit-width") return availW / maxWidth;
    if (zoomMode === "fit-page") return Math.min(availW / maxWidth, availH / maxHeight);
    return zoomMode;
  }

  const zoomInfo = () => ({
    mode: typeof zoomMode === "number" ? "percent" : zoomMode,
    scale,
    percent: Math.round(scale * 100),
  });

  /** (Re)construye los contenedores de página al zoom actual. */
  function layout(keepPosition = null) {
    if (!pdf) return;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, computeScale()));

    for (const task of tasks.values()) task.cancel();
    tasks.clear();
    for (const layer of textLayers.values()) layer.cancel();
    textLayers.clear();
    observer?.disconnect();
    viewer.replaceChildren();

    const frag = document.createDocumentFragment();
    heights = sizes.map((s) => Math.round(s.height * scale));
    for (let i = 0; i < sizes.length; i++) {
      const el = document.createElement("div");
      el.className = "pdf-page";
      el.dataset.page = String(i);
      el.style.width = `${Math.round(sizes[i].width * scale)}px`;
      el.style.height = `${heights[i]}px`;
      const ph = document.createElement("div");
      ph.className = "ph";
      ph.textContent = String(i + 1);
      el.append(ph);
      frag.append(el);
    }
    viewer.append(frag);

    // Sin esto, el scroll topa antes de que la última página llegue arriba de
    // todo y su posición es INALCANZABLE: terminar el documento se guardaría
    // como "anteúltima página". El relleno la deja subir hasta el borde.
    const lastHeight = heights[heights.length - 1] || 0;
    viewer.style.paddingBottom = `${Math.max(12, viewer.clientHeight - lastHeight)}px`;

    // offsetTop real: no derivamos los márgenes del CSS a mano.
    tops = [...viewer.children].map((el) => el.offsetTop);

    observer = new IntersectionObserver(onIntersect, { root: viewer, rootMargin: RENDER_MARGIN });
    for (const el of viewer.children) observer.observe(el);

    if (keepPosition) goTo(keepPosition.page, keepPosition.offset);
    onZoom?.(zoomInfo());
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      const i = Number(entry.target.dataset.page);
      if (entry.isIntersecting) renderPage(i, entry.target);
      else unrenderPage(i, entry.target);
    }
  }

  async function renderPage(i, el) {
    if (tasks.has(i) || el.querySelector("canvas")) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    try {
      const page = await pdf.getPage(i + 1);
      if (!viewer.contains(el)) return;

      const cssViewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(cssViewport.width * dpr);
      canvas.height = Math.round(cssViewport.height * dpr);

      // El canvas entra al DOM antes de estar pintado: pdf.js lo va llenando
      // de a poco, y no lo esperamos. Su promesa avanza por rAF, que se
      // frena con la pestaña oculta; encadenar la capa de texto detrás la
      // dejaría colgada sin motivo.
      const task = page.render({
        canvasContext: canvas.getContext("2d", { alpha: false }),
        viewport: page.getViewport({ scale: scale * dpr }),
      });
      tasks.set(i, task);
      task.promise.then(
        () => tasks.delete(i),
        (err) => {
          tasks.delete(i);
          if (err?.name !== "RenderingCancelledException") console.warn("render página", i + 1, err);
        },
      );
      el.replaceChildren(canvas);

      // Capa de texto: spans transparentes ubicados encima del canvas. Es lo
      // que habilita seleccionar, copiar y el buscador nativo del browser.
      // pdf.js la posiciona en píxeles CSS, de ahí el viewport sin dpr.
      const layer = document.createElement("div");
      layer.className = "textLayer";
      layer.style.setProperty("--scale-factor", String(scale));
      const textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: layer,
        viewport: cssViewport,
      });
      textLayers.set(i, textLayer);
      await textLayer.render();
      if (!viewer.contains(el)) { textLayer.cancel(); textLayers.delete(i); return; }
      el.append(layer);
    } catch (err) {
      if (err?.name !== "RenderingCancelledException") console.warn("capa de texto página", i + 1, err);
    }
  }

  /**
   * Renderiza una página ya, sin esperar a que entre en viewport. El
   * IntersectionObserver no dispara con la pestaña oculta, así que esto es lo
   * que permite renderizar bajo demanda (y lo que usan las pruebas).
   */
  async function ensureRendered(i) {
    const el = viewer.children[i];
    if (!el) return false;
    await renderPage(i, el);
    return !!el.querySelector("canvas");
  }

  function unrenderPage(i, el) {
    tasks.get(i)?.cancel();
    tasks.delete(i);
    textLayers.get(i)?.cancel();
    textLayers.delete(i);
    const canvas = el.querySelector("canvas");
    if (!canvas) return;
    canvas.width = canvas.height = 0;   // libera el backing store ya
    const ph = document.createElement("div");
    ph.className = "ph";
    ph.textContent = String(i + 1);
    el.replaceChildren(ph);
  }

  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    let done = false;
    const run = () => {
      if (done) return;
      done = true;
      rafPending = false;
      onPosition?.(currentPosition());
    };
    // rAF da el update suave mientras la pestaña está visible, pero ahí se
    // throttlea o directamente no corre — y es justo cuando el usuario se va
    // de la app que no podemos perder la última posición. El timer es el piso.
    requestAnimationFrame(run);
    setTimeout(run, 250);
  }

  /** Página visible arriba de todo + cuánto llevamos scrolleado dentro. */
  function currentPosition() {
    if (!tops.length) return { page: 0, offset: 0 };
    const probe = viewer.scrollTop;
    let lo = 0, hi = tops.length - 1, page = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] <= probe + 1) { page = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    const raw = (probe - tops[page]) / (heights[page] || 1);
    return { page, offset: Math.min(0.999, Math.max(0, raw)) };
  }

  function goTo(page, offset = 0) {
    if (!tops.length) return;
    const i = Math.min(Math.max(0, page | 0), tops.length - 1);
    viewer.scrollTop = tops[i] + Math.min(0.999, Math.max(0, offset)) * heights[i];
  }

  /** @param {"fit-width"|"fit-page"|number} mode */
  function setZoom(mode) {
    zoomMode = mode;
    layout(currentPosition());
    return zoomInfo();
  }

  /** Sube o baja al siguiente escalón de la escalera, desde la escala actual. */
  function zoomBy(direction) {
    const next = direction > 0
      ? ZOOM_STEPS.find((z) => z > scale + 0.005)
      : [...ZOOM_STEPS].reverse().find((z) => z < scale - 0.005);
    return setZoom(next ?? scale);
  }

  const getZoom = () => zoomInfo();

  function observeResize() {
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const keep = currentPosition();
        layout(keep);
      }, 150);
    });
    ro.observe(viewer);
    viewer._ro = ro;
  }


  // ── Búsqueda ────────────────────────────────────────────────────
  // Plegado que NO cambia el largo del string, así los índices del texto
  // normalizado siguen sirviendo para recortar el fragmento original.
  const FOLD = { "á":"a","é":"e","í":"i","ó":"o","ú":"u","ü":"u","ñ":"n",
                 "à":"a","è":"e","ì":"i","ò":"o","ù":"u","â":"a","ê":"e",
                 "î":"i","ô":"o","û":"u","ç":"c" };
  const fold = (t) => t.toLowerCase().replace(/[áéíóúüñàèìòùâêîôûç]/g, (c) => FOLD[c]);

  async function pageText(i) {
    if (textCache.has(i)) return textCache.get(i);
    const page = await pdf.getPage(i + 1);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim();
    textCache.set(i, text);
    return text;
  }

  /** Busca en todas las páginas. Devuelve [{page, count, snippet}]. */
  async function search(query, onProgress) {
    const needle = fold(query.trim());
    if (!pdf || needle.length < 2) return [];
    const hits = [];
    for (let i = 0; i < pdf.numPages; i++) {
      const text = await pageText(i);
      const hay = fold(text);
      let at = hay.indexOf(needle), count = 0, first = -1;
      while (at !== -1) {
        count++;
        if (first < 0) first = at;
        at = hay.indexOf(needle, at + needle.length);
      }
      if (count) {
        const from = Math.max(0, first - 40);
        const snippet = (from > 0 ? "…" : "")
          + text.slice(from, first + needle.length + 40).trim()
          + (first + needle.length + 40 < text.length ? "…" : "");
        hits.push({ page: i, count, snippet });
      }
      onProgress?.(i + 1, pdf.numPages);
    }
    return hits;
  }

  function close() {
    viewer.removeEventListener("scroll", onScroll);
    viewer._ro?.disconnect();
    clearTimeout(resizeTimer);
    for (const task of tasks.values()) task.cancel();
    tasks.clear();
    for (const layer of textLayers.values()) layer.cancel();
    textLayers.clear();
    textCache.clear();
    observer?.disconnect();
    observer = null;
    viewer.replaceChildren();
    pdf?.destroy();
    pdf = null;
    sizes = []; tops = []; heights = []; zoomMode = "fit-width";
  }

  return {
    open, close, goTo, currentPosition, setZoom, zoomBy, getZoom, search, ensureRendered,
    relayout: () => layout(currentPosition()),
  };
}
