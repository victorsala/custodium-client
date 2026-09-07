// crypto.js — Custodium B2C · v3
//
// Tot el xifrat passa aquí, al navegador. De la contrasenya del titular només
// surt del dispositiu authHash; encKey no és exportable.
//
//   masterKey = PBKDF2-SHA256(password, salt = email, 600.000 iter)
//   encKey    = HKDF(masterKey, "custodium-enc")  → AES-256-GCM, no extractable
//   authHash  = HKDF(masterKey, "custodium-auth") → 32 bytes, base64
//
// Persones de confiança: la seva clau es deriva de la seva frase amb el mateix
// PBKDF2 (salt = el seu email). Es guarda dins del pla del titular (xifrada
// per ell) per poder rexifrar el paquet a cada desat sense tornar a demanar-la.
//
// Fitxers: clau aleatòria pròpia per fitxer. La clau viatja dins del pla i
// dins del paquet de la persona que ha de rebre'l. Un sol objecte a R2.

export const BLOB_VERSION = 1;
const PBKDF2_ITERATIONS = 600_000;

const te = new TextEncoder();
const td = new TextDecoder();

export async function deriveKeys(email, password) {
  const masterBits = await pbkdf2(password, email);
  const masterKey = await crypto.subtle.importKey("raw", masterBits, "HKDF", false, ["deriveKey", "deriveBits"]);

  const encKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode("custodium-enc") },
    masterKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );

  const authBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode("custodium-auth") },
    masterKey,
    256
  );

  return { encKey, authHash: b64encode(new Uint8Array(authBits)) };
}

// Clau d'una persona de confiança a partir de la seva frase. Retorna 32 bytes.
export async function derivePassphraseKey(email, passphrase) {
  return new Uint8Array(await pbkdf2(passphrase, email));
}

async function pbkdf2(secret, saltText) {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: te.encode(saltText.trim().toLowerCase()), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
}

export function randomKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function importKey(raw) {
  const bytes = typeof raw === "string" ? b64decode(raw) : raw;
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(obj)));
  return { v: BLOB_VERSION, iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) };
}

export async function decryptJson(key, blob) {
  if (blob?.v !== BLOB_VERSION) throw new Error("unknown_blob_version");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(blob.iv) }, key, b64decode(blob.ct));
  return JSON.parse(td.decode(pt));
}

// Fitxers: l'IV (12 bytes) va al davant del ciphertext.
export async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

export async function decryptBytes(key, bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.length < 12 + 16) throw new Error("bad_file");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12)));
}

// Frase llegible per escriure en paper: 4 blocs de 4 caràcters (base32 sense
// caràcters confusos), ~80 bits.
export function generatePassphrase() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

export function b64encode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
