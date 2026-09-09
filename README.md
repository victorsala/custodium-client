# Custodium B2C · beta privada

Pla de successió digital per a una persona: què tens, on és, com s'hi accedeix i qui ho ha de rebre quan tu no puguis actuar. Xifrat al navegador. El servidor guarda el pla, mai les claus.

- Web: https://b2c.custodium.space
- Codi: github.com/victorsala/custodium-b2c (repo de treball, privat), publicat sencer com a mirall a [victorsala/custodium-client](https://github.com/victorsala/custodium-client) (client i servidor; llicència a `public/LICENSE`)
- Estat: beta per a ús personal dels fundadors. No és un producte.

---

## 1. Què fa

1. **Un pla.** Una llista d'elements. Cada element és una cosa que algú hauria de saber: un compte, un document, un domini, una wallet. Té un títol, unes instruccions en text lliure i, si cal, fitxers adjunts.
2. **Persones de confiança.** Cada element es pot assignar a una o diverses persones. Cada persona té la seva pròpia frase, diferent de la contrasenya del titular, i només pot obrir els elements que li corresponen.
3. **Entrega.** Si el titular deixa de donar senyals de vida, el sistema l'avisa per correu (i per SMS, si ha posat el mòbil) i, si continua sense respondre, envia a cada persona un enllaç per obrir la seva part. També es pot entregar a mà, en vida.
4. **Còpia fora de Custodium.** "Descargar copia cifrada" (final de "Tu plan") baixa un zip xifrat amb tot i un obridor que funciona sense servidor ni internet. Custodium ha de ser prescindible: si el domini o l'empresa desapareixen, l'entrega es pot fer a mà.

El que **no** fa: no guarda contrasenyes ni claus en clar, no és un gestor de contrasenyes, no és un testament, no custodia actius. No té recuperació de contrasenya: qui la perd, perd el pla.

---

## 2. Com funciona

### 2.1 Principi

Tot el que és sensible es xifra al navegador abans de sortir del dispositiu. El servidor rep i guarda bytes que no pot desxifrar. Això val per al pla, per als fitxers i per als paquets de cada persona.

### 2.2 Claus

**Titular.** D'una sola contrasenya se'n deriven dues claus:

```
masterKey = PBKDF2-SHA256(contrasenya, salt = email, 600.000 iteracions)
encKey    = HKDF(masterKey, "custodium-enc")   → AES-256-GCM. Xifra el pla. No surt mai del navegador.
authHash  = HKDF(masterKey, "custodium-auth")  → 32 bytes. És l'únic que viatja al servidor, per entrar.
```

El servidor guarda `SHA-256(sal aleatòria || authHash)`. Ni amb la base de dades a la mà es pot obtenir la contrasenya sense forçar-la a través de les 600.000 iteracions.

**Persona de confiança.** De la seva frase, normalitzada (minúscules, sense accents, un espai entre paraules): `PBKDF2-SHA256(frase, salt = el seu email, 600.000 iteracions)` → clau AES-256. Es deriva un cop, quan el titular la crea, i es guarda **dins del pla del titular** (per tant xifrada amb encKey), juntament amb la frase mateixa. Així cada desat pot rexifrar el paquet sense tornar a demanar la frase, i el titular la pot tornar a veure. Guardar la frase no afegeix risc criptogràfic: qui pugui llegir el pla ja té la clau derivada. El servidor no veu mai ni l'una ni l'altra.

**Fitxers.** Cada fitxer té una clau aleatòria de 32 bytes. El fitxer xifrat és un sol objecte a R2; la clau viatja dins del pla del titular i dins del paquet de la persona que l'ha de rebre.

### 2.3 Què hi ha al servidor

| On | Què | Pot llegir-ho el servidor? |
| :--- | :--- | :--- |
| D1 `users` | email, mòbil (opcional), hash d'autenticació amb sal, última senyal de vida, terminis | sí (no és sensible) |
| D1 `vaults` | el pla, xifrat amb encKey | no |
| D1 `recipients` | email i mòbil (opcional) de la persona, el seu paquet xifrat, llista d'ids de fitxer | només email, mòbil i ids |
| D1 `files` | id i mida de cada fitxer | sí (només mida) |
| D1 `events` | registre d'activitat: tipus d'acció, email de la persona si escau, país de la petició (mai IP ni user-agent), data | sí (no és sensible) |
| R2 | els bytes xifrats de cada fitxer, sota `userId/fileId` | no |

Ni el nom ni el tipus dels fitxers arriben al servidor: viuen dins del pla.

### 2.4 Format del pla (en clar, dins del navegador)

```json
{
  "v": 2,
  "recipients": [ { "id": "uuid", "name": "Roser", "email": "…", "phone": "+34…|null", "key": "base64", "phrase": "seis palabras", "createdAt": 0 } ],
  "items": [
    { "id": "uuid", "title": "Compte a Indexa", "recipientIds": [ "uuid", "…" ],
      "notes": "text lliure", "files": [ { "id": "uuid", "name": "x.pdf", "size": 1234, "key": "base64" } ],
      "updatedAt": 0 }
  ]
}
```

Es xifra sencer com a `{ "v": 1, "iv": "base64 (12 bytes)", "ct": "base64" }`. Els fitxers es guarden com `iv (12 bytes) || ciphertext`.

### 2.5 Paquets

A cada desat, per a cada persona, el navegador construeix `{ items: [ { title, notes, files: [ { id, name, size, key } ] } ] }` amb els elements que la inclouen (un element pot anar a diverses persones; la clau del fitxer viatja a cada paquet), el xifra amb la clau de la persona i el puja. El servidor guarda el paquet i la llista d'ids de fitxer que referencia (per servir-los després sense poder obrir-los).

### 2.6 Senyal de vida i entrega

- **Senyal de vida:** qualsevol petició autenticada (entrar, editar) o el botó "Sigo aquí" del correu d'avís.
- **Cron diari (08:00 UTC):** per a cada titular amb persones i paquets:
  - si porta ≥ `warn_days` sense senyal → correu d'avís amb enllaç a `/aqui.html`; es repeteix cada 3 dies;
  - si porta ≥ `release_days` i s'han entregat almenys **dos** avisos des de l'última senyal → entrega a totes les persones pendents.
- **Res es desa fins que el correu ha sortit.** Tant l'avís com l'entrega escriuen a la base de dades només després que Resend hagi acceptat el missatge. Si l'enviament falla no es desa res: l'avís no compta, la persona continua pendent i el cron ho torna a provar l'endemà.
- **`warn_count`** compta els avisos entregats i torna a zero amb qualsevol senyal de vida (entrar, qualsevol petició autenticada o el botó "Sigo aquí"). Exigir-ne dos vol dir que una sola incidència d'enviament no pot desencadenar una entrega: cal que el sistema hagi aconseguit avisar el titular dos cops i que ell no hagi respost cap de les dues vegades.
- **Quan hi ha entrega automàtica, el titular rep un correu** (i un SMS, si té mòbil) dient a qui s'ha entregat, per poder anul·lar els enllaços si ha estat un fals positiu. El correu llista les adreces de les persones: el servidor no en sap els noms, que viuen dins del pla xifrat. Si Resend no l'accepta, el cron el torna a intentar cada dia i agrupa en un sol correu totes les entregues pendents d'avisar.
- **Entrega:** es genera un token aleatori de 32 bytes (se'n guarda el hash), vàlid 90 dies, i s'envia a la persona un enllaç a `/abrir.html?t=…`. La persona escriu la frase; el navegador deriva la clau i desxifra el paquet i els fitxers.
- **Anular:** el titular pot anul·lar l'enllaç des de "Personas". Entrar de nou no anul·la res automàticament.
- **Pausa d'emergència:** amb la fila `pause_releases` de la taula `system` (D1) a `'1'`, el cron continua avisant però no entrega res; s'activa amb un `UPDATE`, sense deploy (vegeu §5). Les entregues manuals ("Entregar ahora") no es pausen.
- El botó "Sigo aquí" és un botó de veritat (POST), no l'enllaç: els escàners de correu obren enllaços sols i comptarien com a senyal.
- Els correus mai contenen contingut, només enllaços. Surten de `avisos@custodium.space` via Resend.
- **SMS** (opcional, si hi ha mòbil): al titular, amb l'avís; a la persona, en entregar ("te ha llegado un correo; mira también el spam"). Sense enllaços ni accents. Canal independent del correu: cobreix el filtre de spam i el compte de correu compromès. Un error d'SMS no atura res.

### 2.7 API

```
POST   /api/register                { email, authHash }           201 | 409
POST   /api/login                   { email, authHash }           { token, expiresAt } | 401
DELETE /api/session                 Bearer                        { ok }
DELETE /api/sessions                Bearer                        { ok }   tanca les altres sessions
DELETE /api/account                 { authHash }                  { ok } | 401   esborra el compte sencer (R2, backup i D1)
POST   /api/password                { authHash, newAuthHash, blob, version }  { token, version } | 401 | 409
GET    /api/vault                   Bearer                        { blob, version, updatedAt } | 404
PUT    /api/vault                   { blob, version }             { version } | 409 version_conflict
PUT    /api/files/:id               bytes (octet-stream)          201 | 413 | 507 quota
GET    /api/files/:id               Bearer                        bytes | 404
DELETE /api/files/:id               Bearer                        { ok }
POST   /api/files/reconcile         { ids, version }              { deleted } | 409 version_conflict; orfes de >7 dies no inclosos
GET    /api/events                  Bearer                        { events: [ { kind, detail, country, createdAt } ] }   últims 50
GET    /api/settings                Bearer                        { warnDays, releaseDays, phone, lastSeen }
PUT    /api/settings                { warnDays?, releaseDays?, phone? }  { ok }
GET    /api/recipients              Bearer                        { recipients: [ { id, email, releasedAt, openedAt, expiresAt, revokedAt } ] }
PUT    /api/recipients/:id          { email, phone?, package, fileIds }  { ok }
DELETE /api/recipients/:id          Bearer                        { ok }
POST   /api/recipients/:id/release  Bearer                        { ok }   envia l'enllaç ara
POST   /api/recipients/:id/revoke   Bearer                        { ok }   anul·la l'enllaç
POST   /api/checkin                 { token }                     { ok }   botó del correu d'avís
GET    /api/release/:token          —                             { from, email, package } | 404
GET    /api/release/:token/files/:id  —                           bytes | 404
GET    /api/env                     —                             { env }   "production" | "staging"
```

Sessió: token aleatori de 32 bytes, 24 hores, guardat hashejat; cada petició autenticada la renova, així que només caduca després d'un dia sencer sense obrir el pla. Límits: pla 1 MB, fitxer 50 MB, 1 GB per titular, 20 persones (`too_many_recipients`). Concurrència optimista al pla (`version`): dos dispositius no es trepitgen.

### 2.8 Client

Sense frameworks ni dependències. Tot l'estat viu en memòria: tancar la pestanya tanca el pla; 15 minuts d'inactivitat també. `_headers` fixa una CSP estricta: scripts, estils, fonts i connexions només del propi origen, sense iframes. Les fonts (Fraunces i Inter, variables, subconjunt llatí) són a `public/fonts/`: el client no fa cap petició a tercers. A staging, `app.js` pregunta `/api/env` i mostra una franja fixa d'avís ("Entorno de pruebas · los datos pueden borrarse sin aviso"); a producció no apareix mai.

Fitxers orfes: si es tanca la pestanya a mitja edició, un fitxer pujat pot quedar al servidor sense que cap pla l'apunti. En obrir el pla, el client envia la llista d'ids vius i la versió del pla (`POST /api/files/reconcile`); el servidor només esborra els d'aquell usuari que no hi siguin i tinguin més de 7 dies si aquella versió encara és l'actual. Amb un `409 version_conflict` no esborra res.

---

## 3. Manual d'ús

### Titular

1. **Crear compte.** Email i contrasenya. Els camps surten ja omplerts amb una frase de sis paraules generada al navegador, visible, amb l'avís "Apúntala antes de continuar"; l'enllaç "prefiero escribir la mía" buida els camps, els oculta i exigeix 16+ caràcters. No hi ha recuperació: guarda-la al gestor de contrasenyes.
2. **Afegir elements.** "+ Añadir elemento": què és, persones que l'han de rebre (caselles; cap = només per a tu), instruccions, fitxers (fins a 50 MB). "Listo" xifra i desa al moment. No hi ha botó de desar.
3. **Persones.** "+ Añadir persona": nom, email, mòbil opcional (per a l'SMS d'avís) i frase. La frase la genera sempre el sistema, sis paraules a l'atzar (llista BIP39 en castellà, 2.048 paraules → 66 bits), tipus `ebano deporte nacar cien organo vagar`; no es pot escriure a mà ("Generar otra" en dona una altra). Escriu-les en paper i dona-l'hi en persona; mai per missatge. En obrir, no importen majúscules, accents ni espais. La frase queda guardada dins del teu pla (xifrada, com la resta): "Mostrar frase" la torna a ensenyar després de demanar-te la contrasenya, durant un minut, per comprovar el paper o tornar-lo a escriure.
4. **Terminis.** A "Personas → Entrega por inactividad": primer avís (8 dies per defecte) i entrega (21). L'entrega ha de ser posterior a l'avís. Els dos terminis compten des de l'última activitat o confirmació; entrar o pulsar "Sigo aquí" els reinicia.
5. **Entregar ara.** A cada persona, "Entregar ahora" envia l'enllaç immediatament. Serveix per provar i com a entrega voluntària. "Anular enlace" el desactiva.
6. **Estat.** A "Personas", cada persona mostra un estat concret: *Sin elementos asignados* · *Sin entregar* · *Acceso enviado* · *Acceso abierto* · *Enlace caducado* · *Enlace anulado* (mai "recibido" o "leído": obrir un accés no demostra haver-ho llegit tot). Dins de la fitxa (Editar): Mostrar frase, Entregar ahora / Enviar de nuevo, Anular enlace, Quitar persona. Si hi ha alguna entrega activa, "Tu plan" ho avisa amb una franja en entrar, per si ha estat un fals positiu.
7. **Cuenta.** Email (no es pot canviar: forma part de la derivació de claus), mòbil per als avisos per SMS i canvi de contrasenya. La nova contrasenya es proposa igual que en crear el compte (frase de sis paraules visible, o "prefiero escribir la mía"). El pla es rexifra al navegador amb la nova; persones i fitxers no es toquen; les altres sessions es tanquen. "Cerrar todas las sesiones" tanca el pla a qualsevol altre dispositiu on s'hagi obert, sense tocar la sessió actual. Més endavant, aquí hi aniran dades de contacte i pagament.
8. **Actividad reciente** (a Cuenta). El que el servidor ha registrat del compte (entrades, intents fallits contra el teu email, canvis, avisos, entregues i obertures), amb data, hora i país de la petició — mai IP ni user-agent — per detectar accessos que no reconeguis. Se'n guarden els 200 més recents; se n'ensenyen 50.
9. **Eliminar la cuenta** (final de Cuenta). Demana la contrasenya actual i, després d'una confirmació, esborra el pla, els fitxers (també de la còpia de seguretat), les persones i el registre; els enllaços enviats deixen de funcionar. No es pot desfer.
10. **Una copia fuera de Custodium** (final de "Tu plan", botó "Descargar copia cifrada"). Baixa un zip amb: el teu pla xifrat (`plan.json`), un paquet xifrat per persona (`paquetes/`), tots els fitxers xifrats (`archivos/`), l'obridor `abrir.html` i un `LEEME.txt`. Tot hi és xifrat: el zip es pot deixar en un USB, al núvol o al notari. Torna a baixar-la quan facis canvis importants.

### Si Custodium desapareix (o no hi ha internet)

Amb la còpia exportada n'hi ha prou. Qui la tingui:

1. Descomprimeix el zip i obre `abrir.html` amb qualsevol navegador (doble clic; no cal servidor ni connexió).
2. Selecciona el zip (o la carpeta descomprimida), escriu el seu email i la seva frase (el titular, la seva contrasenya).
3. L'obridor prova d'obrir el pla i cada paquet: AES-GCM rebutja els que no són seus, així que cadascú veu només el que li correspon, i l'obridor no sap de qui és què. Els fitxers es desxifren amb la clau que va dins del paquet.

El zip i el sobre amb la frase han d'estar en mans diferents: cap dels dos, sol, obre res.

### Persona de confiança

1. Rep un correu de `avisos@custodium.space` amb un enllaç.
2. L'obre, escriu la frase que li van donar en persona, i veu els seus elements. Els fitxers es baixen i es desxifren al seu navegador.
3. L'enllaç dura 90 dies. Convé guardar o imprimir el que necessiti.

### Coses que cal saber

- Si el titular perd la contrasenya, el pla és irrecuperable. Si una persona perd la frase, el seu paquet és irrecuperable. Cap de les dues coses la pot resoldre Custodium.
- Recomana a cada persona una segona còpia de la frase en un sobre tancat, en un lloc diferent del paper. Custodium no en pot fer cap còpia útil: la frase només viu dins del pla xifrat del titular, i si el titular ja no hi és, ningú la pot mostrar.
- Canviar l'email d'una persona obliga a posar-li una frase nova (la clau es deriva dels dos).
- Un fitxer tret d'un element només s'esborra del servidor un cop el pla desat ja no l'apunta.
- Entrar a la web reinicia el comptador de senyal de vida i esborra l'avís pendent.
- Màxim 20 persones de confiança per titular.
- El mòbil s'escriu sempre amb prefix internacional (+34…, o 0034…); sense prefix, es rebutja.

---

## 4. Proves

`npm test` executa les proves locals (Node 20, `node --test`, sense dependències): compatibilitat entre `crypto.js` i l'obridor autònom, normalització de frases i telèfons, i que una clau equivocada no obre res. Executa `npm test` abans de cada deploy.

### Prova bàsica (10 minuts)

1. Crear compte. Afegir dos elements, un amb un PDF. Tancar la pestanya, tornar a entrar: tot hi és.
2. Al tauler de Cloudflare, D1 → `custodium-b2c` → Console: `SELECT blob FROM vaults;` → només base64. R2 → `custodium-b2c-files`: objectes sense nom ni extensió.
3. Entrar amb una contrasenya equivocada: "Email o contraseña incorrectos".

### Prova d'entrega (15 minuts)

1. "Personas" → afegir una persona amb un email teu; la frase surt generada ("Generar otra" en dona una altra); apuntar-la en paper.
2. Editar un element, assignar-lo a la persona, adjuntar un fitxer. Listo.
3. "Entregar ahora". Arriba un correu amb l'enllaç.
4. Obrir l'enllaç en una finestra d'incògnit. Escriure la frase: es veu l'element i es baixa el fitxer. Escriure una frase equivocada: "La frase no es correcta".
5. A "Personas": estat "Acceso abierto · data". Dins de la fitxa, "Anular enlace" → l'enllaç deixa de funcionar i l'estat passa a "Enlace anulado".
6. Final de "Tu plan" → "Descargar copia cifrada". Descomprimir, obrir `abrir.html`, seleccionar el zip, entrar amb el teu email i contrasenya (veus tot el pla) i després amb l'email i la frase de la persona (veus només el seu).

### Prova del disparador (1 dia)

1. Posar "Primer aviso 1 día, Entrega 3 días". Sortir i no entrar.
2. L'endemà a les 08:00 UTC arriba "¿sigues ahí?". Pulsar el botó → "Confirmado".
3. Tornar a posar 8 / 21.

### Prova amb curl (sense navegador)

```sh
BASE=https://b2c.custodium.space
HASH=$(openssl rand -base64 32)
curl -s -X POST $BASE/api/register -H 'content-type: application/json' -d "{\"email\":\"jo@example.com\",\"authHash\":\"$HASH\"}"
TOKEN=$(curl -s -X POST $BASE/api/login -H 'content-type: application/json' -d "{\"email\":\"jo@example.com\",\"authHash\":\"$HASH\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s $BASE/api/vault -H "authorization: Bearer $TOKEN"      # {"error":"no_vault"}
```

---

## 5. Desplegament i operació

### Estructura

```
src/index.js        Worker: API + cron
public/             Client estàtic: index.html, app.js, crypto.js, words.js, fflate.js (zip, MIT), style.css, fonts/,
                    abrir.* (persona, amb servidor), aqui.* (check-in), abrir-offline.html (obridor autònom), _headers,
                    README (bilingüe, amb la verificació), LICENSE (source-available) i THIRD_PARTY.md.
                    VERSION l'escriu el deploy (gitignored).
scripts/            public-commit.sh: construeix el commit del mirall públic (vegeu "Desplegar un canvi")
.github/workflows/  ci.yml (tests + deploy a staging) i deploy-production.yml (botó de producció).
                    No es publica al mirall.
schema.sql          Esquema D1 consolidat (l'estat actual; per crear una D1 nova)
wrangler.toml       Bindings (D1 "DB", R2 "FILES" i "FILES_BACKUP"), domini, crons, [vars] i [env.staging]
```

### Requisits (ja fets)

- Cloudflare: zona `custodium.space`; D1 `custodium-b2c`; R2 `custodium-b2c-files` i `custodium-b2c-files-backup` (WEUR); secrets `RESEND_API_KEY` i, per als SMS, `SMS_USER`, `SMS_PASS`, `SMS_FROM` (passarel·la HTTP de siptraffic; si falten, no s'envien SMS i tot continua funcionant).
- Resend: domini `custodium.space` verificat; remitent `avisos@custodium.space`.
- `wrangler` com a dependència local (`npm install -D wrangler`), sense instal·lació global.

### Entorns

| | Producció | Staging |
| :--- | :--- | :--- |
| Web | b2c.custodium.space | b2c-staging.custodium.space |
| Worker | custodium-b2c | custodium-b2c-staging |
| D1 | custodium-b2c | custodium-b2c-staging |
| R2 | custodium-b2c-files i -files-backup | custodium-b2c-staging-files i -backup |
| Es desplega | botó **deploy-production** (Actions) | la CI, a cada push a `main` amb tests verds |
| `/VERSION` | hash del commit del mirall públic | hash del commit de `main` desplegat |

Mateix codi i mateixos crons; dades i secrets separats. `ENV`, `SITE` i `MAIL_FROM` són `[vars]` per entorn a `wrangler.toml`; amb `ENV = "staging"` el client mostra la franja d'avís. Les migracions s'apliquen a cada entorn a mà (a staging: `npx wrangler d1 execute custodium-b2c-staging --remote --file=…`, idealment abans que a producció).

### Desplegar un canvi

```sh
git add -A && git commit -m "què has canviat"
git push              # la CI passa els tests i, a main, desplega staging
```

Comprovar staging: `https://b2c-staging.custodium.space/VERSION` ha de retornar el hash del commit, i la web ha de funcionar (amb la franja d'avís). Producció, sempre amb el botó: GitHub → Actions → **deploy-production** → Run workflow. Mai automàtic; les migracions en queden fora i van sempre abans, a mà i amb confirmació.

El workflow de producció repeteix els tests i fa el que feia `npm run deploy` en local: `scripts/public-commit.sh` pren l'arbre del commit, en treu `CLAUDE.md` i `.github/` i l'encadena a la història del **mirall públic** [victorsala/custodium-client](https://github.com/victorsala/custodium-client) (si l'arbre no ha canviat, reutilitza el commit anterior); escriu el hash resultant a `public/VERSION` (que no es versiona: és un artefacte del deploy), fa `wrangler deploy`, comprova que `/VERSION` respon exactament aquell hash i, només llavors, publica el mirall. Qualsevol pot fer `git checkout` d'aquell hash al repo públic, comparar fitxer a fitxer el contingut de `public/` amb el que serveix `b2c.custodium.space` (instruccions a `public/README.md`) i llegir el Worker (`src/index.js`) desplegat amb aquella mateixa versió. El peu de totes les pàgines mostra la versió; `abrir-offline.html` no la mostra expressament (ha de funcionar sense servidor i la seva CSP no permet connexions).

**Deploy local d'emergència** (si GitHub Actions no hi és): sincronitzar el mirall i fer-ho a mà —

```sh
git fetch origin-public main && git branch -f public-mirror FETCH_HEAD
npm run deploy        # mirall + public/VERSION + wrangler deploy
git push origin-public public-mirror:main
```

### Token de Cloudflare i secrets de GitHub (un sol cop)

Els workflows despleguen amb un token d'API de Cloudflare de permisos mínims. Crear-lo a dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token:

- Account · **Workers Scripts** · Edit
- Account · **D1** · Edit
- Account · **Workers R2 Storage** · Edit
- Zone · **Workers Routes** · Edit
- Account Resources: només aquest compte. Zone Resources: només `custodium.space`.

I a GitHub, custodium-b2c → Settings → Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN` — el token acabat de crear.
- `CLOUDFLARE_ACCOUNT_ID` — l'id del compte (a la barra lateral del tauler; no és secret, però així no viu al repo).
- `MIRROR_PUSH_TOKEN` — fine-grained PAT (github.com → Settings → Developer settings → Fine-grained tokens) amb accés només a `victorsala/custodium-client` i permís **Contents: Read and write**: és el que fa servir el workflow de producció per publicar el mirall.

### Secrets de staging (un sol cop)

En ordre — primer el correu, imprescindible; els SMS opcionals (els tres o cap):

```sh
npx wrangler secret put RESEND_API_KEY --env staging
npx wrangler secret put SMS_USER --env staging
npx wrangler secret put SMS_PASS --env staging
npx wrangler secret put SMS_FROM --env staging
```

### Branca main (sense protecció, de moment)

Les branques protegides no existeixen en repos privats del pla Free de GitHub. De moment `main` no n'exigeix cap: la garantia real és la CI — staging no es desplega sense tests verds, i producció només surt amb el botó. Quan hi hagi un segon col·laborador, activar la protecció (amb GitHub Pro, o fent públic el repo) amb l'status check `test` obligatori, `enforce_admins: true` i flux de PR.

### Pausar les entregues automàtiques

Interruptor d'emergència: amb la fila `pause_releases` de la taula `system` a `'1'`, el cron diari continua enviant avisos d'inactivitat però no entrega cap pla, i ho deixa al log (`entregues en pausa`, visible amb `npx wrangler tail`). El cron la llegeix a cada execució: no cal cap deploy, ni per activar-la ni per desactivar-la — expressament, perquè serveixi també quan no es pot desplegar. Les entregues manuals ("Entregar ahora") no es pausen.

Dues maneres d'activar-la:

```sh
npx wrangler d1 execute custodium-b2c --remote --command "UPDATE system SET value='1' WHERE key='pause_releases'"
```

o al tauler de Cloudflare: D1 → `custodium-b2c` → Console, amb el mateix `UPDATE`. Per desactivar-la, el mateix amb `value='0'`.

### Canvis d'esquema

Escriure un fitxer de migració (p. ex. `migration-YYYYMMDD.sql` amb els `ALTER`/`CREATE`), aplicar-lo **abans** del deploy que el necessiti, i incorporar el canvi a `schema.sql` perquè continuï descrivint l'estat actual:

```sh
npx wrangler d1 execute custodium-b2c --remote --file=migration-YYYYMMDD.sql
```

Les migracions ja aplicades es poden esborrar del repo un cop consolidades; `git log` en conserva l'historial.

### Rate limiting (tauler de Cloudflare, un sol cop)

Zona `custodium.space` → Security → WAF → Rate limiting rules → Create rule:

- Expressió: `(http.host eq "b2c.custodium.space" and http.request.uri.path in {"/api/login" "/api/register" "/api/password"})`
- Característica: IP. Límit: el més estricte que permeti el pla (al pla gratuït, p. ex. 5 peticions per 10 segons). Acció: Block.

### Còpia dels fitxers i restauració

Cada diumenge a les 03:00 UTC, un cron copia a `custodium-b2c-files-backup` els objectes de `custodium-b2c-files` que hi falten (mateixa clau `userId/fileId`). Del backup no s'esborra mai res, ni que l'original hagi desaparegut — amb una única excepció: l'esborrat del compte (`DELETE /api/account`) elimina els fitxers del titular dels dos buckets. El log del cron (`npx wrangler tail`) mostra el recompte de copiats.

**Restaurar un fitxer:** copiar la clau `userId/fileId` del backup al principal:

```sh
npx wrangler r2 object get custodium-b2c-files-backup/USERID/FILEID --file restaurat.bin --remote
npx wrangler r2 object put custodium-b2c-files/USERID/FILEID --file restaurat.bin --remote
```

### Diagnòstic

- Consola del navegador (F12) per al client.
- `npx wrangler tail` per veure els errors del Worker en directe.
- `Authentication error [code: 10000]` a wrangler = token OAuth caducat: `npx wrangler login`.
- `npm: command not found` = un `apt autoremove` pot endur-se el nodejs de nodesource. Solució: `sudo apt install nodejs && sudo apt-mark manual nodejs`.

### Buidar-ho tot

```sh
npx wrangler d1 execute custodium-b2c --remote --command "DELETE FROM sessions; DELETE FROM recipients; DELETE FROM files; DELETE FROM vaults; DELETE FROM users;"
```

R2: tauler → bucket → Objects → seleccionar tot → Delete.

---

## 6. Límits coneguts de la beta

- Una sola contrasenya per titular, sense segon factor.
- Rate limiting via regla al WAF de Cloudflare (`/api/login`, `/api/register`, `/api/password`); vegeu §5.
- Els paquets es refan sencers a cada desat (bé per a pocs elements, no per a milers).
- Els fitxers es pugen i s'exporten sencers en memòria (50 MB per fitxer és el límit pràctic en mòbil; l'exportació d'1 GB necessita un ordinador).
- Sense clau de recuperació ni per al titular ni per a les persones: decisió de disseny, no un oblit. L'exportació és la còpia de seguretat del titular.
- Sense canvi d'email (és la sal de la derivació de claus; canviar-lo equivaldria a crear un compte nou).
- Cap auditoria externa de la criptografia. Els paràmetres són estàndard (PBKDF2 600k, HKDF, AES-256-GCM, WebCrypto natiu), però el codi no l'ha revisat ningú de fora.
