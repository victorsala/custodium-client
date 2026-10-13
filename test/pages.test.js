// Pàgines estàtiques de public/: cada enllaç intern apunta a un fitxer que existeix
// (Workers Assets serveix /x.html també com a /x), i les pàgines de visitant porten
// la navegació superior i el peu legal. Sense DOM: expressions regulars sobre l'HTML.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = new URL("../public/", import.meta.url).pathname;
const pages = readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));
const html = Object.fromEntries(pages.map((f) => [f, readFileSync(join(PUBLIC, f), "utf8")]));

// Pàgines que es veuen sense sessió i han de portar la navegació de visitant.
const VISITOR = ["index.html", "como-funciona.html", "seguridad.html", "codigo.html", "preguntas.html", "legal.html", "formato.html"];
const NAV = ["/como-funciona", "/seguridad", "/codigo", "/preguntas"];
const FOOT = ["/legal#aviso-legal", "/legal#privacidad", "/legal#cookies", "/legal#condiciones"];
const GENERATED = new Set(["/VERSION"]); // l'escriu el deploy

function resolves(href) {
  const [path] = href.split("#");
  if (path === "" || path === "/") return true;
  if (GENERATED.has(path)) return true;
  const file = path.replace(/^\//, "");
  return existsSync(join(PUBLIC, file)) || existsSync(join(PUBLIC, `${file}.html`));
}

test("pàgines: cada enllaç intern (href=\"/…\") apunta a un fitxer de public/", () => {
  for (const [name, src] of Object.entries(html)) {
    for (const [, href] of src.matchAll(/href="(\/[^"]*)"/g)) {
      assert.ok(resolves(href), `${name}: ${href} no apunta a cap fitxer de public/`);
    }
  }
});

test("pàgines: els fragments (#id) dels enllaços interns existeixen a la pàgina de destí", () => {
  for (const [name, src] of Object.entries(html)) {
    for (const [, href] of src.matchAll(/href="(\/[a-z-]+#[^"/][^"]*)"/g)) {
      const [path, id] = href.split("#");
      const target = html[`${path.slice(1)}.html`];
      assert.ok(target, `${name}: ${href} sense pàgina`);
      assert.ok(target.includes(`id="${id}"`), `${name}: ${href} sense id="${id}" a ${path}.html`);
    }
    for (const [, id] of src.matchAll(/href="#([^"/][^"]*)"/g)) {
      assert.ok(src.includes(`id="${id}"`), `${name}: #${id} no existeix a la mateixa pàgina`);
    }
  }
});

test("pàgines de visitant: navegació superior sencera i peu legal", () => {
  for (const name of VISITOR) {
    const src = html[name];
    assert.ok(src.includes('class="top-nav visitor-nav"'), `${name}: sense visitor-nav`);
    for (const href of NAV) assert.ok(src.includes(`href="${href}"`), `${name}: la navegació no té ${href}`);
    for (const href of FOOT) assert.ok(src.includes(`href="${href}"`), `${name}: el peu no té ${href}`);
    assert.ok(!src.includes("beta privada"), `${name}: encara diu "beta privada"`);
  }
  // La pàgina actual queda marcada, i només ella.
  for (const name of VISITOR.filter((n) => n !== "index.html" && n !== "legal.html" && n !== "formato.html")) {
    const marks = [...html[name].matchAll(/href="(\/[a-z-]+)" aria-current="page"/g)].map((m) => m[1]);
    assert.deepEqual(marks, [`/${name.replace(".html", "")}`], `${name}: aria-current`);
  }
});

test("panell d'estadístiques: cada pestanya té el seu panell, i botons i panells no comparteixen atribut", () => {
  const src = html["stats-panel.html"];
  const tabs = [...src.matchAll(/class="tab[^"]*" data-tab="([a-z]+)"/g)].map((m) => m[1]);
  const panels = [...src.matchAll(/<section data-panel="([a-z]+)"/g)].map((m) => m[1]);
  assert.equal(tabs.length, 5);
  assert.deepEqual(panels, tabs);
  assert.doesNotMatch(src, /<section data-tab=/, "si els panells porten data-tab, amagar-los amaga també els botons");
  const js = readFileSync(join(PUBLIC, "stats-panel.js"), "utf8");
  assert.match(js, /querySelectorAll\("main \[data-panel\]"\)/);
});

test("pàgines públiques: indexables i amb descripció; les de persones de confiança, noindex", () => {
  for (const name of VISITOR) {
    assert.ok(!/name="robots"/.test(html[name]), `${name}: no ha de portar robots noindex`);
    assert.ok(/<meta name="description" content="[^"]{40,}">/.test(html[name]), `${name}: sense meta description`);
  }
  for (const name of ["abrir.html", "aqui.html"]) assert.ok(/content="noindex, nofollow"/.test(html[name]), `${name}: ha de portar noindex`);
  const robots = readFileSync(join(PUBLIC, "robots.txt"), "utf8");
  for (const p of ["/abrir.html", "/aqui.html", "/api/"]) assert.ok(robots.includes(`Disallow: ${p}`), `robots.txt no exclou ${p}`);
});

test("pàgines de persona (abrir, aqui) i obridor: peu legal, sense navegació de visitant", () => {
  for (const name of ["abrir.html", "aqui.html"]) {
    assert.ok(html[name].includes('class="foot-legal"'), `${name}: sense peu legal`);
    assert.ok(!html[name].includes("visitor-nav"), `${name}: no ha de portar la navegació de visitant`);
  }
  assert.ok(!html["abrir-offline.html"].includes('href="/'), "abrir-offline.html no pot dependre del servidor");
});
