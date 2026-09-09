-- Custodium B2C · migració 2026-09-08
--
-- Comptador d'avisos d'inactivitat entregats. S'incrementa només quan Resend ha
-- acceptat el correu d'avís, i torna a zero amb qualsevol senyal de vida (entrar,
-- qualsevol petició autenticada o el botó "Sigo aquí"). L'entrega automàtica
-- necessita warn_count >= 2: així una incidència d'enviament no pot, tota sola,
-- desencadenar una entrega.
--
--   npx wrangler d1 execute custodium-b2c --remote --file=migration-20260908.sql
--
-- Els comptes existents comencen a 0. Un titular que ara mateix estigués en el
-- termini d'entrega rebrà dos avisos més abans de cap entrega: és el comportament
-- que volem, perquè cap dels avisos anteriors es va confirmar com a entregat.

ALTER TABLE users ADD COLUMN warn_count INTEGER NOT NULL DEFAULT 0;
