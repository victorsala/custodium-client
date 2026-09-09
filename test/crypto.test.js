// Proves locals, sense dependències: node --test (Node 20).
//
// La criptografia de l'obridor autònom no s'importa: s'extreu del mateix
// abrir-offline.html que es distribueix. Si algú canvia crypto.js i no
// l'obridor (o al revés), aquests tests ho detecten.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deriveKeys, derivePassphraseKey, randomKey, importKey,
  encryptJson, decryptJson, encryptBytes,
  generatePassphrase, normalizePassphrase,
} from "../public/crypto.js";
import { WORDS } from "../public/words.js";

// ---- criptografia incrustada d'abrir-offline.html, tal com es distribueix ----
const html = readFileSync(new URL("../public/abrir-offline.html", import.meta.url), "utf8");
const start = html.indexOf("// ---------- criptografia");
const end = html.indexOf("// ---------- càrrega");
assert.ok(start > 0 && end > start, "no s'ha trobat el bloc de criptografia dins abrir-offline.html");
const offline = new Function(
  "te", "td",
  html.slice(start, end) + "\nreturn { titularKey, personKey, aes, decryptJson, decryptBytes, normalize, ITER };"
)(new TextEncoder(), new TextDecoder());

// ---- normalizePhone d'app.js (el mòdul sencer arrenca la UI i necessita DOM) ----
const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const phoneSrc = appSrc.match(/function normalizePhone\(value\) \{[\s\S]*?\n\}/);
assert.ok(phoneSrc, "no s'ha trobat normalizePhone dins app.js");
const normalizePhone = new Function(`return ${phoneSrc[0]}`)();

// (a) el que xifra crypto.js, l'obridor ho obre

test("obridor: desxifra el pla del titular (PBKDF2 + HKDF)", async () => {
  const email = "titular@example.com";
  const password = "una contrasenya de setze";
  const plan = { v: 2, recipients: [], items: [{ id: "x", title: "Compte", notes: "text lliure" }] };

  const { encKey } = await deriveKeys(email, password);
  const blob = await encryptJson(encKey, plan);
  assert.deepEqual(await offline.decryptJson(await offline.titularKey(email, password), blob), plan);
});

test("obridor: desxifra el paquet d'una persona encara que escrigui la frase diferent", async () => {
  const email = "roser@example.com";
  const phrase = "ebano deporte nacar cien organo vagar";
  const pkg = { v: 1, items: [{ title: "Compte", files: [] }] };

  const key = await importKey(await derivePassphraseKey(email, phrase));
  const blob = await encryptJson(key, pkg);
  const escrita = "  Ébano  DEPORTE   Nácar cien órgano vagar ";
  assert.deepEqual(await offline.decryptJson(await offline.personKey(email, escrita), blob), pkg);
});

test("obridor: desxifra un fitxer xifrat amb clau pròpia (iv || ct)", async () => {
  const raw = randomKey();
  const bytes = crypto.getRandomValues(new Uint8Array(1024));
  const sealed = await encryptBytes(await importKey(raw), bytes);
  assert.deepEqual(await offline.decryptBytes(await offline.aes(raw), sealed), bytes);
});

test("obridor: mateixes iteracions de PBKDF2 que el client", () => {
  assert.equal(offline.ITER, 600000);
  assert.match(readFileSync(new URL("../public/crypto.js", import.meta.url), "utf8"), /PBKDF2_ITERATIONS = 600_000/);
});

// (b) normalització de la frase

test("normalizePassphrase: accents, majúscules i espais no canvien la clau", () => {
  assert.equal(normalizePassphrase("  Ébano  DEPORTE   Nácar\tcien órgano vagar "), "ebano deporte nacar cien organo vagar");
  assert.equal(offline.normalize("  Ébano  DEPORTE   Nácar\tcien órgano vagar "), "ebano deporte nacar cien organo vagar");
});

// (c) una clau equivocada no obre res

test("una contrasenya o frase equivocada llança error", async () => {
  const { encKey } = await deriveKeys("a@example.com", "la contrasenya correcta");
  const blob = await encryptJson(encKey, { secret: true });

  await assert.rejects(offline.decryptJson(await offline.titularKey("a@example.com", "una altra contrasenya"), blob));
  const wrong = await importKey(await derivePassphraseKey("a@example.com", "sis paraules que no toquen"));
  await assert.rejects(decryptJson(wrong, blob));
});

// (d) frase generada

test("generatePassphrase: sis paraules de words.js", () => {
  const set = new Set(WORDS);
  for (let i = 0; i < 20; i++) {
    const words = generatePassphrase().split(" ");
    assert.equal(words.length, 6);
    for (const w of words) assert.ok(set.has(w), `paraula fora de la llista: ${w}`);
  }
});

// (e) normalització del telèfon

test("normalizePhone: cal prefix internacional (+ o 00)", () => {
  assert.equal(normalizePhone("+1 (253) 234-4735"), "+12532344735");
  assert.equal(normalizePhone("+34 600 000 000"), "+34600000000");
  assert.equal(normalizePhone("0034 600 000 000"), "+34600000000");
  // Sense prefix es rebutja: no es pot endevinar el país.
  assert.equal(normalizePhone("600 000 000"), false);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone("abc"), null);
});
