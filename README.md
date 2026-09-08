# Custodium client

*(español más abajo)*

This is the complete client of [b2c.custodium.space](https://b2c.custodium.space), a digital succession plan. Everything the browser runs is in this repository: no build step, no bundler, no frameworks. All encryption happens in the browser (PBKDF2 + AES-GCM, see `crypto.js`); the server only ever stores ciphertext and never receives passwords, passphrases or content in the clear.

The server side (a Cloudflare Worker) is **not** in this repository.

**Verify what the site serves.** The footer of every page shows the deployed version, also available at [/VERSION](https://b2c.custodium.space/VERSION) — it is a commit hash of this repository. To check that the site serves exactly this code:

```sh
git clone https://github.com/victorsala/custodium-client && cd custodium-client
git checkout $(curl -s https://b2c.custodium.space/VERSION)
for f in index.html app.js crypto.js words.js abrir.html abrir.js aqui.html aqui.js abrir-offline.html fflate.js style.css; do
  diff <(curl -sL "https://b2c.custodium.space/$f") "$f" && echo "OK $f"
done
```

---

# Cliente de Custodium

Este es el cliente completo de [b2c.custodium.space](https://b2c.custodium.space), un plan de sucesión digital. Todo lo que ejecuta el navegador está en este repositorio: sin build, sin bundler, sin frameworks. Todo el cifrado ocurre en el navegador (PBKDF2 + AES-GCM, ver `crypto.js`); el servidor solo guarda texto cifrado y nunca recibe contraseñas, frases ni contenido en claro.

La parte de servidor (un Worker de Cloudflare) **no** está en este repositorio.

**Verificar lo que sirve la web.** El pie de cada página muestra la versión desplegada, también disponible en [/VERSION](https://b2c.custodium.space/VERSION) — es un hash de commit de este repositorio. Para comprobar que la web sirve exactamente este código, usa los comandos de arriba: descarga cada fichero y compáralo con el commit indicado.

Licenses: [LICENSE](LICENSE) · [THIRD_PARTY.md](THIRD_PARTY.md)
