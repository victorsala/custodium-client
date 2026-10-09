-- 2026-10-08 · comptador de visites agregat (README §2.3). Aplicar abans del deploy que porta /api/stats.
-- Visites de les pàgines de visitant (public/stats.js → POST /api/stats) i passos de l'alta
-- (/alta/codigo, /alta): agregat per dia, pàgina, origen, campanya i país. Cap fila per
-- visitant, cap identificador: només sumes.
CREATE TABLE IF NOT EXISTS stats (
  day      TEXT NOT NULL,                  -- YYYY-MM-DD (UTC)
  path     TEXT NOT NULL,                  -- "/", "/como-funciona", "/seguridad", "/codigo", "/preguntas", "/legal", "/alta/codigo", "/alta"
  source   TEXT NOT NULL,                  -- anuncio | buscador | interno | directo | otro
  campaign TEXT NOT NULL DEFAULT '',       -- utm_campaign normalitzat ([a-z0-9_-]{1,32}), '' si no n'hi ha, "otra" passat el límit diari
  country  TEXT NOT NULL,                  -- request.cf.country, o ZZ
  views    INTEGER NOT NULL DEFAULT 0,     -- vistes (una per càrrega; als passos de l'alta, un per pas)
  seconds  INTEGER NOT NULL DEFAULT 0,     -- segons visibles sumats (una lectura per càrrega, 1.800 com a màxim)
  reads    INTEGER NOT NULL DEFAULT 0,     -- lectures amb temps; mitjana = seconds / reads
  PRIMARY KEY (day, path, source, campaign, country)
);
