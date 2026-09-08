// app.js — Custodium B2C · v4
//
// Tot l'estat viu en memòria. Tancar o recarregar la pestanya bloqueja el pla.
//
// Pantalles: login · register · list · edit · people · person-edit.
//
// Pla (xifrat amb la clau del titular):
//   { v: 2,
//     recipients: [ { id, name, email, phone, key, phrase, createdAt } ],   key = derivada de la seva frase, base64
//     items: [ { id, title, recipientIds: [], notes, files: [ { id, name, size, key } ], updatedAt } ] }
//
// A cada desat, per a cada persona es construeix un paquet amb els seus
// elements (i les claus dels seus fitxers), es xifra amb la seva clau i es
// puja. El servidor només veu paquets opacs i l'email on enviar l'enllaç.

import {
  deriveKeys, derivePassphraseKey, randomKey, importKey,
  encryptJson, decryptJson, encryptBytes, decryptBytes,
  generatePassphrase, normalizePassphrase, b64encode,
} from "./crypto.js";
import { zipSync } from "./fflate.js";

const IDLE_LOCK_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 50_000_000;

const state = {
  token: null,
  encKey: null,
  authHash: null,       // per verificar la contrasenya localment abans d'ensenyar una frase
  email: null,
  reveal: {},           // id de persona → "ask" | "shown"
  vault: null,
  version: 0,
  status: {},           // id de persona → { releasedAt, openedAt, expiresAt } (del servidor)
  settings: null,       // { warnDays, releaseDays, lastSeen }
  draft: null,          // element en edició
  personDraft: null,    // persona en edició
  pendingDeletes: [],
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ------------------------------------------------------------------ API

async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (auth && state.token) headers["authorization"] = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* cos buit o binari */ }
  return { status: res.status, data };
}

// ----------------------------------------------------------------- auth

async function submitLogin(event) {
  event.preventDefault();
  const email = $("#login-email").value.trim().toLowerCase();
  const password = $("#login-password").value;
  const msg = (t) => { $("#login-message").textContent = t; };
  if (!email || !password) return msg("Escribe tu email y tu contraseña.");

  setBusy(true, "Derivando las claves en este dispositivo…");
  try {
    const { encKey, authHash } = await deriveKeys(email, password);
    const r = await api("/api/login", { method: "POST", body: { email, authHash }, auth: false });
    if (r.status !== 200) return msg("Email o contraseña incorrectos.");
    $("#login-password").value = "";
    state.email = email;
    state.authHash = authHash;
    await openVault(r.data.token, encKey);
  } catch (err) {
    console.error(err);
    msg(err.message === "decrypt_failed" ? "No se ha podido descifrar el plan con esta contraseña." : "Algo ha fallado. Vuelve a intentarlo.");
    clearSecrets();
  } finally {
    setBusy(false);
  }
}

async function submitRegister(event) {
  event.preventDefault();
  const email = $("#register-email").value.trim().toLowerCase();
  const password = $("#register-password").value;
  const confirm = $("#register-confirm").value;
  const msg = (t) => { $("#register-message").textContent = t; };

  if (!email || !password) return msg("Escribe tu email y una contraseña.");
  if (password.length < 16) return msg("Usa al menos 16 caracteres, o genera una frase de seis palabras.");
  if (password !== confirm) return msg("Las dos contraseñas no coinciden.");

  setBusy(true, "Derivando las claves en este dispositivo…");
  try {
    const { encKey, authHash } = await deriveKeys(email, password);
    const reg = await api("/api/register", { method: "POST", body: { email, authHash }, auth: false });
    if (reg.status === 409) return msg("Ya existe una cuenta con este email.");
    if (reg.status !== 201) return msg("No se ha podido crear la cuenta.");
    const r = await api("/api/login", { method: "POST", body: { email, authHash }, auth: false });
    if (r.status !== 200) return msg("Cuenta creada, pero no se ha podido entrar. Prueba desde Entrar.");
    $("#register-password").value = "";
    $("#register-confirm").value = "";
    state.email = email;
    state.authHash = authHash;
    await openVault(r.data.token, encKey);
  } catch (err) {
    console.error(err);
    msg("Algo ha fallado. Vuelve a intentarlo.");
    clearSecrets();
  } finally {
    setBusy(false);
  }
}

async function openVault(token, encKey) {
  state.token = token;
  state.encKey = encKey;
  await loadVault();
  await loadStatus();
  renderList();
  showScreen("list");
  touchIdle();
}

async function logout() {
  try { await api("/api/session", { method: "DELETE" }); } catch { /* ja tant hi fa */ }
  lock("Has salido. El plan queda cerrado.");
}

function lock(message) {
  clearSecrets();
  state.vault = null;
  state.version = 0;
  state.status = {};
  state.settings = null;
  state.draft = null;
  state.personDraft = null;
  state.pendingDeletes = [];
  showScreen("login");
  $("#login-message").textContent = message || "";
}

function clearSecrets() {
  state.token = null;
  state.encKey = null;
  state.authHash = null;
  state.email = null;
  state.reveal = {};
  clearTimeout(revealTimer);
}

// ---------------------------------------------------------------- vault

async function loadVault() {
  const r = await api("/api/vault");
  if (r.status === 404) {
    state.vault = { v: 2, recipients: [], items: [] };
    state.version = 0;
  } else if (r.status === 200) {
    let vault;
    try { vault = await decryptJson(state.encKey, r.data.blob); } catch { throw new Error("decrypt_failed"); }
    state.vault = migrate(vault);
    state.version = r.data.version;
  } else if (r.status === 401) {
    throw new Error("unauthorized");
  } else {
    throw new Error("load_failed");
  }
  state.pendingDeletes = [];
  renderList();
}

// v1 → v2: la persona passa de text lliure a referència; els fitxers antics
// (xifrats amb la clau del titular, sense clau pròpia) es marquen com a legacy.
function migrate(vault) {
  if (vault.v === 2) return vault;
  return {
    v: 2,
    recipients: [],
    items: (vault.items || []).map((it) => ({
      id: it.id,
      title: it.title,
      recipientIds: [],
      notes: it.recipient ? `${it.notes || ""}\n\n(Antes: para ${it.recipient})`.trim() : (it.notes || ""),
      files: (it.files || []).map((f) => ({ ...f, key: f.key || null })),
      updatedAt: it.updatedAt || Date.now(),
    })),
  };
}

async function loadStatus() {
  const [recs, settings] = await Promise.all([api("/api/recipients"), api("/api/settings")]);
  state.status = {};
  if (recs.status === 200) {
    for (const r of recs.data.recipients) state.status[r.id] = r;
  }
  if (settings.status === 200) state.settings = settings.data;
}

// Cada canvi es xifra i es desa de seguida; després es refan els paquets.
async function persist() {
  setBusy(true, "Cifrando y guardando…");
  try {
    const blob = await encryptJson(state.encKey, state.vault);
    const r = await api("/api/vault", { method: "PUT", body: { blob, version: state.version } });

    if (r.status === 200) {
      state.version = r.data.version;
      await syncPackages();
      await flushPendingDeletes();
      renderList();
      toast("Guardado.");
      return true;
    }
    if (r.status === 409) {
      toast("El plan ha cambiado desde otro dispositivo. Se carga la última versión; este cambio no se ha guardado.");
      await loadVault();
    } else if (r.status === 401) {
      lock("La sesión ha caducado. Vuelve a entrar.");
    } else {
      toast("No se ha podido guardar. Vuelve a intentarlo.");
    }
    return false;
  } catch (err) {
    console.error(err);
    toast("No se ha podido guardar. Revisa la conexión.");
    return false;
  } finally {
    setBusy(false);
  }
}

// Un paquet per persona: els seus elements, amb les claus dels seus fitxers.
async function syncPackages() {
  for (const p of state.vault.recipients) {
    const items = state.vault.items
      .filter((it) => it.recipientIds.includes(p.id))
      .map((it) => ({
        title: it.title,
        notes: it.notes,
        files: it.files.filter((f) => f.key).map((f) => ({ id: f.id, name: f.name, size: f.size, key: f.key })),
      }));
    const fileIds = items.flatMap((it) => it.files.map((f) => f.id));
    const key = await importKey(p.key);
    const pkg = await encryptJson(key, { v: 1, generatedAt: Date.now(), items });
    const r = await api(`/api/recipients/${p.id}`, { method: "PUT", body: { email: p.email, phone: p.phone || null, package: pkg, fileIds } });
    if (r.status !== 200) toast(`No se ha podido preparar el paquete de ${p.name}.`);
  }
}

async function flushPendingDeletes() {
  const ids = state.pendingDeletes;
  state.pendingDeletes = [];
  for (const id of ids) {
    try { await api(`/api/files/${id}`, { method: "DELETE" }); } catch { /* orfe tolerable */ }
  }
}

// ------------------------------------------------------------ items: edit

function startEdit(id) {
  const item = id ? state.vault.items.find((it) => it.id === id) : null;
  state.draft = {
    id,
    title: item?.title ?? "",
    recipientIds: [...(item?.recipientIds ?? [])],
    notes: item?.notes ?? "",
    files: [...(item?.files ?? [])],
    uploaded: [],
    removed: [],
  };

  $("#edit-title").textContent = item ? "Editar elemento" : "Nuevo elemento";
  $("#item-title").value = state.draft.title;
  $("#item-notes").value = state.draft.notes;
  $("#item-message").textContent = "";
  $("#item-files").value = "";
  fillRecipientChecks(state.draft.recipientIds);
  renderDraftFiles();
  showScreen("edit");
  $("#item-title").focus();
}

function fillRecipientChecks(selected) {
  const box = $("#item-recipients");
  box.replaceChildren();
  for (const p of state.vault.recipients) {
    const label = el("label", { class: "check" });
    const input = el("input", { type: "checkbox", value: p.id });
    input.checked = selected.includes(p.id);
    label.append(input, el("span", {}, `${p.name} · ${p.email}`));
    box.append(label);
  }
  $("#item-recipient-hint").hidden = state.vault.recipients.length > 0;
}

function checkedRecipientIds() {
  return [...$$("#item-recipients input:checked")].map((i) => i.value);
}

async function applyItem(event) {
  event.preventDefault();
  const d = state.draft;
  const title = $("#item-title").value.trim();
  if (!title) { $("#item-message").textContent = "Escribe qué es este elemento."; return; }

  const data = {
    title,
    recipientIds: checkedRecipientIds(),
    notes: $("#item-notes").value,
    files: d.files,
    updatedAt: Date.now(),
  };

  if (d.id) {
    const idx = state.vault.items.findIndex((it) => it.id === d.id);
    if (idx >= 0) state.vault.items[idx] = { ...state.vault.items[idx], ...data };
  } else {
    state.vault.items.push({ id: crypto.randomUUID(), ...data });
  }

  state.pendingDeletes.push(...d.removed);
  state.draft = null;
  showScreen("list");
  await persist();
}

async function cancelEdit() {
  const d = state.draft;
  state.draft = null;
  for (const id of d.uploaded) {
    try { await api(`/api/files/${id}`, { method: "DELETE" }); } catch { /* orfe tolerable */ }
  }
  showScreen("list");
}

async function deleteItem(id) {
  const item = state.vault.items.find((it) => it.id === id);
  if (!item || !window.confirm(`¿Eliminar "${item.title}" del plan?`)) return;
  state.vault.items = state.vault.items.filter((it) => it.id !== id);
  state.pendingDeletes.push(...item.files.map((f) => f.id));
  renderList();
  await persist();
}

// ---------------------------------------------------------------- files

async function addFiles(fileList) {
  const d = state.draft;
  for (const file of fileList) {
    if (file.size > MAX_FILE_BYTES) { toast(`${file.name} supera los 50 MB y no se ha adjuntado.`); continue; }
    setBusy(true, `Cifrando y subiendo ${file.name}…`);
    try {
      const raw = randomKey();
      const key = await importKey(raw);
      const sealed = await encryptBytes(key, new Uint8Array(await file.arrayBuffer()));
      const id = crypto.randomUUID();
      const res = await fetch(`/api/files/${id}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${state.token}`, "content-type": "application/octet-stream" },
        body: sealed,
      });
      if (res.status === 201) {
        d.files.push({ id, name: file.name, size: file.size, key: b64encode(raw) });
        d.uploaded.push(id);
      } else if (res.status === 507) {
        toast("Has llegado al límite de 1 GB de archivos.");
      } else if (res.status === 401) {
        lock("La sesión ha caducado. Vuelve a entrar.");
        return;
      } else {
        toast(`No se ha podido subir ${file.name}.`);
      }
    } catch (err) {
      console.error(err);
      toast(`No se ha podido subir ${file.name}.`);
    } finally {
      setBusy(false);
    }
  }
  $("#item-files").value = "";
  renderDraftFiles();
}

function removeDraftFile(id) {
  const d = state.draft;
  d.files = d.files.filter((f) => f.id !== id);
  if (d.uploaded.includes(id)) {
    d.uploaded = d.uploaded.filter((x) => x !== id);
    api(`/api/files/${id}`, { method: "DELETE" }).catch(() => {});
  } else {
    d.removed.push(id);
  }
  renderDraftFiles();
}

async function downloadFile(f) {
  setBusy(true, `Descargando y descifrando ${f.name}…`);
  try {
    const res = await fetch(`/api/files/${f.id}`, { headers: { authorization: `Bearer ${state.token}` } });
    if (res.status === 404) return toast("Este archivo ya no está en el servidor.");
    if (res.status === 401) return lock("La sesión ha caducado. Vuelve a entrar.");
    if (!res.ok) return toast("No se ha podido descargar el archivo.");
    const key = f.key ? await importKey(f.key) : state.encKey;   // legacy: xifrat amb la clau del titular
    const plain = await decryptBytes(key, await res.arrayBuffer());
    saveAs(plain, f.name);
  } catch (err) {
    console.error(err);
    toast("No se ha podido descifrar el archivo.");
  } finally {
    setBusy(false);
  }
}

function saveAs(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --------------------------------------------------------------- people

function startPersonEdit(id) {
  const p = id ? state.vault.recipients.find((x) => x.id === id) : null;
  state.personDraft = { id, name: p?.name ?? "", email: p?.email ?? "" };
  $("#person-title").textContent = p ? "Editar persona" : "Nueva persona";
  $("#person-name").value = state.personDraft.name;
  $("#person-email").value = state.personDraft.email;
  $("#person-phone").value = p?.phone ?? "";
  $("#person-pass").value = p ? "" : generatePassphrase();
  $("#person-pass-label").textContent = p ? "Nueva frase (vacía = no cambiarla)" : "Su frase";
  $("#person-generate").textContent = p ? "Generar una frase nueva" : "Generar otra";
  $("#person-message").textContent = "";
  state.reveal = {};
  renderPersonTools();
  showScreen("person-edit");
  $("#person-name").focus();
}

async function applyPerson(event) {
  event.preventDefault();
  const d = state.personDraft;
  const name = $("#person-name").value.trim();
  const email = $("#person-email").value.trim().toLowerCase();
  const phone = normalizePhone($("#person-phone").value);
  const pass = $("#person-pass").value.trim();
  const msg = (t) => { $("#person-message").textContent = t; };

  if (!name) return msg("Escribe su nombre.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return msg("Escribe un email válido.");
  if (phone === false) return msg("El móvil debe ir en formato internacional, por ejemplo +34 600 000 000.");
  const words = pass ? pass.split(/\s+/).length : 0;
  if (!d.id && words !== 6) return msg("Falta la frase. Pulsa \"Generar otra\".");
  if (d.id && pass && words !== 6) return msg("La frase no es válida. Genera una nueva.");

  const existing = d.id ? state.vault.recipients.find((x) => x.id === d.id) : null;
  if (existing && existing.email !== email && !pass) {
    return msg("Si cambias el email, hace falta una frase nueva: la clave se deriva de los dos.");
  }

  setBusy(true, "Derivando su clave en este dispositivo…");
  try {
    let key = existing?.key ?? null;
    let phrase = existing?.phrase ?? null;
    if (pass) {
      key = b64encode(await derivePassphraseKey(email, pass));
      phrase = normalizePassphrase(pass);
    }

    if (existing) {
      Object.assign(existing, { name, email, phone, key, phrase });
    } else {
      state.vault.recipients.push({ id: crypto.randomUUID(), name, email, phone, key, phrase, createdAt: Date.now() });
    }
    $("#person-pass").value = "";
    state.personDraft = null;
  } finally {
    setBusy(false);
  }

  renderPeople();
  showScreen("people");
  const ok = await persist();
  if (ok) { await loadStatus(); renderPeople(); }
}

function cancelPersonEdit() {
  clearTimeout(revealTimer);
  state.reveal = {};
  state.personDraft = null;
  $("#person-pass").value = "";
  renderPeople();
  showScreen("people");
}

async function deletePerson(id) {
  const p = state.vault.recipients.find((x) => x.id === id);
  if (!p) return;
  const assigned = state.vault.items.filter((it) => it.recipientIds.includes(id)).length;
  const extra = assigned ? ` Los ${assigned} elementos asignados quedarán sin persona.` : "";
  if (!window.confirm(`¿Quitar a ${p.name} de las personas de confianza?${extra}`)) return;

  state.vault.recipients = state.vault.recipients.filter((x) => x.id !== id);
  for (const it of state.vault.items) it.recipientIds = it.recipientIds.filter((x) => x !== id);
  await api(`/api/recipients/${id}`, { method: "DELETE" });
  state.personDraft = null;
  renderPeople();
  showScreen("people");
  const ok = await persist();
  if (ok) { await loadStatus(); renderPeople(); }
}

async function releaseNow(id) {
  const p = state.vault.recipients.find((x) => x.id === id);
  const n = state.vault.items.filter((it) => it.recipientIds.includes(id)).length;
  if (!n) return toast(`${p.name} no tiene ningún elemento asignado todavía.`);
  if (!window.confirm(`Se enviará ahora a ${p.email} un enlace para abrir sus ${n} elementos. Necesitará su frase. ¿Continuar?`)) return;

  setBusy(true, "Enviando el enlace…");
  try {
    const r = await api(`/api/recipients/${id}/release`, { method: "POST" });
    if (r.status === 200) toast(`Enlace enviado a ${p.email}.`);
    else if (r.data?.error === "mail_failed") toast("El correo no se ha podido enviar. Revisa la configuración de envío.");
    else toast("No se ha podido entregar.");
    await loadStatus();
    renderPersonTools();
    renderReleaseNotice();
  } finally {
    setBusy(false);
  }
}

async function revokeRelease(id) {
  const p = state.vault.recipients.find((x) => x.id === id);
  if (!window.confirm(`El enlace enviado a ${p.name} dejará de funcionar. ¿Continuar?`)) return;
  const r = await api(`/api/recipients/${id}/revoke`, { method: "POST" });
  toast(r.status === 200 ? "Enlace anulado." : "No se ha podido anular.");
  await loadStatus();
  renderPersonTools();
  renderReleaseNotice();
}

// Mostrar la frase d'una persona: demana la contrasenya del titular (verificada
// localment contra l'authHash en memòria), l'ensenya 60 segons i l'amaga.
let revealTimer = null;

function askReveal(id) {
  state.reveal = { [id]: "ask" };
  renderPersonTools();
  $(`#reveal-pass-${id}`)?.focus();
}

async function confirmReveal(id) {
  const input = $(`#reveal-pass-${id}`);
  const password = input?.value ?? "";
  if (!password) return;
  setBusy(true, "Comprobando la contraseña…");
  try {
    const { authHash } = await deriveKeys(state.email, password);
    input.value = "";
    if (authHash !== state.authHash) return toast("La contraseña no es correcta.");
    state.reveal = { [id]: "shown" };
    renderPersonTools();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(hideReveal, 60_000);
  } finally {
    setBusy(false);
  }
}

function hideReveal() {
  clearTimeout(revealTimer);
  state.reveal = {};
  if (state.personDraft) renderPersonTools();
}

function renderReveal(p) {
  const mode = state.reveal[p.id];
  const box = el("div", { class: "reveal" });

  if (mode === "shown") {
    if (p.phrase) {
      box.append(el("p", { class: "reveal-phrase" }, p.phrase));
      box.append(el("p", { class: "hint" }, "Quien vea esta pantalla puede copiarla. Se oculta sola en un minuto."));
    } else {
      box.append(el("p", { class: "hint" }, "Frase no disponible: esta persona se creó antes de que se guardara. Edítala y genera una nueva."));
    }
    const hide = el("button", { type: "button", class: "link" }, "Ocultar");
    hide.addEventListener("click", hideReveal);
    box.append(hide);
  } else if (mode === "ask") {
    const form = el("form", { class: "reveal-form" });
    const input = el("input", { type: "password", id: `reveal-pass-${p.id}`, autocomplete: "current-password", placeholder: "Tu contraseña" });
    const ok = el("button", { type: "submit", class: "secondary" }, "Ver la frase");
    const cancel = el("button", { type: "button", class: "link" }, "Cancelar");
    cancel.addEventListener("click", hideReveal);
    form.addEventListener("submit", (e) => { e.preventDefault(); confirmReveal(p.id); });
    form.append(input, ok, cancel);
    box.append(form);
  } else {
    return null;
  }
  return box;
}

async function saveSettings(event) {
  event.preventDefault();
  const warnDays = Number($("#warn-days").value);
  const releaseDays = Number($("#release-days").value);
  const msg = (t) => { $("#settings-message").textContent = t; };
  if (!Number.isInteger(warnDays) || warnDays < 1) return msg("El aviso tiene que ser al menos 1 día.");
  if (!Number.isInteger(releaseDays) || releaseDays <= warnDays) return msg("La entrega tiene que ser posterior al aviso.");
  const r = await api("/api/settings", { method: "PUT", body: { warnDays, releaseDays } });
  if (r.status === 200) {
    state.settings = { ...state.settings, warnDays, releaseDays };
    msg("");
    toast("Plazos guardados.");
  } else {
    msg("No se han podido guardar los plazos.");
  }
}

// -------------------------------------------------------------- account

function goAccount() {
  if (state.draft) return toast("Termina o cancela el elemento que estás editando.");
  if (state.personDraft) return toast("Termina o cancela la persona que estás editando.");
  $("#account-email").textContent = state.email;
  $("#account-phone").value = state.settings?.phone ?? "";
  $("#phone-message").textContent = "";
  for (const id of ["#pw-current", "#pw-new", "#pw-confirm"]) { $(id).type = "password"; $(id).value = ""; }
  $("#pw-message").textContent = "";
  showScreen("account");
}

function normalizePhone(value) {
  const v = String(value || "").replace(/[\s.-]/g, "");
  if (!v) return null;
  return /^\+[1-9]\d{6,14}$/.test(v) ? v : false;
}

async function savePhone(event) {
  event.preventDefault();
  const phone = normalizePhone($("#account-phone").value);
  const msg = (t) => { $("#phone-message").textContent = t; };
  if (phone === false) return msg("Formato internacional, por ejemplo +34 600 000 000.");
  const r = await api("/api/settings", { method: "PUT", body: { phone } });
  if (r.status === 200) {
    state.settings = { ...state.settings, phone };
    msg("");
    toast(phone ? "Móvil guardado." : "Móvil eliminado.");
  } else {
    msg("No se ha podido guardar el móvil.");
  }
}

async function changePassword(event) {
  event.preventDefault();
  const current = $("#pw-current").value;
  const next = $("#pw-new").value;
  const confirm = $("#pw-confirm").value;
  const msg = (t) => { $("#pw-message").textContent = t; };

  if (!current) return msg("Escribe tu contraseña actual.");
  if (next.length < 16) return msg("La nueva contraseña debe tener al menos 16 caracteres, o genera una frase.");
  if (next !== confirm) return msg("Las dos contraseñas nuevas no coinciden.");
  if (next === current) return msg("La nueva contraseña es igual que la actual.");

  setBusy(true, "Derivando las claves y cifrando de nuevo el plan…");
  try {
    const old = await deriveKeys(state.email, current);
    const fresh = await deriveKeys(state.email, next);
    const blob = await encryptJson(fresh.encKey, state.vault);
    const r = await api("/api/password", {
      method: "POST",
      body: { authHash: old.authHash, newAuthHash: fresh.authHash, blob, version: state.version },
    });

    if (r.status === 401) return msg("La contraseña actual no es correcta.");
    if (r.status === 409) { toast("El plan ha cambiado desde otro dispositivo. Se recarga; vuelve a intentarlo."); await loadVault(); return; }
    if (r.status !== 200) return msg("No se ha podido cambiar la contraseña.");

    state.token = r.data.token;
    state.encKey = fresh.encKey;
    state.authHash = fresh.authHash;
    state.version = r.data.version;
    for (const id of ["#pw-current", "#pw-new", "#pw-confirm"]) { $(id).type = "password"; $(id).value = ""; }
    msg("");
    toast("Contraseña cambiada. El plan se ha cifrado de nuevo.");
  } catch (err) {
    console.error(err);
    msg("Algo ha fallado. Vuelve a intentarlo.");
  } finally {
    setBusy(false);
  }
}

// --------------------------------------------------------------- export

// Còpia completa i xifrada, per guardar fora de Custodium: el pla del titular,
// un paquet per persona, tots els fitxers xifrats i l'obridor autònom. Qui
// obri el zip amb abrir.html i el seu email + frase (o contrasenya) veu només
// el que és seu. Custodium no cal per obrir-lo.
async function exportBundle() {
  const nFiles = state.vault.items.reduce((n, it) => n + it.files.length, 0);
  if (!window.confirm(`Se descargará una copia cifrada de todo el plan (${state.vault.items.length} elementos, ${nFiles} archivos) con un abridor que funciona sin Custodium. ¿Continuar?`)) return;

  setBusy(true, "Preparando la copia…");
  try {
    const files = {};
    const te = new TextEncoder();

    files["plan.json"] = te.encode(JSON.stringify(await encryptJson(state.encKey, state.vault)));

    for (const p of state.vault.recipients) {
      const items = state.vault.items
        .filter((it) => it.recipientIds.includes(p.id))
        .map((it) => ({ title: it.title, notes: it.notes, files: it.files.filter((f) => f.key).map((f) => ({ id: f.id, name: f.name, size: f.size, key: f.key })) }));
      const pkg = await encryptJson(await importKey(p.key), { v: 1, generatedAt: Date.now(), items });
      files[`paquetes/${p.id}.json`] = te.encode(JSON.stringify(pkg));
    }

    const seen = new Set();
    for (const it of state.vault.items) {
      for (const f of it.files) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        setBusy(true, `Descargando ${f.name}…`);
        const res = await fetch(`/api/files/${f.id}`, { headers: { authorization: `Bearer ${state.token}` } });
        if (res.status === 401) return lock("La sesión ha caducado. Vuelve a entrar.");
        if (!res.ok) { toast(`No se ha podido descargar ${f.name}; se omite.`); continue; }
        files[`archivos/${f.id}`] = new Uint8Array(await res.arrayBuffer());
      }
    }

    const opener = await fetch("/abrir-offline.html").then((r) => r.text());
    files["abrir.html"] = te.encode(opener);
    files["LEEME.txt"] = te.encode([
      "Copia cifrada de un plan de Custodium.",
      "",
      "Para abrirla no hace falta Custodium ni conexión a internet:",
      "1. Abre abrir.html con cualquier navegador (doble clic).",
      "2. Selecciona este mismo archivo .zip (o la carpeta descomprimida).",
      "3. Escribe tu email y tu frase (o tu contraseña, si eres el titular).",
      "",
      "Cada persona solo puede abrir lo que le corresponde. Sin la frase, nadie puede leer nada.",
      `Exportado el ${new Date().toLocaleString("es-ES")}.`,
    ].join("\n"));

    setBusy(true, "Comprimiendo…");
    const zip = zipSync(files, { level: 0 });
    saveAs(zip, `custodium-${new Date().toISOString().slice(0, 10)}.zip`);
    toast("Copia descargada.");
  } catch (err) {
    console.error(err);
    toast("No se ha podido preparar la copia.");
  } finally {
    setBusy(false);
  }
}

// --------------------------------------------------------------- render

function recipientName(id) {
  return state.vault.recipients.find((p) => p.id === id)?.name ?? null;
}

function renderReleaseNotice() {
  const active = state.vault.recipients
    .map((p) => ({ p, s: state.status[p.id] }))
    .filter(({ s }) => s?.releasedAt && !(s.expiresAt && s.expiresAt * 1000 < Date.now()));
  $("#release-notice").hidden = active.length === 0;
  if (!active.length) return;
  const parts = active.map(({ p, s }) => `${p.name} (${dateEs(s.releasedAt)}${s.openedAt ? ", abierto" : ", no abierto"})`);
  $("#release-notice-text").textContent =
    (active.length === 1 ? "Hay un paquete entregado a " : "Hay paquetes entregados a ") + parts.join(", ") +
    ". Si no era tu intención, anula el enlace.";
}

function renderList() {
  const list = $("#items");
  list.replaceChildren();
  const items = state.vault?.items ?? [];
  $("#empty").hidden = items.length > 0;
  renderReleaseNotice();

  for (const item of items) {
    const li = el("li", { class: "item" });
    const head = el("div", { class: "item-head" });
    head.append(el("h3", {}, item.title));
    const who = item.recipientIds.map(recipientName).filter(Boolean).join(", ");
    head.append(el("p", { class: who ? "item-recipient" : "item-recipient none" }, who ? `Para ${who}` : "Solo para ti"));
    li.append(head);

    if (item.notes) li.append(el("p", { class: "item-notes" }, item.notes));

    if (item.files.length) {
      const files = el("div", { class: "item-files" });
      for (const f of item.files) {
        const b = el("button", { type: "button", class: "link" }, f.name + (f.key ? "" : " (vuelve a subirlo para compartirlo)"));
        b.addEventListener("click", () => downloadFile(f));
        files.append(b);
      }
      li.append(files);
    }

    const actions = el("div", { class: "item-actions" });
    const edit = el("button", { type: "button", class: "link" }, "Editar");
    edit.addEventListener("click", () => startEdit(item.id));
    const del = el("button", { type: "button", class: "link danger" }, "Eliminar");
    del.addEventListener("click", () => deleteItem(item.id));
    actions.append(edit, del);
    li.append(actions);
    list.append(li);
  }
}

function renderDraftFiles() {
  const list = $("#draft-files");
  list.replaceChildren();
  for (const f of state.draft.files) {
    const li = el("li", { class: "file" });
    const name = el("span", { class: "name" }, f.name);
    name.append(el("span", { class: "size" }, formatSize(f.size)));
    const actions = el("div", { class: "file-actions" });
    const dl = el("button", { type: "button", class: "link" }, "Descargar");
    dl.addEventListener("click", () => downloadFile(f));
    const rm = el("button", { type: "button", class: "link danger" }, "Quitar");
    rm.addEventListener("click", () => removeDraftFile(f.id));
    actions.append(dl, rm);
    li.append(name, actions);
    list.append(li);
  }
}

function personStatus(p) {
  const n = state.vault.items.filter((it) => it.recipientIds.includes(p.id)).length;
  const s = state.status[p.id];
  let label, date = null;
  if (s?.releasedAt) {
    if (s.expiresAt && s.expiresAt * 1000 < Date.now()) { label = "Enlace caducado"; date = s.expiresAt; }
    else if (s.openedAt) { label = "Acceso abierto"; date = s.openedAt; }
    else { label = "Acceso enviado"; date = s.releasedAt; }
  } else if (s?.revokedAt) {
    label = "Enlace anulado"; date = s.revokedAt;
  } else if (!n) {
    label = "Sin elementos asignados";
  } else {
    label = "Sin entregar";
  }
  return { n, label, date, released: Boolean(s?.releasedAt) };
}

function renderPeople() {
  const list = $("#people");
  list.replaceChildren();
  const people = state.vault.recipients;
  $("#people-empty").hidden = people.length > 0;

  for (const p of people) {
    const li = el("li", { class: "item" });
    const row = el("div", { class: "item-row" });
    row.append(el("h3", {}, p.name));
    const edit = el("button", { type: "button", class: "link" }, "Editar");
    edit.addEventListener("click", () => startPersonEdit(p.id));
    row.append(edit);
    li.append(row);
    li.append(el("p", { class: "item-recipient" }, p.email));

    const st = personStatus(p);
    const line = el("p", { class: "item-notes" });
    line.append(el("span", { class: "status" }, st.label));
    if (st.date) line.append(` · ${dateEs(st.date)}`);
    if (st.n) line.append(` · ${st.n} ${st.n === 1 ? "elemento" : "elementos"}`);
    li.append(line);
    list.append(li);
  }

  if (state.settings) {
    $("#warn-days").value = state.settings.warnDays;
    $("#release-days").value = state.settings.releaseDays;
    $("#last-seen").textContent = state.settings.lastSeen
      ? `Última actividad registrada: ${dateEs(state.settings.lastSeen)}.`
      : "";
  }
}

// Fitxa de la persona: estat, frase, entrega, anul·lació i baixa.
function renderPersonTools() {
  const id = state.personDraft?.id;
  const p = id ? state.vault.recipients.find((x) => x.id === id) : null;
  $("#person-tools").hidden = !p;
  if (!p) return;

  const st = personStatus(p);
  $("#person-status").textContent = `${st.label}${st.date ? ` · ${dateEs(st.date)}` : ""} · ${st.n} ${st.n === 1 ? "elemento asignado" : "elementos asignados"}.`;

  const reveal = $("#person-reveal");
  reveal.replaceChildren();
  const box = renderReveal(p);
  if (box) reveal.append(box);

  const actions = $("#person-actions");
  actions.replaceChildren();
  if (!state.reveal[p.id]) {
    const show = el("button", { type: "button", class: "link" }, "Mostrar frase");
    show.addEventListener("click", () => askReveal(p.id));
    actions.append(show);
  }
  const rel = el("button", { type: "button", class: "link" }, st.released ? "Enviar de nuevo" : "Entregar ahora");
  rel.addEventListener("click", () => releaseNow(p.id));
  actions.append(rel);
  if (st.released) {
    const rv = el("button", { type: "button", class: "link" }, "Anular enlace");
    rv.addEventListener("click", () => revokeRelease(p.id));
    actions.append(rv);
  }
  const del = el("button", { type: "button", class: "link danger" }, "Quitar persona");
  del.addEventListener("click", () => deletePerson(p.id));
  actions.append(del);
}

function showScreen(name) {
  for (const s of $$("[data-screen]")) s.hidden = s.dataset.screen !== name;
  const inside = !["login", "register"].includes(name);
  $("#top-nav").hidden = !inside;
  if (inside) {
    $("#nav-plan").classList.toggle("is-current", name === "list" || name === "edit");
    $("#nav-people").classList.toggle("is-current", name === "people" || name === "person-edit");
    $("#nav-account").classList.toggle("is-current", name === "account");
  }
  if (name === "login") $("#login-email").focus();
  if (name === "register") $("#register-email").focus();
  window.scrollTo({ top: 0 });
}

function goPeople() {
  if (state.draft) return toast("Termina o cancela el elemento que estás editando.");
  renderPeople();
  showScreen("people");
}

function goPlan() {
  if (state.personDraft) return toast("Termina o cancela la persona que estás editando.");
  if (Object.keys(state.reveal).length) hideReveal();
  renderList();
  showScreen("list");
}

function setBusy(on, text = "") {
  document.body.classList.toggle("is-busy", on);
  $("#busy").textContent = text;
  $("#busy").hidden = !on;
  for (const b of $$("button[type=submit]")) b.disabled = on;
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

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dateEs(epochS) {
  return new Date(epochS * 1000).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
}

// ------------------------------------------------------------ idle lock

let idleTimer = null;
function touchIdle() {
  if (!state.encKey) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => lock("Plan cerrado por inactividad. Vuelve a entrar."), IDLE_LOCK_MS);
}

// ---------------------------------------------------------------- boot

function boot() {
  $("#login-form").addEventListener("submit", submitLogin);
  $("#register-form").addEventListener("submit", submitRegister);
  $("#to-register").addEventListener("click", () => {
    $("#register-message").textContent = "";
    for (const id of ["#register-password", "#register-confirm"]) { $(id).type = "password"; $(id).value = ""; }
    showScreen("register");
  });
  $("#to-login").addEventListener("click", () => { $("#login-message").textContent = ""; showScreen("login"); });
  $("#register-generate").addEventListener("click", () => {
    const phrase = generatePassphrase();
    for (const id of ["#register-password", "#register-confirm"]) { $(id).type = "text"; $(id).value = phrase; }
    $("#register-message").textContent = "Apúntala antes de continuar. Se muestra en claro solo ahora.";
  });
  $("#logout").addEventListener("click", logout);
  $("#nav-plan").addEventListener("click", goPlan);
  $("#nav-people").addEventListener("click", goPeople);
  $("#nav-account").addEventListener("click", goAccount);
  $("#password-form").addEventListener("submit", changePassword);
  $("#pw-generate").addEventListener("click", () => {
    const phrase = generatePassphrase();
    for (const id of ["#pw-new", "#pw-confirm"]) { $(id).type = "text"; $(id).value = phrase; }
    $("#pw-message").textContent = "Apúntala antes de continuar. Se muestra en claro solo ahora.";
  });
  $("#add").addEventListener("click", () => startEdit(null));
  $("#export").addEventListener("click", exportBundle);
  $("#phone-form").addEventListener("submit", savePhone);
  $("#release-notice-go").addEventListener("click", goPeople);
  $("#item-form").addEventListener("submit", applyItem);
  $("#item-cancel").addEventListener("click", cancelEdit);
  $("#item-files").addEventListener("change", (e) => addFiles([...e.target.files]));
  $("#add-person").addEventListener("click", () => startPersonEdit(null));
  $("#person-form").addEventListener("submit", applyPerson);
  $("#person-cancel").addEventListener("click", cancelPersonEdit);
  $("#person-generate").addEventListener("click", () => { $("#person-pass").value = generatePassphrase(); });
  $("#settings-form").addEventListener("submit", saveSettings);

  for (const evt of ["click", "keydown", "input"]) document.addEventListener(evt, touchIdle, { passive: true });

  window.addEventListener("beforeunload", (e) => {
    if (state.draft || state.personDraft) { e.preventDefault(); e.returnValue = ""; }
  });

  if (!window.isSecureContext || !crypto?.subtle) {
    showScreen("login");
    $("#login-message").textContent = "Este navegador no ofrece cifrado seguro (se necesita HTTPS y WebCrypto).";
    $("#login-submit").disabled = true;
    $("#to-register").disabled = true;
    return;
  }

  showScreen("login");
}

boot();
