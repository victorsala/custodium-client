# Custodium — client and server

*(español más abajo)*

This repository is the public mirror of [b2c.custodium.space](https://b2c.custodium.space), a digital succession plan: the complete client (`public/`) **and** the Cloudflare Worker that serves it (`src/index.js`, configured in `wrangler.toml`). No build step, no bundler, no frameworks. All encryption happens in the browser (PBKDF2 + AES-GCM, see `public/crypto.js`); the server only ever stores ciphertext and never receives passwords, passphrases or content in the clear. The full manual (in Catalan) is in the root [README.md](../README.md).

**Verify what the site serves.** The footer of every page shows the deployed version, also available at [/VERSION](https://b2c.custodium.space/VERSION) — it is a commit hash of this repository. To check that the site serves exactly the client code at that commit:

```sh
git clone https://github.com/victorsala/custodium-client && cd custodium-client
git checkout $(curl -s https://b2c.custodium.space/VERSION)
for f in index.html app.js crypto.js words.js abrir.html abrir.js aqui.html aqui.js abrir-offline.html fflate.js style.css; do
  diff <(curl -sL "https://b2c.custodium.space/$f") "public/$f" && echo "OK $f"
done
```

**About the server.** `src/index.js` is the Worker deployed together with that same version. Reading it shows what the server does — and what it cannot do: it only ever handles ciphertext, hashed credentials and delivery schedules. Unlike the client, no external check can prove that a remote server runs exactly the published code; that is precisely why the design never requires trusting it. Everything sensitive is encrypted in the browser before it is sent, and *that* code you can verify byte by byte with the commands above.

---

# Custodium — cliente y servidor

Este repositorio es el espejo público de [b2c.custodium.space](https://b2c.custodium.space), un plan de sucesión digital: el cliente completo (`public/`) **y** el Worker de Cloudflare que lo sirve (`src/index.js`, configurado en `wrangler.toml`). Sin build, sin bundler, sin frameworks. Todo el cifrado ocurre en el navegador (PBKDF2 + AES-GCM, ver `public/crypto.js`); el servidor solo guarda texto cifrado y nunca recibe contraseñas, frases ni contenido en claro. El manual completo (en catalán) está en el [README.md](../README.md) de la raíz.

**Verificar lo que sirve la web.** El pie de cada página muestra la versión desplegada, también disponible en [/VERSION](https://b2c.custodium.space/VERSION) — es un hash de commit de este repositorio. Para comprobar que la web sirve exactamente el código de cliente de ese commit, usa los comandos de arriba: descarga cada fichero y compáralo con su copia en `public/`.

**Sobre el servidor.** `src/index.js` es el Worker desplegado junto a esa misma versión. Leerlo muestra qué hace el servidor — y qué no puede hacer: solo maneja texto cifrado, credenciales con hash y plazos de entrega. A diferencia del cliente, ninguna comprobación externa puede demostrar que un servidor remoto ejecuta exactamente el código publicado; precisamente por eso el diseño no exige confiar en él. Todo lo sensible se cifra en el navegador antes de enviarse, y *ese* código sí puede verificarse byte a byte con los comandos de arriba.

Licenses: [LICENSE](LICENSE) · [THIRD_PARTY.md](THIRD_PARTY.md)
