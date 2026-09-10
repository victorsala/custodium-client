#!/usr/bin/env node
// Comprova que el SALT_PEPPER guardat al gestor de contrasenyes és el que hi
// ha desplegat: calcula la sal falsa d'un email exactament com ho fa el Worker
// i la compara amb la que retorna /api/salt?email= de producció (o d'staging).
//
//   node scripts/check-pepper.mjs <pepper> [email] [--staging]
//   echo -n "$PEPPER" | node scripts/check-pepper.mjs - [email] [--staging]
//
// Amb "-" el pepper es llegeix d'stdin, per no deixar-lo a l'historial de
// l'intèrpret d'ordres. Mai s'imprimeix. Sense email, se'n fa servir un que
// no pot tenir compte (així /api/salt respon amb l'HMAC i no amb una sal
// guardada). Surt amb 0 si coincideix i amb 1 si no.
//
// La derivació no es reescriu aquí: s'extreu de src/index.js tal com es
// desplega (deriveSalt i KDF_SALT_BYTES), com fan els tests. Si el Worker
// canvia, aquest script canvia amb ell.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const staging = args.includes("--staging");
const positional = args.filter((a) => a !== "--staging");
if (positional.length < 1 || positional.length > 2) {
  console.error("Ús: node scripts/check-pepper.mjs <pepper|-> [email] [--staging]");
  process.exit(2);
}

let pepper = positional[0];
if (pepper === "-") pepper = readFileSync(0, "utf8").replace(/\r?\n$/, "");
if (!pepper) {
  console.error("El pepper és buit.");
  process.exit(2);
}

// Mateixa normalització que parseEmail al Worker: trim i minúscules.
const email = (positional[1] ?? `check-pepper-${Date.now().toString(36)}@example.invalid`).trim().toLowerCase();
const base = staging ? "https://b2c-staging.custodium.space" : "https://b2c.custodium.space";

// deriveSalt i KDF_SALT_BYTES, del Worker que es desplega.
const workerSrc = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
const bytes = workerSrc.match(/^const KDF_SALT_BYTES = (\d+);/m);
const fn = workerSrc.match(/async function deriveSalt\(pepper, email\) \{[\s\S]*?\n\}/);
if (!bytes || !fn) {
  console.error("No s'ha trobat deriveSalt o KDF_SALT_BYTES dins src/index.js.");
  process.exit(2);
}
const deriveSalt = new Function("KDF_SALT_BYTES", `return ${fn[0]}`)(Number(bytes[1]));

// Mateixa codificació que b64.encode al Worker (base64 estàndard).
const expected = Buffer.from(await deriveSalt(pepper, email)).toString("base64");

const res = await fetch(`${base}/api/salt?email=${encodeURIComponent(email)}`);
if (!res.ok) {
  console.error(`${base}/api/salt ha respost ${res.status}: ${await res.text()}`);
  process.exit(2);
}
const { salt } = await res.json();

console.log(`entorn:     ${staging ? "staging" : "producció"} (${base})`);
console.log(`email:      ${email}`);
console.log(`calculada:  ${expected}`);
console.log(`servidor:   ${salt}`);
if (salt === expected) {
  console.log("Coincideix: el pepper és el desplegat.");
  process.exit(0);
}
console.log("NO coincideix: el pepper no és el desplegat, o l'email té compte amb una sal fixada.");
process.exit(1);
