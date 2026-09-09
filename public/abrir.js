// abrir.js — Custodium B2C · pàgina de la persona de confiança
//
// Rep l'enllaç per correu, escriu la seva frase i el navegador desxifra el
// paquet aquí. Els fitxers es baixen xifrats i es desxifren amb la clau que
// viatja dins del paquet. El servidor no veu res en clar.

import { derivePassphraseKey, importKey, decryptJson, decryptBytes } from "./crypto.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);
const token = new URLSearchParams(location.search).get("t");

let info = null;   // { from, email, package }

function showScreen(name) {
  for (const s of $$("[data-screen]")) s.hidden = s.dataset.screen !== name;
}

function setBusy(on, text = "") {
  $("#busy").textContent = text;
  $("#busy").hidden = !on;
  $("#open-submit").disabled = on;
}

let toastTimer = null;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

async function load() {
  if (!token || !window.isSecureContext || !crypto?.subtle) return showScreen("invalid");
  let res;
  try { res = await fetch(`/api/release/${encodeURIComponent(token)}`); } catch { return showScreen("invalid"); }
  if (!res.ok) return showScreen("invalid");
  info = await res.json();
  $("#ask-intro").textContent = `${info.from} la dejó preparada en Custodium para cuando no pudiera actuar.`;
  showScreen("ask");
  $("#pass").focus();
}

async function open(event) {
  event.preventDefault();
  const pass = $("#pass").value.trim();
  const msg = (t) => { $("#open-message").textContent = t; };
  if (!pass) return msg("Escribe la frase.");

  setBusy(true, "Derivando la clave en este dispositivo…");
  try {
    const key = await importKey(await derivePassphraseKey(info.email, pass));
    let pkg;
    try { pkg = await decryptJson(key, info.package); } catch { return msg("La frase no es correcta."); }
    render(pkg);
    $("#pass").value = "";
    showScreen("view");
  } catch (err) {
    console.error(err);
    msg("Algo ha fallado. Vuelve a intentarlo.");
  } finally {
    setBusy(false);
  }
}

function render(pkg) {
  $("#view-intro").textContent = `${info.from} dejó preparados ${pkg.items.length} ${pkg.items.length === 1 ? "elemento" : "elementos"} para ti.`;
  const list = $("#items");
  list.replaceChildren();
  for (const item of pkg.items) {
    const li = el("li", { class: "item" });
    li.append(el("h3", {}, item.title));
    if (item.notes) li.append(el("p", { class: "item-notes" }, item.notes));
    if (item.files?.length) {
      const files = el("div", { class: "item-files" });
      for (const f of item.files) {
        const b = el("button", { type: "button", class: "link" }, f.name);
        b.addEventListener("click", () => download(f));
        files.append(b);
      }
      li.append(files);
    }
    list.append(li);
  }
}

async function download(f) {
  $("#busy").textContent = `Descargando y descifrando ${f.name}…`;
  $("#busy").hidden = false;
  try {
    const res = await fetch(`/api/release/${encodeURIComponent(token)}/files/${f.id}`);
    if (!res.ok) return toast("Este archivo no está disponible.");
    const key = await importKey(f.key);
    const plain = await decryptBytes(key, await res.arrayBuffer());
    const url = URL.createObjectURL(new Blob([plain]));
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    console.error(err);
    toast("No se ha podido descifrar el archivo.");
  } finally {
    $("#busy").hidden = true;
  }
}

$("#open-form").addEventListener("submit", open);
load();

// El deploy escriu /VERSION amb el hash del commit publicat a custodium-client.
fetch("/VERSION").then((r) => (r.ok ? r.text() : "")).then((v) => {
  if (v) $("#version").textContent = `versión ${v.trim().slice(0, 12)}`;
}).catch(() => {});
