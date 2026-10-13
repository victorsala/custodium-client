// Panell d'estadístiques (/stats; README §2.8). El Worker ja ha demanat usuari i contrasenya
// per servir la pàgina; el navegador els reenvia sol a /api/admin/stats. D'allà arriben les
// files agregades del període (dia, pàgina, origen, campanya, país, vistes, segons, lectures)
// i aquí es fan les sumes, els talls per vista i l'ordenació. Sense dependències.
(() => {
  const $ = (s) => document.querySelector(s);
  const STEPS = { "/alta/codigo": "paso: código enviado", "/alta": "paso: cuenta creada", "/llamada": "paso: llamada pedida" };
  const PAGE_NAMES = {
    "/": "Portada (login)", "/crear-cuenta": "Crear cuenta (paso 1)", "/crear-cuenta/codigo": "Crear cuenta (paso 2)",
    "/como-funciona": "Cómo funciona", "/seguridad": "Seguridad", "/codigo": "Código", "/preguntas": "Preguntas", "/legal": "Legal", "/formato": "Formato",
  };
  const SOURCE_NAMES = { anuncio: "Anuncio", buscador: "Buscador", interno: "Interno", directo: "Directo", otro: "Otro" };
  const nf = new Intl.NumberFormat("es-ES");
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const msg = (t) => { $("#dash-msg").textContent = t; };
  const pctText = (v, d = 1) => (v === null || v === undefined ? "–" : v.toFixed(d).replace(".", ",") + " %");

  let rows = [];
  let range = { from: "", to: "" };
  let tab = "resumen";
  const tables = {}; // id → { title, cols, data }
  const sorts = {};  // id → { key, dir }

  $("#dash-env").textContent = /^b2c-staging\./.test(location.hostname) ? "staging" : "";

  // ---- filtres ----
  const fmtDate = (d) => d.toISOString().slice(0, 10);
  function period() {
    const v = $("#periodo").value;
    if (v === "custom") return { from: $("#desde").value, to: $("#hasta").value };
    return { from: fmtDate(new Date(Date.now() - (Number(v) - 1) * 86400000)), to: fmtDate(new Date()) };
  }
  $("#periodo").addEventListener("change", () => {
    const custom = $("#periodo").value === "custom";
    for (const l of document.querySelectorAll(".dash-date")) l.hidden = !custom;
    if (custom && !$("#desde").value) { const p = period.call(null); $("#desde").value = fmtDate(new Date(Date.now() - 29 * 86400000)); $("#hasta").value = fmtDate(new Date()); void p; }
  });
  $("#filters").addEventListener("submit", (e) => { e.preventDefault(); load(); });

  async function load() {
    const { from, to } = period();
    if (!from || !to) return msg("Indica las dos fechas.");
    if (from > to) return msg("La fecha inicial es posterior a la final.");
    msg("Cargando…");
    const q = new URLSearchParams({ desde: from, fins: to });
    const campaign = $("#campana").value;
    if (campaign) q.set("campaign", campaign);
    let r;
    try { r = await fetch(`/api/admin/stats?${q}`, { headers: { accept: "application/json" } }); } catch { return msg("Sin conexión."); }
    if (r.status === 401) return msg("Acceso restringido: recarga la página y escribe el usuario y la contraseña.");
    if (!r.ok) return msg(`No se han podido cargar las estadísticas (${r.status}).`);
    const data = await r.json();
    rows = data.rows;
    range = { from: data.from, to: data.to };
    fillCampaigns(data.campaigns, campaign);
    msg(rows.length ? `Del ${data.from} al ${data.to}${data.campaign ? ` · campaña ${data.campaign}` : ""}.` : "Sin visitas en este periodo.");
    render();
  }
  function fillCampaigns(list, current) {
    const sel = $("#campana");
    sel.innerHTML = '<option value="">Todas</option>' + list.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    sel.value = list.includes(current) ? current : "";
  }

  // ---- agregacions ----
  const isPage = (p) => !(p in STEPS);
  const sum = (list, f) => list.reduce((n, r) => n + f(r), 0);
  function groupBy(list, keyFn) {
    const m = new Map();
    for (const r of list) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return m;
  }
  function stat(list) {
    const s = {
      vistas: sum(list, (r) => (isPage(r.path) ? r.views : 0)),
      lecturas: sum(list, (r) => r.reads),
      segundos: sum(list, (r) => r.seconds),
      portada: sum(list, (r) => (r.path === "/" ? r.views : 0)),
      crear: sum(list, (r) => (r.path === "/crear-cuenta" ? r.views : 0)),
      codigo: sum(list, (r) => (r.path === "/crear-cuenta/codigo" ? r.views : 0)),
      enviados: sum(list, (r) => (r.path === "/alta/codigo" ? r.views : 0)),
      altas: sum(list, (r) => (r.path === "/alta" ? r.views : 0)),
      llamadas: sum(list, (r) => (r.path === "/llamada" ? r.views : 0)),
    };
    s.otras = s.vistas - s.portada - s.crear - s.codigo;
    s.seg = s.lecturas ? Math.round(s.segundos / s.lecturas) : null;
    s.pcta = s.portada ? (100 * s.altas) / s.portada : null;
    return s;
  }

  // ---- vistes ----
  function render() {
    renderKpis();
    renderBars();
    renderTable("t-dia", "Por día", [
      { key: "day", label: "Día" }, { key: "vistas", label: "Páginas vistas", num: true }, { key: "lecturas", label: "Lecturas", num: true },
      { key: "seg", label: "Seg. medios", num: true }, { key: "portada", label: "Portadas", num: true }, { key: "altas", label: "Altas", num: true }, { key: "llamadas", label: "Llamadas", num: true },
    ], [...groupBy(rows, (r) => r.day)].map(([day, list]) => ({ day, ...stat(list) })), { key: "day", dir: -1 });

    renderTable("t-pagina", "Por página", [
      { key: "nombre", label: "Página" }, { key: "vistas", label: "Vistas", num: true }, { key: "lecturas", label: "Lecturas", num: true },
      { key: "pctl", label: "% lecturas", num: true, fmt: (v) => pctText(v, 0) }, { key: "seg", label: "Seg. medios", num: true },
    ], [...groupBy(rows, (r) => r.path)].map(([path, list]) => {
      const vistas = sum(list, (r) => r.views), lecturas = sum(list, (r) => r.reads), segundos = sum(list, (r) => r.seconds);
      return { nombre: STEPS[path] ?? PAGE_NAMES[path] ?? path, vistas, lecturas, pctl: path in STEPS ? null : vistas ? (100 * lecturas) / vistas : null, seg: lecturas ? Math.round(segundos / lecturas) : null };
    }), { key: "vistas", dir: -1 });

    renderTable("t-campana", "Campañas", [
      { key: "campaign", label: "Campaña" }, { key: "portada", label: "Portada", num: true }, { key: "crear", label: "Crear cuenta", num: true }, { key: "codigo", label: "Paso código", num: true },
      { key: "altas", label: "Altas", num: true }, { key: "pcta", label: "% altas", num: true, fmt: (v) => pctText(v) }, { key: "llamadas", label: "Llamadas", num: true },
      { key: "otras", label: "Otras páginas", num: true }, { key: "seg", label: "Seg. medios", num: true },
    ], [...groupBy(rows.filter((r) => r.campaign), (r) => r.campaign)].map(([campaign, list]) => ({ campaign, ...stat(list) })), { key: "portada", dir: -1 });

    renderTable("t-origen", "Origen", [{ key: "origen", label: "Origen" }, { key: "vistas", label: "Páginas vistas", num: true }, { key: "altas", label: "Altas", num: true }],
      [...groupBy(rows, (r) => r.source)].map(([source, list]) => ({ origen: SOURCE_NAMES[source] ?? source, ...stat(list) })), { key: "vistas", dir: -1 });

    renderTable("t-pais", "País", [{ key: "pais", label: "País" }, { key: "vistas", label: "Páginas vistas", num: true }, { key: "altas", label: "Altas", num: true }],
      [...groupBy(rows, (r) => r.country)].map(([country, list]) => ({ pais: country, ...stat(list) })), { key: "vistas", dir: -1 });
  }

  function renderKpis() {
    const s = stat(rows);
    const items = [
      ["Páginas vistas", nf.format(s.vistas)], ["Lecturas", nf.format(s.lecturas)], ["Seg. medios", s.seg === null ? "–" : nf.format(s.seg)],
      ["Portadas", nf.format(s.portada)], ["Códigos enviados", nf.format(s.enviados)], ["Cuentas creadas", nf.format(s.altas)],
      ["% altas / portadas", pctText(s.pcta)], ["Llamadas pedidas", nf.format(s.llamadas)],
    ];
    $("#kpis").innerHTML = items.map(([l, v]) => `<li><strong>${esc(v)}</strong><span>${esc(l)}</span></li>`).join("");
  }

  function renderBars() {
    const svg = $("#bars");
    const byDay = [...groupBy(rows, (r) => r.day)].map(([day, list]) => [day, stat(list).vistas]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (!byDay.length) { svg.innerHTML = ""; return; }
    const W = 600, H = 160, pad = 24;
    const max = Math.max(1, ...byDay.map((d) => d[1]));
    const slot = (W - pad * 2) / byDay.length;
    const bw = Math.max(2, slot - 2);
    const every = byDay.length <= 16 ? 1 : byDay.length <= 45 ? 7 : 14;
    svg.innerHTML = byDay.map(([day, v], i) => {
      const h = Math.round(((H - pad * 2) * v) / max);
      const x = pad + i * slot;
      const label = i % every === 0 ? `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(day.slice(5))}</text>` : "";
      return `<rect x="${x.toFixed(1)}" y="${H - pad - h}" width="${bw.toFixed(1)}" height="${h}" rx="2"><title>${esc(day)}: ${esc(nf.format(v))}</title></rect>${label}`;
    }).join("") + `<text x="${pad}" y="14">máximo ${esc(nf.format(max))}</text>`;
  }

  // ---- taules ordenables ----
  function renderTable(id, title, cols, data, defaultSort) {
    tables[id] = { title, cols, data };
    if (!sorts[id]) sorts[id] = defaultSort;
    drawTable(id);
  }
  const fmtCell = (v) => (v === null || v === undefined ? "–" : typeof v === "number" ? nf.format(v) : String(v));
  function drawTable(id) {
    const { title, cols, data } = tables[id];
    const s = sorts[id];
    const sorted = [...data].sort((a, b) => {
      const x = a[s.key], y = b[s.key];
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * s.dir;
    });
    const th = cols.map((c) => `<th${c.num ? ' class="num"' : ""}><button type="button" data-sort="${c.key}">${esc(c.label)}${s.key === c.key ? (s.dir < 0 ? " ▾" : " ▴") : ""}</button></th>`).join("");
    const tr = sorted.map((r) => `<tr>${cols.map((c) => `<td${c.num ? ' class="num"' : ""}>${esc(c.fmt ? c.fmt(r[c.key]) : fmtCell(r[c.key]))}</td>`).join("")}</tr>`).join("");
    $("#" + id).innerHTML = `<table><caption>${esc(title)}</caption><thead><tr>${th}</tr></thead><tbody>${tr || `<tr><td colspan="${cols.length}" class="empty">Sin datos</td></tr>`}</tbody></table>`;
    for (const b of document.querySelectorAll(`#${id} [data-sort]`)) {
      b.addEventListener("click", () => {
        const k = b.dataset.sort;
        const col = cols.find((c) => c.key === k);
        sorts[id] = { key: k, dir: sorts[id].key === k ? -sorts[id].dir : col.num ? -1 : 1 };
        drawTable(id);
      });
    }
  }

  // ---- pestanyes ----
  for (const b of document.querySelectorAll(".dash-tabs .tab")) {
    b.addEventListener("click", () => {
      tab = b.dataset.tab;
      for (const t of document.querySelectorAll(".dash-tabs .tab")) t.classList.toggle("is-current", t === b);
      // Els botons porten data-tab i els panells data-panel: així amagar panells mai amaga els botons.
      for (const sct of document.querySelectorAll("main [data-panel]")) sct.hidden = sct.dataset.panel !== tab;
    });
  }

  // ---- CSV de la vista actual (per obrir-lo a Excel: ; i BOM) ----
  const csvCell = (v) => { const s = String(v ?? ""); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  $("#csv").addEventListener("click", () => {
    const ids = { resumen: ["t-dia"], dia: ["t-dia"], pagina: ["t-pagina"], campana: ["t-campana"], origen: ["t-origen", "t-pais"] }[tab];
    const lines = [];
    for (const id of ids) {
      const t = tables[id];
      if (!t) continue;
      lines.push(t.title, t.cols.map((c) => csvCell(c.label)).join(";"));
      for (const r of t.data) lines.push(t.cols.map((c) => csvCell(c.fmt ? c.fmt(r[c.key]) : r[c.key])).join(";"));
      lines.push("");
    }
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `custodium-stats-${tab}-${range.from}-${range.to}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  load();
})();
