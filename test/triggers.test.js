// Cicle sencer d'avisos, entrega, notícies al titular i recordatoris a les
// persones (README §2.6), amb rellotge simulat (Date.now) i el Worker sencer
// (scheduled i fetch) contra una D1 de mentida en memòria i Resend/SMS
// simulats. Sense dependències: node --test (Node 20).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const DAY = 86400, HOUR = 3600;
const CRON = "0 8,20 * * *";
const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";

// ---- rellotge simulat: el Worker llegeix Date.now ----
const realNow = Date.now;
let T = 0;
afterEach(() => { Date.now = realNow; });

// ---- D1 de mentida: les sentències del cron, del check-in, de l'obertura, de l'anul·lació i dels terminis ----
function fakeD1(db) {
  const user = (id) => db.users.find((u) => u.id === id) ?? null;
  const rec = (id) => db.recipients.find((r) => r.id === id) ?? null;
  function exec(raw, args) {
    const sql = raw.replace(/\s+/g, " ").trim();
    // cron
    if (sql === "SELECT value FROM system WHERE key = 'pause_releases'") return { value: db.pause };
    if (sql === "SELECT id, email, phone, last_seen, warned_at, warn_count, warn_days, release_days, warn_sms_at FROM users") return db.users.map((u) => ({ ...u }));
    if (sql === "SELECT id, email, phone, released_at, release_mode, reminder_count, opened_at FROM recipients WHERE user_id = ? AND package IS NOT NULL ORDER BY created_at") {
      return db.recipients.filter((r) => r.user_id === args[0] && r.package).map((r) => ({ ...r }));
    }
    if (sql === "INSERT INTO release_tokens (token_hash, recipient_id, created_at, expires_at) VALUES (?, ?, ?, ?)") {
      const [token_hash, recipient_id, created_at, expires_at] = args;
      db.releaseTokens.push({ token_hash, recipient_id, created_at, expires_at });
      return null;
    }
    if (sql === "UPDATE recipients SET released_at = ?, release_mode = ?, reminder_count = 0, opened_at = NULL, revoked_at = NULL, owner_notified_at = ?, updated_at = ? WHERE id = ?") {
      const [released_at, release_mode, owner_notified_at, updated_at, id] = args;
      Object.assign(rec(id), { released_at, release_mode, reminder_count: 0, opened_at: null, revoked_at: null, owner_notified_at, updated_at });
      return null;
    }
    if (sql === "UPDATE recipients SET owner_notified_at = ? WHERE id = ?") { rec(args[1]).owner_notified_at = args[0]; return null; }
    if (sql === "UPDATE users SET warn_sms_at = ? WHERE id = ?") { user(args[1]).warn_sms_at = args[0]; return null; }
    if (sql === "UPDATE recipients SET reminder_count = reminder_count + 1, updated_at = ? WHERE id = ?") {
      const r = rec(args[1]); r.reminder_count += 1; r.updated_at = args[0];
      return null;
    }
    if (sql === "INSERT INTO checkin_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)") {
      const [token_hash, user_id, created_at, expires_at] = args;
      db.checkinTokens.push({ token_hash, user_id, created_at, expires_at });
      return null;
    }
    if (sql === "UPDATE users SET warned_at = ?, warn_count = warn_count + 1 WHERE id = ?") {
      const u = user(args[1]); u.warned_at = args[0]; u.warn_count += 1;
      return null;
    }
    if (sql === "DELETE FROM checkin_tokens WHERE expires_at < ?") { db.checkinTokens = db.checkinTokens.filter((t) => t.expires_at >= args[0]); return null; }
    if (sql === "DELETE FROM release_tokens WHERE expires_at < ?") { db.releaseTokens = db.releaseTokens.filter((t) => t.expires_at >= args[0]); return null; }
    if (sql.startsWith("DELETE FROM pending_signups WHERE expires_at < ?")) return null;
    // registre d'activitat
    if (sql.startsWith("INSERT INTO events ")) { db.events.push({ user_id: args[0], kind: args[1], detail: args[2], created_at: args[4] }); return null; }
    if (sql.startsWith("DELETE FROM events ")) return null;
    // botó "Sigo aquí"
    if (sql === "SELECT u.id FROM checkin_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.expires_at > ? AND t.created_at > COALESCE(u.last_seen, 0)") {
      const t = db.checkinTokens.find((x) => x.token_hash === args[0] && x.expires_at > args[1] && x.created_at > (user(x.user_id).last_seen ?? 0));
      return t ? { id: t.user_id } : null;
    }
    if (sql === "UPDATE users SET last_seen = ?, warned_at = NULL, warn_count = 0 WHERE id = ?") {
      Object.assign(user(args[1]), { last_seen: args[0], warned_at: null, warn_count: 0 });
      return null;
    }
    // obertura d'un enllaç
    if (sql === "SELECT r.id, r.user_id, r.email, r.package, r.file_ids, r.opened_at, u.email AS owner_email FROM release_tokens t JOIN recipients r ON r.id = t.recipient_id JOIN users u ON u.id = r.user_id WHERE t.token_hash = ? AND t.expires_at > ? AND r.released_at IS NOT NULL") {
      const t = db.releaseTokens.find((x) => x.token_hash === args[0] && x.expires_at > args[1]);
      const r = t && rec(t.recipient_id);
      if (!r || !r.released_at) return null;
      return { id: r.id, user_id: r.user_id, email: r.email, package: r.package, file_ids: r.file_ids, opened_at: r.opened_at, owner_email: user(r.user_id).email };
    }
    if (sql === "UPDATE recipients SET opened_at = ? WHERE id = ?") { rec(args[1]).opened_at = args[0]; return null; }
    // sessió (authenticate) i anul·lació
    if (sql === "SELECT user_id, expires_at FROM sessions WHERE token_hash = ?") return db.sessions.get(args[0]) ?? null;
    if (sql === "UPDATE sessions SET expires_at = ? WHERE token_hash = ?") return null;
    if (sql === "UPDATE users SET last_seen = ?, warn_count = 0 WHERE id = ?") { Object.assign(user(args[1]), { last_seen: args[0], warn_count: 0 }); return null; }
    if (sql === "SELECT email FROM recipients WHERE id = ? AND user_id = ?") { const r = rec(args[0]); return r && r.user_id === args[1] ? { email: r.email } : null; }
    if (sql === "DELETE FROM release_tokens WHERE recipient_id = ?") { db.releaseTokens = db.releaseTokens.filter((t) => t.recipient_id !== args[0]); return null; }
    if (sql === "UPDATE recipients SET released_at = NULL, release_mode = NULL, reminder_count = 0, opened_at = NULL, revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ?") {
      Object.assign(rec(args[2]), { released_at: null, release_mode: null, reminder_count: 0, opened_at: null, revoked_at: args[0], updated_at: args[1] });
      return null;
    }
    // terminis
    if (sql === "SELECT warn_days, release_days, phone FROM users WHERE id = ?") { const u = user(args[0]); return { warn_days: u.warn_days, release_days: u.release_days, phone: u.phone }; }
    if (sql === "UPDATE users SET warn_days = ?, release_days = ?, phone = ? WHERE id = ?") { Object.assign(user(args[3]), { warn_days: args[0], release_days: args[1], phone: args[2] }); return null; }
    // llista de persones (estat a Personas)
    if (sql.startsWith("SELECT r.id, r.email, r.released_at, r.opened_at, r.revoked_at, r.reminder_count,")) {
      return db.recipients.filter((r) => r.user_id === args[0]).map((r) => ({
        ...r, token_expires_at: db.releaseTokens.filter((t) => t.recipient_id === r.id).reduce((m, t) => Math.max(m, t.expires_at), 0) || null,
      }));
    }
    throw new Error(`SQL no prevista a la D1 de mentida: ${sql}`);
  }
  return {
    prepare(sql) {
      let args = [];
      const st = {
        bind: (...a) => { args = a; return st; },
        first: async () => exec(sql, args),
        run: async () => { exec(sql, args); return { success: true, meta: { changes: 1 } }; },
        all: async () => ({ results: exec(sql, args) ?? [] }),
      };
      return st;
    },
    async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; },
  };
}

// ---- Resend i SMS simulats: capturen en comptes d'enviar; rejectMailTo fa que Resend rebutgi ----
let mails = [], sms = [], rejectMailTo = new Set();
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://api.resend.com/")) {
    const m = JSON.parse(init.body);
    if (rejectMailTo.has(m.to[0])) return new Response("rebutjat", { status: 500 });
    mails.push(m);
    return new Response("{}", { status: 200 });
  }
  if (u.startsWith("https://www.siptraffic.com/")) {
    sms.push(Object.fromEntries(new URL(u).searchParams));
    return new Response("OK", { status: 200 });
  }
  throw new Error(`fetch inesperat: ${u}`);
};

let db, env;
beforeEach(() => {
  T = 1_800_000_000;
  Date.now = () => T * 1000;
  mails = []; sms = []; rejectMailTo = new Set();
  db = { pause: "0", users: [], recipients: [], releaseTokens: [], checkinTokens: [], events: [], sessions: new Map() };
  env = {
    DB: fakeD1(db), RESEND_API_KEY: "clau de prova", MAIL_FROM: "Custodium <avisos@example.com>", SITE: "https://example.com", ENV: "test",
    SMS_USER: "u", SMS_PASS: "p", SMS_FROM: "Custodium",
  };
});

// Titular vist ara mateix, amb mòbil; terminis de prova.
function owner({ warn = 1, release = 4, phone = "+34600000001" } = {}) {
  db.users.push({ id: "u1", email: "titular@example.com", phone, last_seen: T, warned_at: null, warn_count: 0, warn_days: warn, release_days: release, warn_sms_at: null });
  return db.users[0];
}
function person(id, email, phone = null) {
  db.recipients.push({
    id, user_id: "u1", email, phone, package: "{\"v\":1}", file_ids: "[]",
    released_at: null, release_mode: null, reminder_count: 0, opened_at: null, revoked_at: null, owner_notified_at: null, created_at: T, updated_at: T,
  });
  return db.recipients.at(-1);
}
async function seedSession() {
  const token = Buffer.alloc(32, 9);
  const hash = Buffer.from(await crypto.subtle.digest("SHA-256", token)).toString("base64");
  db.sessions.set(hash, { user_id: "u1", expires_at: T + 10 * DAY });
  return token.toString("base64");
}
// Una execució del cron, tal com la dispara Cloudflare.
async function cron() {
  const tasks = [];
  await worker.scheduled({ cron: CRON }, env, { waitUntil: (p) => tasks.push(p) });
  await Promise.all(tasks);
}
// Avança fins a l'execució següent (cada 12 h) i la fa.
async function tick(hours = 12) { T += hours * HOUR; await cron(); }
const linkIn = (mail, page) => mail.text.match(new RegExp(`${page.replace(/\\./g, "\\\\.")}\\?t=([A-Za-z0-9_-]+)`))?.[1];
const to = (email) => mails.filter((m) => m.to[0] === email);
const byKind = (kind) => db.events.filter((e) => e.kind === kind);
const post = (path, body, token) => worker.fetch(new Request(`https://example.com${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
}), env);
const get = (path, token) => worker.fetch(new Request(`https://example.com${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), env);

test("avisos: cap abans de warn_days; després un a cada execució, amb SMS com a màxim un al dia", async () => {
  const u = owner({ warn: 1, release: 4 });
  const a = person(R1, "a@example.com");
  await tick(12);                                   // 0,5 dies
  assert.equal(mails.length, 0);
  await tick(12);                                   // 1 dia: primer avís, amb SMS
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to[0], u.email);
  assert.match(mails[0].subject, /sigues ahí/);
  assert.match(mails[0].text, /desde hace un día/);
  assert.match(mails[0].text, /a partir del/);
  assert.equal(sms.length, 1);
  assert.equal(u.warn_count, 1);
  await tick(12);                                   // 1,5 dies: segon avís, sense SMS (fa 12 h)
  assert.equal(mails.length, 2);
  assert.equal(sms.length, 1);
  await tick(12);                                   // 2 dies: tercer avís, amb SMS (fa 24 h)
  assert.equal(mails.length, 3);
  assert.equal(sms.length, 2);
  assert.match(mails[2].text, /desde hace 2 días/);
  assert.equal(byKind("warning_sent").length, 3);
  assert.equal(db.checkinTokens.length, 3, "cada avís porta el seu botó");
  assert.equal(a.released_at, null, "abans de release_days no s'entrega res");
});

test("entrega: a la primera execució ≥ release_days, a totes les persones pendents, amb notícia al titular i sense «¿sigues ahí?»", async () => {
  const u = owner({ warn: 1, release: 4 });
  const a = person(R1, "a@example.com", "+34600000002");
  const b = person(R2, "b@example.com");
  for (let i = 0; i < 7; i++) await tick(12);       // fins a 3,5 dies: sis avisos
  assert.equal(byKind("warning_sent").length, 6);
  assert.equal(a.released_at, null);
  mails = []; sms = [];
  await tick(12);                                   // 4 dies
  assert.equal(a.released_at, T);
  assert.equal(b.released_at, T);
  assert.equal(a.release_mode, "auto");
  assert.equal(mails.length, 3, "un correu per persona i la notícia al titular, res més");
  assert.match(to(a.email)[0].text, /Ha pasado el plazo que fijó/);
  assert.match(to(u.email)[0].subject, /se ha entregado tu plan/);
  assert.match(to(u.email)[0].text, /a@example\.com[\s\S]*b@example\.com/);
  assert.equal(sms.filter((x) => x.to === a.phone).length, 1, "SMS a la persona amb mòbil");
  assert.equal(sms.filter((x) => x.to === u.phone).length, 1, "SMS al titular amb la notícia (l'últim va ser fa un dia)");
  assert.equal(byKind("release_auto").length, 2);
  assert.equal(db.releaseTokens.length, 2);
});

test("sense dos avisos entregats no s'entrega: un avís que Resend rebutja no compta i es torna a provar", async () => {
  const u = owner({ warn: 1, release: 4 });
  const a = person(R1, "a@example.com");
  rejectMailTo.add(u.email);
  for (let i = 0; i < 8; i++) await tick(12);       // 4 dies sense cap avís entregat
  assert.equal(u.warn_count, 0);
  assert.equal(db.checkinTokens.length, 0);
  assert.equal(sms.length, 0, "sense correu no hi ha SMS");
  assert.equal(a.released_at, null);
  rejectMailTo.clear();
  await tick(12);
  assert.equal(u.warn_count, 1);
  assert.equal(a.released_at, null);
  await tick(12);
  assert.equal(u.warn_count, 2);
  assert.equal(a.released_at, null);
  await tick(12);
  assert.equal(a.released_at, T, "amb dos avisos entregats, entrega");
});

test("«Sigo aquí»: val el botó de qualsevol avís del període; després cap botó anterior val i es torna a començar", async () => {
  const u = owner({ warn: 1, release: 4 });
  person(R1, "a@example.com");
  await tick(24); await tick(12); await tick(12);   // tres avisos
  T += HOUR;
  const r = await post("/api/checkin", { token: linkIn(mails[0], "/aqui.html") });
  assert.equal(r.status, 200, "el botó del primer avís encara serveix");
  assert.equal(u.last_seen, T);
  assert.equal(u.warn_count, 0);
  assert.equal(byKind("checkin").length, 1);
  const again = await post("/api/checkin", { token: linkIn(mails[2], "/aqui.html") });
  assert.equal(again.status, 404, "després d'una senyal de vida, cap botó anterior val");
  mails = [];
  await tick(12);
  assert.equal(mails.length, 0, "el comptador ha tornat a començar");
  await tick(12);
  assert.equal(mails.length, 1);
});

test("després de l'entrega: notícia al titular a cada execució durant 5 dies (SMS un al dia) i recordatoris a la persona a les dates fixades, cadascun amb enllaç nou i tots vàlids", async () => {
  const u = owner({ warn: 1, release: 4 });
  const a = person(R1, "a@example.com");
  for (let i = 0; i < 8; i++) await tick(12);       // dia 4: entrega
  const released = T;
  assert.equal(a.released_at, released);
  const firstLink = linkIn(to(a.email)[0], "/abrir.html");
  mails = []; sms = [];

  for (let i = 0; i < 30; i++) await tick(12);      // fins a 15 dies després de l'entrega
  // (la primera notícia i el primer SMS van sortir a l'execució de l'entrega, ja buidats)
  assert.equal(to(u.email).length, 9, "notícia a cada execució durant cinc dies");
  assert.ok(to(u.email).every((m) => /se ha entregado tu plan/.test(m.subject)));
  assert.equal(sms.filter((x) => x.to === u.phone).length, 4, "SMS al titular: un al dia durant els cinc dies");
  assert.equal(to(a.email).length, 6, "recordatoris als dies 1, 2, 4, 7, 10 i 15");
  assert.equal(a.reminder_count, 6);
  assert.deepEqual(byKind("reminder_sent").map((e) => (e.created_at - released) / DAY), [1, 2, 4, 7, 10, 15]);
  assert.match(to(a.email)[0].text, /Hace un día te avisamos/);
  assert.match(to(a.email)[1].text, /Hace 2 días te avisamos/);

  const links = [firstLink, ...to(a.email).map((m) => linkIn(m, "/abrir.html"))];
  assert.equal(new Set(links).size, 7, "cada correu porta un enllaç diferent");
  assert.equal(db.releaseTokens.length, 7);
  assert.equal((await get(`/api/release/${links[0]}`)).status, 200, "el primer enllaç continua obrint");
  assert.equal((await get(`/api/release/${links[6]}`)).status, 200, "l'últim també");
  assert.equal(byKind("release_opened").length, 1, "només la primera obertura queda registrada");

  const session = await seedSession();
  const list = await (await get("/api/recipients", session)).json();
  assert.equal(list.recipients[0].reminders, 6);
  assert.equal(list.recipients[0].expiresAt, db.releaseTokens.at(-1).expires_at, "la caducitat és la de l'últim enllaç enviat");
  db.users[0].last_seen = released - DAY; // (la consulta anterior ha comptat com a senyal de vida; ho desfem per veure només l'efecte d'obrir)

  mails = [];
  for (let i = 0; i < 12; i++) await tick(12);      // fins al dia 21 després de l'entrega
  assert.equal(mails.length, 0, "oberta: cap recordatori més; les notícies van acabar al cinquè dia");
});

test("si el titular entra després de l'entrega s'aturen notícies i recordatoris; els enllaços valen fins que els anul·la", async () => {
  const u = owner({ warn: 1, release: 4 });
  const a = person(R1, "a@example.com");
  for (let i = 0; i < 8; i++) await tick(12);       // entrega
  const link = linkIn(to(a.email)[0], "/abrir.html");
  T += HOUR;
  Object.assign(u, { last_seen: T, warn_count: 0 }); // entra
  mails = []; sms = [];
  for (let i = 0; i < 10; i++) await tick(12);
  assert.equal(mails.length, 0);
  assert.equal(sms.length, 0);
  assert.equal((await get(`/api/release/${link}`)).status, 200, "l'enllaç entregat continua valent");

  const session = await seedSession();
  assert.equal((await post(`/api/recipients/${R1}/revoke`, {}, session)).status, 200);
  assert.equal(a.released_at, null);
  assert.equal(db.releaseTokens.length, 0);
  assert.equal((await get(`/api/release/${link}`)).status, 404, "anul·lat: cap enllaç obre");
  assert.equal(byKind("release_revoked").length, 1);
});

test("pause_releases: el cron continua avisant però no entrega; en treure la pausa, entrega", async () => {
  owner({ warn: 1, release: 4 });
  const a = person(R1, "a@example.com");
  db.pause = "1";
  for (let i = 0; i < 10; i++) await tick(12);      // fins a 5 dies
  assert.equal(a.released_at, null);
  assert.equal(byKind("warning_sent").length, 9, "un avís a cada execució des del dia 1");
  db.pause = "0";
  await tick(12);
  assert.equal(a.released_at, T);
});

test("una entrega que Resend rebutja es reintenta a l'execució següent; un recordatori rebutjat compta, queda a Actividad i no deixa cap enllaç", async () => {
  owner({ warn: 1, release: 4 });
  const a = person(R1, "a@example.com");
  const b = person(R2, "b@example.com");
  rejectMailTo.add(b.email);
  for (let i = 0; i < 8; i++) await tick(12);       // entrega: a sí, b no
  assert.equal(a.released_at, T);
  assert.equal(b.released_at, null);
  assert.equal(byKind("release_auto").length, 1);
  rejectMailTo.clear();
  await tick(12);                                   // reintent: b
  assert.equal(b.released_at, T);
  assert.equal(byKind("release_auto").length, 2);

  rejectMailTo.add(a.email);
  await tick(12);                                   // un dia després de l'entrega d'a: primer recordatori, rebutjat
  assert.equal(a.reminder_count, 1);
  assert.deepEqual(byKind("reminder_failed").map((e) => e.detail), [a.email]);
  assert.equal(db.releaseTokens.filter((t) => t.recipient_id === a.id).length, 1, "cap enllaç nou per a un correu que no ha sortit");
  rejectMailTo.clear();
  await tick(24);                                   // dos dies després: segon recordatori, aquest sí
  assert.equal(a.reminder_count, 2);
  assert.equal(byKind("reminder_sent").filter((e) => e.detail === a.email).length, 1);
  assert.equal(db.releaseTokens.filter((t) => t.recipient_id === a.id).length, 2);
});

test("terminis: l'entrega ha de ser com a mínim tres dies després del primer avís", async () => {
  owner();
  const session = await seedSession();
  const put = async (body) => (await worker.fetch(new Request("https://example.com/api/settings", {
    method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${session}` }, body: JSON.stringify(body),
  }), env)).status;
  assert.equal(await put({ warnDays: 1, releaseDays: 3 }), 400);
  assert.equal(await put({ warnDays: 8, releaseDays: 10 }), 400);
  assert.equal(await put({ warnDays: 1, releaseDays: 4 }), 200);
  assert.equal(await put({ warnDays: 8, releaseDays: 21 }), 200);
});
