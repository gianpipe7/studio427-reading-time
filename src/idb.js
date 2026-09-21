// IndexedDB: bytes de los PDF, cache de marcadores y la cola de escrituras
// que quedaron pendientes por estar sin conexión.
const DB_NAME = "pdfsync";
const DB_VERSION = 3;

/** Tope del cache de PDF. Arriba de esto se desaloja por menos usado. */
export const CACHE_CAP_BYTES = 300 * 1024 * 1024;

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // doc_id -> {blob, size, lastUsed}
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      // doc_id -> Blob JPEG de la primera página
      if (!db.objectStoreNames.contains("covers")) db.createObjectStore("covers");
      if (!db.objectStoreNames.contains("bookmarks")) {
        const s = db.createObjectStore("bookmarks", { keyPath: "id" });
        s.createIndex("doc", "doc_id");
      }
      // v1 guardaba el Blob pelado; v2 necesita tamaño y último uso para el LRU.
      if (event.oldVersion === 1) {
        const store = req.transaction.objectStore("files");
        store.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          if (cursor.value instanceof Blob) {
            cursor.update({ blob: cursor.value, size: cursor.value.size, lastUsed: Date.now() });
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.onerror = () => reject(t.error);
    t.oncomplete = () => resolve(req?.result);
    if (req) req.onerror = () => reject(req.error);
  });
}

const blobOf = (rec) => (rec instanceof Blob ? rec : rec?.blob);
const sizeOf = (rec) => (rec instanceof Blob ? rec.size : rec?.size || 0);

export const files = {
  /** Devuelve el Blob y marca el uso, que es lo que ordena el desalojo. */
  async get(docId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("files", "readwrite");
      const store = t.objectStore("files");
      const req = store.get(docId);
      req.onsuccess = () => {
        const blob = blobOf(req.result);
        if (!blob) return;
        store.put({ blob, size: blob.size, lastUsed: Date.now() }, docId);
        resolve(blob);
      };
      t.oncomplete = () => resolve(undefined);
      t.onerror = () => reject(t.error);
    });
  },
  put: (docId, blob) =>
    tx("files", "readwrite", (s) => s.put({ blob, size: blob.size, lastUsed: Date.now() }, docId)),
  del: (docId) => tx("files", "readwrite", (s) => s.delete(docId)),
  has: async (docId) => (await tx("files", "readonly", (s) => s.count(docId))) > 0,

  /** Inventario del cache, sin traer los blobs a memoria. */
  async entries() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction("files");
      const req = t.objectStore("files").openCursor();
      const list = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        list.push({ docId: cursor.key, size: sizeOf(cursor.value), lastUsed: cursor.value?.lastUsed || 0 });
        cursor.continue();
      };
      t.oncomplete = () => resolve(list);
      t.onerror = () => reject(t.error);
    });
  },

  async usage() {
    const list = await this.entries();
    return { bytes: list.reduce((n, e) => n + e.size, 0), count: list.length };
  },

  /**
   * Desaloja los menos usados hasta bajar del tope.
   *
   * `keep` NO es una optimización: un PDF que todavía no se subió al storage
   * solo existe acá, así que desalojarlo lo pierde para siempre. Quien llama
   * es responsable de pasar esos doc_id.
   */
  async enforceQuota(cap = CACHE_CAP_BYTES, keep = []) {
    const list = await this.entries();
    let total = list.reduce((n, e) => n + e.size, 0);
    if (total <= cap) return { evicted: [], bytes: total };

    const safe = new Set(keep);
    const evicted = [];
    for (const entry of list.filter((e) => !safe.has(e.docId)).sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (total <= cap) break;
      await this.del(entry.docId);
      total -= entry.size;
      evicted.push(entry.docId);
    }
    return { evicted, bytes: total };
  },

  async clear(keep = []) {
    const safe = new Set(keep);
    for (const entry of await this.entries()) {
      if (!safe.has(entry.docId)) await this.del(entry.docId);
    }
  },
};

export const covers = {
  get: (docId) => tx("covers", "readonly", (s) => s.get(docId)),
  put: (docId, blob) => tx("covers", "readwrite", (s) => s.put(blob, docId)),
  del: (docId) => tx("covers", "readwrite", (s) => s.delete(docId)),
};

export const kv = {
  get: (key) => tx("kv", "readonly", (s) => s.get(key)),
  put: (key, value) => tx("kv", "readwrite", (s) => s.put(value, key)),
  del: (key) => tx("kv", "readwrite", (s) => s.delete(key)),
};

export const bookmarksStore = {
  all: () => tx("bookmarks", "readonly", (s) => s.getAll()),
  put: (row) => tx("bookmarks", "readwrite", (s) => s.put(row)),
  del: (id) => tx("bookmarks", "readwrite", (s) => s.delete(id)),
  async forDoc(docId) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction("bookmarks").objectStore("bookmarks").index("doc").getAll(docId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
};

export async function clearAll() {
  const db = await open();
  await Promise.all(["files", "kv", "bookmarks", "covers"].map((name) =>
    new Promise((resolve, reject) => {
      const t = db.transaction(name, "readwrite");
      t.objectStore(name).clear();
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    })));
}
