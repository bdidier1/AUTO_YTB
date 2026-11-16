"use strict";

/* ---------- Outils ---------- */

// Cree un element DOM sans jamais passer par innerHTML (pas d'injection possible).
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== "list") el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const nf = new Intl.NumberFormat("fr-FR");
const nfCompact = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const eur = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const dateTimeFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function api(method, path, body) {
  const opts = { method, headers: { "X-AutoYTB": "1" } };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  let data = null;
  try { data = await r.json(); } catch { /* vide */ }
  if (!r.ok) {
    if (r.status === 401 && data && data.reconnect) showReauth(data.detail);
    let d = data && data.detail;
    if (Array.isArray(d)) d = d.map((e) => String(e.msg || "").replace(/^Value error, /, "")).join(" · ");
    throw new Error(d || `Erreur ${r.status}`);
  }
  return data;
}

// Bandeau affiche quand Google a coupe l'acces au compte actif.
function showReauth(msg) {
  const b = $("#reauthBanner");
  b.replaceChildren(
    h("span", {}, "⚠ " + (msg || "Google a coupé l'accès à ce compte.")),
    h("button", { type: "button", class: "btn primary sm", onclick: () => connectAccount() }, "Reconnecter le compte"),
    h("button", { type: "button", class: "icon-btn", title: "Fermer", onclick: () => b.classList.add("hidden") }, "✕"));
  b.classList.remove("hidden");
}

let toastTimer;
function toast(msg, kind = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), kind === "err" ? 7000 : 3500);
}

function safeGoogleImg(url) {
  return /^https:\/\/([\w-]+\.)*(ggpht\.com|googleusercontent\.com|ytimg\.com)\//.test(url || "") ? url : "";
}

function extLink(href, text, cls = "") {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer", class: cls }, text);
}

function fmtDur(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return "";
  sec = Math.round(sec * 10) / 10;
  if (sec < 60) return `${sec.toLocaleString("fr-FR")} s`;
  const m = Math.floor(sec / 60), r = Math.round(sec % 60);
  return `${m} min ${String(r).padStart(2, "0")}`;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function toDateInput(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function toTimeInput(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function fromInputs(dateStr, timeStr) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  const dt = new Date(y, mo - 1, d, hh, mm, 0, 0);
  return isNaN(dt) ? null : dt;
}

/* ---------- Dates de publication par defaut ---------- */

// 10h00 le week-end, 14h00 le mercredi, 16h30 les autres jours de semaine.
function defaultTimeFor(d) {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return [10, 0];
  if (wd === 3) return [14, 0];
  return [16, 30];
}
function withDefaultTime(d) {
  const x = new Date(d);
  const [hh, mm] = defaultTimeFor(x);
  x.setHours(hh, mm, 0, 0);
  return x;
}
const dayKey = (d) => toDateInput(new Date(d));

// Jours deja occupes sur un compte : videos publiees, programmees, ou en attente d'envoi dans l'appli.
function busyDays(videos, cid) {
  const days = new Map();   // "AAAA-MM-JJ" -> { pub: [...], sched: [...] }
  const add = (date, kind, item) => {
    const k = dayKey(date);
    if (!days.has(k)) days.set(k, { pub: [], sched: [] });
    days.get(k)[kind].push(item);
  };
  for (const v of videos || []) {
    if (v.publish_at && v.privacy === "private") add(v.publish_at, "sched", { title: v.title, at: v.publish_at, id: v.id });
    else if (v.privacy === "public") add(v.published, "pub", { title: v.title, at: v.published, id: v.id, views: v.views });
  }
  // Videos programmees depuis le site mais pas encore visibles sur YouTube (conversion ou envoi
  // en cours, en erreur, ou envoyees il y a moins d'une minute) : elles comptent aussi.
  const known = new Set((videos || []).map((v) => v.id));
  for (const c of state.jobs.values()) {
    const p = c.job.publish;
    if (!p || p.channel_id !== cid || !p.publish_at || new Date(p.publish_at) <= new Date()) continue;
    if (c.job.youtube_id && known.has(c.job.youtube_id)) continue;     // deja dans la liste YouTube
    const note = c.job.status === "done" ? "" : c.job.status === "error" ? " (en erreur sur le site)" : " (envoi en cours)";
    add(p.publish_at, "sched", { title: p.title + note, at: p.publish_at, id: c.job.youtube_id || undefined });
  }
  return days;
}

// Jour qui suit la derniere video programmee (YouTube + site), a l'heure par defaut de ce jour.
// Sans programmation a venir : le premier jour libre a partir d'aujourd'hui.
function firstFreeSlot(days) {
  const now = Date.now();
  const todayKey = dayKey(new Date());
  let lastKey = null;
  for (const [k, d] of days || []) {
    if (k >= todayKey && (d.sched.length || d.pub.length) && (!lastKey || k > lastKey)) lastKey = k;
  }
  const start = lastKey ? new Date(lastKey + "T12:00:00") : new Date();
  if (lastKey) start.setDate(start.getDate() + 1);
  for (let i = 0; i < 400; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const slot = withDefaultTime(d);
    if (slot.getTime() - now < 10 * 60e3) continue;      // heure deja passee aujourd'hui
    if (!days || !days.has(dayKey(slot))) return slot;
  }
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return withDefaultTime(d);
}
const defaultPublishDate = () => firstFreeSlot(null);

// Champ date + heure. Quand on change la date, l'heure par defaut du jour est remise
// (16h30 en semaine, 14h00 le mercredi, 10h00 le week-end), sauf si l'heure a ete modifiee a la main.
function dateTimeField(initial) {
  const date = h("input", { type: "date", value: toDateInput(initial), min: toDateInput(new Date()) });
  const time = h("input", { type: "time", value: toTimeInput(initial), step: 60 });
  let timeTouched = false;
  time.addEventListener("input", () => { timeTouched = true; });
  date.addEventListener("change", () => {
    if (!timeTouched && date.value) {
      const [hh, mm] = defaultTimeFor(fromInputs(date.value, "12:00"));
      time.value = `${pad2(hh)}:${pad2(mm)}`;
    }
  });
  const el = h("div", { class: "dt-field" }, date, time);
  return {
    el,
    get: () => (date.value && time.value ? fromInputs(date.value, time.value) : null),
    set(d) { date.value = toDateInput(d); time.value = toTimeInput(d); timeTouched = false; },
  };
}

/* ---------- Videos d'une chaine (cache partage, 1 min) ---------- */

const videoCache = new Map();
function getChannelVideos(cid, force = false) {
  const c = videoCache.get(cid);
  if (!force && c && Date.now() - c.t < 60e3) return c.p;
  const p = api("GET", `/api/videos/${cid}`).catch((e) => { videoCache.delete(cid); throw e; });
  videoCache.set(cid, { t: Date.now(), p });
  return p;
}
function invalidateVideos(cid) { videoCache.delete(cid); }

/* ---------- Etat ---------- */

const state = { accounts: [], active: null, status: null, jobs: new Map(), days: 28, elig: new Map() };

function loadActive() {
  try { return localStorage.getItem("activeChannel"); } catch { return null; }
}
function saveActive(id) {
  try { localStorage.setItem("activeChannel", id); } catch { /* ignore */ }
}

function getEligibility(cid) {
  if (!state.elig.has(cid)) {
    state.elig.set(cid, api("GET", `/api/eligibility/${cid}`).catch((e) => { state.elig.delete(cid); throw e; }));
  }
  return state.elig.get(cid);
}

/* ---------- Comptes + menu du profil ---------- */

async function refreshAccounts() {
  state.accounts = await api("GET", "/api/accounts");
  const stored = state.active || loadActive();
  state.active = state.accounts.some((a) => a.channel_id === stored)
    ? stored : (state.accounts[0] ? state.accounts[0].channel_id : null);
  renderSwitch();
  for (const card of state.jobs.values()) card.refreshAccounts?.();
}

function activeAccount() {
  return state.accounts.find((a) => a.channel_id === state.active) || null;
}

function setActive(id) {
  state.active = id;
  saveActive(id);
  renderSwitch();
  route();
}

function avatarOf(a, cls = "avatar sm") {
  return a && safeGoogleImg(a.thumbnail) ? h("img", { class: cls, src: a.thumbnail, alt: "" }) : h("span", { class: cls + " avatar-ph" }, "▶");
}

function renderSwitch() {
  const acc = activeAccount();
  const img = $("#accountAvatar");
  const src = acc && safeGoogleImg(acc.thumbnail);
  img.classList.toggle("hidden", !src);
  if (src) img.src = src;
  $("#accountName").textContent = acc ? acc.title : "Aucun compte";

  const go = (hash) => () => { closeMenu(); location.hash = hash; };
  const others = state.accounts.filter((a) => a.channel_id !== state.active);
  $("#accountMenu").replaceChildren(...[
    acc ? h("div", { class: "menu-head" }, avatarOf(acc, "avatar"), h("div", {}, h("strong", {}, acc.title), h("div", { class: "hint" }, "Compte actif"))) : null,
    h("button", { type: "button", role: "menuitem", onclick: go("#profil") }, h("span", { class: "mi" }, "👤"), "Profil de la chaîne"),
    h("button", { type: "button", role: "menuitem", onclick: go("#stats") }, h("span", { class: "mi" }, "📊"), "Statistiques"),
    h("button", { type: "button", role: "menuitem", onclick: go("#videos") }, h("span", { class: "mi" }, "🎬"), "Vidéos en ligne"),
    h("button", { type: "button", role: "menuitem", onclick: go("#comptes") }, h("span", { class: "mi" }, "⚙"), "Gérer les comptes"),
    others.length ? h("hr") : null,
    others.length ? h("div", { class: "menu-label" }, "Changer de compte") : null,
    ...others.map((a) => h("button", {
      type: "button", role: "menuitem", onclick: () => { closeMenu(); setActive(a.channel_id); toast("Compte actif : " + a.title, "ok"); },
    }, avatarOf(a), a.title)),
    h("hr"),
    h("button", { type: "button", role: "menuitem", onclick: () => { closeMenu(); connectAccount(); } }, h("span", { class: "mi" }, "+"), "Ajouter un compte"),
  ].filter(Boolean));
}

function closeMenu() {
  $("#accountMenu").classList.add("hidden");
  $("#accountBtn").setAttribute("aria-expanded", "false");
}

$("#accountBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const m = $("#accountMenu");
  m.classList.toggle("hidden");
  $("#accountBtn").setAttribute("aria-expanded", String(!m.classList.contains("hidden")));
});
document.addEventListener("click", (e) => { if (!$("#accountSwitch").contains(e.target)) closeMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });

async function connectAccount() {
  try {
    const { url } = await api("POST", "/api/accounts/connect");
    if (!/^https:\/\/accounts\.google\.com\//.test(url)) throw new Error("URL de connexion inattendue");
    location.href = url;
  } catch (e) {
    toast(e.message, "err");
    location.hash = "#comptes";
  }
}

/* ---------- Navigation ---------- */

const VIEWS = ["publier", "videos", "video", "stats", "profil", "comptes"];

function route() {
  const raw = location.hash.slice(1) || "publier";
  const [path, query] = raw.split("?");
  const [tab, arg] = path.split("/");
  const cur = VIEWS.includes(tab) ? tab : "publier";
  for (const v of VIEWS) $("#view-" + v).classList.toggle("hidden", v !== cur);
  const navTab = cur === "video" ? "videos" : cur;
  for (const a of document.querySelectorAll("#tabs a")) a.classList.toggle("on", a.dataset.tab === navTab);

  if (query) {
    const p = new URLSearchParams(query);
    if (p.get("ok")) toast("Compte YouTube connecté ✔", "ok");
    const errs = { annule: "Connexion annulée.", refuse: "Google a refusé la connexion.", echec: "La connexion a échoué, recommence." };
    if (p.get("err")) toast(errs[p.get("err")] || "Erreur de connexion", "err");
    history.replaceState(null, "", "#" + path);
  }
  if (cur === "publier") loadPublishCalendar();
  if (cur === "videos") loadVideos();
  if (cur === "video") loadVideoDetail(arg);
  if (cur === "stats") loadStats();
  if (cur === "profil") loadProfile();
  if (cur === "comptes") renderAccountsView();
}
window.addEventListener("hashchange", route);

/* ---------- Demarrage (apres chargement de tous les scripts) ---------- */

window.addEventListener("DOMContentLoaded", async () => {
  try {
    state.status = await api("GET", "/api/status");
    const hint = $("#encoderHint");
    if (!state.status.ffmpeg) hint.textContent = "⚠ ffmpeg introuvable : installe-le avec « winget install Gyan.FFmpeg » puis relance.";
    else hint.textContent = `Téléchargement → aperçu et découpage → conversion 4K (2160×3840) 60 i/s → mise en ligne · encodeur : ${state.status.encoder}`;
    await refreshAccounts();
  } catch (e) {
    toast(e.message, "err");
  }
  route();
  pollJobs();
});
