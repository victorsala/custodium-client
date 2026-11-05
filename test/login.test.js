// Entrada (POST /api/login) i comptador: una entrada correcta suma el pas /sesion, l'automàtica
// que segueix l'alta (afterSignup) no, i una d'incorrecta tampoc. El Worker sencer contra una D1 de mentida.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import worker from "../src/index.js";

const AUTH = randomBytes(32);
const SALT = randomBytes(16);
const HASH = createHash("sha256").update(SALT).update(AUTH).digest();
let steps, env;

beforeEach(() => {
  steps = [];
  const user = { id: "u1", auth_salt: SALT.toString("base64"), auth_hash: HASH.toString("base64") };
  env = {
    DB: {
      prepare(sql) {
        let args = [];
        const st = {
          bind: (...a) => { args = a; return st; },
          first: async () => {
            if (/^SELECT id, auth_salt, auth_hash FROM users WHERE email = \?$/.test(sql)) return args[0] === "ana@example.com" ? user : null;
            return { n: 0, known: 0 }; // límit de campanyes del comptador
          },
          run: async () => { if (sql.startsWith("INSERT INTO stats")) steps.push({ path: args[1], source: args[2], campaign: args[3] }); return { success: true }; },
          all: async () => ({ results: [] }),
        };
        return st;
      },
      async batch(list) { for (const st of list) await st.run(); return []; },
    },
  };
});

const login = (body) => worker.fetch(new Request("https://example.com/api/login", { method: "POST", body: JSON.stringify(body) }), env);

test("entrada correcta: suma /sesion amb l'origen i la campanya del client", async () => {
  const r = await login({ email: "ana@example.com", authHash: AUTH.toString("base64"), source: "anuncio", campaign: "ads-nov" });
  assert.equal(r.status, 200);
  assert.deepEqual(steps, [{ path: "/sesion", source: "anuncio", campaign: "ads-nov" }]);
});

test("l'entrada automàtica després de l'alta (afterSignup) i una d'incorrecta no sumen", async () => {
  const a = await login({ email: "ana@example.com", authHash: AUTH.toString("base64"), afterSignup: true });
  assert.equal(a.status, 200);
  const b = await login({ email: "ana@example.com", authHash: randomBytes(32).toString("base64") });
  assert.equal(b.status, 401);
  const c = await login({ email: "ningu@example.com", authHash: AUTH.toString("base64") });
  assert.equal(c.status, 401);
  assert.deepEqual(steps, []);
});
