// routes.js — rutes del client, al fragment de l'URL (README §2.8).
//
// La pantalla viu al fragment (#/plan, #/personas, #/elemento/<id>…) i el
// navegador la posa a l'historial: enrere, endavant, recarregar i enllaçar
// funcionen com a qualsevol web. El fragment no arriba mai al servidor. Només
// hi van noms de pantalla i ids d'element o de persona (UUIDs generats al
// navegador): cap token ni cap dada.
//
// Pures i sense DOM: es proven a test/routes.test.js.

const ID = /^[A-Za-z0-9-]{1,64}$/;

// "#/persona/<id>" → { name: "person", id }. Sense fragment (o "#/") és el
// pla. Una ruta que no existeix, sense la barra inicial o amb un id de
// caràcters estranys → null.
export function parseRoute(hash) {
  const path = String(hash ?? "").replace(/^#/, "");
  if (path && !path.startsWith("/")) return null;
  const parts = path.split("/").filter(Boolean);
  const [a, b] = parts;
  if (parts.length === 0) return { name: "plan" };
  if (parts.length === 1) {
    if (a === "plan") return { name: "plan" };
    if (a === "personas") return { name: "people" };
    if (a === "cuenta") return { name: "account" };
    if (a === "crear-cuenta") return { name: "register" };
    return null;
  }
  if (parts.length === 2 && a === "elemento") {
    if (b === "nuevo") return { name: "item", id: null };
    return ID.test(b) ? { name: "item", id: b } : null;
  }
  if (parts.length === 2 && a === "persona") {
    if (b === "nueva") return { name: "person", id: null };
    return ID.test(b) ? { name: "person", id: b } : null;
  }
  return null;
}

// La inversa: ruta → fragment canònic.
export function routeHash(route) {
  switch (route?.name) {
    case "item": return route.id ? `#/elemento/${route.id}` : "#/elemento/nuevo";
    case "person": return route.id ? `#/persona/${route.id}` : "#/persona/nueva";
    case "people": return "#/personas";
    case "account": return "#/cuenta";
    case "register": return "#/crear-cuenta";
    default: return "#/plan";
  }
}
