-- Custodium B2C · esquema D1 · estat consolidat (9 setembre 2026, inclou migration-20260908, -20260908b, -20260909, -20260909b, -20260909c i -20260909d)
-- Crea la base de dades tal com és avui. Per a una D1 nova:
--   npx wrangler d1 execute <nom> --remote --file=schema.sql
-- La base de dades de producció ja té tot això aplicat (migracions v1–v5, consolidades aquí).
-- Els canvis futurs es fan amb fitxers de migració nous i s'incorporen aquí.
--
-- El servidor no guarda mai contrasenyes, frases ni contingut en clar.

-- Ordre de columnes = el de producció (PRAGMA table_info): les afegides amb
-- ALTER TABLE van al final, en l'ordre en què es van afegir. Així una D1 nova
-- queda igual que la de producció, columna per columna.
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,       -- uuid
  email               TEXT UNIQUE NOT NULL,   -- sempre en minúscules
  auth_salt           TEXT NOT NULL,          -- 16 bytes aleatoris, base64
  auth_hash           TEXT NOT NULL,          -- SHA-256(auth_salt || authHash), base64
  created_at          INTEGER NOT NULL,
  last_seen           INTEGER,                -- última activitat o confirmació (epoch s)
  warned_at           INTEGER,                -- últim avís d'inactivitat enviat
  warn_days           INTEGER NOT NULL DEFAULT 8,
  release_days        INTEGER NOT NULL DEFAULT 21,
  checkin_token_hash  TEXT,                   -- botó "Sigo aquí" del correu
  checkin_expires_at  INTEGER,
  -- Afegides amb ALTER TABLE, en aquest ordre:
  phone               TEXT,                       -- mòbil per a l'SMS d'avís, opcional, format +34…
  warn_count          INTEGER NOT NULL DEFAULT 0, -- (migration-20260908) avisos entregats des de l'última senyal; cal >= 2 per entregar
  kdf_salt            TEXT                        -- (migration-20260909c) sal de la derivació de claus del titular:
                                                  -- HMAC(SALT_PEPPER, email) truncat a 16 bytes, base64, fixat a l'alta
                                                  -- (README §2.2). NULL només en files anteriors a la migració, que s'esborren
);

-- Altes en curs: el compte no es crea fins que el codi enviat per correu ha
-- tornat (README §2.7). Una fila per email; el cron diari esborra les que ja
-- no serveixen (codi caducat i finestra del límit passada).
CREATE TABLE IF NOT EXISTS pending_signups (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT,                         -- "sal.hash" (base64): SHA-256(sal || codi). NULL si l'email ja tenia compte
  attempts    INTEGER NOT NULL DEFAULT 0,   -- verificacions fallides del codi vigent; a 5 cal demanar-ne un de nou
  sends       INTEGER NOT NULL DEFAULT 0,   -- codis enviats dins la finestra d'una hora que comença a created_at (màxim 3)
  expires_at  INTEGER,                      -- caducitat del codi (15 min)
  created_at  INTEGER NOT NULL              -- inici de la finestra del límit de codis
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,               -- SHA-256 del token; el token en clar només el té el client
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS vaults (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  blob        TEXT NOT NULL,                  -- JSON opac {"v":1,"iv":"…","ct":"…"}, xifrat amb la clau del titular
  version     INTEGER NOT NULL,               -- concurrència optimista
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,               -- uuid generat al client; els bytes xifrats són a R2 sota userId/id
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  size        INTEGER NOT NULL,               -- bytes xifrats; el servidor no sap nom ni tipus
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS files_user ON files(user_id);

-- Mateix criteri que users: ordre de producció, afegides amb ALTER TABLE al final.
CREATE TABLE IF NOT EXISTS recipients (
  id                TEXT PRIMARY KEY,         -- uuid generat al client
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,            -- cal per enviar-li l'enllaç
  package           TEXT,                     -- JSON opac, xifrat amb la clau de la persona
  file_ids          TEXT NOT NULL DEFAULT '[]', -- ids de fitxer que el paquet referencia (uuids opacs)
  released_at       INTEGER,
  token_hash        TEXT,                     -- SHA-256 de l'enllaç d'obertura
  token_expires_at  INTEGER,
  opened_at         INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  -- Afegides amb ALTER TABLE, en aquest ordre:
  phone             TEXT,                     -- SMS "revisa el correo", opcional
  revoked_at        INTEGER,
  owner_notified_at INTEGER                   -- (migration-20260909b) correu al titular sobre una entrega automàtica, quan Resend l'ha acceptat
);

CREATE INDEX IF NOT EXISTS recipients_user ON recipients(user_id);
CREATE INDEX IF NOT EXISTS recipients_token ON recipients(token_hash);

-- Registre d'activitat del compte, escrit pel servidor. Mai IP ni user-agent:
-- només el país. Es conserven els 200 events més recents per usuari.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                 -- login, login_failed, password_changed, email_changed, sessions_closed,
                                             -- phone_changed, settings_changed, release_manual, release_auto,
                                             -- release_revoked, release_opened, warning_sent, checkin
  detail      TEXT,                          -- email de la persona, si escau (a email_changed, el correu nou)
  country     TEXT,                          -- request.cf.country de la petició que l'origina
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS events_user_created ON events(user_id, created_at);

-- Configuració d'operació, una fila per clau. Avui només l'interruptor
-- d'emergència: amb pause_releases = '1' el cron avisa però no entrega (README §5).
CREATE TABLE IF NOT EXISTS system (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

INSERT OR IGNORE INTO system (key, value) VALUES ('pause_releases', '0');
