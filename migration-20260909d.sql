-- Verificació de l'email a l'alta (README §2.7 i §3): el compte no es crea
-- fins que el codi enviat per correu ha tornat. Una fila per email en curs.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS). Aplicar amb:
--   npx wrangler d1 execute custodium-b2c-staging --remote --file=migration-20260909d.sql
--   npx wrangler d1 execute custodium-b2c --remote --file=migration-20260909d.sql
CREATE TABLE IF NOT EXISTS pending_signups (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT,                         -- "sal.hash" (base64): SHA-256(sal || codi). NULL si l'email ja tenia compte
  attempts    INTEGER NOT NULL DEFAULT 0,   -- verificacions fallides del codi vigent; a 5 cal demanar-ne un de nou
  sends       INTEGER NOT NULL DEFAULT 0,   -- codis enviats dins la finestra d'una hora que comença a created_at (màxim 3)
  expires_at  INTEGER,                      -- caducitat del codi (15 min)
  created_at  INTEGER NOT NULL              -- inici de la finestra del límit de codis
);
