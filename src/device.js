// Identidad del dispositivo. Vive en localStorage: es lo que permite
// descartar el eco de realtime (mi propia escritura vuelve como evento) y
// lo que el otro dispositivo muestra en "seguís en la pág. X (iPad)".
const KEY = "pdfsync.device";

function guessName() {
  const ua = navigator.userAgent;
  // iPadOS 13+ se hace pasar por Mac; se lo delata el touch.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Este navegador";
}

let cached = null;

export function getDevice() {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      cached = JSON.parse(raw);
      if (cached?.id) return cached;
    }
  } catch { /* storage bloqueado: seguimos con uno efímero */ }
  cached = { id: crypto.randomUUID(), name: guessName() };
  persist();
  return cached;
}

export function setDeviceName(name) {
  const d = getDevice();
  d.name = (name || "").trim().slice(0, 40) || guessName();
  persist();
  return d;
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(cached)); } catch { /* sin persistencia */ }
}
