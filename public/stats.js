// Comptador propi de visites, només a la portada i a les pàgines de visitant. Envia una
// vista en carregar i, en sortir, els segons que la pàgina ha estat visible. Tot al mateix
// origen (POST /api/stats), on es suma per dia, pàgina, origen, campanya i país: sense
// cookies, sense localStorage, sense cap identificador, cap fila per visitant. A la portada
// cada pantalla d'entrada compta com una pàgina («/» el login, «/crear-cuenta» el pas 1 de
// l'alta, «/crear-cuenta/codigo» el pas 2, segons body.dataset.statsScreen, que posa app.js);
// dins de l'app no es compta res. README §2.3.
(() => {
  const PAGES = ["/", "/como-funciona", "/seguridad", "/codigo", "/preguntas", "/legal", "/formato"];
  const SCREENS = { login: "/", register: "/crear-cuenta", "register-code": "/crear-cuenta/codigo" };
  const path = location.pathname.replace(/\/index\.html$/, "/").replace(/\.html$/, "");
  const q = new URLSearchParams(location.search);

  // Campanya: l'etiqueta utm_campaign de l'anunci (o ?c=, que és com viatja entre les
  // pàgines del web). Identifica l'anunci, no la persona, i no es guarda enlloc més.
  const campaign = (q.get("utm_campaign") ?? q.get("c") ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  let ref = "";
  try { ref = document.referrer ? new URL(document.referrer).hostname : ""; } catch { ref = ""; }
  const source = campaign || q.has("utm_source") || q.has("gclid") ? "anuncio"
    : /(^|\.)custodium\.space$/.test(ref) ? "interno"
    : /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|qwant|brave)\./.test(ref) ? "buscador"
    : ref === "" ? "directo"
    : "otro";
  // app.js ho adjunta a l'alta perquè el servidor sumi "altas" per origen i campanya,
  // sense guardar-ho al compte.
  window.custodiumVisit = Object.freeze({ source, campaign });

  if (!PAGES.includes(path) || typeof navigator.sendBeacon !== "function") return;

  // La campanya passa a tots els enllaços interns de la pàgina (?c=…): navegació, marca,
  // «más detalle», crides a l'acció i peu legal, perquè les pàgines següents comptin amb
  // ella dins de la mateixa visita. Res queda al navegador.
  if (campaign) {
    for (const a of document.querySelectorAll("a.brand, .visitor-nav a, .more-links a, .doc-cta a, .foot-legal a")) {
      try {
        const u = new URL(a.getAttribute("href"), location.origin);
        if (u.origin !== location.origin || u.searchParams.has("c")) continue;
        u.searchParams.set("c", campaign);
        a.setAttribute("href", u.pathname + u.search + u.hash);
      } catch { /* enllaç que no és un URL: es deixa estar */ }
    }
  }

  const send = (page, data) => navigator.sendBeacon("/api/stats", JSON.stringify({ path: page, source, campaign, ...data }));

  // Clic a l'enllaç per reservar 15 minuts (cal.com): un pas més de l'embut, "/llamada". Només el
  // clic; la reserva en si la sap Cal.com, no nosaltres.
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.('a[href^="https://cal.com/"]');
    if (a) send("/llamada", { kind: "view" });
  });

  // Una "pàgina" en curs: la seva vista ja enviada, i el temps visible que acumula fins que
  // s'envia un sol cop (en sortir, en amagar-se la pestanya o en canviar de pantalla).
  let current = null; // { page, since, total, sent }
  const pause = () => { if (current && current.since !== null) { current.total += performance.now() - current.since; current.since = null; } };
  const resume = () => { if (current && !current.sent && current.since === null && document.visibilityState === "visible") current.since = performance.now(); };
  const report = () => {
    if (!current || current.sent) return;
    pause();
    const seconds = Math.min(Math.round(current.total / 1000), 1800);
    if (seconds >= 1) { current.sent = true; send(current.page, { kind: "time", seconds }); }
  };
  const start = (page) => {
    report();
    current = { page, since: document.visibilityState === "visible" ? performance.now() : null, total: 0, sent: false };
    send(page, { kind: "view" });
  };
  const stop = () => { report(); current = null; };

  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resume(); else report(); });
  addEventListener("pagehide", report);

  if (path !== "/") { start(path); return; }

  // Portada: la pantalla la diu app.js a body.dataset.statsScreen. Les d'entrada compten com a
  // pàgines; qualsevol altra (dins de l'app) atura el comptador.
  const sync = () => {
    const page = SCREENS[document.body.dataset.statsScreen];
    if (!page) { if (current) stop(); return; }
    if (!current || current.page !== page) start(page);
  };
  sync();
  new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ["data-stats-screen"] });
})();
