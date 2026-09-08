// aqui.js — botó "Sigo aquí" del correu d'avís. Un GET no compta (els escàners
// de correu obren enllaços); cal el clic, que fa un POST.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const token = new URLSearchParams(location.search).get("t");

function showScreen(name) {
  for (const s of $$("[data-screen]")) s.hidden = s.dataset.screen !== name;
}

async function confirm() {
  $("#confirm").disabled = true;
  try {
    const res = await fetch("/api/checkin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    showScreen(res.ok ? "done" : "invalid");
  } catch {
    $("#message").textContent = "No se ha podido confirmar. Revisa la conexión y vuelve a intentarlo.";
    $("#confirm").disabled = false;
  }
}

if (!token) {
  showScreen("invalid");
} else {
  $("#confirm").addEventListener("click", confirm);
  showScreen("ask");
}

// El deploy escriu /VERSION amb el hash del commit publicat a custodium-client.
fetch("/VERSION").then((r) => (r.ok ? r.text() : "")).then((v) => {
  if (v) $("#version").textContent = `versión ${v.trim().slice(0, 12)}`;
}).catch(() => {});
