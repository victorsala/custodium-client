-- Custodium B2C · esquema D1 · estat consolidat (9 setembre 2026, inclou migration-20260908, -20260908b i -20260909)
-- Crea la base de dades tal com és avui. Per a una D1 nova:
--   npx wrangler d1 execute <nom> --remote --file=schema.sql
-- La base de dades de producció ja té tot això aplicat (migracions v1–v5, consolidades aquí).
-- Els canvis futurs es fan amb fitxers de migració nous i s'incorporen aquí.
--
-- El servidor no guarda mai contrasenyes, frases ni contingut en clar.

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,       -- uuid
  email               TEXT UNIQUE NOT NULL,   -- sempre en minúscules; és la sal de la derivació de claus
  phone               TEXT,                   -- mòbil per a l'SMS d'avís, opcional, format +34…
  auth_salt           TEXT NOT NULL,          -- 16 bytes aleatoris, base64
  auth_hash           TEXT NOT NULL,          -- SHA-256(auth_salt || authHash), base64
  last_seen           INTEGER,                -- última activitat o confirmació (epoch s)
  warned_at           INTEGER,                -- últim avís d'inactivitat enviat
  warn_days           INTEGER NOT NULL DEFAULT 8,
  release_days        INTEGER NOT NULL DEFAULT 21,
  checkin_token_hash  TEXT,                   -- botó "Sigo aquí" del correu
  checkin_expires_at  INTEGER,
  created_at          INTEGER NOT NULL,
  -- Al final perquè va arribar amb un ALTER TABLE (migration-20260908) i així
  -- una D1 nova queda igual que la de producció, columna per columna.
  warn_count          INTEGER NOT NULL DEFAULT 0  -- avisos entregats des de l'última senyal; cal >= 2 per entregar
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

CREATE TABLE IF NOT EXISTS recipients (
  id                TEXT PRIMARY KEY,         -- uuid generat al client
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email             TEXT NOT NULL,            -- cal per enviar-li l'enllaç
  phone             TEXT,                     -- SMS "revisa el correo", opcional
  package           TEXT,                     -- JSON opac, xifrat amb la clau de la persona
  file_ids          TEXT NOT NULL DEFAULT '[]', -- ids de fitxer que el paquet referencia (uuids opacs)
  released_at       INTEGER,
  token_hash        TEXT,                     -- SHA-256 de l'enllaç d'obertura
  token_expires_at  INTEGER,
  opened_at         INTEGER,
  revoked_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS recipients_user ON recipients(user_id);
CREATE INDEX IF NOT EXISTS recipients_token ON recipients(token_hash);

-- Registre d'activitat del compte, escrit pel servidor. Mai IP ni user-agent:
-- només el país. Es conserven els 200 events més recents per usuari.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                 -- login, login_failed, password_changed, sessions_closed, phone_changed,
                                             -- settings_changed, release_manual, release_auto, release_revoked,
                                             -- release_opened, warning_sent, checkin
  detail      TEXT,                          -- email de la persona, si escau
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
