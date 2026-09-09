-- Avís al titular d'una entrega automàtica. NULL significa que encara cal
-- avisar-lo; el cron ho reintenta fins que Resend accepta el correu.
--
-- SQLite/D1 no admet ADD COLUMN IF NOT EXISTS: aquesta migració s'ha d'aplicar
-- una sola vegada, com la resta de migracions ADD COLUMN d'aquest repositori.
-- Abans de repetir-la, comprova-ho amb:
--   npx wrangler d1 execute custodium-b2c --remote --command "PRAGMA table_info(recipients)"
ALTER TABLE recipients ADD COLUMN owner_notified_at INTEGER;

-- Backfill: les entregues fetes abans d'aquesta columna ja es van comunicar
-- (o eren manuals, que no s'avisen). Sense això, el primer cron enviaria al
-- titular un "se ha entregado tu plan" per entregues velles.
UPDATE recipients SET owner_notified_at = released_at WHERE released_at IS NOT NULL;
