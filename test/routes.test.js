// Rutes del client (public/routes.js): fragment de l'URL ↔ pantalla. Pures,
// sense DOM: node --test (Node 20).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, routeHash } from "../public/routes.js";

const UUID = "3f2b9c1e-8d4a-4b6f-9e2a-1c5d7e9f0a3b";

test("parseRoute: cada ruta, i routeHash la torna a la forma canònica", () => {
  const cases = {
    "#/plan": { name: "plan" },
    "#/elemento/nuevo": { name: "item", id: null },
    [`#/elemento/${UUID}`]: { name: "item", id: UUID },
    "#/personas": { name: "people" },
    "#/persona/nueva": { name: "person", id: null },
    [`#/persona/${UUID}`]: { name: "person", id: UUID },
    "#/cuenta": { name: "account" },
    "#/crear-cuenta": { name: "register" },
  };
  for (const [hash, route] of Object.entries(cases)) {
    assert.deepEqual(parseRoute(hash), route, hash);
    assert.equal(routeHash(route), hash);
  }
});

test("parseRoute: sense fragment és el pla", () => {
  for (const hash of ["", "#", "#/", null, undefined]) assert.deepEqual(parseRoute(hash), { name: "plan" }, String(hash));
});

test("parseRoute: tolera la barra final", () => {
  assert.deepEqual(parseRoute("#/personas/"), { name: "people" });
  assert.deepEqual(parseRoute("#/elemento/nuevo/"), { name: "item", id: null });
});

test("parseRoute: el que no és cap ruta → null", () => {
  for (const hash of ["#plan", "#/foo", "#/elemento", "#/elemento/", "#/persona/", "#/cuenta/x", "#/elemento/nuevo/x", "#/Plan", "#/PERSONAS"]) {
    assert.equal(parseRoute(hash), null, hash);
  }
});

test("parseRoute: un id només pot ser lletres, xifres i guions, fins a 64", () => {
  for (const bad of ["../x", "a b", "a%20b", "<script>", "x?y=1", "a.b", "a".repeat(65)]) {
    assert.equal(parseRoute(`#/elemento/${bad}`), null, bad);
    assert.equal(parseRoute(`#/persona/${bad}`), null, bad);
  }
  assert.deepEqual(parseRoute("#/elemento/" + "a".repeat(64)), { name: "item", id: "a".repeat(64) });
});

test("routeHash: una ruta desconeguda o absent és el pla", () => {
  assert.equal(routeHash(null), "#/plan");
  assert.equal(routeHash({ name: "foo" }), "#/plan");
});
