// Alta amb verificació de l'email: el Worker sencer (routing, errors, SQL)
// contra una D1 de mentida en memòria i un Resend simulat que captura els
// correus. Sense dependències: node --test (Node 20).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// ---- D1 de mentida: només les sentències que fa servir l'alta ----
function fakeD1(db) {
  function exec(sql, args) {
    if (/^SELECT id FROM users WHERE email = \?$/.test(sql)) return db.users.get(args[0]) ?? null;
    if (/^SELECT kdf_salt FROM users WHERE email = \?$/.test(sql)) return db.users.get(args[0]) ?? null;
    if (/^SELECT sends, created_at FROM pending_signups WHERE email = \?$/.test(sql)) return db.pending.get(args[0]) ?? null;
    if (/^SELECT code_hash, attempts, expires_at FROM pending_signups WHERE email = \?$/.test(sql)) return db.pending.get(args[0]) ?? null;
    if (/^INSERT OR REPLACE INTO pending_signups \(email, code_hash, attempts, sends, expires_at, created_at\) VALUES \(\?, \?, 0, \?, \?, \?\)$/.test(sql)) {
      const [email, code_hash, sends, expires_at, created_at] = args;
      db.pending.set(email, { email, code_hash, attempts: 0, sends, expires_at, created_at });
      return null;
    }
    if (/^UPDATE pending_signups SET attempts = attempts \+ 1 WHERE email = \?$/.test(sql)) {
      const row = db.pending.get(args[0]);
      if (row) row.attempts += 1;
      return null;
    }
    if (/^INSERT INTO users \(id, email, auth_salt, auth_hash, kdf_salt, created_at, last_seen\) VALUES/.test(sql)) {
      const [id, email, auth_salt, auth_hash, kdf_salt, created_at, last_seen] = args;
      if (db.users.has(email)) throw new Error("D1_ERROR: UNIQUE constraint failed: users.email");
      db.users.set(email, { id, email, auth_salt, auth_hash, kdf_salt, created_at, last_seen });
      return null;
    }
    if (/^DELETE FROM pending_signups WHERE email = \?$/.test(sql)) { db.pending.delete(args[0]); return null; }
    throw new Error(`SQL no prevista a la D1 de mentida: ${sql}`);
  }
  return {
    prepare(sql) {
      let args = [];
      const st = {
        bind: (...a) => { args = a; return st; },
        first: async () => exec(sql, args),
        run: async () => { exec(sql, args); return { success: true }; },
        all: async () => ({ results: exec(sql, args) ?? [] }),
      };
      return st;
    },
    async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; },
  };
}

// ---- Resend simulat: captura els correus en comptes d'enviar-los ----
let mails = [];
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://api.resend.com/")) {
    mails.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  }
  throw new Error(`fetch inesperat: ${url}`);
};

let db, env;
beforeEach(() => {
  db = { users: new Map(), pending: new Map() };
  mails = [];
  env = { DB: fakeD1(db), SALT_PEPPER: "pepper de prova", RESEND_API_KEY: "clau de prova", MAIL_FROM: "Custodium <avisos@example.com>", SITE: "https://example.com", ENV: "test" };
});

const post = (path, body) => worker.fetch(new Request(`https://example.com${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), env);
const AUTH_HASH = Buffer.alloc(32, 7).toString("base64");
const lastCode = () => mails.at(-1).text.match(/\b(\d{6})\b/)?.[1];
const start = async (email) => { const r = await post("/api/register/start", { email }); return { status: r.status, data: await r.json() }; };
const register = async (email, code) => { const r = await post("/api/register", { email, authHash: AUTH_HASH, code }); return { status: r.status, data: await r.json() }; };

test("alta: codi correcte → es crea el compte amb la seva kdf_salt i s'esborra el pending", async () => {
  const email = "nou@example.com";
  const saltBefore = await (await worker.fetch(new Request(`https://example.com/api/salt?email=${email}`), env)).json();

  const s = await start(email);
  assert.equal(s.status, 200);
  assert.deepEqual(s.data, { ok: true });
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to[0], email);
  assert.match(mails[0].text, /Tu código para crear la cuenta en Custodium: \d{6}\. Caduca en 15 minutos\. Si no has sido tú, ignora este mensaje\./);
  const code = lastCode();
  const pending = db.pending.get(email);
  assert.ok(pending.code_hash && !pending.code_hash.includes(code), "el codi es guarda hashejat, mai en clar");
  assert.equal(pending.attempts, 0);
  assert.equal(pending.sends, 1);
  assert.equal(db.users.size, 0, "cap compte fins que el codi torna");

  const r = await register(email, code);
  assert.equal(r.status, 201);
  assert.equal(db.users.size, 1);
  assert.equal(db.users.get(email).kdf_salt, saltBefore.salt, "la sal del compte és la que /api/salt ja donava");
  assert.equal(db.pending.has(email), false);
});

test("alta: codi incorrecte → invalid_code, compta l'intent, i el bo encara entra", async () => {
  const email = "nou@example.com";
  await start(email);
  const r = await register(email, lastCode() === "000000" ? "000001" : "000000");
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "invalid_code");
  assert.equal(db.pending.get(email).attempts, 1);
  assert.equal(db.users.size, 0);
  assert.equal((await register(email, lastCode())).status, 201);
});

test("alta: codi caducat → code_expired encara que sigui el bo", async () => {
  const email = "nou@example.com";
  await start(email);
  db.pending.get(email).expires_at = Math.floor(Date.now() / 1000) - 1;
  const r = await register(email, lastCode());
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "code_expired");
  assert.equal(db.users.size, 0);
});

test("alta: cinquè intent fallit → too_many_attempts, i el codi bo ja no serveix fins a demanar-ne un de nou", async () => {
  const email = "nou@example.com";
  await start(email);
  const good = lastCode();
  const bad = good === "000000" ? "000001" : "000000";
  for (let i = 1; i <= 4; i++) {
    const r = await register(email, bad);
    assert.equal(r.data.error, "invalid_code", `intent ${i}`);
  }
  const fifth = await register(email, bad);
  assert.equal(fifth.status, 400);
  assert.equal(fifth.data.error, "too_many_attempts");
  assert.equal((await register(email, good)).data.error, "too_many_attempts", "el codi bo tampoc entra");
  assert.equal(db.users.size, 0);

  // Codi nou: torna a començar amb zero intents.
  await start(email);
  assert.equal(db.pending.get(email).attempts, 0);
  assert.equal((await register(email, lastCode())).status, 201);
});

test("alta: email amb compte → 200 { ok }, correu 'ya tienes cuenta' sense codi, i no es crea res", async () => {
  const email = "titular@example.com";
  db.users.set(email, { id: "u1", email, kdf_salt: "x", auth_salt: "y", auth_hash: "z" });

  const s = await start(email);
  assert.equal(s.status, 200);
  assert.deepEqual(s.data, { ok: true }, "mateixa resposta que per a un email nou");
  assert.equal(mails.length, 1);
  assert.equal(mails[0].text, [
    "Ya existe una cuenta con este correo.",
    "",
    "Si eres tú, entra en https://example.com.",
    "Si has olvidado la contraseña, no hay forma de recuperarla: tu plan sigue cifrado con ella.",
    "Si no has sido tú, ignora este mensaje.",
  ].join("\n"));
  assert.equal(lastCode(), undefined, "cap codi al correu");
  assert.equal(db.pending.get(email).code_hash, null);

  const r = await register(email, "123456");
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "invalid_code");
  assert.equal(db.users.size, 1);
  assert.equal(db.users.get(email).id, "u1", "el compte existent no s'ha tocat");
});

test("alta: límit de tres codis per email i hora, igual amb compte que sense", async () => {
  for (const email of ["nou@example.com", "titular@example.com"]) {
    if (email.startsWith("titular")) db.users.set(email, { id: "u1", email, kdf_salt: "x" });
    for (let i = 1; i <= 3; i++) assert.equal((await start(email)).status, 200, `${email}: codi ${i}`);
    const r = await start(email);
    assert.equal(r.status, 429);
    assert.equal(r.data.error, "too_many_codes");
    assert.equal(db.pending.get(email).sends, 3);
    // Passada l'hora, la finestra es reinicia.
    db.pending.get(email).created_at -= 3601;
    assert.equal((await start(email)).status, 200);
    assert.equal(db.pending.get(email).sends, 1);
  }
});

test("alta: codi mal format o absent → bad_code, sense tocar els intents", async () => {
  const email = "nou@example.com";
  await start(email);
  for (const code of ["12345", "abcdef", "", undefined]) {
    const r = await register(email, code);
    assert.equal(r.status, 400);
    assert.equal(r.data.error, "bad_code");
  }
  assert.equal(db.pending.get(email).attempts, 0);
});
