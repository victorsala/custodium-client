// Alta amb verificació de l'email: el Worker sencer (routing, errors, SQL)
// contra una D1 de mentida en memòria i un Resend simulat que captura els
// correus. Sense dependències: node --test (Node 20).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// ---- D1 de mentida: només les sentències que fan servir l'alta i el canvi de correu ----
function fakeD1(db) {
  const byId = (id) => [...db.users.values()].find((u) => u.id === id) ?? null;
  function exec(sql, args) {
    if (/^SELECT id FROM users WHERE email = \?$/.test(sql)) return db.users.get(args[0]) ?? null;
    if (/^SELECT kdf_salt FROM users WHERE email = \?$/.test(sql)) return db.users.get(args[0]) ?? null;
    if (/^SELECT email FROM users WHERE id = \?$/.test(sql)) return byId(args[0]);
    if (/^SELECT email, auth_salt, auth_hash FROM users WHERE id = \?$/.test(sql)) return byId(args[0]);
    if (/^UPDATE users SET last_seen = \?, warn_count = 0 WHERE id = \?$/.test(sql)) return null;
    if (/^UPDATE users SET email = \? WHERE id = \?$/.test(sql)) {
      const [email, id] = args;
      const u = byId(id);
      if (db.users.has(email)) throw new Error("D1_ERROR: UNIQUE constraint failed: users.email");
      db.users.delete(u.email); u.email = email; db.users.set(email, u);
      return null;
    }
    if (/^SELECT user_id, expires_at FROM sessions WHERE token_hash = \?$/.test(sql)) return db.sessions.get(args[0]) ?? null;
    if (/^UPDATE sessions SET expires_at = \? WHERE token_hash = \?$/.test(sql)) return null;
    if (/^DELETE FROM sessions WHERE user_id = \? AND token_hash != \?$/.test(sql)) {
      for (const [hash, sess] of db.sessions) if (sess.user_id === args[0] && hash !== args[1]) db.sessions.delete(hash);
      return null;
    }
    if (/^INSERT INTO events /.test(sql)) { db.events.push({ user_id: args[0], kind: args[1], detail: args[2] }); return null; }
    if (/^DELETE FROM events /.test(sql)) return null;
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
  db = { users: new Map(), pending: new Map(), sessions: new Map(), events: [] };
  mails = [];
  env = { DB: fakeD1(db), SALT_PEPPER: "pepper de prova", RESEND_API_KEY: "clau de prova", MAIL_FROM: "Custodium <avisos@example.com>", SITE: "https://example.com", MAIL_CONTACT: "avisos@example.com", ENV: "test" };
});

const post = (path, body, token) => worker.fetch(new Request(`https://example.com${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
}), env);
const AUTH_HASH = Buffer.alloc(32, 7).toString("base64");
const sha256 = async (...parts) => new Uint8Array(await crypto.subtle.digest("SHA-256", Buffer.concat(parts.map((p) => Buffer.from(p)))));
// Un titular amb sessió oberta (i una segona sessió en un altre dispositiu),
// amb auth_hash coherent amb AUTH_HASH, com el deixa register.
async function seedOwner(email) {
  const authSalt = Buffer.alloc(16, 3);
  const authHash = await sha256(authSalt, Buffer.from(AUTH_HASH, "base64"));
  db.users.set(email, { id: "u1", email, kdf_salt: "sal-fixada", auth_salt: authSalt.toString("base64"), auth_hash: Buffer.from(authHash).toString("base64") });
  const token = Buffer.alloc(32, 9), other = Buffer.alloc(32, 10);
  const far = Math.floor(Date.now() / 1000) + 3600;
  db.sessions.set(Buffer.from(await sha256(token)).toString("base64"), { user_id: "u1", expires_at: far });
  db.sessions.set(Buffer.from(await sha256(other)).toString("base64"), { user_id: "u1", expires_at: far });
  return token.toString("base64");
}
const startEmail = async (newEmail, token) => { const r = await post("/api/email/start", { newEmail }, token); return { status: r.status, data: await r.json() }; };
const changeEmail = async (newEmail, code, token, authHash = AUTH_HASH) => { const r = await post("/api/email", { authHash, newEmail, code }, token); return { status: r.status, data: await r.json() }; };
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

// ---- canvi de correu ----

test("canvi de correu: codi al correu nou + contrasenya → email nou, altres sessions fora, avís a l'antic, event", async () => {
  const token = await seedOwner("antic@example.com");
  const s = await startEmail("nou@example.com", token);
  assert.equal(s.status, 200);
  assert.deepEqual(s.data, { ok: true });
  assert.equal(mails[0].to[0], "nou@example.com");
  assert.match(mails[0].text, /Tu código para cambiar el correo de Custodium: \d{6}\. Caduca en 15 minutos\. Si no has sido tú, ignora este mensaje\./);
  const code = lastCode();

  const r = await changeEmail("nou@example.com", code, token);
  assert.equal(r.status, 200);
  assert.equal(db.users.has("antic@example.com"), false);
  assert.equal(db.users.get("nou@example.com").id, "u1");
  assert.equal(db.users.get("nou@example.com").kdf_salt, "sal-fixada", "la sal no canvia");
  assert.equal(db.pending.has("nou@example.com"), false);
  assert.equal(db.sessions.size, 1, "només queda la sessió que ha fet el canvi");
  assert.deepEqual(db.events, [{ user_id: "u1", kind: "email_changed", detail: "nou@example.com" }]);
  assert.equal(mails.length, 2);
  assert.equal(mails[1].to[0], "antic@example.com");
  assert.equal(mails[1].text, "Tu correo de Custodium ha pasado a ser nou@example.com. Si no has sido tú, escríbenos a avisos@example.com.");

  // /api/salt del correu nou dóna la sal fixada; la sessió continua viva.
  const salt = await (await worker.fetch(new Request("https://example.com/api/salt?email=nou@example.com"), env)).json();
  assert.equal(salt.salt, "sal-fixada");
  assert.equal((await startEmail("un-altre@example.com", token)).status, 200);
});

test("canvi de correu: contrasenya incorrecta → 401 sense gastar cap intent; codi incorrecte → invalid_code", async () => {
  const token = await seedOwner("antic@example.com");
  await startEmail("nou@example.com", token);
  const bad = await changeEmail("nou@example.com", lastCode(), token, Buffer.alloc(32, 8).toString("base64"));
  assert.equal(bad.status, 401);
  assert.equal(bad.data.error, "invalid_credentials");
  assert.equal(db.pending.get("nou@example.com").attempts, 0);

  const wrong = await changeEmail("nou@example.com", lastCode() === "000000" ? "000001" : "000000", token);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.data.error, "invalid_code");
  assert.equal(db.pending.get("nou@example.com").attempts, 1);
  assert.ok(db.users.has("antic@example.com"), "res no ha canviat");
  assert.equal(db.sessions.size, 2);
  assert.equal(mails.length, 1, "cap avís a l'antic");
});

test("canvi de correu: el correu nou ja té compte → 'ya tienes cuenta' al nou, i el canvi respon com un codi dolent", async () => {
  const token = await seedOwner("antic@example.com");
  db.users.set("ocupat@example.com", { id: "u2", email: "ocupat@example.com", kdf_salt: "x" });

  const s = await startEmail("ocupat@example.com", token);
  assert.equal(s.status, 200);
  assert.deepEqual(s.data, { ok: true }, "mateixa resposta que per a un correu lliure");
  assert.equal(mails[0].to[0], "ocupat@example.com");
  assert.match(mails[0].text, /^Ya existe una cuenta con este correo\./);
  assert.equal(lastCode(), undefined);

  const r = await changeEmail("ocupat@example.com", "123456", token);
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "invalid_code");
  assert.equal(db.users.get("antic@example.com").id, "u1");
  assert.equal(db.users.get("ocupat@example.com").id, "u2");

  // Compte aparegut entre el codi i el canvi: mateixa resposta, i avís al nou.
  await startEmail("lliure@example.com", token);
  const code = lastCode();
  db.users.set("lliure@example.com", { id: "u3", email: "lliure@example.com", kdf_salt: "y" });
  const race = await changeEmail("lliure@example.com", code, token);
  assert.equal(race.data.error, "invalid_code");
  assert.match(mails.at(-1).text, /^Ya existe una cuenta con este correo\./);
  assert.equal(mails.at(-1).to[0], "lliure@example.com");
  assert.equal(db.users.get("antic@example.com").id, "u1");
});

test("canvi de correu: mateix correu → same_email; sense sessió → 401; límit de tres codis", async () => {
  const token = await seedOwner("antic@example.com");
  assert.equal((await startEmail("antic@example.com", token)).data.error, "same_email");
  assert.equal((await startEmail("nou@example.com")).status, 401);
  assert.equal((await changeEmail("nou@example.com", "123456")).status, 401);
  for (let i = 1; i <= 3; i++) assert.equal((await startEmail("nou@example.com", token)).status, 200);
  assert.equal((await startEmail("nou@example.com", token)).status, 429);
});
