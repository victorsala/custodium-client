#!/bin/sh
# Visites de les pàgines de visitant (taula stats, README §2.3): per dia i pàgina, vistes,
# lectures amb temps i segons mitjans de lectura; després un resum per origen, per país i per
# campanya, com un embut: portada (login), crear cuenta (pas 1), codi (pas 2 mostrat),
# altes, trucades demanades (clic a l'enllaç de cal.com), % d'altes sobre la portada, altres
# pàgines i segons mitjans.
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
Q1="SELECT day, CASE path WHEN '/alta/codigo' THEN 'paso: código enviado' WHEN '/alta' THEN 'paso: cuenta creada' WHEN '/llamada' THEN 'paso: llamada pedida' ELSE path END AS path, SUM(views) AS vistes, SUM(reads) AS lectures, CASE WHEN SUM(reads) > 0 THEN SUM(seconds) / SUM(reads) ELSE NULL END AS segons_mitjans FROM stats WHERE day >= $SINCE GROUP BY day, path ORDER BY day DESC, vistes DESC"
Q2="SELECT source AS origen, SUM(views) AS pagines_vistes FROM stats WHERE day >= $SINCE GROUP BY source ORDER BY pagines_vistes DESC"
Q3="SELECT country AS pais, SUM(views) AS pagines_vistes FROM stats WHERE day >= $SINCE GROUP BY country ORDER BY pagines_vistes DESC LIMIT 15"
Q4="SELECT campaign AS campanya, SUM(CASE WHEN path = '/' THEN views ELSE 0 END) AS portada, SUM(CASE WHEN path = '/crear-cuenta' THEN views ELSE 0 END) AS crear_cuenta, SUM(CASE WHEN path = '/crear-cuenta/codigo' THEN views ELSE 0 END) AS pas_codi, SUM(CASE WHEN path = '/alta' THEN views ELSE 0 END) AS altes, SUM(CASE WHEN path = '/llamada' THEN views ELSE 0 END) AS llamadas, ROUND(100.0 * SUM(CASE WHEN path = '/alta' THEN views ELSE 0 END) / NULLIF(SUM(CASE WHEN path = '/' THEN views ELSE 0 END), 0), 1) AS pct_altes, SUM(CASE WHEN path NOT IN ('/', '/crear-cuenta', '/crear-cuenta/codigo', '/alta', '/alta/codigo', '/llamada') THEN views ELSE 0 END) AS altres_pagines, CASE WHEN SUM(reads) > 0 THEN SUM(seconds) / SUM(reads) ELSE NULL END AS segons_mitjans FROM stats WHERE day >= $SINCE AND campaign != '' GROUP BY campaign ORDER BY portada DESC"
exec npx wrangler d1 execute "$DB" --remote --command "$Q1; $Q2; $Q3; $Q4"
