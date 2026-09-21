import * as pdfjsLib from "../vendor/pdfjs/pdf.js";

// Worker local: la app funciona sin CDN (y sin red, una vez cacheada).
pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL("../vendor/pdfjs/pdf.worker.js", import.meta.url).href;

export const { getDocument, TextLayer, version } = pdfjsLib;
