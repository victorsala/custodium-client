// Panell d'estadístiques: /stats i /api/admin/stats darrere d'usuari i contrasenya (HTTP Basic)
// contra el hash del secret. El Worker sencer amb una D1, un ASSETS i un entorn de mentida.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../src/index.js";

const CRED = "ana:ebano deporte nacar cien organo vagar";
const HASH = createHash("sha256").update(CRED, "utf8").digest("hex");
const basic = (cred) => "Basic " + Buffer.from(cred, "utf8").toString("base64");

let env, queries;
beforeEach(() => {
  queries = [];
  env = {
    STATS_AUTH_SHA256: HASH.toUpperCase(), // majúscules a propòsit: es normalitza
    DB: {
      prepare(sql) {
        let args = [];
        const st = {
          bind: (...a) => { args = a; return st; },
          all: async () => {
            queries.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
            if (/^SELECT DISTINCT campaign/.test(sql)) return { results: [{ campaign: "ads-octubre" }, { campaign: "prueba" }] };
            return { results: [{ day: "2026-10-10", path: "/", source: "anuncio", campaign: "ads-octubre", country: "ES", views: 3, seconds: 40, reads: 2 }] };
          },
        };
        return st;
      },
    },
    ASSETS: { fetch: async (url) => (String(url).endsWith("/stats-panel") ? new Response("<!doctype html><title>panel</title>", { status: 200, headers: { "content-type": "text/html" } }) : new Response("no", { status: 404 })) },
  };
});
const get = (path, headers = {}) => worker.fetch(new Request(`https://example.com${path}`, { headers }), env);

test("panell: sense credencials → 401 amb el repte Basic; amb credencials dolentes, igual", async () => {
  for (const headers of [{}, { authorization: basic("ana:dolenta") }, { authorization: "Bearer x" }, { authorization: "Basic %%%" }]) {
    const r = await get("/stats", headers);
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate"), /^Basic realm=/);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal(queries.length, 0, "cap consulta sense autenticar");
});

test("panell: amb les credencials bones, /stats serveix la pàgina amb CSP, no-store i noindex", async () => {
  const r = await get("/stats", { authorization: basic(CRED) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'; script-src 'self'/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await r.text(), /<title>panel<\/title>/);
});

test("dades: el període i la campanya (normalitzada) van a la consulta; tornen files i campanyes", async () => {
  const r = await get("/api/admin/stats?desde=2026-10-01&fins=2026-10-10&campaign=Ads%20Octubre", { authorization: basic(CRED) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const data = await r.json();
  assert.deepEqual([data.from, data.to, data.campaign], ["2026-10-01", "2026-10-10", "adsoctubre"]);
  assert.equal(data.rows.length, 1);
  assert.deepEqual(data.campaigns, ["ads-octubre", "prueba"]);
  const q = queries.find((x) => x.sql.startsWith("SELECT day, path"));
  assert.match(q.sql, /WHERE day >= \? AND day <= \? AND campaign = \? ORDER BY day$/);
  assert.deepEqual(q.args, ["2026-10-01", "2026-10-10", "adsoctubre"]);
});

test("dades: sense paràmetres són 30 dies fins avui; sense campanya no es filtra; dates mal formades → 400", async () => {
  const r = await get("/api/admin/stats", { authorization: basic(CRED) });
  const data = await r.json();
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(data.to, today);
  assert.equal(Math.round((Date.parse(data.to) - Date.parse(data.from)) / 86400000), 29);
  const q = queries.find((x) => x.sql.startsWith("SELECT day, path"));
  assert.doesNotMatch(q.sql, /campaign = \?/);
  for (const bad of ["?desde=2026-1-1", "?fins=ahir", "?desde=2026-10-10&fins=2026-10-01"]) {
    const b = await get(`/api/admin/stats${bad}`, { authorization: basic(CRED) });
    assert.equal(b.status, 400, bad);
  }
});

test("panell: sense el secret, les dues rutes no existeixen (404), fins i tot amb credencials", async () => {
  delete env.STATS_AUTH_SHA256;
  for (const p of ["/stats", "/api/admin/stats"]) {
    const r = await get(p, { authorization: basic(CRED) });
    assert.equal(r.status, 404, p);
  }
});
