// Custodium B2C · API · v3
//
// El servidor autentica, guarda blobs xifrats i, quan toca, envia enllaços.
// No veu mai contrasenyes, frases, contingut ni fitxers en clar.
//
//   GET    /api/salt?email=           —                        → { salt }   sal de derivació del compte (base64, 16 bytes)
//   POST   /api/register/start        { email }                → { ok } | 429   envia un codi de 6 xifres per correu (o "ja tens compte")
//   POST   /api/register              { email, authHash, code } → 201 | 400 invalid_code | code_expired | too_many_attempts
//   POST   /api/login                 { email, authHash }      → { token, expiresAt } | 401
//   DELETE /api/session               Bearer                   → { ok }
//   POST   /api/password              { authHash, newAuthHash, blob, version } → { token, version } | 401 | 409
//   POST   /api/email/start           { newEmail }  Bearer     → { ok } | 429   codi de 6 xifres al correu nou (mateixos límits que l'alta)
//   POST   /api/email                 { authHash, newEmail, code } Bearer → { ok } | 401 | 400 invalid_code | code_expired | too_many_attempts
//   DELETE /api/account               { authHash }             → { ok } | 401  esborra R2 (i backup) i tot D1
//   GET    /api/vault                 Bearer                   → { blob, version, updatedAt } | 404
//   PUT    /api/vault                 { blob, version }        → { version } | 409
//   PUT    /api/files/:id             bytes xifrats            → 201 | 409 | 413 | 507
//   GET    /api/files/:id             Bearer                   → bytes | 404
//   DELETE /api/files/:id             Bearer                   → { ok }
//   POST   /api/files/reconcile       { ids, version }         → { deleted } | 409  esborra orfes de >7 dies no inclosos a ids
//   GET    /api/settings              Bearer                   → { warnDays, releaseDays, phone, lastSeen }
//   PUT    /api/settings              { warnDays?, releaseDays?, phone? } → { ok }
//   GET    /api/recipients            Bearer                   → { recipients: [ { id, email, releasedAt, openedAt, expiresAt, revokedAt, reminders } ] }
//   PUT    /api/recipients/:id        { email, phone?, package, fileIds } → { ok }
//   DELETE /api/recipients/:id        Bearer                   → { ok }
//   POST   /api/recipients/:id/release  Bearer                 → { ok }   (entrega ara: envia l'enllaç)
//   POST   /api/recipients/:id/revoke   Bearer                 → { ok }   (anul·la l'enllaç)
//   POST   /api/checkin               { token }                → { ok }   (botó "Sigo aquí" del correu)
//   GET    /api/release/:token        —                        → { from, email, package } | 404
//   GET    /api/release/:token/files/:id  —                    → bytes | 404
//   GET    /api/env                   —                        → { env }   "production" | "staging" (franja del client)
//
// Cron (scheduled), dos cops al dia. Per a cada titular, segons el temps sense
// senyal de vida: a partir de warn_days, avís a cada execució; a la primera
// execució a partir de release_days (amb dos avisos entregats com a mínim),
// entrega a totes les persones pendents; després, durant RELEASED_NOTICE_DAYS,
// li repeteix a cada execució que s'ha entregat, i recorda l'enllaç a cada
// persona que no l'ha obert a les dates de REMINDER_DAYS. Entrar (o "Sigo
// aquí") ho atura tot. Amb pause_releases='1' a la taula system (D1) continua
// avisant però no entrega res.
//
// Avisos i entregues envien primer i desen després: si Resend no accepta el
// correu no es desa res, i el cron ho torna a provar a l'execució següent. Així
// un correu perdut no consumeix un avís ni marca una entrega que no ha sortit.
// Els recordatoris a les persones són l'excepció: un que falla es dona per fet
// (queda a Actividad) i es passa a la data següent, per no insistir dos cops al
// dia contra una adreça morta.

const CRON_TRIGGERS = "0 8,20 * * *";     // wrangler.toml: el mateix als dos entorns
const TOKEN_TTL_S = 24 * 3600;            // sessió: 24 h, renovada a cada petició autenticada
const RELEASE_TTL_S = 90 * 24 * 3600;     // enllaç d'obertura: 90 dies des de cada correu que el porta
const MIN_WARNINGS_BEFORE_RELEASE = 2;    // avisos entregats abans d'una entrega automàtica
const MIN_RELEASE_GAP_DAYS = 3;           // entrega com a mínim tres dies després del primer avís: sis avisos i tres SMS abans
const OWNER_SMS_GAP_S = 20 * 3600;        // SMS al titular: com a màxim un al dia (el cron passa cada 12 h)
const RELEASED_NOTICE_DAYS = 5;           // dies d'avisos "s'ha entregat" al titular després d'una entrega automàtica
const REMINDER_DAYS = [1, 2, 4, 7, 10, 15, 21, 26, 33, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 150]; // recordatoris a la persona: dies després de l'entrega
const CRON_SLACK_S = 3600;                // marge perquè una data que cau just a l'hora del cron no salti a l'execució següent
const MAX_BODY_BYTES = 1_000_000;
const MAX_FILE_BYTES = 50_000_000;       // 50 MB per fitxer (escàners notarials llargs)
const MAX_USER_BYTES = 1_000_000_000;    // 1 GB per titular
const MAX_FILE_IDS = 500;
const MAX_RECIPIENTS = 20;
const SIGNUP_CODE_TTL_S = 15 * 60;        // el codi de l'alta caduca als 15 minuts
const SIGNUP_MAX_ATTEMPTS = 5;            // verificacions fallides per codi; després cal demanar-ne un de nou
const SIGNUP_MAX_SENDS = 3;               // codis per email dins de la finestra
const SIGNUP_WINDOW_S = 3600;             // finestra del límit de codis: una hora

// SITE, MAIL_FROM, MAIL_CONTACT i ENV viuen a wrangler.toml ([vars], per entorn).
// SALT_PEPPER és un secret (wrangler secret put): clau de l'HMAC del qual surt
// la sal de derivació de cada compte (vegeu accountSalt).

const KDF_SALT_BYTES = 16;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+[1-9]\d{6,14}$/;    // format internacional, p. ex. +34600000000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (!pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });

    try {
      if (pathname === "/api/env"      && method === "GET") return json({ env: env.ENV || "production" });
      if (pathname === "/api/salt"     && method === "GET") return await getSalt(request, env);
      if (pathname === "/api/register/start" && method === "POST") return await startSignup(request, env);
      if (pathname === "/api/register" && method === "POST") return await register(request, env);
      if (pathname === "/api/login"    && method === "POST") return await login(request, env);
      if (pathname === "/api/session"  && method === "DELETE") return await logout(request, env);
      if (pathname === "/api/sessions" && method === "DELETE") return await closeOtherSessions(request, env);
      if (pathname === "/api/account"  && method === "DELETE") return await deleteAccount(request, env);
      if (pathname === "/api/password" && method === "POST") return await changePassword(request, env);
      if (pathname === "/api/email/start" && method === "POST") return await startEmailChange(request, env);
      if (pathname === "/api/email"    && method === "POST") return await changeEmail(request, env);
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
    if (event.cron === CRON_TRIGGERS) ctx.waitUntil(runTriggers(env));
    else if (event.cron === "0 3 * * SUN") ctx.waitUntil(backupFiles(env));
    else console.log(`cron desconegut, no es fa res: ${event.cron}`);
  },
};

// ---------------------------------------------------------------- auth

// Primer pas de l'alta: un codi de sis xifres al correu, per comprovar que
// l'email és de qui el demana abans de crear res. El codi es guarda hashejat
// amb sal a pending_signups i caduca als 15 minuts. Si l'email ja té compte no
// s'envia cap codi sinó un "ja tens compte", però la resposta és la mateixa
// (200 { ok }) i la fila de pending_signups es crea igual, sense codi: ni la
// resposta ni el límit de codis diuen si el compte existeix. Res es desa fins
// que Resend ha acceptat el correu. Cobert per la regla del WAF (README §5).
async function startSignup(request, env) {
  const email = parseEmail((await readJson(request))?.email);
  return issueCode(env, email, "signup");
}

// Primer pas del canvi de correu: el mateix codi, però al correu nou i amb
// sessió oberta. Mateixa taula, mateixos límits i mateixa resposta tant si el
// correu nou té compte com si no (llavors hi arriba "ja tens compte").
async function startEmailChange(request, env) {
  const { userId } = await authenticate(request, env);
  const newEmail = parseEmail((await readJson(request))?.newEmail);
  const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first();
  if (newEmail === user.email) throw new HttpError(400, "same_email");
  return issueCode(env, newEmail, "email");
}

const CODE_MAIL = {
  signup: { subject: "Tu código para crear la cuenta en Custodium", text: (code) => `Tu código para crear la cuenta en Custodium: ${code}. Caduca en 15 minutos. Si no has sido tú, ignora este mensaje.` },
  email: { subject: "Tu código para cambiar el correo de Custodium", text: (code) => `Tu código para cambiar el correo de Custodium: ${code}. Caduca en 15 minutos. Si no has sido tú, ignora este mensaje.` },
};

// Envia un codi a un correu (o "ja tens compte" si ja en té) i deixa la fila
// a pending_signups. purpose: "signup" o "email" (només canvia el text).
async function issueCode(env, email, purpose) {
  const ts = now();
  const [user, pending] = await Promise.all([
    env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first(),
    env.DB.prepare("SELECT sends, created_at FROM pending_signups WHERE email = ?").bind(email).first(),
  ]);

  // Límit de codis: la finestra d'una hora comença amb el primer codi i es
  // reinicia quan ha passat. Val igual per als emails amb compte.
  const inWindow = pending && ts - pending.created_at < SIGNUP_WINDOW_S;
  const sends = inWindow ? pending.sends : 0;
  if (sends >= SIGNUP_MAX_SENDS) throw new HttpError(429, "too_many_codes");
  const windowStart = inWindow ? pending.created_at : ts;

  let codeHash = null;
  let expiresAt = ts;
  if (user) {
    await sendAccountExistsMail(env, email);
  } else {
    const code = signupCode();
    const salt = randomBytes(16);
    codeHash = `${b64.encode(salt)}.${b64.encode(await hashSignupCode(salt, code))}`;
    expiresAt = ts + SIGNUP_CODE_TTL_S;
    await sendMail(env, email, CODE_MAIL[purpose].subject, CODE_MAIL[purpose].text(code), mailHtml({
      subject: CODE_MAIL[purpose].subject,
      eyebrow: "Código de verificación",
      title: purpose === "signup" ? "Tu código para crear la cuenta." : "Tu código para cambiar el correo.",
      box: { label: "Escribe este código", big: code, text: "Caduca en 15 minutos." },
      after: ["Si no has sido tú, ignora este mensaje."],
    }));
  }

  await env.DB
    .prepare("INSERT OR REPLACE INTO pending_signups (email, code_hash, attempts, sends, expires_at, created_at) VALUES (?, ?, 0, ?, ?, ?)")
    .bind(email, codeHash, sends + 1, expiresAt, windowStart)
    .run();
  return json({ ok: true });
}

async function sendAccountExistsMail(env, email) {
  const subject = "Ya tienes una cuenta en Custodium";
  await sendMail(env, email, subject,
    `Ya existe una cuenta con este correo.\n\nSi eres tú, entra en ${env.SITE}.\nSi has olvidado la contraseña, no hay forma de recuperarla: tu plan sigue cifrado con ella.\nSi no has sido tú, ignora este mensaje.`,
    mailHtml({
      subject,
      eyebrow: "Tu cuenta",
      title: "Ya tienes una cuenta.",
      paragraphs: ["Ya existe una cuenta con este correo. Si eres tú, entra con tu contraseña."],
      button: { label: "Entrar en Custodium", url: env.SITE },
      after: ["Si has olvidado la contraseña, no hay forma de recuperarla: tu plan sigue cifrado con ella.", "Si no has sido tú, ignora este mensaje."],
    }));
}

// Sis xifres a l'atzar, amb zeros al davant si cal. Rebutja la cua de
// l'espai d'un Uint32 perquè totes les xifres siguin igual de probables.
function signupCode() {
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= 4_294_000_000);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

async function hashSignupCode(salt, code) {
  return sha256(salt, new TextEncoder().encode(code));
}

// Veredicte sobre un codi d'alta: "ok", o per què no. Cinc verificacions per
// codi: a la cinquena fallida (i a partir d'aquí, encara que el codi sigui bo)
// cal demanar-ne un de nou. Comparació en temps constant.
async function verifySignupCode(pending, code, ts) {
  if (!pending?.code_hash) return "invalid_code";
  if (pending.attempts >= SIGNUP_MAX_ATTEMPTS) return "too_many_attempts";
  if (pending.expires_at < ts) return "code_expired";
  const [salt, hash] = pending.code_hash.split(".").map((part) => b64.decode(part));
  if (salt && hash && timingSafeEqual(await hashSignupCode(salt, code), hash)) return "ok";
  return pending.attempts + 1 >= SIGNUP_MAX_ATTEMPTS ? "too_many_attempts" : "invalid_code";
}

// Segon pas de l'alta: només amb el codi bo es crea el compte. La sal de
// derivació (kdf_salt) és la mateixa que /api/salt ja donava per a aquest
// email abans que existís el compte: el client l'ha demanat, ha derivat
// l'authHash amb ella, i aquí es fixa a la fila. Des d'ara mana la fila
// (vegeu accountSalt). Cap 409 "ja existeix": per a un email amb compte no hi
// ha cap codi vàlid, i la resposta és la d'un codi dolent.
async function register(request, env) {
  const body = await readJson(request);
  const { email, authHash } = parseCredentials(body);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, "bad_code");
  const ts = now();

  const pending = await env.DB.prepare("SELECT code_hash, attempts, expires_at FROM pending_signups WHERE email = ?").bind(email).first();
  const verdict = await verifySignupCode(pending, code, ts);
  if (verdict !== "ok") {
    if (verdict !== "code_expired") await env.DB.prepare("UPDATE pending_signups SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    throw new HttpError(400, verdict);
  }

  const kdfSalt = await accountSalt(env, email);
  const salt = randomBytes(16);
  const hash = await sha256(salt, authHash);

  try {
    await env.DB.batch([
      env.DB
        .prepare("INSERT INTO users (id, email, auth_salt, auth_hash, kdf_salt, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), email, b64.encode(salt), b64.encode(hash), kdfSalt, ts, ts),
      env.DB.prepare("DELETE FROM pending_signups WHERE email = ?").bind(email),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(400, "invalid_code");
    throw err;
  }
  return json({ ok: true }, 201);
}

// La sal del compte, perquè el client pugui derivar les claus. Cobert per la
// regla de rate limiting del WAF (README §5).
async function getSalt(request, env) {
  const email = parseEmail(new URL(request.url).searchParams.get("email"));
  return json({ salt: await accountSalt(env, email) });
}

// Sal de derivació d'un email, tingui compte o no: la guardada a la fila si
// n'hi ha, i si no HMAC-SHA256(SALT_PEPPER, email) truncat a 16 bytes. Com que
// a l'alta es guarda exactament aquest HMAC, la resposta és la mateixa abans i
// després de registrar l'email: /api/salt no diu si el compte existeix. Es
// guarda (i no es recalcula) perquè sobrevisqui a un canvi d'email o de pepper.
// L'HMAC es calcula sempre, també quan hi ha fila, per no delatar-ho pel temps.
async function accountSalt(env, email) {
  if (!env.SALT_PEPPER) throw new HttpError(500, "salt_not_configured");
  const user = await env.DB.prepare("SELECT kdf_salt FROM users WHERE email = ?").bind(email).first();
  const derived = b64.encode(await deriveSalt(env.SALT_PEPPER, email));
  return user?.kdf_salt || derived;
}

// HMAC-SHA256(pepper, email) truncat a la mida de la sal. Únic per email i,
// sense el pepper, impossible de recalcular des de fora.
async function deriveSalt(pepper, email) {
  const te = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", te.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(email)));
  return mac.slice(0, KDF_SALT_BYTES);
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
    env.DB.prepare("UPDATE users SET last_seen = ?, warned_at = NULL, warn_count = 0 WHERE id = ?").bind(ts, user.id),
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
    env.DB.prepare("DELETE FROM release_tokens WHERE recipient_id IN (SELECT id FROM recipients WHERE user_id = ?)").bind(userId),
    env.DB.prepare("DELETE FROM checkin_tokens WHERE user_id = ?").bind(userId),
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
// Canvi de correu: contrasenya actual (authHash) i codi rebut al correu nou.
// Si el correu nou ja té compte, la resposta és la d'un codi dolent (no ho
// revela) i el correu nou rep "ja tens compte". Es tanquen les altres
// sessions, es registra email_changed i l'adreça antiga rep un avís, sense
// cap enllaç de desfer: qui tingui la contrasenya i el correu nou mana.
// La sal de derivació (kdf_salt) no canvia: les claus continuen sent les
// mateixes i el pla no cal rexifrar-lo.
async function changeEmail(request, env) {
  const { userId, tokenHash } = await authenticate(request, env);
  const body = await readJson(request);
  const current = typeof body?.authHash === "string" ? b64.decode(body.authHash) : null;
  if (!current || current.length !== 32) throw new HttpError(400, "bad_auth_hash");
  const newEmail = parseEmail(body?.newEmail);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, "bad_code");
  const ts = now();

  const user = await env.DB.prepare("SELECT email, auth_salt, auth_hash FROM users WHERE id = ?").bind(userId).first();
  const computed = await sha256(b64.decode(user.auth_salt), current);
  if (!timingSafeEqual(computed, b64.decode(user.auth_hash))) throw new HttpError(401, "invalid_credentials");
  if (newEmail === user.email) throw new HttpError(400, "same_email");

  const pending = await env.DB.prepare("SELECT code_hash, attempts, expires_at FROM pending_signups WHERE email = ?").bind(newEmail).first();
  const verdict = await verifySignupCode(pending, code, ts);
  if (verdict !== "ok") {
    if (verdict !== "code_expired") await env.DB.prepare("UPDATE pending_signups SET attempts = attempts + 1 WHERE email = ?").bind(newEmail).run();
    throw new HttpError(400, verdict);
  }

  // Un codi vàlid només existeix si el correu nou no tenia compte quan es va
  // demanar; si n'ha aparegut un entremig, mateixa resposta que un codi dolent.
  const taken = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(newEmail).first();
  if (taken) {
    await sendAccountExistsMail(env, newEmail);
    throw new HttpError(400, "invalid_code");
  }

  // Primer l'avís a l'adreça antiga; si Resend no l'accepta, no es canvia res.
  await sendMail(env, user.email, "Tu correo de Custodium ha cambiado",
    `Tu correo de Custodium ha pasado a ser ${newEmail}. Si no has sido tú, escríbenos a ${env.MAIL_CONTACT}.`,
    mailHtml({
      subject: "Tu correo de Custodium ha cambiado",
      eyebrow: "Tu cuenta",
      title: "Tu correo ha cambiado.",
      paragraphs: [`Tu correo de Custodium ha pasado a ser **${newEmail}**.`],
      after: [`Si no has sido tú, escríbenos a ${env.MAIL_CONTACT}.`],
    }));

  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(newEmail, userId),
      env.DB.prepare("DELETE FROM pending_signups WHERE email = ?").bind(newEmail),
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(userId, tokenHash),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) {
      await sendAccountExistsMail(env, newEmail);
      throw new HttpError(400, "invalid_code");
    }
    throw err;
  }
  await logEvent(env, userId, "email_changed", newEmail, request);
  return json({ ok: true });
}

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
  if (!Number.isInteger(releaseDays) || releaseDays < warnDays + MIN_RELEASE_GAP_DAYS || releaseDays > 730) throw new HttpError(400, "bad_release_days");

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
    .prepare(`SELECT r.id, r.email, r.released_at, r.opened_at, r.revoked_at, r.reminder_count,
                (SELECT MAX(t.expires_at) FROM release_tokens t WHERE t.recipient_id = r.id) AS token_expires_at
              FROM recipients r WHERE r.user_id = ? ORDER BY r.created_at`)
    .bind(userId)
    .all();
  return json({
    recipients: rows.results.map((r) => ({
      id: r.id, email: r.email, releasedAt: r.released_at, openedAt: r.opened_at, expiresAt: r.token_expires_at, revokedAt: r.revoked_at,
      reminders: r.reminder_count,
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
  const [, res] = await env.DB.batch([
    env.DB.prepare("DELETE FROM release_tokens WHERE recipient_id IN (SELECT id FROM recipients WHERE id = ? AND user_id = ?)").bind(id, userId),
    env.DB.prepare("DELETE FROM recipients WHERE id = ? AND user_id = ?").bind(id, userId),
  ]);
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
  const ts = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM release_tokens WHERE recipient_id = ?").bind(id),
    env.DB
      .prepare("UPDATE recipients SET released_at = NULL, release_mode = NULL, reminder_count = 0, opened_at = NULL, revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .bind(ts, ts, id, userId),
  ]);
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
  // Val el botó de qualsevol avís d'aquest període d'inactivitat: un token
  // serveix mentre no ha caducat i no hi ha hagut cap senyal de vida després
  // d'enviar-lo (created_at > last_seen).
  const u = await env.DB
    .prepare(`SELECT u.id FROM checkin_tokens t JOIN users u ON u.id = t.user_id
              WHERE t.token_hash = ? AND t.expires_at > ? AND t.created_at > COALESCE(u.last_seen, 0)`)
    .bind(hash, ts)
    .first();
  if (!u) throw new HttpError(404, "bad_token");
  await env.DB.prepare("UPDATE users SET last_seen = ?, warned_at = NULL, warn_count = 0 WHERE id = ?").bind(ts, u.id).run();
  await logEvent(env, u.id, "checkin", null, request);
  return json({ ok: true });
}

async function findRelease(env, tokenStr) {
  const raw = b64.decodeUrl(tokenStr);
  if (!raw || raw.length !== 32) throw new HttpError(404, "no_release");
  const hash = b64.encode(await sha256(raw));
  // Obre qualsevol enllaç enviat (entrega, "Enviar de nuevo" o recordatori)
  // mentre no ha caducat: cada correu porta el seu token i tots queden a
  // release_tokens fins que caduquen o el titular anul·la l'accés.
  const rec = await env.DB
    .prepare(`SELECT r.id, r.user_id, r.email, r.package, r.file_ids, r.opened_at, u.email AS owner_email
              FROM release_tokens t JOIN recipients r ON r.id = t.recipient_id JOIN users u ON u.id = r.user_id
              WHERE t.token_hash = ? AND t.expires_at > ? AND r.released_at IS NOT NULL`)
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
// i la persona continua com a pendent, perquè el cron ho reintenti. Cada
// enviament (entrega, "Enviar de nuevo", recordatori) porta un token nou; els
// anteriors continuen valent fins que caduquen o s'anul·la l'accés.
async function releaseRecipient(env, user, rec, mode) {
  const ts = now();
  const { link, hash, expiresAt } = await newReleaseLink(env, ts);
  const intro = mode === "manual"
    ? `${user.email} ha preparado en Custodium información para ti y te la entrega ahora.`
    : `${user.email} preparó en Custodium información para ti, para cuando no pudiera actuar. Ha pasado el plazo que fijó sin dar señales, y por eso recibes este mensaje.`;

  const subject = "Custodium — hay información preparada para ti";
  await sendMail(env, rec.email, subject, [
    intro,
    "",
    "Puedes abrirla aquí:",
    link,
    "",
    "Necesitarás la frase que te entregó en persona. Sin ella no se puede abrir: nadie más, tampoco Custodium, puede leer este contenido.",
    `El enlace es válido hasta el ${dateEs(expiresAt)}.`,
    "",
    "Custodium · Guardamos el plan, nunca las claves.",
  ].join("\n"), mailHtml({
    subject,
    eyebrow: "Información preparada para ti",
    title: "Hay información para ti.",
    paragraphs: [intro],
    steps: ["Abre la página desde el botón de este correo.", "Escribe la **frase** que te entregó en persona. Sin ella no se puede abrir: nadie más, tampoco Custodium, puede leer este contenido."],
    button: { label: "Abrir la información", url: link },
    box: { label: "Enlace válido hasta el", big: dateEs(expiresAt) },
    link: { text: "Si el botón no funciona, copia y pega este enlace en tu navegador.", url: link },
    foot: `Recibes este correo porque ${user.email} te designó como persona de confianza en Custodium.`,
  }));

  if (rec.phone) {
    await sendSms(env, rec.phone, `Custodium: ${user.email} te ha enviado un correo con informacion importante para ti. Revisa tu bandeja de entrada y tambien la carpeta de spam.`);
  }

  // Una entrega manual no necessita avís al mateix titular; d'una automàtica
  // n'hi arriben durant RELEASED_NOTICE_DAYS (notifyOwnerReleased).
  await env.DB.batch([
    env.DB.prepare("INSERT INTO release_tokens (token_hash, recipient_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(hash, rec.id, ts, expiresAt),
    env.DB
      .prepare("UPDATE recipients SET released_at = ?, release_mode = ?, reminder_count = 0, opened_at = NULL, revoked_at = NULL, owner_notified_at = ?, updated_at = ? WHERE id = ?")
      .bind(ts, mode, mode === "manual" ? ts : null, ts, rec.id),
  ]);
}

async function newReleaseLink(env, ts) {
  const token = randomBytes(32);
  const hash = b64.encode(await sha256(token));
  return { link: `${env.SITE}/abrir.html?t=${b64.encodeUrl(token)}`, hash, expiresAt: ts + RELEASE_TTL_S };
}

// Recordatori a una persona que encara no ha obert: enllaç nou, sense SMS. Un
// que Resend rebutja es dona per fet (queda a Actividad) i es passa a la data
// següent: contra una adreça morta no s'insisteix dos cops al dia.
async function sendReminder(env, user, rec, ts) {
  const { link, hash, expiresAt } = await newReleaseLink(env, ts);
  const days = Math.floor((ts - rec.released_at) / 86400);
  let sent = true;
  try {
    const subject = "Custodium — sigue habiendo información preparada para ti";
    const intro = `${days === 1 ? "Hace un día" : `Hace ${days} días`} te avisamos de que ${user.email} había preparado en Custodium información para ti. Todavía no se ha abierto.`;
    await sendMail(env, rec.email, subject, [
      intro,
      "",
      "Puedes abrirla aquí:",
      link,
      "",
      "Necesitarás la frase que te entregó en persona. Los enlaces de los correos anteriores siguen siendo válidos.",
      `Este enlace es válido hasta el ${dateEs(expiresAt)}.`,
      "",
      "Custodium · Guardamos el plan, nunca las claves.",
    ].join("\n"), mailHtml({
      subject,
      eyebrow: "Información preparada para ti",
      title: "Sigue habiendo información para ti.",
      paragraphs: [intro],
      steps: ["Abre la página desde el botón de este correo.", "Escribe la **frase** que te entregó en persona."],
      button: { label: "Abrir la información", url: link },
      box: { label: "Enlace válido hasta el", big: dateEs(expiresAt) },
      after: ["Los enlaces de los correos anteriores siguen siendo válidos."],
      link: { text: "Si el botón no funciona, copia y pega este enlace en tu navegador.", url: link },
      foot: `Recibes este correo porque ${user.email} te designó como persona de confianza en Custodium.`,
    }));
  } catch (err) {
    sent = false;
    console.error("reminder failed for recipient", rec.id, err);
  }
  await env.DB.batch([
    ...(sent ? [env.DB.prepare("INSERT INTO release_tokens (token_hash, recipient_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(hash, rec.id, ts, expiresAt)] : []),
    env.DB.prepare("UPDATE recipients SET reminder_count = reminder_count + 1, updated_at = ? WHERE id = ?").bind(ts, rec.id),
  ]);
  await logEvent(env, user.id, sent ? "reminder_sent" : "reminder_failed", rec.email, null);
}

// El titular ha de saber que s'ha entregat, per poder anul·lar-ho si ha estat
// un fals positiu. Durant RELEASED_NOTICE_DAYS després d'una entrega automàtica
// li ho repetim a cada execució (SMS com a màxim un al dia), fins que entra.
// El servidor només coneix els emails: els noms viuen dins del pla.
async function notifyOwnerReleased(env, user, released, ts) {
  const emails = released.map((r) => r.email);
  const subject = "Custodium — se ha entregado tu plan";
  await sendMail(env, user.email, subject, [
    "Ha pasado el plazo que fijaste sin señales tuyas, y por eso se ha entregado a tus personas de confianza la parte del plan que les corresponde.",
    "",
    "Se ha entregado a:",
    ...emails.map((e) => `  ${e}`),
    "",
    "Si es un error, entra en tu cuenta y anula el acceso:",
    env.SITE,
    "",
    "Custodium · Guardamos el plan, nunca las claves.",
  ].join("\n"), mailHtml({
    subject,
    eyebrow: "Entrega realizada",
    title: "Se ha entregado tu plan.",
    paragraphs: ["Ha pasado el plazo que fijaste sin señales tuyas, y por eso se ha entregado a tus personas de confianza la parte del plan que les corresponde."],
    box: { label: "Se ha entregado a", lines: emails },
    after: ["Si es un error, entra en tu cuenta y anula el acceso desde «Personas»."],
    button: { label: "Entrar en Custodium", url: env.SITE, last: true },
    foot: "Recibirás este aviso durante unos días, hasta que entres en tu cuenta.",
  }));
  await env.DB.batch(released.map((r) => env.DB.prepare("UPDATE recipients SET owner_notified_at = ? WHERE id = ?").bind(ts, r.id)));

  if (await ownerSmsDue(env, user, ts)) {
    const n = emails.length;
    await sendSms(env, user.phone, `Custodium: se ha entregado tu plan a ${n} ${n === 1 ? "persona" : "personas"} de confianza. Si es un error, entra en tu cuenta y anula el acceso.`);
  }
}

// SMS al titular com a màxim un al dia, comptant avisos i notícies d'entrega.
async function ownerSmsDue(env, user, ts) {
  if (!user.phone) return false;
  if (user.warn_sms_at && ts - user.warn_sms_at < OWNER_SMS_GAP_S) return false;
  await env.DB.prepare("UPDATE users SET warn_sms_at = ? WHERE id = ?").bind(ts, user.id).run();
  user.warn_sms_at = ts;
  return true;
}

// Envia primer i desa després: un avís que no ha sortit no compta, i el cron
// el torna a provar. warn_count és el que després autoritza l'entrega. Cada
// avís porta un botó "Sigo aquí" nou; els dels avisos anteriors continuen
// valent (checkin_tokens) fins que hi ha una senyal de vida.
async function sendWarning(env, user, ts, idleS, releaseAfterS) {
  const token = randomBytes(32);
  const hash = b64.encode(await sha256(token));
  const deadline = user.last_seen + releaseAfterS;
  const days = Math.floor(idleS / 86400);
  const link = `${env.SITE}/aqui.html?t=${b64.encodeUrl(token)}`;
  const site = env.SITE.replace(/^https?:\/\//, "");

  const subject = "Custodium — ¿sigues ahí?";
  const since = `No has entrado en Custodium desde hace ${days === 1 ? "un día" : `${days} días`}.`;
  await sendMail(env, user.email, subject, [
    since,
    "",
    "Si todo va bien, confírmalo aquí (un solo clic):",
    link,
    "",
    `Si no lo confirmas, a partir del ${dateEs(deadline)} entregaremos a tus personas de confianza la parte del plan que les corresponde.`,
    `Entrar en ${site} también cuenta como confirmación. Los botones de los avisos anteriores siguen sirviendo.`,
    "Recibirás este aviso dos veces al día hasta que confirmes.",
    "",
    "Custodium · Guardamos el plan, nunca las claves.",
  ].join("\n"), mailHtml({
    subject,
    eyebrow: "Confirmación de actividad",
    title: "¿Sigues ahí?",
    paragraphs: [`${since} Confirma que sigues aquí para que la cuenta atrás de la entrega vuelva a empezar.`],
    steps: ["Abre la página desde el botón de este correo.", "Allí, pulsa **«Sigo aquí»** para completar la confirmación."],
    button: { label: "Abrir la página de confirmación", url: link },
    note: "Abrir el enlace no basta: debes pulsar el botón en la página.",
    box: { label: "Confirma antes del", big: dateEs(deadline), text: "Si no recibimos tu confirmación antes de esa fecha, entregaremos a tus personas de confianza únicamente la información que hayas asignado a cada una, según tu plan." },
    after: [`Entrar en tu cuenta en ${site} también cuenta como confirmación. Los botones de los avisos anteriores siguen sirviendo.`, "Recibirás este aviso dos veces al día hasta que confirmes."],
    link: { text: "Si el botón no funciona, copia y pega este enlace en tu navegador. Después, pulsa «Sigo aquí» en la página.", url: link },
    foot: "Recibes este aviso como parte del seguimiento de actividad de tu cuenta.",
  }));

  await env.DB.batch([
    env.DB.prepare("INSERT INTO checkin_tokens (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(hash, user.id, ts, deadline + 7 * 24 * 3600),
    env.DB.prepare("UPDATE users SET warned_at = ?, warn_count = warn_count + 1 WHERE id = ?").bind(ts, user.id),
  ]);
  await logEvent(env, user.id, "warning_sent", null, null);

  if (await ownerSmsDue(env, user, ts)) {
    await sendSms(env, user.phone, `Custodium: llevas ${days} dias sin entrar. Entra en tu cuenta de Custodium o pulsa el boton del correo para confirmar que sigues ahi. Si no lo haces, a partir del ${dateShort(deadline)} entregaremos tu plan.`);
  }
}

// ------------------------------------------------------------------ cron

async function runTriggers(env) {
  const ts = now();
  // Interruptor d'emergència (README §5): viu a D1 i es llegeix a cada
  // execució, perquè es pugui activar en plena incidència sense cap deploy.
  const row = await env.DB.prepare("SELECT value FROM system WHERE key = 'pause_releases'").first();
  const paused = row?.value === "1";
  const users = await env.DB.prepare("SELECT id, email, phone, last_seen, warned_at, warn_count, warn_days, release_days, warn_sms_at FROM users").all();

  for (const u of users.results) {
    try {
      await runUserTriggers(env, u, ts, paused);
    } catch (err) {
      console.error("trigger failed for user", u.id, err);
    }
  }

  // Neteja: botons i enllaços caducats, i altes no completades (la fila ja no
  // serveix quan el codi ha caducat i la finestra del límit de codis també).
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM checkin_tokens WHERE expires_at < ?").bind(ts),
      env.DB.prepare("DELETE FROM release_tokens WHERE expires_at < ?").bind(ts),
      env.DB.prepare("DELETE FROM pending_signups WHERE expires_at < ? AND created_at < ?").bind(ts, ts - SIGNUP_WINDOW_S),
    ]);
  } catch (err) {
    console.error("neteja del cron", err);
  }
}

// Un titular, una execució. Segons el temps sense senyal de vida:
//   < warn_days           res.
//   ≥ warn_days           avís a cada execució, mentre hi hagi persones per entregar.
//   ≥ release_days        entrega a totes les persones pendents (amb dos avisos
//                         entregats i sense pausa); després, avís "s'ha entregat"
//                         a cada execució durant RELEASED_NOTICE_DAYS i recordatori
//                         a qui no ha obert a les dates de REMINDER_DAYS.
// Entrar o "Sigo aquí" posa last_seen al dia i ho atura tot; els enllaços ja
// entregats continuen valent fins que el titular els anul·la des de Personas.
async function runUserTriggers(env, u, ts, paused) {
  const lastSeen = u.last_seen ?? ts;
  const idle = ts - lastSeen;
  if (idle < u.warn_days * 86400) return;

  const recs = await env.DB
    .prepare("SELECT id, email, phone, released_at, release_mode, reminder_count, opened_at FROM recipients WHERE user_id = ? AND package IS NOT NULL ORDER BY created_at")
    .bind(u.id)
    .all();
  if (!recs.results.length) return;
  const user = { ...u, last_seen: lastSeen };
  const releaseAfter = u.release_days * 86400;
  const pending = recs.results.filter((r) => !r.released_at);

  // Calen dos avisos entregats: una incidència d'enviament no pot, tota sola,
  // desencadenar una entrega. Qualsevol senyal de vida torna el compte a zero.
  if (pending.length && idle >= releaseAfter && u.warn_count >= MIN_WARNINGS_BEFORE_RELEASE) {
    if (paused) {
      console.log(`entregues en pausa (pause_releases=1): no s'entrega el pla de ${u.email}`);
    } else {
      for (const r of pending) {
        try {
          await releaseRecipient(env, user, r, "auto");
          await logEvent(env, u.id, "release_auto", r.email, null);
          Object.assign(r, { released_at: ts, release_mode: "auto", reminder_count: 0, opened_at: null });
        } catch (err) {
          console.error("release failed for recipient", r.id, err);
        }
      }
    }
  }

  // Entregues automàtiques que el titular encara no ha vist (no ha entrat des
  // de llavors): notícia al titular i recordatoris a qui no ha obert.
  const released = recs.results.filter((r) => r.released_at && r.release_mode === "auto" && r.released_at > lastSeen);
  if (released.length) {
    if (released.some((r) => ts - r.released_at < RELEASED_NOTICE_DAYS * 86400)) {
      try { await notifyOwnerReleased(env, user, released, ts); } catch (err) { console.error("owner notice failed for user", u.id, err); }
    }
    for (const r of released) {
      if (r.opened_at || r.reminder_count >= REMINDER_DAYS.length) continue;
      if (ts + CRON_SLACK_S < r.released_at + REMINDER_DAYS[r.reminder_count] * 86400) continue;
      await sendReminder(env, user, r, ts);
    }
    return;
  }

  if (pending.length) await sendWarning(env, user, ts, idle, releaseAfter);
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

// ------------------------------------------------------------ correu HTML
//
// Cada correu surt amb text pla (la font de veritat: és el que comproven els
// tests i el que veu qui llegeix en text) i una versió HTML muntada amb la
// mateixa plantilla per a tots: capçalera verd fosc amb un filet de llautó,
// targeta clara, botó teal. Taules i estils en línia, que és el que entenen els
// clients de correu; Georgia en lloc de Fraunces, perquè les fonts web no hi
// arriben; cap imatge. Mai contingut del pla: només enllaços, dates, codis i
// adreces.

// Colors: els de la Guia Visual. La capçalera en --teal-dark (la nit del web surt quasi
// negra en un correu); la targeta en un blanc càlid molt lleuger i el fons de fora quasi
// neutre. Gmail al mòbil inverteix els fons clars en mode fosc, i un marfil càlid
// invertit surt d'un oliva brut; un blanc quasi neutre surt d'un gris net. Els clients
// que entenen prefers-color-scheme (Apple Mail, Outlook) reben una versió fosca
// dissenyada (l'<style> del cap) en comptes d'una inversió automàtica.
const M = { header: "#164A43", ivory: "#F7F4EE", outer: "#F4F3F1", card: "#FBFAF8", ink: "#1B2B2E", slate: "#5E6E72", teal: "#1C5D54", tealDark: "#164A43", tealSoft: "#E4EEEA", brass: "#AE8E5C", hair: "#E5E5E2", box: "#F1F4F2", boxLine: "#DCE3DE" };
const SANS = "Helvetica, Arial, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";
const DARK_CSS = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .bg-outer { background: #141A1A !important; }
    .bg-card { background: #1C2426 !important; }
    .bg-box { background: #243033 !important; border-color: #33474A !important; }
    .tx-ink { color: #F0EDE6 !important; }
    .tx-slate { color: #B7C1C3 !important; }
    .tx-teal { color: #8CC7BA !important; }
    .hr { border-top-color: #33474A !important; }
  }`;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// **negreta** dins d'un text; s'escapa primer, així que el text mai pot dur HTML.
function fmt(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, `<strong class="tx-ink" style="color:${M.ink};">$1</strong>`);
}

// Peces, en aquest ordre: etiqueta, títol, paràgrafs, passos numerats, botó, nota
// sota el botó, caixa destacada (etiqueta + dada gran o llista de línies + text),
// més paràgrafs, enllaç de recanvi. button.last el posa al final, després de tot.
function mailHtml({ subject, eyebrow, title, paragraphs = [], steps = [], button, note, box, after = [], link, foot }) {
  const para = (t) => `<p class="tx-slate" style="margin:0 0 14px;font-size:16px;line-height:1.6;color:${M.slate};">${fmt(t)}</p>`;
  const btn = () => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0 12px;"><tr><td align="center" style="background:${M.teal};border-radius:10px;"><a href="${esc(button.url)}" style="display:block;padding:15px 24px;font-family:${SANS};font-size:16px;font-weight:600;color:${M.ivory};text-decoration:none;">${esc(button.label)}</a></td></tr></table>`;
  let body = "";
  if (eyebrow) body += `<p class="tx-teal" style="margin:0 0 10px;font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:${M.teal};">${esc(eyebrow)}</p>`;
  if (title) body += `<h1 class="tx-ink" style="margin:0 0 18px;font-family:${SERIF};font-weight:normal;font-size:32px;line-height:1.1;color:${M.ink};">${esc(title)}</h1>`;
  body += paragraphs.map(para).join("");
  if (steps.length) {
    body += `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 10px;">` + steps.map((t, i) =>
      `<tr><td valign="top" style="padding:0 0 12px;"><div style="width:28px;height:28px;border-radius:14px;background:${M.tealSoft};color:${M.teal};font-family:${SANS};font-size:13px;font-weight:600;text-align:center;line-height:28px;">${i + 1}</div></td>` +
      `<td class="tx-ink" valign="top" style="padding:2px 0 12px 12px;font-family:${SANS};font-size:16px;line-height:1.5;color:${M.ink};">${fmt(t)}</td></tr>`).join("") + `</table>`;
  }
  if (button && !button.last) body += btn();
  if (note) body += `<p class="tx-slate" style="margin:0 0 20px;font-size:14px;line-height:1.5;color:${M.slate};">${fmt(note)}</p>`;
  if (box) {
    body += `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr><td class="bg-box" style="padding:22px 24px;background:${M.box};border:1px solid ${M.boxLine};border-radius:12px;">`;
    if (box.label) body += `<p class="tx-slate" style="margin:0 0 6px;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:${M.slate};">${esc(box.label)}</p>`;
    if (box.big) body += `<p class="tx-ink" style="margin:0 0 10px;font-family:${SERIF};font-size:30px;line-height:1.15;color:${M.ink};">${esc(box.big)}</p>`;
    for (const line of box.lines ?? []) body += `<p class="tx-ink" style="margin:0 0 4px;font-size:16px;line-height:1.5;color:${M.ink};">${esc(line)}</p>`;
    if (box.text) body += `<p class="tx-slate" style="margin:${box.lines ? "10px" : "0"} 0 0;font-size:15px;line-height:1.6;color:${M.slate};">${fmt(box.text)}</p>`;
    body += `</td></tr></table>`;
  }
  body += after.map(para).join("");
  if (button?.last) body += btn();
  if (link) {
    body += `<hr class="hr" style="border:0;border-top:1px solid ${M.hair};margin:24px 0;">` +
      `<p class="tx-slate" style="margin:0 0 8px;font-size:14px;line-height:1.5;color:${M.slate};">${fmt(link.text)}</p>` +
      `<p style="margin:0 0 14px;font-size:14px;word-break:break-all;"><a class="tx-teal" href="${esc(link.url)}" style="color:${M.teal};">${esc(link.url)}</a></p>` +
      `<p class="tx-slate" style="margin:0;font-size:14px;line-height:1.5;color:${M.slate};">Este enlace es personal. No lo compartas ni reenvíes este correo.</p>`;
  }
  const preheader = paragraphs[0] ?? box?.text ?? subject;
  return `<!doctype html><html lang="es" xml:lang="es"><head><meta charset="utf-8"><meta http-equiv="content-language" content="es"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title><style>${DARK_CSS}</style></head>` +
    `<body class="bg-outer" style="margin:0;padding:0;background:${M.outer};">` +
    `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${M.outer};">${esc(preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg-outer" style="background:${M.outer};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">` +
    `<tr><td style="background:${M.header};border-bottom:2px solid ${M.brass};border-radius:12px 12px 0 0;padding:24px 32px;"><span style="font-family:${SERIF};font-size:26px;color:${M.ivory};">Custodium</span></td></tr>` +
    `<tr><td class="bg-card" style="background:${M.card};border-radius:0 0 12px 12px;padding:32px 32px 28px;font-family:${SANS};color:${M.ink};">${body}</td></tr>` +
    `<tr><td align="center" class="tx-slate" style="padding:28px 24px 8px;font-family:${SANS};font-size:13px;line-height:1.5;color:${M.slate};"><div class="tx-teal" style="font-family:${SERIF};font-size:22px;color:${M.tealDark};">Custodium</div><div style="margin-top:4px;">Guardamos el plan, nunca las claves.</div>${foot ? `<div style="margin-top:12px;">${fmt(foot)}</div>` : ""}</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

export { mailHtml };

async function sendMail(env, to, subject, text, html) {
  if (!env.RESEND_API_KEY) throw new HttpError(500, "mail_not_configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, ...(html ? { html } : {}) }),
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
