# Custodium B2C · beta

Plan de sucesión digital para una persona: qué tienes, dónde está, cómo se accede y quién debe recibirlo cuando tú no puedas actuar. Cifrado en el navegador. El servidor guarda el plan, nunca las claves.

- Web: https://custodium.space
- Código: github.com/victorsala/custodium-b2c (repo de trabajo, privado), publicado entero como espejo en [victorsala/custodium-client](https://github.com/victorsala/custodium-client) (cliente y servidor; licencia en `public/LICENSE`)
- Estado: beta para uso personal de los fundadores. No es un producto.

---

## 1. Qué hace

1. **Un plan.** Una lista de elementos. Cada elemento es algo que alguien debería saber: una cuenta, un documento, un dominio, una wallet. Tiene un título, unas instrucciones en texto libre y, si hace falta, archivos adjuntos.
2. **Personas de confianza.** Cada elemento puede asignarse a una o varias personas. Cada persona tiene su propia frase, distinta de la contraseña del titular, y solo puede abrir los elementos que le corresponden.
3. **Entrega.** Si el titular deja de dar señales de vida, el sistema le avisa por correo (y por SMS, si ha puesto el móvil) y, si sigue sin responder, envía a cada persona un enlace para abrir su parte. También se puede entregar a mano, en vida.
4. **Copia fuera de Custodium.** "Descargar copia cifrada" (en "Cuenta") descarga un zip cifrado con todo y un abridor que funciona sin servidor ni internet. Custodium debe ser prescindible: si el dominio o la empresa desaparecen, la entrega puede hacerse a mano.

Lo que **no** hace: no guarda contraseñas ni claves en claro, no es un gestor de contraseñas, no es un testamento, no custodia activos. No tiene recuperación de contraseña: quien la pierde, pierde el plan.

---

## 2. Cómo funciona

### 2.1 Principio

Todo lo sensible se cifra en el navegador antes de salir del dispositivo. El servidor recibe y guarda bytes que no puede descifrar. Esto vale para el plan, para los archivos y para los paquetes de cada persona.

### 2.2 Claves

**Titular.** De una sola contraseña se derivan dos claves:

```
masterKey = PBKDF2-SHA256(contraseña, salt = sal de la cuenta, 600.000 iteraciones)
encKey    = HKDF(masterKey, "custodium-enc")   → AES-256-GCM. Cifra el plan. No sale nunca del navegador.
authHash  = HKDF(masterKey, "custodium-auth")  → 32 bytes. Es lo único que viaja al servidor, para entrar.
```

La **sal de la cuenta** son 16 bytes (base64) que da el servidor: antes de crear la cuenta, de entrar o de cambiar la contraseña, el cliente la pide a `GET /api/salt?email=` y deriva con ella. Para un email **sin** cuenta, la respuesta es `HMAC-SHA256(SALT_PEPPER, email)` truncado a 16 bytes, con `SALT_PEPPER` un secreto del Worker. En el alta, el servidor guarda exactamente ese valor en `users.kdf_salt`, y para un email **con** cuenta devuelve el que tiene guardado. Así la respuesta es idéntica antes y después de registrar un email: `/api/salt` no puede servir para saber si alguien tiene cuenta. (Si la sal real fuera aleatoria, la diferencia entre el HMAC de antes y la aleatoria de después delataría la existencia de la cuenta.) La sal no es secreta, pero sin el pepper nadie de fuera puede calcularla, es única por email, y dos titulares con la misma contraseña no comparten ninguna clave. Se guarda en la fila, en lugar de recalcularla, para que la cuenta sobreviva a un cambio de pepper y a un cambio de correo: una vez fijada, manda la fila. (Tras un cambio de correo, `/api/salt` del correo nuevo devuelve la sal fijada, no el HMAC del correo nuevo: quien compare las dos puede deducir que ese correo es de una cuenta que nació con otra dirección. Es el precio de no recifrar el plan; asumido.) La copia exportada lleva la sal dentro de `plan.json` para que el abridor autónomo funcione sin servidor.

El servidor guarda `SHA-256(sal aleatoria || authHash)` (una segunda sal, `auth_salt`, independiente de la de derivación). Ni con la base de datos en la mano se puede obtener la contraseña sin forzarla a través de las 600.000 iteraciones; y dos titulares con la misma contraseña no comparten ninguna clave.

**Persona de confianza.** De su frase, normalizada (minúsculas, sin acentos, un espacio entre palabras): `PBKDF2-SHA256(frase, salt = su email, 600.000 iteraciones)` → clave AES-256. Se deriva una vez, cuando el titular la crea, y se guarda **dentro del plan del titular** (por tanto cifrada con encKey), junto con la frase misma. Así cada guardado puede recifrar el paquete sin volver a pedir la frase, y el titular puede volver a verla. Guardar la frase no añade riesgo criptográfico: quien pueda leer el plan ya tiene la clave derivada. El servidor no ve nunca ni la una ni la otra.

**Archivos.** Cada archivo tiene una clave aleatoria de 32 bytes. El archivo cifrado es un solo objeto en R2; la clave viaja dentro del plan del titular y dentro del paquete de la persona que debe recibirlo.

### 2.3 Qué hay en el servidor

| Dónde | Qué | ¿Puede leerlo el servidor? |
| :--- | :--- | :--- |
| D1 `users` | email, móvil (opcional), sal de derivación de claves, hash de autenticación con sal, última señal de vida, plazos, último SMS | sí (datos personales) |
| D1 `checkin_tokens` | hash de cada botón "Sigo aquí" enviado, con caducidad | sí (solo hashes) |
| D1 `pending_signups` | altas en curso: email, hash con sal del código enviado, intentos, códigos enviados, caducidad | sí (nunca el código en claro) |
| D1 `vaults` | el plan, cifrado con encKey | no |
| D1 `recipients` | email y móvil (opcional) de la persona, su paquete cifrado, lista de ids de archivo, estado de la entrega y recordatorios enviados | solo email, móvil, ids y estado |
| D1 `release_tokens` | hash de cada enlace de apertura enviado, con caducidad | sí (solo hashes) |
| D1 `files` | id y tamaño de cada archivo | sí (solo tamaño) |
| D1 `events` | registro de actividad: tipo de acción, email de la persona si procede, país de la petición (nunca IP ni user-agent), fecha | sí (datos personales) |
| R2 | los bytes cifrados de cada archivo, bajo `userId/fileId` | no |
| D1 `stats` | visitas de las páginas de visitante y pasos del alta: por día, página, origen (anuncio · buscador · interno · directo · otro), campaña y país, vistas, lecturas y segundos sumados | sí (agregado: no identifica a nadie) |

Ni el nombre ni el tipo de los archivos llegan al servidor: viven dentro del plan.

Que el servidor no pueda leer el contenido no significa que no tenga nada: correos, móviles, país de conexión, fechas de actividad y las relaciones entre titular y personas de confianza son datos personales, y los de una persona de confianza lo son de alguien que no ha abierto ninguna cuenta. Se guardan porque sin ellos no se puede avisar ni entregar, no por ningún otro motivo; se borran con la cuenta (`DELETE /api/account`, backup incluido). `public/legal.html` (aviso legal, política de privacidad, cookies y condiciones de la beta; enlazada en el pie de todas las páginas) describe cuáles son, para qué, quién accede a ellos y la retención. No hay ninguna cookie ni nada en el almacenamiento del navegador: la sesión vive en memoria.

**Visitas.** Se cuentan en propio, sin terceros: `public/stats.js` (solo en la portada y las páginas de visitante) envía por `sendBeacon` una vista al cargar y, al salir, los segundos que la página ha estado visible (1.800 como máximo), con el origen en cinco valores fijos (`anuncio` si la URL trae `utm_campaign`, `utm_source` o `gclid`; `buscador`; `interno`; `directo`; `otro`) y la **campaña**: `utm_campaign` normalizado (`[a-z0-9_-]`, 32 caracteres), que identifica el anuncio y no a la persona. Dentro de la misma visita la campaña pasa a todos los enlaces internos como `?c=…` (marca, navegación, «más detalle», llamadas a la acción y pie legal) para que las páginas siguientes cuenten con ella; no queda nada en el navegador, así que una visita posterior o desde otro dispositivo no se cruza con nada. `stats.js` deja `window.custodiumVisit = { source, campaign }` y `app.js` lo adjunta a `/api/register/start` y `/api/register`: el servidor suma los pasos `/alta/codigo` y `/alta` por origen y campaña, **sin guardar nada en la cuenta** (`bumpStep`; un fallo ahí nunca rompe el alta). `POST /api/stats` solo suma en `stats` por día UTC, página, origen, campaña y país (`request.cf.country`): no hay filas por visitante ni identificadores; páginas y orígenes son conjuntos cerrados, los pasos del alta no se aceptan por el beacon, y las campañas nuevas tienen un tope de 20 por día (las demás caen en `otra`), así que la tabla tiene tamaño acotado aunque alguien la martillee (además rechaza `Sec-Fetch-Site` distinto de `same-origin`). **No** va en la regla de rate limiting del WAF: un recorrido normal por las páginas envía dos beacons por página y el límite del plan gratuito (5 peticiones por 10 s) los bloqueaba. En la portada cada pantalla de entrada cuenta como una página, según `body.dataset.statsScreen` (lo ponen `showScreen` y `showRegisterStep` en `app.js`; no `data-screen`, que es el selector de las secciones): `/` el login, `/crear-cuenta` el paso 1 del alta y `/crear-cuenta/codigo` el paso 2; al cambiar de pantalla se envía el tiempo de la anterior y la vista de la nueva. Dentro de la app no se cuenta nada (cualquier otra pantalla detiene el contador), y en `abrir.html` y `aqui.html` tampoco. `npm run stats` (`scripts/stats.sh`) saca los últimos 14 días por día y página, los totales por origen y país, y por campaña, como embudo: portada, crear cuenta, paso del código, altas, % de altas sobre la portada, otras páginas y segundos medios (`npm run stats -- 30`, `npm run stats -- --staging`).

### 2.4 Formato del plan (en claro, dentro del navegador)

```json
{
  "v": 2,
  "recipients": [ { "id": "uuid", "name": "Roser", "email": "…", "phone": "+34…|null", "key": "base64", "phrase": "seis palabras", "createdAt": 0 } ],
  "items": [
    { "id": "uuid", "title": "Cuenta en Indexa", "recipientIds": [ "uuid", "…" ],
      "notes": "texto libre", "files": [ { "id": "uuid", "name": "x.pdf", "size": 1234, "key": "base64" } ],
      "updatedAt": 0 }
  ],
  "onboarding": { "exportedAt": 0, "plazosReviewed": 0, "dismissedAt": 0 }
}
```

`onboarding` es opcional: marcas de la guía de primeros pasos (`exportedAt` al descargar una copia, `plazosReviewed` al guardar los plazos una vez, `dismissedAt` al cerrar la guía). El resto de pasos se deducen del plan y de la configuración.

Se cifra entero como `{ "v": 1, "iv": "base64 (12 bytes)", "ct": "base64" }`. Los archivos se guardan como `iv (12 bytes) || ciphertext`.

### 2.5 Paquetes

En cada guardado, para cada persona, el navegador construye `{ items: [ { title, notes, files: [ { id, name, size, key } ] } ] }` con los elementos que la incluyen (un elemento puede ir a varias personas; la clave del archivo viaja en cada paquete), lo cifra con la clave de la persona y lo sube. El servidor guarda el paquete y la lista de ids de archivo que referencia (para servirlos después sin poder abrirlos).

### 2.6 Señal de vida y entrega

- **Señal de vida:** cualquier petición autenticada (entrar, editar) o el botón "Sigo aquí" del correo de aviso.
- **Plazos por defecto de una cuenta nueva:** `warn_days` 21 y `release_days` 35 (`DEFAULT_WARN_DAYS` y `DEFAULT_RELEASE_DAYS` en `src/index.js`, escritos en la fila al crearla: la DEFAULT del esquema solo cuenta para filas insertadas a mano, porque la tabla viva conserva la DEFAULT con la que se creó). Cambiarlos no toca las cuentas existentes: cada una conserva los suyos. Las páginas de visitante y los textos de Cuenta los citan: si cambian, hay que revisarlos.
- **Cron, dos veces al día (08:00 y 20:00 UTC):** para cada titular con personas y paquetes, según el tiempo sin señal:
  - ≥ `warn_days` → correo de aviso ("¿sigues ahí?", con el botón de `/aqui.html`) en **cada ejecución**, y SMS como máximo uno al día si tiene móvil. El correo dice a partir de qué día se entregará (última señal + `release_days`), y se cumple.
  - ≥ `release_days`, con al menos **dos** avisos entregados desde la última señal → entrega a todas las personas pendientes. A partir de ahí ya no hay "¿sigues ahí?": durante 5 días, en cada ejecución, el titular recibe "se ha entregado tu plan" (SMS uno al día) por si ha sido un falso positivo, y cada persona que no ha abierto recibe un recordatorio con el enlace los días 1, 2, 4, 7, 10, 15, 21, 26, 33, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130 y 150 después de la entrega (sin SMS). Entrar lo detiene todo; los enlaces entregados siguen valiendo hasta que el titular los anula desde Personas.
  - `release_days` debe ser como mínimo `warn_days + 3`: antes de entregar habrán salido seis avisos y tres SMS.
- **Nada se guarda hasta que el correo ha salido.** Tanto el aviso como la entrega escriben en la base de datos solo después de que Resend haya aceptado el mensaje. Si el envío falla no se guarda nada: el aviso no cuenta, la persona sigue pendiente y el cron lo vuelve a intentar en la ejecución siguiente. La excepción son los recordatorios a las personas: uno que Resend rechaza se da por hecho (queda en Actividad como "No se ha podido enviar el recordatorio") y se pasa a la fecha siguiente, para no insistir dos veces al día contra una dirección muerta.
- **`warn_count`** cuenta los avisos entregados y vuelve a cero con cualquier señal de vida (entrar, cualquier petición autenticada o el botón "Sigo aquí"). Exigir dos significa que una sola incidencia de envío no puede desencadenar una entrega: hace falta que el sistema haya conseguido avisar al titular dos veces y que él no haya respondido ninguna de las dos. Con un aviso en cada ejecución, esto solo frena la entrega si el correo al titular no sale de ninguna manera.
- **La noticia al titular** lista las direcciones de las personas: el servidor no sabe sus nombres, que viven dentro del plan cifrado. Si Resend no la acepta, se vuelve a intentar en la ejecución siguiente.
- **Entrega:** cada correo que lleva un enlace (entrega, "Enviar de nuevo", recordatorio) genera un token aleatorio de 32 bytes nuevo; se guarda su hash en `release_tokens`, válido 100 días desde ese correo, y **todos los enviados abren** hasta que caducan o se anula el acceso. El enlace es `/abrir.html?t=…`; la persona escribe la frase, el navegador deriva la clave y descifra el paquete y los archivos. El servidor solo sabe cuándo se ha abierto un enlace (descargado el paquete), no si la frase ha funcionado.
- **Anular:** el titular puede anular el acceso desde "Personas": se borran todos los enlaces de la persona. Volver a entrar no anula nada automáticamente.
- **Pausa de emergencia:** con la fila `pause_releases` de la tabla `system` (D1) a `'1'`, el cron sigue avisando pero no entrega nada; se activa con un `UPDATE`, sin deploy (véase §5). Las entregas manuales ("Entregar ahora") no se pausan.
- El botón "Sigo aquí" es un botón de verdad (POST), no el enlace: los escáneres de correo abren enlaces solos y contarían como señal. Cada aviso lleva su botón (`checkin_tokens`) y todos los del periodo valen: un botón sirve mientras no ha caducado y no ha habido ninguna señal de vida después de enviarlo.
- Los correos nunca contienen contenido, solo enlaces (y, en el alta, el código de seis cifras). Salen de `avisos@custodium.space` vía Resend. Cada correo sale en texto plano y en HTML con la misma plantilla para todos (`mailHtml` en `src/index.js`: cabecera en teal oscuro con un filete de latón, tarjeta blanco cálido (#FBFAF8) sobre un fondo casi neutro, botón teal, tablas y estilos en línea, Georgia en lugar de Fraunces, ninguna imagen; los clientes que entienden `prefers-color-scheme` reciben una versión oscura diseñada, y en Gmail móvil, que invierte los fondos claros por su cuenta, el blanco neutro sale de un gris limpio en lugar del marfil invertido). El texto es la fuente de verdad: es lo que comprueban los tests y lo que ve quien lee en texto.
- **SMS** (opcional, si hay móvil): al titular, con el aviso y con la noticia de entrega, como máximo uno al día; a la persona, solo al entregar ("te ha llegado un correo; mira también el spam"), no con los recordatorios. Sin enlaces ni acentos. Canal independiente del correo: cubre el filtro de spam y la cuenta de correo comprometida. Un error de SMS no detiene nada.

### 2.7 API

```
GET    /api/salt?email=             —                             { salt }   sal de la cuenta; indistinguible si el email no existe
POST   /api/register/start          { email, source?, campaign? }  { ok } | 429 too_many_codes   envía el código (§3); 3 por email y hora; suma /alta/codigo (§2.3)
POST   /api/register                { email, authHash, code, source?, campaign? }  201 | 400 invalid_code | code_expired | too_many_attempts   suma /alta (§2.3)
POST   /api/login                   { email, authHash }           { token, expiresAt } | 401
DELETE /api/session                 Bearer                        { ok }
DELETE /api/sessions                Bearer                        { ok }   cierra las demás sesiones
DELETE /api/account                 { authHash }                  { ok } | 401   borra la cuenta entera (R2, backup y D1)
POST   /api/password                { authHash, newAuthHash, blob, version }  { token, version } | 401 | 409
POST   /api/email/start             { newEmail }  Bearer         { ok } | 429   código al correo nuevo; misma tabla y límites que el alta
POST   /api/email                   { authHash, newEmail, code }  Bearer  { ok } | 401 | 400 invalid_code | code_expired | too_many_attempts
GET    /api/vault                   Bearer                        { blob, version, updatedAt } | 404
PUT    /api/vault                   { blob, version }             { version } | 409 version_conflict
PUT    /api/files/:id               bytes (octet-stream)          201 | 413 | 507 quota
GET    /api/files/:id               Bearer                        bytes | 404
DELETE /api/files/:id               Bearer                        { ok }
POST   /api/files/reconcile         { ids, version }              { deleted } | 409 version_conflict; huérfanos de >7 días no incluidos
GET    /api/events                  Bearer                        { events: [ { kind, detail, country, createdAt } ] }   últimos 50
GET    /api/settings                Bearer                        { warnDays, releaseDays, phone, lastSeen }
PUT    /api/settings                { warnDays?, releaseDays?, phone? }  { ok }
GET    /api/recipients              Bearer                        { recipients: [ { id, email, releasedAt, openedAt, expiresAt, revokedAt, reminders } ] }
PUT    /api/recipients/:id          { email, phone?, package, fileIds }  { ok }
DELETE /api/recipients/:id          Bearer                        { ok }
POST   /api/recipients/:id/release  Bearer                        { ok }   envía el enlace ahora
POST   /api/recipients/:id/revoke   Bearer                        { ok }   anula el enlace
POST   /api/checkin                 { token }                     { ok }   botón del correo de aviso
POST   /api/stats                   { kind: view|time, path, source, campaign?, seconds? }  204 | 400 bad_stats | 403   contador agregado de visitas (§2.3); sin sesión
GET    /api/release/:token          —                             { from, email, package } | 404
GET    /api/release/:token/files/:id  —                           bytes | 404
GET    /api/env                     —                             { env }   "production" | "staging"
```

Alta con verificación del email: `/api/register/start` genera un código de seis cifras, guarda `SHA-256(sal || código)` en `pending_signups` (caduca a los 15 minutos) y lo envía por correo. Si el email ya tiene cuenta no envía ningún código sino "Ya existe una cuenta con este correo" (con el enlace para entrar y el recordatorio de que la contraseña no se puede recuperar), pero la respuesta es la misma (`200 { ok }`) y la fila se crea igual sin código, para que ni la respuesta ni el límite de códigos digan si la cuenta existe. `/api/register` compara el código en tiempo constante y cuenta los intentos: al quinto fallo el código queda inservible (`too_many_attempts`) y hay que pedir uno nuevo; solo con el código bueno se crea el usuario (con su `kdf_salt`) y se borra la fila. Por eso no hay ningún `409 email_exists`: para un email con cuenta no existe ningún código válido, y la respuesta es la de un código malo. El cron borra las filas con el código caducado y la ventana del límite (una hora) pasada.

Cambio de correo, con el mismo mecanismo: `/api/email/start` (con sesión) envía el código al correo **nuevo** (o "ya tienes cuenta", si ya la tiene; respuesta igual) y `/api/email` exige la contraseña actual (`authHash`) y el código. Si el correo nuevo ya tiene cuenta, la respuesta es la de un código malo y el correo nuevo recibe "ya tienes cuenta": no se revela nada. Con todo bien: se actualiza `email`, se cierran las demás sesiones, se registra `email_changed` (con el correo nuevo como detalle) y la dirección antigua recibe "Tu correo de Custodium ha pasado a ser …. Si no has sido tú, escríbenos a …" (`MAIL_CONTACT` en `wrangler.toml`), sin ningún enlace de deshacer. La sal de derivación no cambia (§2.2), así que las claves y el plan quedan como estaban; el abridor de la copia tampoco depende de ella.

Sesión: token aleatorio de 32 bytes, 24 horas, guardado hasheado; cada petición autenticada la renueva, así que solo caduca tras un día entero sin abrir el plan. Límites: plan 1 MB, archivo 50 MB, 1 GB por titular, 20 personas (`too_many_recipients`). Concurrencia optimista en el plan (`version`): dos dispositivos no se pisan.

### 2.8 Cliente

Sin frameworks ni dependencias. Todo el estado vive en memoria: cerrar la pestaña cierra el plan; 15 minutos de inactividad también. `_headers` fija una CSP estricta: scripts, estilos, fuentes y conexiones solo del propio origen, sin iframes. Las fuentes (Fraunces e Inter, variables, subconjunto latino) están en `public/fonts/`: el cliente no hace ninguna petición a terceros. En staging, `app.js` pregunta `/api/env` y muestra una franja fija de aviso ("Entorno de pruebas · los datos pueden borrarse sin aviso"); en producción no aparece nunca.

**Portada.** Sin sesión (entrada y alta), `main` se ensancha (`body.is-entry`, que pone `showScreen`) y el formulario va en una tarjeta a la izquierda, con una presentación del producto a la derecha (qué es, un ejemplo de plan con datos ficticios, qué no es) y cuatro pilares debajo. El ejemplo es el mismo tablero que la web B2B: HTML en `index.html` y, en `portada.js`, las líneas elemento → persona (un SVG que se dibuja una vez y se recalcula si cambia el tamaño; con `prefers-reduced-motion` no hay movimiento). Dentro de la app no existe nada de esto. El formulario va primero en el DOM: en el móvil queda solo arriba y el foco entra igual que antes.

**Rutas.** La pantalla vive en el fragmento de la URL, que el servidor no ve nunca: `#/plan` (por defecto), `#/elemento/nuevo`, `#/elemento/<id>`, `#/personas`, `#/persona/nueva`, `#/persona/<id>`, `#/cuenta` y `#/crear-cuenta` (`public/routes.js`: `parseRoute` y `routeHash`, puras, probadas en `test/routes.test.js`). En el fragmento solo van nombres de pantalla e ids (UUID generados en el navegador): ningún token ni ningún dato. Dos sentidos: la app cambia de pantalla con `navigate(ruta)` (`history.pushState` y pintar), y atrás, adelante o una URL escrita a mano disparan `hashchange` y se pinta la ruta que lleva; así el navegador funciona como en cualquier web (atrás, adelante, recargar, enlazar). Sin sesión (enlace directo, recarga, bloqueo por inactividad) se muestra la entrada con la ruta en el fragmento y, al entrar, se va a ella. Salir de un editor por cualquier vía (atrás incluido) lo cierra como «Cancelar» (los archivos subidos y no guardados se borran) y, si hay cambios sin guardar, pide confirmación antes; el mismo criterio vale para el aviso al cerrar la pestaña. «Cancelar», «Listo» y las bajas vuelven a la entrada anterior del historial (el editor no queda en él) o, si se ha llegado por enlace directo, a la lista que le toca. Un id que ya no está en el plan avisa y lleva a la lista. `abrir.html` y `aqui.html` no tienen rutas.

Archivos huérfanos: si se cierra la pestaña a media edición, un archivo subido puede quedar en el servidor sin que ningún plan lo apunte. Al abrir el plan, el cliente envía la lista de ids vivos y la versión del plan (`POST /api/files/reconcile`); el servidor solo borra los de ese usuario que no estén en ella y tengan más de 7 días si esa versión sigue siendo la actual. Con un `409 version_conflict` no borra nada.

**Páginas de visitante.** Mientras no hay sesión, la cabecera muestra una navegación (`.visitor-nav`, oculta por CSS cuando `#top-nav` es visible) hacia cuatro páginas estáticas, sin script, pensadas para quien llega desde un anuncio: `como-funciona` (el plan, las personas, la línea de tiempo de los avisos y la entrega con los valores por defecto, la copia, cómo probarlo), `seguridad` (qué puede y qué no puede leer el servidor, qué pasaría con una brecha, contraseña perdida, correos y SMS, límites conocidos y parámetros criptográficos), `codigo` (el espejo público, las órdenes de verificación, qué no se puede verificar, licencia, cómo avisar de un error) y `preguntas` (precio y beta, qué es y qué no, avisos, personas, límites, quién hay detrás). `legal` lleva el aviso legal, la política de privacidad, las cookies (no hay) y las condiciones de la beta. Todas comparten cabecera, pie, la llamada final «Crear una cuenta» (`/#/crear-cuenta`) y el contador de visitas `stats.js` (§2.3). Los hechos que explican (plazos, límites, qué guarda el servidor) salen de este README: si cambia el comportamiento, hay que revisarlas. `test/pages.test.js` comprueba que ningún enlace interno quede roto y que todas lleven la navegación y el pie legal.

---

## 3. Manual de uso

### Titular

1. **Crear cuenta**, en dos pasos. (1) Email → "Enviar código": llega un correo con un código de seis cifras que caduca en 15 minutos (si el email ya tiene cuenta, llega un correo que lo dice y ningún código; la pantalla no lo distingue). (2) "Te hemos enviado un código a …": el código y la contraseña. Los campos de contraseña salen ya rellenos con una frase de seis palabras generada en el navegador, visible, con el aviso "Apúntala antes de continuar"; el enlace "prefiero escribir la mía" vacía los campos, los oculta y exige 16+ caracteres. "No me ha llegado" envía otro código (solo vale el último; tres por hora como máximo); "Cambiar el email" vuelve al paso 1. Cinco códigos equivocados y hay que pedir uno nuevo. Las claves se derivan solo en el paso 2. No hay recuperación de la contraseña: guárdala en el gestor de contraseñas.
   - **Primeros pasos.** Bajo la intro de "Tu plan", un bloque "Primeros pasos" con seis casillas (contraseña guardada, una persona, primer elemento, móvil para los avisos, plazos revisados, copia descargada), cada una deducida del plan o de la configuración (ningún dato nuevo en el servidor; "plazos revisados" y "copia descargada" son marcas dentro del plan cifrado, la primera al pulsar "Guardar plazos" una vez). Cada paso pendiente enlaza a la acción. Desaparece cuando las seis están hechas o al cerrarlo con la X (`onboarding.dismissedAt`, no vuelve a salir). Mientras es visible no se muestra "Aún no hay nada".
2. **Añadir elementos.** "+ Añadir elemento": qué es, personas que deben recibirlo (casillas; ninguna = solo para ti), instrucciones, archivos (hasta 50 MB). El desplegable "Empezar desde una plantilla (opcional)" rellena el título (si está vacío) y las instrucciones con un guion. Veintiuna plantillas en cuatro grupos (cuentas y accesos · dinero y patrimonio · casa y documentos · trabajo, personas y otros), en `public/templates.js` (`{ id, group, name, title, notes }`); se añaden sin tocar `app.js`. "Listo" cifra y guarda al momento. No hay botón de guardar. "Cancelar" vuelve a la pantalla anterior. En "Tu plan" cada elemento es una ficha: el título (recortado a 35 caracteres) con «Editar» al lado, las instrucciones recortadas a dos líneas («Leer más» las despliega, solo si no caben), un botón para descargar cada archivo con el tipo (PDF, MP3…) y, al pie, las personas que deben recibirlo (inicial y nombre, hasta cuatro) y la fecha del último cambio. Las dos flechas de cada ficha suben o bajan el elemento una posición: el orden es el del array del plan y se guarda como cualquier otro cambio.
3. **Personas.** "+ Añadir persona": nombre, email, móvil opcional (para el SMS de aviso) y frase. La frase la genera siempre el sistema, seis palabras al azar (lista BIP39 en castellano, 2.048 palabras → 66 bits), del tipo `ebano deporte nacar cien organo vagar`; no se puede escribir a mano ("Generar otra" da otra). Escríbelas en papel y dáselas en persona; nunca por mensaje. Al abrir, no importan mayúsculas, acentos ni espacios. La frase queda guardada dentro de tu plan (cifrada, como el resto): "Mostrar frase" la vuelve a enseñar tras pedirte la contraseña, durante un minuto, para comprobar el papel o volver a escribirlo.
4. **Plazos.** En "Cuenta → Definir entrega por inactividad", dos pasos en vertical: (1) "Primero, te avisamos a ti", con los días hasta el primer aviso (21 por defecto) y qué llegará (2 correos al día; 1 SMS al día si hay móvil); (2) "Si no respondes, entregamos el plan", con los días hasta la entrega (35 por defecto). La entrega debe ser como mínimo tres días después del primer aviso (lo dice junto al campo). Debajo, la **previsión** con las dos fechas, calculadas como las calcula el servidor: el día de la primera ejecución del cron (08:00 o 20:00 UTC) a partir de la última entrada o confirmación más cada plazo; mientras se editan los días cambia al momento y dice "pendiente de guardar" hasta que se pulsa "Guardar plazos". Los dos plazos cuentan desde la última actividad o confirmación, no uno después del otro; entrar o pulsar "Sigo aquí" (el de cualquier aviso) los reinicia.
5. **Entregar ahora.** En cada persona, "Entregar ahora" envía el enlace inmediatamente. Sirve para probar y como entrega voluntaria. "Anular enlace" lo desactiva.
6. **Estado.** En "Personas", cada persona es una ficha: la inicial, el nombre con «Editar», el correo y el móvil, y al pie los elementos asignados (al pulsarlo se ven los títulos) y el estado de la entrega con la fecha. Cada persona muestra un estado concreto: *Sin elementos asignados* · *Sin entregar* · *Acceso enviado* · *Acceso abierto* · *Enlace caducado* · *Enlace anulado* (nunca "recibido" o "leído": abrir un acceso no demuestra haberlo leído todo). Dentro de la ficha (Editar): Mostrar frase, Entregar ahora / Enviar de nuevo (envía un enlace nuevo; los anteriores siguen valiendo), Anular enlace (los borra todos), Quitar persona; tras una entrega automática, también cuántos recordatorios se han enviado. Si hay alguna entrega activa, "Tu plan" lo avisa con una franja al entrar, por si ha sido un falso positivo.
7. **Cuenta.** Arriba, «En esta página»: un enlace por ficha (generados de los títulos) que desplazan hasta la ficha y le ponen el foco, sin tocar el fragmento de la URL. Todo en fichas, en este orden: el correo de la cuenta; el móvil para los avisos por SMS («Guardar móvil» solo se activa cuando el campo cambia; vacío y guardado, el móvil se borra); los plazos de entrega (punto 4); la copia fuera de Custodium (punto 10); el cambio de contraseña; las sesiones; la actividad reciente; el cambio de correo; y la eliminación de la cuenta. **Cambiar el correo** (una ficha que cambia de estado), en dos pasos como el alta: el correo nuevo → "Enviar código" (llega un código de seis cifras, 15 minutos, tres por hora); después el código y la contraseña actual → "Cambiar el correo". Se cierran las demás sesiones, la dirección anterior recibe un aviso (sin enlace de deshacer) y queda registrado en Actividad. "Los avisos y la entrega dependen de este correo. Úsalo solo si lo consultas habitualmente." La nueva contraseña se propone igual que al crear la cuenta (frase de seis palabras visible, o «Prefiero escribir mi contraseña»); la casilla «He guardado mi nueva contraseña» es la que activa el botón. El plan se recifra en el navegador con la nueva; personas y archivos no se tocan; las demás sesiones se cierran. "Cerrar las demás sesiones" (ficha «Sesiones») cierra el plan en cualquier otro dispositivo donde se haya abierto, sin tocar la sesión actual. Más adelante, aquí irán datos de contacto y pago.
8. **Actividad reciente** (en Cuenta). Lo que el servidor ha registrado de la cuenta (entradas, intentos fallidos contra tu email, cambios, avisos, entregas y aperturas), con fecha, hora y país de la petición — nunca IP ni user-agent — para detectar accesos que no reconozcas. Se guardan los 200 más recientes; el servidor envía 50 y la ficha los muestra de ocho en ocho, con un filtro (toda la actividad, entradas y sesiones, cambios de la cuenta, avisos y entregas) que actúa sobre esos 50.
9. **Eliminar la cuenta** (final de Cuenta, en una ficha en tono de peligro). Pide la contraseña actual (con «Mostrar») y la casilla «Entiendo que se eliminará mi cuenta…», que es la que activa el botón; entonces borra el plan, los archivos (también de la copia de seguridad), las personas y el registro; los enlaces enviados dejan de funcionar. No se puede deshacer.
10. **Una copia fuera de Custodium** (ficha en "Cuenta", botón "Descargar copia cifrada"). Descarga un zip con: tu plan cifrado (`plan.json`, con la sal de la cuenta dentro para que el abridor no necesite el servidor), un paquete cifrado por persona (`paquetes/`), todos los archivos cifrados (`archivos/`), el abridor `abrir.html` y un `LEEME.txt`. Todo está cifrado: el zip puede dejarse en un USB, en la nube o en el notario. Vuelve a descargarla cuando hagas cambios importantes.

### Si Custodium desaparece (o no hay internet)

Con la copia exportada basta. Quien la tenga:

1. Descomprime el zip y abre `abrir.html` con cualquier navegador (doble clic; no hace falta servidor ni conexión).
2. Selecciona el zip (o la carpeta descomprimida), escribe su email y su frase (el titular, su contraseña).
3. El abridor intenta abrir el plan y cada paquete: AES-GCM rechaza los que no son suyos, así que cada cual ve solo lo que le corresponde, y el abridor no sabe de quién es qué. Los archivos se descifran con la clave que va dentro del paquete.

El zip y el sobre con la frase deben estar en manos distintas: ninguno de los dos, solo, abre nada.

### Persona de confianza

1. Recibe un correo de `avisos@custodium.space` con un enlace.
2. Lo abre, escribe la frase que le dieron en persona, y ve sus elementos. Los archivos se descargan y se descifran en su navegador.
3. Cada enlace dura 100 días desde el correo que lo lleva. Mientras no lo abra, le llegan recordatorios con un enlace nuevo (los anteriores siguen valiendo). Conviene guardar o imprimir lo que necesite.

### Cosas que hay que saber

- Si el titular pierde la contraseña, el plan es irrecuperable. Si una persona pierde la frase, su paquete es irrecuperable. Ninguna de las dos cosas puede resolverla Custodium.
- Recomienda a cada persona una segunda copia de la frase en un sobre cerrado, en un lugar distinto del papel. Custodium no puede hacer ninguna copia útil: la frase solo vive dentro del plan cifrado del titular, y si el titular ya no está, nadie puede mostrarla.
- Cambiar el email de una persona obliga a ponerle una frase nueva (la clave se deriva de los dos).
- Un archivo quitado de un elemento solo se borra del servidor una vez el plan guardado ya no lo apunta.
- Entrar en la web reinicia el contador de señal de vida y borra el aviso pendiente.
- Máximo 20 personas de confianza por titular.
- El móvil se escribe siempre con prefijo internacional (+34…, o 0034…); sin prefijo, se rechaza.
- Cada pantalla tiene su dirección: `#/plan`, `#/personas`, `#/cuenta`, `#/elemento/<id>`, `#/persona/<id>` (y `#/elemento/nuevo`, `#/persona/nueva`, `#/crear-cuenta`). Pueden enlazarse desde un manual o un correo; sin sesión llevan a la entrada y, una vez dentro, a la pantalla. Atrás y adelante del navegador funcionan. Salir de un editor (atrás incluido) lo cierra; si había cambios sin guardar, antes lo pregunta.

---

## 4. Pruebas

`npm test` ejecuta las pruebas locales (Node 20, `node --test`, sin dependencias): compatibilidad entre `crypto.js` y el abridor autónomo, normalización de frases y teléfonos, las rutas del cliente (`parseRoute`), que una clave equivocada no abre nada, el alta, el contador de visitas y los disparadores del cron contra una D1 simulada, y los enlaces de las páginas de visitante. Ejecuta `npm test` antes de cada deploy.

### Prueba básica (10 minutos)

1. Crear cuenta. Añadir dos elementos, uno con un PDF. Cerrar la pestaña, volver a entrar: todo está.
2. En el panel de Cloudflare, D1 → `custodium-b2c` → Console: `SELECT blob FROM vaults;` → solo base64. R2 → `custodium-b2c-files`: objetos sin nombre ni extensión.
3. Entrar con una contraseña equivocada: "Email o contraseña incorrectos".

### Prueba de entrega (15 minutos)

1. "Personas" → añadir una persona con un email tuyo; la frase sale generada ("Generar otra" da otra); apuntarla en papel.
2. Editar un elemento, asignarlo a la persona, adjuntar un archivo. Listo.
3. "Entregar ahora". Llega un correo con el enlace.
4. Abrir el enlace en una ventana de incógnito. Escribir la frase: se ve el elemento y se descarga el archivo. Escribir una frase equivocada: "La frase no es correcta".
5. En "Personas": estado "Acceso abierto · fecha". Dentro de la ficha, "Anular enlace" → el enlace deja de funcionar y el estado pasa a "Enlace anulado".
6. "Cuenta" → "Descargar copia cifrada". Descomprimir, abrir `abrir.html`, seleccionar el zip, entrar con tu email y contraseña (ves todo el plan) y después con el email y la frase de la persona (ves solo lo suyo).

### Prueba del disparador (4 días)

1. Poner "Primer aviso 1 día, Entrega 4 días" (el mínimo: tres días entre uno y otra), con una persona que tenga un elemento asignado. Salir y no entrar.
2. Al día siguiente a las 08:00 UTC llega "¿sigues ahí?" (y un SMS, si hay móvil); a las 20:00 UTC, otro correo sin SMS. Así dos veces al día, tres días.
3. El cuarto día a las 08:00 UTC: correo a la persona con el enlace, y "se ha entregado tu plan" al titular, que se repite en cada ejecución durante cinco días. Al día siguiente, si la persona no ha abierto, primer recordatorio (enlace nuevo; el primero también abre).
4. Pulsar el botón de un aviso antiguo → "Confirmado" (todos los botones del periodo valen). Entrar → en "Tu plan" sale la franja de la entrega; "Anular enlace" la deshace y ningún enlace abre.
5. Volver a poner 21 / 35.

### Prueba con curl (sin navegador)

```sh
BASE=https://custodium.space
HASH=$(openssl rand -base64 32)
curl -s $BASE/api/salt?email=yo@example.com                     # {"salt":"…"}, la misma antes y después del alta
curl -s -X POST $BASE/api/register/start -H 'content-type: application/json' -d '{"email":"yo@example.com"}'   # {"ok":true}; el código llega al correo
CODE=123456   # el del correo
curl -s -X POST $BASE/api/register -H 'content-type: application/json' -d "{\"email\":\"yo@example.com\",\"authHash\":\"$HASH\",\"code\":\"$CODE\"}"
TOKEN=$(curl -s -X POST $BASE/api/login -H 'content-type: application/json' -d "{\"email\":\"yo@example.com\",\"authHash\":\"$HASH\"}" | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s $BASE/api/vault -H "authorization: Bearer $TOKEN"      # {"error":"no_vault"}
```

---

## 5. Despliegue y operación

### Estructura

```
src/index.js        Worker: API + cron
public/             Cliente estático: index.html, app.js, routes.js (rutas del fragmento), crypto.js, words.js, templates.js (plantillas de elemento), portada.js, stats.js (contador de visitas), fflate.js (zip, MIT), style.css, fonts/,
                    abrir.* (persona, con servidor), aqui.* (check-in), abrir-offline.html (abridor autónomo), _headers,
                    páginas de visitante sin script: como-funciona, seguridad, codigo, preguntas y legal (.html; Workers Assets las sirve también sin extensión),
                    README (bilingüe, con la verificación), LICENSE (source-available) y THIRD_PARTY.md.
                    VERSION lo escribe el deploy (gitignored).
scripts/            public-commit.sh: construye el commit del espejo público (véase "Desplegar un cambio"); stats.sh: visitas (`npm run stats`); check-pepper.mjs (§5)
.github/workflows/  ci.yml (tests + deploy a staging) y deploy-production.yml (botón de producción).
                    No se publica en el espejo.
schema.sql          Esquema D1 consolidado (el estado actual; para crear una D1 nueva)
wrangler.toml       Bindings (D1 "DB", R2 "FILES" y "FILES_BACKUP"), dominio, crons, [vars] y [env.staging]
```

### Requisitos (ya hechos)

- Cloudflare: zona `custodium.space`; D1 `custodium-b2c`; R2 `custodium-b2c-files` y `custodium-b2c-files-backup` (WEUR); secretos `RESEND_API_KEY`, `SALT_PEPPER` (clave del HMAC del que sale la sal de derivación de cada cuenta, §2.2: `openssl rand -base64 32`; sin él `/api/salt` y `/api/register` responden 500 y nadie puede entrar) y, para los SMS, `SMS_USER`, `SMS_PASS`, `SMS_FROM` (pasarela HTTP de siptraffic; si faltan, no se envían SMS y todo sigue funcionando). `SALT_PEPPER` se pone con `npx wrangler secret put SALT_PEPPER` (y `--env staging` para staging). No cambiarlo nunca a la ligera: las cuentas existentes conservan la sal guardada y siguen funcionando, pero la de los emails sin cuenta cambiaría y volvería a distinguirlos de los que la tienen. Para confirmar que el valor del gestor de contraseñas es el desplegado: `scripts/check-pepper.mjs` calcula la sal de un email exactamente como el Worker (extrae `deriveSalt` de `src/index.js`) y la compara con `/api/salt` de producción (`--staging` para staging); no imprime nunca el pepper, y con `-` lo lee de stdin para no dejarlo en el historial:

```sh
echo -n "$PEPPER" | node scripts/check-pepper.mjs -              # producción
echo -n "$PEPPER" | node scripts/check-pepper.mjs - --staging    # staging
```
- Resend: dominio `custodium.space` verificado; remitente `avisos@custodium.space`.
- `wrangler` como dependencia local (`npm install -D wrangler`), sin instalación global.

### Entornos

| | Producción | Staging |
| :--- | :--- | :--- |
| Web | custodium.space (y www) | b2c-staging.custodium.space |
| Worker | custodium-b2c | custodium-b2c-staging |
| D1 | custodium-b2c | custodium-b2c-staging |
| R2 | custodium-b2c-files y -files-backup | custodium-b2c-staging-files y -backup |
| Se despliega | botón **deploy-production** (Actions) | la CI, en cada push a `main` con tests verdes |
| `/VERSION` | hash del commit del espejo público | hash del commit de `main` desplegado |

Mismo código y mismos crons; datos y secretos separados. `ENV`, `SITE` y `MAIL_FROM` son `[vars]` por entorno en `wrangler.toml`; con `ENV = "staging"` el cliente muestra la franja de aviso. Las migraciones se aplican en cada entorno a mano (en staging: `npx wrangler d1 execute custodium-b2c-staging --remote --file=…`, idealmente antes que en producción).

### Desplegar un cambio

```sh
git add -A && git commit -m "qué has cambiado"
git push              # la CI pasa los tests y, en main, despliega staging
```

Comprobar staging: `https://b2c-staging.custodium.space/VERSION` debe devolver el hash del commit, y la web debe funcionar (con la franja de aviso). Producción, siempre con el botón: GitHub → Actions → **deploy-production** → Run workflow. Nunca automático; las migraciones quedan fuera y van siempre antes, a mano y con confirmación.

El workflow de producción repite los tests y hace lo que hacía `npm run deploy` en local: `scripts/public-commit.sh` toma el árbol del commit, le quita `CLAUDE.md` y `.github/` y lo encadena a la historia del **espejo público** [victorsala/custodium-client](https://github.com/victorsala/custodium-client) (si el árbol no ha cambiado, reutiliza el commit anterior); escribe el hash resultante en `public/VERSION` (que no se versiona: es un artefacto del deploy), hace `wrangler deploy`, comprueba que `/VERSION` responde exactamente ese hash y, solo entonces, publica el espejo. Cualquiera puede hacer `git checkout` de ese hash en el repo público, comparar archivo a archivo el contenido de `public/` con lo que sirve `custodium.space` (instrucciones en `public/README.md`) y leer el Worker (`src/index.js`) desplegado con esa misma versión. El pie de la portada, de `abrir.html` y de `aqui.html` muestra la versión; las páginas de visitante no tienen script y no la muestran, y `abrir-offline.html` no la muestra expresamente (debe funcionar sin servidor y su CSP no permite conexiones).

**Deploy local de emergencia** (si GitHub Actions no está): sincronizar el espejo y hacerlo a mano —

```sh
git fetch origin-public main && git branch -f public-mirror FETCH_HEAD
npm run deploy        # espejo + public/VERSION + wrangler deploy
git push origin-public public-mirror:main
```

### Token de Cloudflare y secretos de GitHub (una sola vez)

Los workflows despliegan con un token de API de Cloudflare de permisos mínimos. Crearlo en dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token:

- Account · **Workers Scripts** · Edit
- Account · **D1** · Edit
- Account · **Workers R2 Storage** · Edit
- Zone · **Workers Routes** · Edit
- Account Resources: solo esta cuenta. Zone Resources: solo `custodium.space`.

Y en GitHub, custodium-b2c → Settings → Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN` — el token recién creado.
- `CLOUDFLARE_ACCOUNT_ID` — el id de la cuenta (en la barra lateral del panel; no es secreto, pero así no vive en el repo).
- `MIRROR_PUSH_TOKEN` — fine-grained PAT (github.com → Settings → Developer settings → Fine-grained tokens) con acceso solo a `victorsala/custodium-client` y permiso **Contents: Read and write**: es el que usa el workflow de producción para publicar el espejo.

### Secretos de staging (una sola vez)

En orden — primero el correo y el pepper, imprescindibles; los SMS opcionales (los tres o ninguno):

```sh
npx wrangler secret put RESEND_API_KEY --env staging
npx wrangler secret put SALT_PEPPER --env staging
npx wrangler secret put SMS_USER --env staging
npx wrangler secret put SMS_PASS --env staging
npx wrangler secret put SMS_FROM --env staging
```

### Rama main (sin protección, de momento)

Las ramas protegidas no existen en repos privados del plan Free de GitHub. De momento `main` no exige ninguna: la garantía real es la CI — staging no se despliega sin tests verdes, y producción solo sale con el botón. Cuando haya un segundo colaborador, activar la protección (con GitHub Pro, o haciendo público el repo) con el status check `test` obligatorio, `enforce_admins: true` y flujo de PR.

### Pausar las entregas automáticas

Interruptor de emergencia: con la fila `pause_releases` de la tabla `system` a `'1'`, el cron sigue enviando avisos de inactividad pero no entrega ningún plan, y lo deja en el log (`entregues en pausa`, visible con `npx wrangler tail`). El cron la lee en cada ejecución: no hace falta ningún deploy, ni para activarla ni para desactivarla — expresamente, para que sirva también cuando no se puede desplegar. Las entregas manuales ("Entregar ahora") no se pausan.

Dos maneras de activarla:

```sh
npx wrangler d1 execute custodium-b2c --remote --command "UPDATE system SET value='1' WHERE key='pause_releases'"
```

o en el panel de Cloudflare: D1 → `custodium-b2c` → Console, con el mismo `UPDATE`. Para desactivarla, lo mismo con `value='0'`.

### Cambios de esquema

Escribir un archivo de migración (p. ej. `migration-YYYYMMDD.sql` con los `ALTER`/`CREATE`), aplicarlo **antes** del deploy que lo necesite, e incorporar el cambio a `schema.sql` para que siga describiendo el estado actual:

```sh
npx wrangler d1 execute custodium-b2c --remote --file=migration-YYYYMMDD.sql
```

Si `--file` falla con `fetch failed` o con `Authentication error [code: 10000]` (pasa por el endpoint de importación, que desde algunas redes no responde y que el token OAuth de `wrangler login` no puede usar), el mismo SQL sin comentarios y en una sola línea va por `--command "…"`: D1 ejecuta las sentencias en un solo batch, transaccional. Siempre con la salida entera y comprobando después que las tablas y columnas están.

Las migraciones ya aplicadas pueden borrarse del repo una vez consolidadas; `git log` conserva su historial.

### Rate limiting (panel de Cloudflare, una sola vez)

Zona `custodium.space` → Security → WAF → Rate limiting rules → Create rule:

- Expresión: `(http.host eq "custodium.space" and http.request.uri.path in {"/api/salt" "/api/register/start" "/api/email/start" "/api/login" "/api/register" "/api/password" "/api/email"})`
- `/api/stats` **no** se incluye: cada página envía dos beacons y un recorrido rápido superaría el límite; el endpoint se protege solo (§2.3).
- `/api/register/start` debe estar: envía un correo a cualquier dirección sin autenticar. El límite de tres códigos por email y hora es del Worker; el del WAF, por IP, es el que detiene un envío masivo a direcciones distintas.
- `/api/salt` debe estar: responde a cualquier email sin autenticar y, aunque la sal falsa no delata nada, es la primera petición de cada intento de entrada y no debe poder martillearse.
- Característica: IP. Límite: el más estricto que permita el plan (en el plan gratuito, p. ej. 5 peticiones por 10 segundos). Acción: Block.

### Copia de los archivos y restauración

Cada domingo a las 03:00 UTC, un cron copia a `custodium-b2c-files-backup` los objetos de `custodium-b2c-files` que faltan allí (misma clave `userId/fileId`). Del backup no se borra nunca nada, ni aunque el original haya desaparecido — con una única excepción: el borrado de la cuenta (`DELETE /api/account`) elimina los archivos del titular de los dos buckets. El log del cron (`npx wrangler tail`) muestra el recuento de copiados.

**Restaurar un archivo:** copiar la clave `userId/fileId` del backup al principal:

```sh
npx wrangler r2 object get custodium-b2c-files-backup/USERID/FILEID --file restaurado.bin --remote
npx wrangler r2 object put custodium-b2c-files/USERID/FILEID --file restaurado.bin --remote
```

### Diagnóstico

- Consola del navegador (F12) para el cliente.
- `npx wrangler tail` para ver los errores del Worker en directo.
- `Authentication error [code: 10000]` en wrangler = token OAuth caducado: `npx wrangler login`.
- `npm: command not found` = un `apt autoremove` puede llevarse el nodejs de nodesource. Solución: `sudo apt install nodejs && sudo apt-mark manual nodejs`.

### Vaciarlo todo

```sh
npx wrangler d1 execute custodium-b2c --remote --command "DELETE FROM sessions; DELETE FROM events; DELETE FROM recipients; DELETE FROM files; DELETE FROM vaults; DELETE FROM users; DELETE FROM pending_signups;"
```

R2: panel → bucket → Objects → seleccionar todo → Delete.

---

## 6. Límites conocidos de la beta

- Una sola contraseña por titular, sin segundo factor.
- Rate limiting vía regla en el WAF de Cloudflare (`/api/salt`, `/api/register/start`, `/api/email/start`, `/api/login`, `/api/register`, `/api/password`, `/api/email`); véase §5.
- Los paquetes se rehacen enteros en cada guardado (bien para pocos elementos, no para miles).
- Los archivos se suben y se exportan enteros en memoria (50 MB por archivo es el límite práctico en móvil; la exportación de 1 GB necesita un ordenador).
- Sin clave de recuperación ni para el titular ni para las personas: decisión de diseño, no un olvido. La exportación es la copia de seguridad del titular.
- El servidor conserva metadatos personales (correos, móviles, país, actividad, relaciones titular–personas). Cifrar el contenido no elimina la responsabilidad sobre esos datos.
- Ninguna auditoría externa de la criptografía. Los parámetros son estándar (PBKDF2 600k, HKDF, AES-256-GCM, WebCrypto nativo), pero el código no lo ha revisado nadie de fuera.
- "Aviso entregado" significa aceptado por Resend, no entregado en el buzón. Un correo que la API rechaza no cuenta y se reintenta; un rebote posterior (buzón lleno, dirección muerta) no se detecta: los avisos cuentan igualmente y la entrega se hace cuando hay dos. Sin webhooks de Resend (`delivered`, `bounced`) la única defensa es el SMS, si hay móvil.
- Si tras guardar el plan un paquete no se sube (error de red o del servidor), el plan queda guardado pero ese paquete queda desactualizado hasta el guardado siguiente: solo un aviso en la pantalla en ese momento, sin reintento ni estado visible en Personas.
