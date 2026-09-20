-- Neteja després del deploy que fa servir release_tokens i checkin_tokens
-- (migration-20260920.sql): les columnes velles ja no les llegeix ningú.
-- Aplicar només quan /VERSION de l'entorn ja serveix aquell codi; abans, el
-- codi anterior encara les necessita. Un sol cop, primer a staging:
--   npx wrangler d1 execute custodium-b2c-staging --remote --file=migration-20260920b.sql
--   npx wrangler d1 execute custodium-b2c --remote --file=migration-20260920b.sql
DROP INDEX IF EXISTS recipients_token;
ALTER TABLE recipients DROP COLUMN token_hash;
ALTER TABLE recipients DROP COLUMN token_expires_at;
ALTER TABLE users DROP COLUMN checkin_token_hash;
ALTER TABLE users DROP COLUMN checkin_expires_at;
