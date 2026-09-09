-- Registre d'activitat del compte, escrit pel servidor.
-- Mai IP ni user-agent: només el país (request.cf.country) i el detall mínim.
-- Es conserven els 200 events més recents per usuari (retallat a logEvent).
--
-- Aplicar amb:
--   npx wrangler d1 execute custodium-b2c --remote --file=migration-20260908b.sql

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  detail      TEXT,
  country     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS events_user_created ON events(user_id, created_at);
