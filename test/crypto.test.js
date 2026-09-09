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
  generatePassphrase, normalizePassphrase, b64encode,
} from "../public/crypto.js";

// Una sal de compte qualsevol, com la que dóna el servidor (16 bytes, base64).
const randomSalt = () => b64encode(crypto.getRandomValues(new Uint8Array(16)));
import { WORDS } from "../public/words.js";

// ---- criptografia incrustada d'abrir-offline.html, tal com es distribueix ----
const html = readFileSync(new URL("../public/abrir-offline.html", import.meta.url), "utf8");
const start = html.indexOf("// ---------- criptografia");
const end = html.indexOf("// ---------- càrrega");
assert.ok(start > 0 && end > start, "no s'ha trobat el bloc de criptografia dins abrir-offline.html");
const offline = new Function(
  "te", "td",
  html.slice(start, end) + "\nreturn { titularKey, personKey, aes, decryptJson, decryptBytes, openPlan, normalize, ITER };"
)(new TextEncoder(), new TextDecoder());

// ---- normalizePhone d'app.js (el mòdul sencer arrenca la UI i necessita DOM) ----
const appSrc = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const phoneSrc = appSrc.match(/function normalizePhone\(value\) \{[\s\S]*?\n\}/);
assert.ok(phoneSrc, "no s'ha trobat normalizePhone dins app.js");
const normalizePhone = new Function(`return ${phoneSrc[0]}`)();
const onboardingSrc = appSrc.match(/function onboardingState\(vault, settings\) \{[\s\S]*?\n\}/);
assert.ok(onboardingSrc, "no s'ha trobat onboardingState dins app.js");
const onboardingState = new Function(`return ${onboardingSrc[0]}`)();

// ---- parsePhone i reconciliació del Worker (s'extreuen del codi desplegat) ----
const workerSrc = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const serverPhoneSrc = workerSrc.match(/function parsePhone\(value\) \{[\s\S]*?\n\}/);
assert.ok(serverPhoneSrc, "no s'ha trobat parsePhone dins src/index.js");
class ServerHttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const parsePhone = new Function(
  "PHONE_RE", "HttpError",
  `return ${serverPhoneSrc[0]}`
)(/^\+[1-9]\d{6,14}$/, ServerHttpError);
const reconcileDecisionSrc = workerSrc.match(/function reconcileVersionMatches\(requestedVersion, vaultVersion\) \{[\s\S]*?\n\}/);
assert.ok(reconcileDecisionSrc, "no s'ha trobat reconcileVersionMatches dins src/index.js");
const reconcileVersionMatches = new Function(`return ${reconcileDecisionSrc[0]}`)();
const deriveSaltSrc = workerSrc.match(/async function deriveSalt\(pepper, email\) \{[\s\S]*?\n\}/);
assert.ok(deriveSaltSrc, "no s'ha trobat deriveSalt dins src/index.js");
const deriveSalt = new Function("KDF_SALT_BYTES", `return ${deriveSaltSrc[0]}`)(16);
const accountSaltSrc = workerSrc.match(/async function accountSalt\(env, email\) \{[\s\S]*?\n\}/);
assert.ok(accountSaltSrc, "no s'ha trobat accountSalt dins src/index.js");
const accountSalt = new Function(
  "HttpError", "b64", "deriveSalt",
  `return ${accountSaltSrc[0]}`
)(ServerHttpError, { encode: (bytes) => b64encode(bytes) }, deriveSalt);
// D1 de mentida amb una sola taula users, per a accountSalt: només cal
// prepare(sql).bind(email).first() → la fila o null.
function fakeDb(rows) {
  return { prepare: () => ({ bind: (email) => ({ first: async () => rows.get(email) ?? null }) }) };
}

// (a) el que xifra crypto.js, l'obridor ho obre

test("obridor: desxifra el pla del titular (PBKDF2 + HKDF) amb la sal del compte", async () => {
  const salt = randomSalt();
  const password = "una contrasenya de setze";
  const plan = { v: 2, recipients: [], items: [{ id: "x", title: "Compte", notes: "text lliure" }] };

  const { encKey } = await deriveKeys(salt, password);
  const blob = await encryptJson(encKey, plan);
  assert.deepEqual(await offline.decryptJson(await offline.titularKey(salt, password), blob), plan);
});

test("obridor: obre el plan.json de la còpia, que porta la sal dins", async () => {
  // Mateix format que exportBundle (app.js): el blob xifrat més la sal del compte.
  const salt = randomSalt();
  const password = "una contrasenya de setze";
  const plan = { v: 2, recipients: [], items: [{ id: "x", title: "Compte", notes: "text lliure" }] };
  const { encKey } = await deriveKeys(salt, password);
  const planJson = JSON.stringify({ ...(await encryptJson(encKey, plan)), salt });

  assert.deepEqual(await offline.openPlan(JSON.parse(planJson), password), plan);
  // Sense la sal (o amb una altra) no s'obre: l'email ja no serveix per derivar.
  const { salt: _dropped, ...withoutSalt } = JSON.parse(planJson);
  await assert.rejects(offline.openPlan(withoutSalt, password));
  await assert.rejects(offline.openPlan({ ...JSON.parse(planJson), salt: randomSalt() }, password));
});

test("sal derivada: determinista per a un mateix email i diferent entre emails", async () => {
  const pepper = "un secret qualsevol";
  const a1 = await deriveSalt(pepper, "a@example.com");
  const a2 = await deriveSalt(pepper, "a@example.com");
  const b = await deriveSalt(pepper, "b@example.com");
  assert.equal(a1.length, 16);
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b);
  // Amb un altre pepper canvia tot: sense el secret no es pot reproduir.
  assert.notDeepEqual(await deriveSalt("un altre secret", "a@example.com"), a1);
});

test("/api/salt: la sal d'un email és la mateixa abans i després de registrar-lo", async () => {
  const rows = new Map();
  const env = { SALT_PEPPER: "un secret qualsevol", DB: fakeDb(rows) };
  const email = "a@example.com";

  const before = await accountSalt(env, email);
  // register fa exactament això: guarda a la fila la sal que accountSalt li dóna.
  rows.set(email, { kdf_salt: before });
  const after = await accountSalt(env, email);
  assert.equal(after, before);
  assert.equal(before, b64encode(await deriveSalt(env.SALT_PEPPER, email)));

  // Un cop guardada, mana la fila: un canvi de pepper (o d'email, en el futur)
  // no canvia la sal del compte.
  assert.equal(await accountSalt({ ...env, SALT_PEPPER: "un altre secret" }, email), before);
  // Sense pepper no hi ha sal per a ningú.
  await assert.rejects(accountSalt({ DB: fakeDb(rows) }, email), (e) => e.status === 500);
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
  const salt = randomSalt();
  const { encKey } = await deriveKeys(salt, "la contrasenya correcta");
  const blob = await encryptJson(encKey, { secret: true });

  await assert.rejects(offline.decryptJson(await offline.titularKey(salt, "una altra contrasenya"), blob));
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

test("móvil sin prefijo internacional: cliente y Worker lo rechazan", () => {
  const localNumber = "600 000 000";
  assert.equal(normalizePhone(localNumber), false);
  assert.throws(
    () => parsePhone(localNumber),
    (err) => err instanceof ServerHttpError && err.status === 400 && err.code === "bad_phone"
  );
});

test("reconciliació: només la versió actual pot esborrar fitxers", () => {
  assert.equal(reconcileVersionMatches(4, 4), true);
  assert.equal(reconcileVersionMatches(3, 4), false);
  assert.equal(reconcileVersionMatches(0, undefined), true);
  assert.equal(reconcileVersionMatches(1, undefined), false);
});

// (f) primers passos

test("onboardingState: cada pas es dedueix del pla i de la configuració; la guia se'n va en acabar o en tancar-la", () => {
  const done = (r) => Object.fromEntries(r.steps.map((s) => [s.id, s.done]));
  const none = { password: true, person: false, item: false, phone: false, deadlines: false, copy: false };

  // Compte acabat de crear: només la contrasenya, i la guia visible.
  const empty = onboardingState({ v: 2, recipients: [], items: [] }, { warnDays: 8, releaseDays: 21, phone: null });
  assert.deepEqual(done(empty), none);
  assert.deepEqual(empty.steps.map((s) => s.id), ["password", "person", "item", "phone", "deadlines", "copy"]);
  assert.deepEqual([empty.allDone, empty.dismissed, empty.visible], [false, false, true]);

  // Cada pas per separat.
  const vault = { v: 2, recipients: [], items: [] };
  assert.equal(done(onboardingState({ ...vault, recipients: [{ id: "p1" }] }, {})).person, true);
  assert.equal(done(onboardingState({ ...vault, items: [{ id: "x" }] }, {})).item, true);
  assert.equal(done(onboardingState(vault, { phone: "+34600000000" })).phone, true);
  assert.equal(done(onboardingState(vault, { phone: "" })).phone, false);
  assert.equal(done(onboardingState({ ...vault, onboarding: { plazosReviewed: 1 } }, {})).deadlines, true);
  assert.equal(done(onboardingState({ ...vault, onboarding: { exportedAt: 1 } }, {})).copy, true);

  // Les sis fetes: desapareix sola.
  const all = onboardingState({ ...vault, recipients: [{ id: "p1" }], items: [{ id: "x" }], onboarding: { plazosReviewed: 1, exportedAt: 2 } }, { phone: "+34600000000" });
  assert.equal(all.allDone, true);
  assert.equal(all.visible, false);

  // Tancada amb la X: no torna a sortir encara que quedin passos.
  const closed = onboardingState({ ...vault, onboarding: { dismissedAt: 5 } }, {});
  assert.deepEqual([closed.allDone, closed.dismissed, closed.visible], [false, true, false]);

  // Pla o configuració encara no carregats: no peta.
  assert.equal(onboardingState(undefined, undefined).visible, true);
});
