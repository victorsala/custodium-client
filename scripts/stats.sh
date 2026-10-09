#!/bin/sh
# Visites de les pàgines de visitant (taula stats, README §2.3): per dia i pàgina, vistes,
# lectures amb temps i segons mitjans de lectura; després un resum per origen, per país i per
# campanya (portada, altres pàgines, segons mitjans, codis demanats, altes i % d'altes).
# Últims 14 dies per defecte.   npm run stats          npm run stats -- 30          npm run stats -- --staging
set -e
DB=custodium-b2c
DAYS=14
for a in "$@"; do
  case "$a" in
    --staging) DB=custodium-b2c-staging ;;
    ''|*[!0-9]*) echo "argument no reconegut: $a" >&2; exit 1 ;;
    *) DAYS=$a ;;
  esac
done
SINCE="date('now', '-$DAYS days')"
Q1="SELECT day, path, SUM(views) AS vistes, SUM(reads) AS lectures, CASE WHEN SUM(reads) > 0 THEN SUM(seconds) / SUM(reads) ELSE NULL END AS segons_mitjans FROM stats WHERE day >= $SINCE GROUP BY day, path ORDER BY day DESC, vistes DESC"
Q2="SELECT source AS origen, SUM(views) AS vistes FROM stats WHERE day >= $SINCE GROUP BY source ORDER BY vistes DESC"
Q3="SELECT country AS pais, SUM(views) AS vistes FROM stats WHERE day >= $SINCE GROUP BY country ORDER BY vistes DESC LIMIT 15"
Q4="SELECT campaign AS campanya, SUM(CASE WHEN path = '/' THEN views ELSE 0 END) AS portada, SUM(CASE WHEN path NOT IN ('/', '/alta', '/alta/codigo') THEN views ELSE 0 END) AS altres_pagines, CASE WHEN SUM(reads) > 0 THEN SUM(seconds) / SUM(reads) ELSE NULL END AS segons_mitjans, SUM(CASE WHEN path = '/alta/codigo' THEN views ELSE 0 END) AS codis, SUM(CASE WHEN path = '/alta' THEN views ELSE 0 END) AS altes, ROUND(100.0 * SUM(CASE WHEN path = '/alta' THEN views ELSE 0 END) / NULLIF(SUM(CASE WHEN path = '/' THEN views ELSE 0 END), 0), 1) AS pct_altes FROM stats WHERE day >= $SINCE AND campaign != '' GROUP BY campaign ORDER BY portada DESC"
exec npx wrangler d1 execute "$DB" --remote --command "$Q1; $Q2; $Q3; $Q4"
