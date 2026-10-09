// Comptador de visites (POST /api/stats): el Worker sencer contra una D1 de mentida que
// només recorda les sentències i els seus arguments. Sense dependències: node --test.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

let rows, cap, env;
beforeEach(() => {
  rows = [];
  cap = { n: 0, known: 0 }; // resposta de la consulta del límit de campanyes per dia
  env = {
    DB: {
      prepare(sql) {
        let args = [];
        const st = {
          bind: (...a) => { args = a; return st; },
          first: async () => { rows.push({ sql: sql.replace(/\s+/g, " ").trim(), args }); return cap; },
          run: async () => { rows.push({ sql: sql.replace(/\s+/g, " ").trim(), args }); return { success: true }; },
        };
        return st;
      },
    },
  };
});

function post(body, { country, headers = {} } = {}) {
  const req = new Request("https://example.com/api/stats", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers });
  if (country) Object.defineProperty(req, "cf", { value: { country } });
  return worker.fetch(req, env);
}
const today = () => new Date().toISOString().slice(0, 10);
const inserts = () => rows.filter((r) => r.sql.startsWith("INSERT"));

test("stats: una vista suma 1 a la fila (dia, pàgina, origen, campanya, país) amb un upsert", async () => {
  const r = await post({ kind: "view", path: "/seguridad", source: "interno" }, { country: "ES" });
  assert.equal(r.status, 204);
  assert.equal(rows.length, 1, "sense campanya no es consulta cap límit");
  assert.match(rows[0].sql, /^INSERT INTO stats \(day, path, source, campaign, country, views, seconds, reads\) VALUES \(\?, \?, \?, \?, \?, \?, \?, \?\) ON CONFLICT\(day, path, source, campaign, country\) DO UPDATE SET views = views \+ excluded\.views, seconds = seconds \+ excluded\.seconds, reads = reads \+ excluded\.reads$/);
  assert.deepEqual(rows[0].args, [today(), "/seguridad", "interno", "", "ES", 1, 0, 0]);
});

test("stats: el temps suma els segons i una lectura, no cap vista; sense país → ZZ", async () => {
  const r = await post({ kind: "time", path: "/como-funciona", source: "anuncio", seconds: 42 });
  assert.equal(r.status, 204);
  assert.deepEqual(rows[0].args, [today(), "/como-funciona", "anuncio", "", "ZZ", 0, 42, 1]);
});

test("stats: la campanya es normalitza i, mentre no es passi el límit diari, es guarda tal qual", async () => {
  const r = await post({ kind: "view", path: "/", source: "anuncio", campaign: "  Ads Octubre 2026!  " }, { country: "ES" });
  assert.equal(r.status, 204);
  assert.equal(rows.length, 2);
  assert.match(rows[0].sql, /^SELECT \(SELECT COUNT\(\*\) FROM \(SELECT DISTINCT campaign FROM stats WHERE day = \? AND campaign != ''\)\) AS n, EXISTS\(SELECT 1 FROM stats WHERE day = \? AND campaign = \?\) AS known$/);
  assert.deepEqual(rows[0].args, [today(), today(), "adsoctubre2026"]);
  assert.deepEqual(inserts()[0].args, [today(), "/", "anuncio", "adsoctubre2026", "ES", 1, 0, 0]);
});

test("stats: passat el límit de campanyes del dia, una de nova cau a «otra»; una de coneguda no", async () => {
  cap = { n: 20, known: 0 };
  await post({ kind: "view", path: "/", source: "anuncio", campaign: "nova" });
  assert.equal(inserts()[0].args[3], "otra");
  rows = [];
  cap = { n: 20, known: 1 };
  await post({ kind: "view", path: "/", source: "anuncio", campaign: "coneguda" });
  assert.equal(inserts()[0].args[3], "coneguda");
});

test("stats: el cos pot arribar com a text pla (sendBeacon) i la portada compta com a /", async () => {
  const r = await post(JSON.stringify({ kind: "view", path: "/", source: "directo" }), { headers: { "content-type": "text/plain;charset=UTF-8" } });
  assert.equal(r.status, 204);
  assert.equal(rows[0].args[1], "/");
});

test("stats: pàgina, origen, tipus o segons fora de rang → 400 i cap escriptura; els passos de l'alta no entren pel beacon", async () => {
  const bad = [
    { kind: "view", path: "/abrir", source: "interno" },
    { kind: "view", path: "/seguridad.html", source: "interno" },
    { kind: "view", path: "/alta", source: "anuncio" },
    { kind: "view", path: "/alta/codigo", source: "anuncio" },
    { kind: "view", path: "/seguridad", source: "facebook" },
    { kind: "click", path: "/seguridad", source: "interno" },
    { kind: "time", path: "/seguridad", source: "interno", seconds: 0 },
    { kind: "time", path: "/seguridad", source: "interno", seconds: 1801 },
    { kind: "time", path: "/seguridad", source: "interno", seconds: 3.5 },
    { kind: "time", path: "/seguridad", source: "interno", seconds: "12" },
    { kind: "time", path: "/seguridad", source: "interno" },
    "no és json",
  ];
  for (const b of bad) {
    const r = await post(b);
    assert.equal(r.status, 400, JSON.stringify(b));
  }
  assert.equal(rows.length, 0);
});

test("stats: una petició d'un altre lloc (Sec-Fetch-Site ≠ same-origin) → 403; sense capçalera (curl) passa", async () => {
  const r = await post({ kind: "view", path: "/legal", source: "otro" }, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(r.status, 403);
  assert.equal(rows.length, 0);
  const ok = await post({ kind: "view", path: "/legal", source: "otro" }, { headers: { "sec-fetch-site": "same-origin" } });
  assert.equal(ok.status, 204);
  assert.equal(rows.length, 1);
});
