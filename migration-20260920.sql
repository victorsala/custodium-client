-- Entrega insistent (README §2.6): cron dos cops al dia, avís al titular a cada
-- execució, recordatoris a les persones amb un enllaç nou a cada correu (i els
-- anteriors vàlids), SMS al titular com a màxim un al dia.
--
-- Additiva: el codi anterior continua funcionant amb ella aplicada. Les
-- columnes que deixen de servir (users.checkin_*, recipients.token_*) es treuen
-- després del deploy amb migration-20260920b.sql. Aplicar UN SOL COP (els
-- ALTER TABLE no són idempotents), primer a staging:
--   npx wrangler d1 execute custodium-b2c-staging --remote --file=migration-20260920.sql
--   npx wrangler d1 execute custodium-b2c --remote --file=migration-20260920.sql

-- Enllaços d'obertura: un per correu enviat (entrega, "Enviar de nuevo",
-- recordatori). Tots valen fins que caduquen o el titular anul·la l'accés.
CREATE TABLE IF NOT EXISTS release_tokens (
  token_hash    TEXT PRIMARY KEY,           -- SHA-256 del token; el token en clar només va dins del correu
  recipient_id  TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL            -- 90 dies des del correu que el porta
);
CREATE INDEX IF NOT EXISTS release_tokens_recipient ON release_tokens(recipient_id);
-- Els enllaços ja enviats continuen funcionant.
INSERT OR IGNORE INTO release_tokens (token_hash, recipient_id, created_at, expires_at)
  SELECT token_hash, id, released_at, token_expires_at FROM recipients
  WHERE token_hash IS NOT NULL AND released_at IS NOT NULL AND token_expires_at IS NOT NULL;

-- Botons "Sigo aquí": un per avís enviat. Un val mentre no ha caducat i no hi
-- ha hagut cap senyal de vida després d'enviar-lo (created_at > users.last_seen).
CREATE TABLE IF NOT EXISTS checkin_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkin_tokens_user ON checkin_tokens(user_id);
INSERT OR IGNORE INTO checkin_tokens (token_hash, user_id, created_at, expires_at)
  SELECT checkin_token_hash, id, warned_at, checkin_expires_at FROM users
  WHERE checkin_token_hash IS NOT NULL AND warned_at IS NOT NULL AND checkin_expires_at IS NOT NULL;

ALTER TABLE users ADD COLUMN warn_sms_at INTEGER;                          -- últim SMS al titular (avís o notícia d'entrega)
ALTER TABLE recipients ADD COLUMN release_mode TEXT;                        -- 'auto' | 'manual' mentre released_at no és NULL
ALTER TABLE recipients ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0; -- recordatoris enviats (o donats per fets) des de l'entrega

-- Backfill: les entregues existents no reben recordatoris (com si fossin
-- manuals) tret que hi hagi constància que van ser automàtiques (el correu al
-- titular va sortir després de l'entrega). Així el primer cron no escriu a
-- ningú que el titular no esperi.
UPDATE recipients
  SET release_mode = CASE WHEN owner_notified_at IS NOT NULL AND owner_notified_at > released_at THEN 'auto' ELSE 'manual' END
  WHERE released_at IS NOT NULL;
