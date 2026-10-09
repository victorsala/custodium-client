#!/bin/sh
# Visites de les pàgines de visitant (taula stats, README §2.3): per dia i pàgina, vistes,
# lectures amb temps i segons mitjans de lectura; després un resum per origen, per país i per
# campanya, com un embut: portada (login), crear cuenta (pas 1), codi (pas 2 mostrat),
# altes, trucades demanades (clic a l'enllaç de cal.com), % d'altes sobre la portada, altres
# pàgines i segons mitjans.
#
#   npm run stats                         últims 14 dies
#   npm run stats -- 30                   últims 30 dies
#   npm run stats -- --desde 2026-10-10 --fins 2026-10-12     un interval de dates (UTC)
#   npm run stats -- --campanya ads-octubre                   només aquesta campanya
#   npm run stats -- 7 --campanya ads-octubre --staging       tot combinable; --staging mira staging
#   npm run stats -- ajuda                                    què vol dir cada opció i cada columna
set -e
ajuda() {
  cat <<'TXT'
npm run stats [-- opcions]      Visites del web (taula stats de D1, README §2.3). Sense opcions: producció, últims 14 dies.

Opcions (es poden combinar, en qualsevol ordre):
  N                       Els últims N dies (per exemple 7 o 30). Sense número, 14.
  --desde AAAA-MM-DD      Des d'aquest dia (inclòs), en lloc dels últims N dies.
  --fins AAAA-MM-DD       Fins a aquest dia (inclòs). Els dies són UTC, com els del cron.
  --campanya NOM          Només les visites d'aquesta campanya (l'utm_campaign de l'anunci, en minúscules,
                          xifres, _ i -). També --campaign o -c.
  --staging               Mira la base de dades de staging en lloc de la de producció.
  --help, -h, ajuda       Aquesta ajuda.

Exemples:
  npm run stats -- 7
  npm run stats -- --desde 2026-10-10 --fins 2026-10-12
  npm run stats -- --campanya ads-octubre
  npm run stats -- 30 --campanya ads-octubre --staging

Què surt (quatre taules):
  1. Per dia i pàgina
     vistes          Càrregues de la pàgina (una per càrrega). Les pantalles de la portada compten a part:
                     "/" el login, "/crear-cuenta" el pas 1 de l'alta, "/crear-cuenta/codigo" el pas 2.
                     Les files "paso: …" no són pàgines sinó fets que suma el servidor o un clic:
                     código enviado (s'ha enviat un codi d'alta), cuenta creada, llamada pedida (clic a cal.com).
     lectures        Càrregues que a més han enviat temps: la pàgina ha estat visible almenys un segon.
                     Lectures <= vistes; la diferència són càrregues tancades abans d'un segon o en segon pla.
     segons_mitjans  Segons visibles de mitjana, només sobre les lectures (segons sumats / lectures).
  2. Per origen      Pàgines vistes en total segons d'on ve la visita: anuncio (URL amb utm o gclid, o campanya
                     arrossegada amb ?c=), buscador, interno (enllaç de custodium.space sense campanya),
                     directo (sense referent), otro.
  3. Per país        Pàgines vistes per país de la connexió (ZZ si no se sap).
  4. Per campanya (embut; només surt si hi ha visites amb campanya)
     portada         Càrregues del login amb aquesta campanya.
     crear_cuenta    Vegades que s'ha obert el pas 1 de l'alta.
     pas_codi        Vegades que s'ha arribat al pas 2 (el codi ja enviat).
     altes           Comptes creats.
     llamadas        Clics a l'enllaç per reservar 15 minuts (la reserva en si la sap Cal.com).
     pct_altes       altes / portada, en %.
     altres_pagines  Vistes de cómo funciona, seguridad, código, preguntas i legal.
     segons_mitjans  Segons visibles de mitjana sobre totes les lectures de la campanya.

Res d'això identifica ningú: són sumes per dia, pàgina, origen, campanya i país. No hi ha visitants únics,
expressament (caldria un identificador), ni cap dada associada a cap compte.
TXT
}
DB=custodium-b2c
DAYS=14
DESDE=""
FINS=""
CAMPANYA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h|help|ajuda) ajuda; exit 0 ;;
    --staging) DB=custodium-b2c-staging ;;
    --desde) shift; DESDE=$1 ;;
    --fins) shift; FINS=$1 ;;
    --campanya|--campaign|-c) shift; CAMPANYA=$1 ;;
    ''|*[!0-9]*) echo "argument no reconegut: $1" >&2; exit 1 ;;
    *) DAYS=$1 ;;
  esac
  shift
done
# Els valors van dins del SQL: només formes tancades.
for d in "$DESDE" "$FINS"; do
  case "$d" in ''|[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;; *) echo "data no vàlida (cal YYYY-MM-DD): $d" >&2; exit 1 ;; esac
done
case "$CAMPANYA" in
  '') ;;
  *[!a-z0-9_-]*) echo "campanya no vàlida (lletres minúscules, xifres, _ i -): $CAMPANYA" >&2; exit 1 ;;
esac

if [ -n "$DESDE" ]; then WHERE="day >= '$DESDE'"; else WHERE="day >= date('now', '-$DAYS days')"; fi
[ -n "$FINS" ] && WHERE="$WHERE AND day <= '$FINS'"
[ -n "$CAMPANYA" ] && WHERE="$WHERE AND campaign = '$CAMPANYA'"

LABEL="CASE path WHEN '/alta/codigo' THEN 'paso: código enviado' WHEN '/alta' THEN 'paso: cuenta creada' WHEN '/llamada' THEN 'paso: llamada pedida' ELSE path END"
Q1="SELECT day, $LABEL AS path, SUM(views) AS vistes, SUM(reads) AS lectures, CASE WHEN SUM(reads) > 0 THEN SUM(seconds) / SUM(reads) ELSE NULL END AS segons_mitjans FROM stats WHERE $WHERE GROUP BY day, path ORDER BY day DESC, vistes DESC"
Q2="SELECT source AS origen, SUM(views) AS pagines_vistes FROM stats WHERE $WHERE GROUP BY source ORDER BY pagines_vistes DESC"
Q3="SELECT country AS pais, SUM(views) AS pagines_vistes FROM stats WHERE $WHERE GROUP BY country ORDER BY pagines_vistes DESC LIMIT 15"
Q4="SELECT campaign AS campanya, SUM(CASE WHEN path = '/' THEN views ELSE 0 END) AS portada, SUM(CASE WHEN path = '/crear-cuenta' THEN views ELSE 0 END) AS crear_cuenta, SUM(CASE WHEN path = '/crear-cuenta/codigo' THEN views ELSE 0 END) AS pas_codi, SUM(CASE WHEN path = '/alta' THEN views ELSE 0 END) AS altes, SUM(CASE WHEN path = '/llamada' THEN views ELSE 0 END) AS llamadas, ROUND(100.0 * SUM(CASE WHEN path = '/alta' THEN views ELSE 0 END) / NULLIF(SUM(CASE WHEN path = '/' THEN views ELSE 0 END), 0), 1) AS pct_altes, SUM(CASE WHEN path NOT IN ('/', '/crear-cuenta', '/crear-cuenta/codigo', '/alta', '/alta/codigo', '/llamada') THEN views ELSE 0 END) AS altres_pagines, CASE WHEN SUM(reads) > 0 THEN SUM(seconds) / SUM(reads) ELSE NULL END AS segons_mitjans FROM stats WHERE $WHERE AND campaign != '' GROUP BY campaign ORDER BY portada DESC"
echo "stats · $DB · $WHERE"
exec npx wrangler d1 execute "$DB" --remote --command "$Q1; $Q2; $Q3; $Q4"
