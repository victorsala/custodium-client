// Comptador propi de visites, només a la portada i a les pàgines de visitant. Envia una
// vista en carregar i, en sortir, els segons que la pàgina ha estat visible. Tot al mateix
// origen (POST /api/stats), on es suma per dia, pàgina, origen, campanya i país: sense
// cookies, sense localStorage, sense cap identificador, cap fila per visitant. A la portada
// el temps compta només mentre és portada: dins de l'app no es compta res. README §2.3.
(() => {
  const PAGES = ["/", "/como-funciona", "/seguridad", "/codigo", "/preguntas", "/legal"];
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

  // La campanya passa als enllaços interns de la pàgina (?c=…) perquè les pàgines
  // següents comptin amb ella dins de la mateixa visita. Res queda al navegador.
  if (campaign) {
    for (const a of document.querySelectorAll(".visitor-nav a, .more-links a, .doc-cta a")) {
      try {
        const u = new URL(a.getAttribute("href"), location.origin);
        if (u.origin !== location.origin || u.searchParams.has("c")) continue;
        u.searchParams.set("c", campaign);
        a.setAttribute("href", u.pathname + u.search + u.hash);
      } catch { /* enllaç que no és un URL: es deixa estar */ }
    }
  }

  const send = (data) => navigator.sendBeacon("/api/stats", JSON.stringify({ path, source, campaign, ...data }));
  send({ kind: "view" });

  // Temps visible: s'atura quan la pestanya passa a segon pla i s'envia un sol cop, en
  // sortir (pagehide), en amagar-se (al mòbil pagehide no sempre arriba) o, a la portada,
  // en entrar a l'app (body deixa de ser is-entry).
  let since = document.visibilityState === "visible" ? performance.now() : null;
  let total = 0;
  let sent = false;
  const pause = () => { if (since !== null) { total += performance.now() - since; since = null; } };
  const resume = () => { if (!sent && since === null && document.visibilityState === "visible") since = performance.now(); };
  const report = () => {
    if (sent) return;
    pause();
    const seconds = Math.min(Math.round(total / 1000), 1800);
    if (seconds >= 1) { sent = true; send({ kind: "time", seconds }); }
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resume(); else report(); });
  addEventListener("pagehide", report);
  if (path === "/") {
    new MutationObserver(() => { if (document.body.classList.contains("is-entry")) resume(); else report(); })
      .observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
})();
