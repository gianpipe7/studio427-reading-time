// Helpers de UI: toasts, overlay de carga, formato de fechas.
const toasts = () => document.getElementById("toasts");

/**
 * @param {string} text
 * @param {{action?: {label: string, onClick: () => void}, timeout?: number, variant?: "error"}} [opts]
 */
export function toast(text, opts = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (opts.variant === "error" ? " error" : "");
  const span = document.createElement("span");
  span.textContent = text;
  el.append(span);

  const close = () => el.remove();

  if (opts.action) {
    const btn = document.createElement("button");
    btn.className = "primary small";
    btn.textContent = opts.action.label;
    btn.onclick = () => { close(); opts.action.onClick(); };
    el.append(btn);
  }
  const dismiss = document.createElement("button");
  dismiss.className = "ghost small";
  dismiss.textContent = "✕";
  dismiss.setAttribute("aria-label", "Cerrar");
  dismiss.onclick = close;
  el.append(dismiss);

  toasts().append(el);
  const ms = opts.timeout ?? (opts.action ? 12000 : 4000);
  if (ms > 0) setTimeout(close, ms);
  return close;
}

export function showLoading(text = "") {
  const el = document.getElementById("loading");
  document.getElementById("loading-text").textContent = text;
  el.hidden = false;
}
export function setLoadingText(text) {
  document.getElementById("loading-text").textContent = text;
}
export function hideLoading() {
  document.getElementById("loading").hidden = true;
}

export function showScreen(id) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id;
}

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
const UNITS = [["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1]];

/** "hace 5 min" a partir de un timestamptz. */
export function timeAgo(iso) {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  for (const [unit, size] of UNITS) {
    if (secs >= size || unit === "second") {
      return rtf.format(-Math.max(1, Math.round(secs / size)), unit);
    }
  }
  return "recién";
}

export function formatBytes(n) {
  if (!n) return "";
  const mb = n / 1048576;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(n / 1024)} kB`;
}
