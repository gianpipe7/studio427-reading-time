// doc_id = SHA-256 (hex) de los bytes del PDF. Requiere contexto seguro
// (https o localhost), que es donde va a correr la app igual.
export async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
