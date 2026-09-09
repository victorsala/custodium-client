// Custodium B2C · API · v3
//
// El servidor autentica, guarda blobs xifrats i, quan toca, envia enllaços.
// No veu mai contrasenyes, frases, contingut ni fitxers en clar.
//
//   POST   /api/register              { email, authHash }      → 201 | 409
//   POST   /api/login                 { email, authHash }      → { token, expiresAt } | 401
//   DELETE /api/session               Bearer                   → { ok }
//   POST   /api/password              { authHash, newAuthHash, blob, version } → { token, version } | 401 | 409
//   DELETE /api/account               { authHash }             → { ok } | 401  esborra R2 (i backup) i tot D1
//   GET    /api/vault                 Bearer                   → { blob, version, updatedAt } | 404
//   PUT    /api/vault                 { blob, version }        → { version } | 409
//   PUT    /api/files/:id             bytes xifrats            → 201 | 409 | 413 | 507
//   GET    /api/files/:id             Bearer                   → bytes | 404
//   DELETE /api/files/:id             Bearer                   → { ok }
//   POST   /api/files/reconcile       { ids, version }         → { deleted } | 409  esborra orfes de >7 dies no inclosos a ids
//   GET    /api/settings              Bearer                   → { warnDays, releaseDays, phone, lastSeen }
//   PUT    /api/settings              { warnDays?, releaseDays?, phone? } → { ok }
//   GET    /api/recipients            Bearer                   → { recipients: [ { id, email, releasedAt, openedAt, expiresAt } ] }
//   PUT    /api/recipients/:id        { email, phone?, package, fileIds } → { ok }
//   DELETE /api/recipients/:id        Bearer                   → { ok }
//   POST   /api/recipients/:id/release  Bearer                 → { ok }   (entrega ara: envia l'enllaç)
//   POST   /api/recipients/:id/revoke   Bearer                 → { ok }   (anul·la l'enllaç)
//   POST   /api/checkin               { token }                → { ok }   (botó "Sigo aquí" del correu)
//   GET    /api/release/:token        —                        → { from, email, package } | 404
//   GET    /api/release/:token/files/:id  —                    → bytes | 404
//
// Cron diari (scheduled): avisa el titular a partir de warn_days sense entrar,
// cada 3 dies; entrega a totes les persones a partir de release_days si s'han
// enviat almenys dos avisos des de l'última activitat. Amb pause_releases='1'
// a la taula system (D1) continua avisant però no entrega res.
//
// Avisos i entregues envien primer i desen després: si Resend no accepta el
// correu no es desa res, i el cron ho torna a provar l'endemà. Així un correu
// perdut no consumeix un avís ni marca una entrega que no ha sortit.

const TOKEN_TTL_S = 24 * 3600;            // sessió: 24 h, renovada a cada petició autenticada
const RELEASE_TTL_S = 90 * 24 * 3600;     // enllaç d'obertura: 90 dies
const WARN_REPEAT_S = 3 * 24 * 3600;      // reavís cada 3 dies
const MIN_WARNINGS_BEFORE_RELEASE = 2;    // avisos entregats abans d'una entrega automàtica
const MAX_BODY_BYTES = 1_000_000;
const MAX_FILE_BYTES = 50_000_000;       // 50 MB per fitxer (escàners notarials llargs)
const MAX_USER_BYTES = 1_000_000_000;    // 1 GB per titular
const MAX_FILE_IDS = 500;
const MAX_RECIPIENTS = 20;

const SITE = "https://b2c.custodium.space";
const MAIL_FROM = "Custodium <avisos@custodium.space>";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;    // format internacional, p. ex. +34600000000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (!pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });

    try {
      if (pathname === "/api/register" && method === "POST") return await register(request, env);
      if (pathname === "/api/login"    && method === "POST") return await login(request, env);
      if (pathname === "/api/session"  && method === "DELETE") return await logout(request, env);
      if (pathname === "/api/sessions" && method === "DELETE") return await closeOtherSessions(request, env);
      if (pathname === "/api/account"  && method === "DELETE") return await deleteAccount(request, env);
      if (pathname === "/api/password" && method === "POST") return await changePassword(request, env);
      if (pathname === "/api/vault"    && method === "GET") return await getVault(request, env);
      if (pathname === "/api/vault"    && method === "PUT") return await putVault(request, env);
      if (pathname === "/api/events"   && method === "GET") return await listEvents(request, env);
      if (pathname === "/api/settings" && method === "GET") return await getSettings(request, env);
      if (pathname === "/api/settings" && method === "PUT") return await putSettings(request, env);
      if (pathname === "/api/recipients" && method === "GET") return await listRecipients(request, env);
      if (pathname === "/api/checkin"  && method === "POST") return await checkin(request, env);

      if (pathname === "/api/files/reconcile" && method === "POST") return await reconcileFiles(request, env);

      let m;
      if ((m = pathname.match(/^\/api\/files\/([^/]+)$/))) {
        const id = uuid(m[1]);
        if (method === "PUT") return await putFile(request, env, id);
        if (method === "GET") return await getFile(request, env, id);
        if (method === "DELETE") return await deleteFile(request, env, id);
      }
      if ((m = pathname.match(/^\/api\/recipients\/([^/]+)$/))) {
        const id = uuid(m[1]);
        if (method === "PUT") return await putRecipient(request, env, id);
        if (method === "DELETE") return await deleteRecipient(request, env, id);
      }
      if ((m = pathname.match(/^\/api\/recipients\/([^/]+)\/(release|revoke)$/)) && method === "POST") {
        const id = uuid(m[1]);
        return m[2] === "release" ? await releaseNow(request, env, id) : await revokeRelease(request, env, id);
      }
      if ((m = pathname.match(/^\/api\/release\/([^/]+)$/)) && method === "GET") {
        return await openRelease(request, env, m[1]);
      }
      if ((m = pathname.match(/^\/api\/release\/([^/]+)\/files\/([^/]+)$/)) && method === "GET") {
        return await openReleaseFile(env, m[1], uuid(m[2]));
      }

      throw new HttpError(404, "not_found");
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.code, ...err.extra }, err.status);
      console.error(err);
      return json({ error: "server_error" }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    // Cada cron té la seva feina, explícita: un cron nou no fa res fins que
    // no se li assigni aquí. Així una prova no pot disparar còpies per accident.
    if (event.cron === "0 8 * * *") ctx.waitUntil(runTriggers(env));
    else if (event.cron === "0 3 * * SUN") ctx.waitUntil(backupFiles(env));
    else console.log(`cron desconegut, no es fa res: ${event.cron}`);
  },
};

// ---------------------------------------------------------------- auth

async function register(request, env) {
  const { email, authHash } = parseCredentials(await readJson(request));
  const salt = randomBytes(16);
  const hash = await sha256(salt, authHash);
  const ts = now();

  try {
    await env.DB
      .prepare("INSERT INTO users (id, email, auth_salt, auth_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), email, b64.encode(salt), b64.encode(hash), ts, ts)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "email_exists");
    throw err;
  }
  return json({ ok: true }, 201);
}

async function login(request, env) {
  const { email, authHash } = parseCredentials(await readJson(request));
  const user = await env.DB.prepare("SELECT id, auth_salt, auth_hash FROM users WHERE email = ?").bind(email).first();

  // Es calcula igualment quan l'usuari no existeix, per no delatar-ho pel temps.
  const salt = user ? b64.decode(user.auth_salt) : randomBytes(16);
  const stored = user ? b64.decode(user.auth_hash) : randomBytes(32);
  const computed = await sha256(salt, authHash);
  if (!user || !timingSafeEqual(computed, stored)) {
    // Només si l'email existeix: registrar intents contra emails desconeguts
    // no aporta res al titular i faria d'oracle d'existència.
    if (user) await logEvent(env, user.id, "login_failed", null, request);
    throw new HttpError(401, "invalid_credentials");
  }

  const token = randomBytes(32);
  const tokenHash = b64.encode(await sha256(token));
  const ts = now();

  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at < ?").bind(user.id, ts),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, user.id, ts + TOKEN_TTL_S),
    env.DB.prepare("UPDATE users SET last_seen = ?, warned_at = NULL, warn_count = 0, checkin_token_hash = NULL, checkin_expires_at = NULL WHERE id = ?").bind(ts, user.id),
  ]);
  await logEvent(env, user.id, "login", null, request);

  return json({ token: b64.encode(token), expiresAt: ts + TOKEN_TTL_S });
}

async function logout(request, env) {
  const { tokenHash } = await authenticate(request, env);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  return json({ ok: true });
}

// Tanca totes les sessions del titular menys la d'aquest dispositiu.
async function closeOtherSessions(request, env) {
  const { userId, tokenHash } = await authenticate(request, env);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").bind(userId, tokenHash).run();
  await logEvent(env, userId, "sessions_closed", null, request);
  return json({ ok: true });
}

// Esborrat del compte: es verifica la contrasenya com al canvi de contrasenya.
// Primer els fitxers de R2 (bucket principal i còpia: és l'única operació que
// esborra del backup) i després tot D1 en un sol batch.
async function deleteAccount(request, env) {
  const { userId } = await authenticate(request, env);
  const body = await readJson(request);
  const current = typeof body?.authHash === "string" ? b64.decode(body.authHash) : null;
  if (!current || current.length !== 32) throw new HttpError(400, "bad_auth_hash");

  const user = await env.DB.prepare("SELECT auth_salt, auth_hash FROM users WHERE id = ?").bind(userId).first();
  const computed = await sha256(b64.decode(user.auth_salt), current);
  if (!timingSafeEqual(computed, b64.decode(user.auth_hash))) throw new HttpError(401, "invalid_credentials");

  for (const bucket of [env.FILES, env.FILES_BACKUP]) {
    let cursor;
    do {
      const page = await bucket.list({ prefix: `${userId}/`, cursor });
      if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM recipients WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM files WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM events WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM vaults WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  return json({ ok: true });
}

// Canvi de contrasenya: el client envia l'authHash actual (per verificar), el
// nou, i el pla rexifrat amb la clau nova. Fitxers i paquets no canvien: tenen
// claus pròpies que viuen dins del pla. Totes les sessions cauen; se'n retorna una de nova.
async function changePassword(request, env) {
  const { userId } = await authenticate(request, env);
  const body = await readJson(request);

  const current = typeof body?.authHash === "string" ? b64.decode(body.authHash) : null;
  const next = typeof body?.newAuthHash === "string" ? b64.decode(body.newAuthHash) : null;
  if (!current || current.length !== 32 || !next || next.length !== 32) throw new HttpError(400, "bad_auth_hash");
  const blob = validateBlob(body?.blob);
  const version = body?.version;
  if (!Number.isInteger(version) || version < 0) throw new HttpError(400, "bad_version");

  const user = await env.DB.prepare("SELECT auth_salt, auth_hash FROM users WHERE id = ?").bind(userId).first();
  const computed = await sha256(b64.decode(user.auth_salt), current);
  if (!timingSafeEqual(computed, b64.decode(user.auth_hash))) throw new HttpError(401, "invalid_credentials");

  const vault = await env.DB.prepare("SELECT version FROM vaults WHERE user_id = ?").bind(userId).first();
  if ((vault ? vault.version : 0) !== version) throw new HttpError(409, "version_conflict", { currentVersion: vault ? vault.version : 0 });

  const salt = randomBytes(16);
  const hash = await sha256(salt, next);
  const token = randomBytes(32);
  const tokenHash = b64.encode(await sha256(token));
  const ts = now();
  const newVersion = version + 1;

  await env.DB.batch([
    env.DB.prepare("UPDATE users SET auth_salt = ?, auth_hash = ?, last_seen = ? WHERE id = ?").bind(b64.encode(salt), b64.encode(hash), ts, userId),
    vault
      ? env.DB.prepare("UPDATE vaults SET blob = ?, version = ?, updated_at = ? WHERE user_id = ?").bind(blob, newVersion, ts, userId)
      : env.DB.prepare("INSERT INTO vaults (user_id, blob, version, updated_at) VALUES (?, ?, ?, ?)").bind(userId, blob, newVersion, ts),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(tokenHash, userId, ts + TOKEN_TTL_S),
  ]);
  await logEvent(env, userId, "password_changed", null, request);

  return json({ token: b64.encode(token), expiresAt: ts + TOKEN_TTL_S, version: newVersion });
}

// Cada petició autenticada compta com a senyal de vida, esborra els avisos
// acumulats i renova la sessió: qui obre el pla cada dia no la perd mai.
async function authenticate(request, env) {
  const header = request.headers.get("authorization") || "";
  const raw = header.startsWith("Bearer ") ? b64.decode(header.slice(7).trim()) : null;
  if (!raw || raw.length !== 32) throw new HttpError(401, "unauthorized");

  const tokenHash = b64.encode(await sha256(raw));
  const session = await env.DB.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").bind(tokenHash).first();
  const ts = now();
  if (!session || session.expires_at < ts) throw new HttpError(401, "unauthorized");

  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").bind(ts + TOKEN_TTL_S, tokenHash),
    env.DB.prepare("UPDATE users SET last_seen = ?, warn_count = 0 WHERE id = ?").bind(ts, session.user_id),
  ]);
  return { userId: session.user_id, tokenHash };
}

// Registre d'activitat que el titular pot revisar a "Cuenta". Mai IP ni
// user-agent: només el país de la petició (Cloudflare ja el dona). Els events
// de cron no tenen petició i queden sense país. Un error aquí no ha d'aturar
// mai l'operació que es registra.
async function logEvent(env, userId, kind, detail, request) {
  try {
    // Un sol viatge a D1: l'INSERT i la poda van junts.
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO events (user_id, kind, detail, country, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(userId, kind, detail ?? null, request?.cf?.country ?? null, now()),
      env.DB
        .prepare("DELETE FROM events WHERE user_id = ? AND id NOT IN (SELECT id FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 200)")
        .bind(userId, userId),
    ]);
  } catch (err) {
    console.error("logEvent failed", kind, err);
  }
}

async function listEvents(request, env) {
  const { userId } = await authenticate(request, env);
  const r = await env.DB
    .prepare("SELECT kind, detail, country, created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 50")
    .bind(userId)
    .all();
  return json({ events: r.results.map((e) => ({ kind: e.kind, detail: e.detail, country: e.country, createdAt: e.created_at })) });
}

function parseCredentials(body) {
  const email = parseEmail(body?.email);
  const authHash = typeof body?.authHash === "string" ? b64.decode(body.authHash) : null;
  if (!authHash || authHash.length !== 32) throw new HttpError(400, "bad_auth_hash");
  return { email, authHash };
}

function parseEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, "bad_email");
  return email;
}

// ---------------------------------------------------------------- vault

async function getVault(request, env) {
  const { userId } = await authenticate(request, env);
  const row = await env.DB.prepare("SELECT blob, version, updated_at FROM vaults WHERE user_id = ?").bind(userId).first();
  if (!row) throw new HttpError(404, "no_vault");
  return json({ blob: JSON.parse(row.blob), version: row.version, updatedAt: row.updated_at });
}

async function putVault(request, env) {
  const { userId } = await authenticate(request, env);
  const body = await readJson(request);
  const blob = validateBlob(body?.blob);
  const version = body?.version;
  if (!Number.isInteger(version) || version < 0) throw new HttpError(400, "bad_version");

  const ts = now();
  if (version === 0) {
    try {
      await env.DB.prepare("INSERT INTO vaults (user_id, blob, version, updated_at) VALUES (?, ?, 1, ?)").bind(userId, blob, ts).run();
    } catch (err) {
      if (isUniqueViolation(err)) await vaultConflict(env, userId);
      throw err;
    }
    return json({ version: 1 });
  }

  const res = await env.DB
    .prepare("UPDATE vaults SET blob = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ?")
    .bind(blob, ts, userId, version)
    .run();
  if (res.meta.changes === 0) await vaultConflict(env, userId);
  return json({ version: version + 1 });
}

async function vaultConflict(env, userId) {
  const row = await env.DB.prepare("SELECT version FROM vaults WHERE user_id = ?").bind(userId).first();
  throw new HttpError(409, "version_conflict", { currentVersion: row ? row.version : 0 });
}

// ---------------------------------------------------------------- files

async function putFile(request, env, id) {
  const { userId } = await authenticate(request, env);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large");

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) throw new HttpError(400, "empty_file");
  if (bytes.byteLength > MAX_FILE_BYTES) throw new HttpError(413, "file_too_large");

  const used = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE user_id = ?").bind(userId).first();
  if (used.total + bytes.byteLength > MAX_USER_BYTES) throw new HttpError(507, "quota_exceeded");

  // El duplicat es comprova abans d'escriure a R2: amb l'ordre invers, un id
  // repetit sobreescriuria (i després esborraria) els bytes del fitxer existent.
  const dup = await env.DB.prepare("SELECT id FROM files WHERE id = ?").bind(id).first();
  if (dup) throw new HttpError(409, "file_exists");

  // Primer R2, després D1: si l'INSERT falla, s'esborra l'objecte i no queda
  // cap fila fantasma comptant per la quota.
  await env.FILES.put(`${userId}/${id}`, bytes);
  try {
    await env.DB.prepare("INSERT INTO files (id, user_id, size, created_at) VALUES (?, ?, ?, ?)").bind(id, userId, bytes.byteLength, now()).run();
  } catch (err) {
    await env.FILES.delete(`${userId}/${id}`);
    if (isUniqueViolation(err)) throw new HttpError(409, "file_exists");
    throw err;
  }

  return json({ ok: true, size: bytes.byteLength }, 201);
}

async function getFile(request, env, id) {
  const { userId } = await authenticate(request, env);
  const row = await env.DB.prepare("SELECT id FROM files WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!row) throw new HttpError(404, "no_file");
  return streamFile(env, userId, id);
}

async function deleteFile(request, env, id) {
  const { userId } = await authenticate(request, env);
  const res = await env.DB.prepare("DELETE FROM files WHERE id = ? AND user_id = ?").bind(id, userId).run();
  if (res.meta.changes === 0) throw new HttpError(404, "no_file");
  await env.FILES.delete(`${userId}/${id}`);
  return json({ ok: true });
}

const ORPHAN_AGE_S = 7 * 24 * 3600;

async function reconcileFiles(request, env) {
  const { userId } = await authenticate(request, env);
  const body = await readJson(request);
  const ids = body?.ids;
  const version = body?.version;
  if (!Array.isArray(ids) || ids.length > 5000 || !ids.every((x) => typeof x === "string" && UUID_RE.test(x))) {
    throw new HttpError(400, "bad_ids");
  }
  if (!Number.isInteger(version) || version < 0) throw new HttpError(400, "bad_version");

  // Un dispositiu amb un pla antic no pot decidir quins fitxers ja no s'usen.
  // Sense pla encara desat, la versió implícita és 0, com a putVault.
  const vault = await env.DB.prepare("SELECT version FROM vaults WHERE user_id = ?").bind(userId).first();
  if (!reconcileVersionMatches(version, vault?.version)) {
    throw new HttpError(409, "version_conflict", { currentVersion: vault?.version ?? 0 });
  }

  const live = new Set(ids);
  const old = await env.DB
    .prepare("SELECT id FROM files WHERE user_id = ? AND created_at < ?")
    .bind(userId, now() - ORPHAN_AGE_S)
    .all();
  let deleted = 0;
  for (const row of old.results) {
    if (live.has(row.id)) continue;
    await env.DB.prepare("DELETE FROM files WHERE id = ? AND user_id = ?").bind(row.id, userId).run();
    await env.FILES.delete(`${userId}/${row.id}`);
    deleted++;
  }
  return json({ deleted });
}

function reconcileVersionMatches(requestedVersion, vaultVersion) {
  return requestedVersion === (vaultVersion ?? 0);
}

async function streamFile(env, ownerId, id) {
  const obj = await env.FILES.get(`${ownerId}/${id}`);
  if (!obj) throw new HttpError(404, "no_file");
  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(obj.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

// ------------------------------------------------------------- settings

async function getSettings(request, env) {
  const { userId } = await authenticate(request, env);
  const u = await env.DB.prepare("SELECT warn_days, release_days, phone, last_seen FROM users WHERE id = ?").bind(userId).first();
  return json({ warnDays: u.warn_days, releaseDays: u.release_days, phone: u.phone, lastSeen: u.last_seen });
}

// Accepta qualsevol subconjunt: terminis (des de Personas) o telèfon (des de Cuenta).
async function putSettings(request, env) {
  const { userId } = await authenticate(request, env);
  const body = await readJson(request);
  const u = await env.DB.prepare("SELECT warn_days, release_days, phone FROM users WHERE id = ?").bind(userId).first();

  const warnDays = body?.warnDays ?? u.warn_days;
  const releaseDays = body?.releaseDays ?? u.release_days;
  const phone = "phone" in (body || {}) ? parsePhone(body.phone) : u.phone;
  if (!Number.isInteger(warnDays) || warnDays < 1 || warnDays > 365) throw new HttpError(400, "bad_warn_days");
  if (!Number.isInteger(releaseDays) || releaseDays <= warnDays || releaseDays > 730) throw new HttpError(400, "bad_release_days");

  await env.DB.prepare("UPDATE users SET warn_days = ?, release_days = ?, phone = ? WHERE id = ?").bind(warnDays, releaseDays, phone, userId).run();
  if ("phone" in (body || {})) await logEvent(env, userId, "phone_changed", null, request);
  if (body?.warnDays !== undefined || body?.releaseDays !== undefined) await logEvent(env, userId, "settings_changed", null, request);
  return json({ ok: true });
}

// Cal el prefix internacional ("+" o "00"): sense prefix no es pot endevinar
// el país, i s'enviarien SMS a números inexistents.
function parsePhone(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).replace(/[^\d+]/g, "");
  if (!text.startsWith("+") && !text.startsWith("00")) throw new HttpError(400, "bad_phone");
  let digits = text.replace(/\D/g, "");
  if (text.startsWith("00")) digits = digits.slice(2);
  const phone = "+" + digits;
  if (!PHONE_RE.test(phone)) throw new HttpError(400, "bad_phone");
  return phone;
}

// ----------------------------------------------------------- recipients

async function listRecipients(request, env) {
  const { userId } = await authenticate(request, env);
  const rows = await env.DB
    .prepare("SELECT id, email, released_at, opened_at, token_expires_at, revoked_at FROM recipients WHERE user_id = ? ORDER BY created_at")
    .bind(userId)
    .all();
  return json({
    recipients: rows.results.map((r) => ({
      id: r.id, email: r.email, releasedAt: r.released_at, openedAt: r.opened_at, expiresAt: r.token_expires_at, revokedAt: r.revoked_at,
    })),
  });
}

async function putRecipient(request, env, id) {
  const { userId } = await authenticate(request, env);
  const body = await readJson(request);
  const email = parseEmail(body?.email);
  const phone = parsePhone(body?.phone);
  const pkg = validateBlob(body?.package);
  const fileIds = body?.fileIds;
  if (!Array.isArray(fileIds) || fileIds.length > MAX_FILE_IDS || !fileIds.every((f) => typeof f === "string" && UUID_RE.test(f))) {
    throw new HttpError(400, "bad_file_ids");
  }

  const existing = await env.DB.prepare("SELECT id FROM recipients WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!existing) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM recipients WHERE user_id = ?").bind(userId).first();
    if (count.n >= MAX_RECIPIENTS) throw new HttpError(409, "too_many_recipients");
  }

  const ts = now();
  const res = await env.DB
    .prepare(`INSERT INTO recipients (id, user_id, email, phone, package, file_ids, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET email = excluded.email, phone = excluded.phone, package = excluded.package,
                file_ids = excluded.file_ids, updated_at = excluded.updated_at
              WHERE recipients.user_id = excluded.user_id`)
    .bind(id, userId, email, phone, pkg, JSON.stringify(fileIds), ts, ts)
    .run();
  if (res.meta.changes === 0) throw new HttpError(409, "recipient_conflict");
  return json({ ok: true });
}

async function deleteRecipient(request, env, id) {
  const { userId } = await authenticate(request, env);
  const res = await env.DB.prepare("DELETE FROM recipients WHERE id = ? AND user_id = ?").bind(id, userId).run();
  if (res.meta.changes === 0) throw new HttpError(404, "no_recipient");
  return json({ ok: true });
}

async function releaseNow(request, env, id) {
  const { userId } = await authenticate(request, env);
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(userId).first();
  const rec = await env.DB.prepare("SELECT id, email, phone, package FROM recipients WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!rec) throw new HttpError(404, "no_recipient");
  if (!rec.package) throw new HttpError(409, "no_package");
  await releaseRecipient(env, user, rec, "manual");
  await logEvent(env, userId, "release_manual", rec.email, request);
  return json({ ok: true });
}

async function revokeRelease(request, env, id) {
  const { userId } = await authenticate(request, env);
  const rec = await env.DB.prepare("SELECT email FROM recipients WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!rec) throw new HttpError(404, "no_recipient");
  await env.DB
    .prepare("UPDATE recipients SET released_at = NULL, token_hash = NULL, token_expires_at = NULL, opened_at = NULL, revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(now(), now(), id, userId)
    .run();
  await logEvent(env, userId, "release_revoked", rec.email, request);
  return json({ ok: true });
}

// -------------------------------------------------------- check-in & release

async function checkin(request, env) {
  const body = await readJson(request);
  const raw = typeof body?.token === "string" ? b64.decodeUrl(body.token) : null;
  if (!raw || raw.length !== 32) throw new HttpError(400, "bad_token");

  const hash = b64.encode(await sha256(raw));
  const ts = now();
  const u = await env.DB.prepare("SELECT id FROM users WHERE checkin_token_hash = ? AND checkin_expires_at > ?").bind(hash, ts).first();
  if (!u) throw new HttpError(404, "bad_token");
  await env.DB
    .prepare("UPDATE users SET last_seen = ?, warned_at = NULL, warn_count = 0, checkin_token_hash = NULL, checkin_expires_at = NULL WHERE id = ?")
    .bind(ts, u.id)
    .run();
  await logEvent(env, u.id, "checkin", null, request);
  return json({ ok: true });
}

async function findRelease(env, tokenStr) {
  const raw = b64.decodeUrl(tokenStr);
  if (!raw || raw.length !== 32) throw new HttpError(404, "no_release");
  const hash = b64.encode(await sha256(raw));
  const rec = await env.DB
    .prepare(`SELECT r.id, r.user_id, r.email, r.package, r.file_ids, r.opened_at, u.email AS owner_email
              FROM recipients r JOIN users u ON u.id = r.user_id
              WHERE r.token_hash = ? AND r.released_at IS NOT NULL AND r.token_expires_at > ?`)
    .bind(hash, now())
    .first();
  if (!rec || !rec.package) throw new HttpError(404, "no_release");
  return rec;
}

async function openRelease(request, env, tokenStr) {
  const rec = await findRelease(env, tokenStr);
  if (!rec.opened_at) {
    // Només la primera obertura: cada recàrrega de la pàgina passa per aquí,
    // i no ha de poder omplir el registre del titular.
    await env.DB.prepare("UPDATE recipients SET opened_at = ? WHERE id = ?").bind(now(), rec.id).run();
    await logEvent(env, rec.user_id, "release_opened", rec.email, request);
  }
  return json({ from: rec.owner_email, email: rec.email, package: JSON.parse(rec.package) });
}

async function openReleaseFile(env, tokenStr, fileId) {
  const rec = await findRelease(env, tokenStr);
  const allowed = JSON.parse(rec.file_ids);
  if (!allowed.includes(fileId)) throw new HttpError(404, "no_file");
  const row = await env.DB.prepare("SELECT id FROM files WHERE id = ? AND user_id = ?").bind(fileId, rec.user_id).first();
  if (!row) throw new HttpError(404, "no_file");
  return streamFile(env, rec.user_id, fileId);
}

// Envia primer i desa després: si el correu no surt, l'enllaç no queda registrat
// i la persona continua com a pendent, perquè el cron ho reintenti.
async function releaseRecipient(env, user, rec, mode) {
  const token = randomBytes(32);
  const hash = b64.encode(await sha256(token));
  const ts = now();
  const expiresAt = ts + RELEASE_TTL_S;
  // Una entrega manual no necessita un segon avís al mateix titular. Les
  // automàtiques queden pendents fins que notifyOwnerOfPendingReleases l'envia.
  const ownerNotifiedAt = mode === "manual" ? ts : null;

  const link = `${SITE}/abrir.html?t=${b64.encodeUrl(token)}`;
  const intro = mode === "manual"
    ? `${user.email} ha preparado en Custodium información para ti y te la entrega ahora.`
    : `${user.email} preparó en Custodium información para ti, para cuando no pudiera actuar. Ha pasado el plazo que fijó sin dar señales, y por eso recibes este mensaje.`;

  await sendMail(env, rec.email, "Custodium — hay información preparada para ti", [
    intro,
    "",
    "Puedes abrirla aquí:",
    link,
    "",
    "Necesitarás la frase que te entregó en persona. Sin ella no se puede abrir: nadie más, tampoco Custodium, puede leer este contenido.",
    `El enlace es válido hasta el ${dateEs(expiresAt)}.`,
    "",
    "Custodium · Guardamos el plan, nunca las claves.",
  ].join("\n"));

  if (rec.phone) {
    await sendSms(env, rec.phone, `Custodium: ${user.email} te ha enviado un correo con informacion importante para ti. Revisa tu bandeja de entrada y tambien la carpeta de spam.`);
  }

  await env.DB
    .prepare("UPDATE recipients SET released_at = ?, token_hash = ?, token_expires_at = ?, opened_at = NULL, revoked_at = NULL, owner_notified_at = ?, updated_at = ? WHERE id = ?")
    .bind(ts, hash, expiresAt, ownerNotifiedAt, ts, rec.id)
    .run();
}

// El titular ha de saber que s'ha entregat, per poder anul·lar-ho si ha estat un
// fals positiu. El servidor només coneix els emails: els noms viuen dins del pla.
async function notifyOwnerReleased(env, user, emails) {
  await sendMail(env, user.email, "Custodium — se ha entregado tu plan", [
    "Ha pasado el plazo que fijaste sin señales tuyas, y por eso se ha entregado a tus personas de confianza la parte del plan que les corresponde.",
    "",
    "Se ha entregado a:",
    ...emails.map((e) => `  ${e}`),
    "",
    "Si es un error, entra en tu cuenta y anula el acceso:",
    SITE,
    "",
    "Custodium · Guardamos el plan, nunca las claves.",
  ].join("\n"));

  if (user.phone) {
    const n = emails.length;
    await sendSms(env, user.phone, `Custodium: se ha entregado tu plan a ${n} ${n === 1 ? "persona" : "personas"} de confianza. Si es un error, entra en tu cuenta y anula el acceso.`);
  }
}

// Reuneix totes les entregues automàtiques que encara no s'han comunicat al
// titular. Només les marca després que Resend accepti un únic correu amb la
// llista completa; si falla, continuen pendents per al cron següent.
async function notifyOwnerOfPendingReleases(env, user) {
  const pending = await env.DB
    .prepare("SELECT id, email FROM recipients WHERE user_id = ? AND released_at IS NOT NULL AND owner_notified_at IS NULL ORDER BY created_at")
    .bind(user.id)
    .all();
  if (!pending.results.length) return;

  await notifyOwnerReleased(env, user, pending.results.map((r) => r.email));
  const ts = now();
  await env.DB.batch(pending.results.map((r) => env.DB
    .prepare("UPDATE recipients SET owner_notified_at = ? WHERE id = ? AND owner_notified_at IS NULL")
    .bind(ts, r.id)));
}

// Envia primer i desa després: un avís que no ha sortit no compta, i el cron
// el torna a provar. warn_count és el que després autoritza l'entrega.
async function sendWarning(env, user, ts, idleS, releaseAfterS) {
  const token = randomBytes(32);
  const hash = b64.encode(await sha256(token));
  const deadline = user.last_seen + releaseAfterS;

  const days = Math.floor(idleS / 86400);
  const link = `${SITE}/aqui.html?t=${b64.encodeUrl(token)}`;

  await sendMail(env, user.email, "Custodium — ¿sigues ahí?", [
    `No has entrado en Custodium desde hace ${days} días.`,
    "",
    "Si todo va bien, confírmalo aquí (un solo clic):",
    link,
    "",
    `Si no lo confirmas antes del ${dateEs(deadline)}, entregaremos a tus personas de confianza la parte del plan que les corresponde.`,
    "Entrar en b2c.custodium.space también cuenta como confirmación.",
    "",
    "Custodium · Guardamos el plan, nunca las claves.",
  ].join("\n"));

  if (user.phone) {
    await sendSms(env, user.phone, `Custodium: llevas ${days} dias sin entrar. Entra en tu cuenta de Custodium o pulsa el boton del correo para confirmar que sigues ahi. Si no lo haces antes del ${dateShort(deadline)}, entregaremos tu plan.`);
  }

  await env.DB
    .prepare("UPDATE users SET warned_at = ?, warn_count = warn_count + 1, checkin_token_hash = ?, checkin_expires_at = ? WHERE id = ?")
    .bind(ts, hash, deadline + 7 * 24 * 3600, user.id)
    .run();
  await logEvent(env, user.id, "warning_sent", null, null);
}

// ------------------------------------------------------------------ cron

async function runTriggers(env) {
  const ts = now();
  // Interruptor d'emergència (README §5): viu a D1 i es llegeix a cada
  // execució, perquè es pugui activar en plena incidència sense cap deploy.
  const row = await env.DB.prepare("SELECT value FROM system WHERE key = 'pause_releases'").first();
  const paused = row?.value === "1";
  const users = await env.DB.prepare("SELECT id, email, phone, last_seen, warned_at, warn_count, warn_days, release_days FROM users").all();

  for (const u of users.results) {
    try {
      const lastSeen = u.last_seen ?? ts;
      const idle = ts - lastSeen;
      const warnAfter = u.warn_days * 86400;
      const releaseAfter = u.release_days * 86400;
      if (idle < warnAfter) {
        await notifyOwnerOfPendingReleases(env, u);
        continue;
      }

      const recs = await env.DB
        .prepare("SELECT id, email, phone, package, released_at FROM recipients WHERE user_id = ? AND package IS NOT NULL")
        .bind(u.id)
        .all();
      if (!recs.results.length) continue;

      const warnedSinceLastSeen = u.warned_at && u.warned_at > lastSeen;

      // Calen dos avisos entregats: una incidència d'enviament no pot, tota sola,
      // desencadenar una entrega. Qualsevol senyal de vida torna el compte a zero.
      if (idle >= releaseAfter && u.warn_count >= MIN_WARNINGS_BEFORE_RELEASE) {
        // Amb la pausa activa no s'entrega res, però el titular continua
        // rebent avisos mentre duri.
        if (paused) {
          console.log(`entregues en pausa (pause_releases=1): no s'entrega el pla de ${u.email}`);
        } else {
          for (const r of recs.results) {
            if (r.released_at) continue;
            try {
              await releaseRecipient(env, u, r, "auto");
              await logEvent(env, u.id, "release_auto", r.email, null);
            } catch (err) {
              console.error("release failed for recipient", r.id, err);
            }
          }
          await notifyOwnerOfPendingReleases(env, u);
          continue;
        }
      }

      if (!warnedSinceLastSeen || ts - u.warned_at >= WARN_REPEAT_S) {
        await sendWarning(env, { ...u, last_seen: lastSeen }, ts, idle, releaseAfter);
      }
      await notifyOwnerOfPendingReleases(env, u);
    } catch (err) {
      console.error("trigger failed for user", u.id, err);
    }
  }
}

// Còpia setmanal a FILES_BACKUP: copia els objectes que falten, amb la mateixa
// clau. Mai no s'hi esborra res, ni que l'original hagi desaparegut: la còpia
// és la darrera defensa davant d'un esborrat accidental o maliciós.
async function backupFiles(env) {
  const listKeys = async (bucket) => {
    const keys = [];
    let cursor;
    do {
      const page = await bucket.list({ cursor });
      for (const o of page.objects) keys.push(o.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  };

  const already = new Set(await listKeys(env.FILES_BACKUP));
  let copied = 0;
  for (const key of await listKeys(env.FILES)) {
    if (already.has(key)) continue;
    const obj = await env.FILES.get(key);
    if (!obj) continue; // esborrat entre el list i el get
    await env.FILES_BACKUP.put(key, obj.body);
    copied++;
  }
  console.log(`backup: ${copied} objectes copiats a FILES_BACKUP`);
}

// ------------------------------------------------------------------ mail

async function sendMail(env, to, subject, text) {
  if (!env.RESEND_API_KEY) throw new HttpError(500, "mail_not_configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }),
  });
  if (!res.ok) {
    console.error("resend error", res.status, await res.text());
    throw new HttpError(502, "mail_failed");
  }
}

// SMS via passarel·la HTTP del proveïdor (GET amb usuari, contrasenya, origen,
// destí i text). Credencials com a secrets: SMS_USER, SMS_PASS, SMS_FROM.
// Sense enllaços al text (el proveïdor bloqueja comptes que n'envien) i sense
// accents (GSM-7). Un error d'SMS no atura mai el flux: el correu ja ha sortit.
async function sendSms(env, to, text) {
  if (!env.SMS_USER || !env.SMS_PASS || !env.SMS_FROM) return;
  try {
    const url = new URL("https://www.siptraffic.com/myaccount/sendsms.php");
    url.search = new URLSearchParams({ username: env.SMS_USER, password: env.SMS_PASS, from: env.SMS_FROM, to, text }).toString();
    const res = await fetch(url.toString());
    if (!res.ok) console.error("sms error", res.status);
  } catch (err) {
    console.error("sms failed", err);
  }
}

// ----------------------------------------------------------------- utils

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, "too_large");
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "too_large");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

function validateBlob(blob) {
  if (!blob || typeof blob !== "object") throw new HttpError(400, "bad_blob");
  if (blob.v !== 1) throw new HttpError(400, "bad_blob_version");
  const iv = typeof blob.iv === "string" ? b64.decode(blob.iv) : null;
  const ct = typeof blob.ct === "string" ? b64.decode(blob.ct) : null;
  if (!iv || iv.length !== 12 || !ct || ct.length < 16) throw new HttpError(400, "bad_blob");
  return JSON.stringify({ v: 1, iv: blob.iv, ct: blob.ct });
}

function uuid(value) {
  if (!UUID_RE.test(value)) throw new HttpError(400, "bad_id");
  return value;
}

const b64 = {
  encode(bytes) {
    let s = "";
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s);
  },
  decode(str) {
    try {
      return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  },
  encodeUrl(bytes) {
    return b64.encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decodeUrl(str) {
    if (typeof str !== "string" || !/^[A-Za-z0-9_-]+$/.test(str)) return null;
    const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
    return b64.decode(padded);
  },
};

async function sha256(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    buf.set(p, offset);
    offset += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function isUniqueViolation(err) {
  return /UNIQUE constraint failed/i.test(String(err?.message || err?.cause?.message || ""));
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function dateShort(epochS) {
  return new Date(epochS * 1000).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", timeZone: "Europe/Madrid" });
}

function dateEs(epochS) {
  return new Date(epochS * 1000).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Madrid" });
}
