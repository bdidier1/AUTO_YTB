"use strict";

/* =====================================================================
   PUBLIER : 1. telechargement + 4K  ->  2. apercu + decoupage  ->  3. mise en ligne
   ===================================================================== */

$("#addForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#urlInput");
  const url = input.value.trim();
  if (!url) return;
  const btn = e.submitter;
  btn.disabled = true;
  try {
    await api("POST", "/api/jobs", { url });
    input.value = "";
    await pollJobs();
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.disabled = false;
  }
});

const STATUS_LABEL = {
  queued: "En attente", downloading: "Téléchargement", preparing: "Préparation", converting: "Conversion 4K60",
  converted: "4K prête", uploading: "Envoi YouTube", done: "En ligne", error: "Erreur",
};
const BUSY = new Set(["queued", "downloading", "preparing", "converting", "uploading"]);
const LOADING = new Set(["queued", "downloading", "preparing"]);

/* ---------- Decoupage (meme logique que le serveur) ---------- */

function keepSegments(ed, dur) {
  const start = Math.max(0, Number(ed.start) || 0);
  const end = Math.min(dur, Number(ed.end) || dur);
  let segs = [[start, end]];
  for (const [a, b] of [...ed.cuts].map(([x, y]) => [Number(x), Number(y)]).sort((p, q) => p[0] - q[0])) {
    const out = [];
    for (const [s0, e0] of segs) {
      if (b <= s0 || a >= e0) { out.push([s0, e0]); continue; }
      if (a > s0) out.push([s0, a]);
      if (b < e0) out.push([b, e0]);
    }
    segs = out;
  }
  return segs.filter(([s0, e0]) => e0 - s0 >= 0.05);
}
const keptDuration = (segs) => segs.reduce((t, [a, b]) => t + b - a, 0);

// Pendant la lecture, saute les passages coupes pour montrer le resultat final.
function attachSkipPlayback(video, getSegs) {
  let raf = 0;
  const tick = () => {
    const segs = getSegs();
    if (segs.length && !video.paused && !video.seeking) {
      const t = video.currentTime;
      if (!segs.some(([a, b]) => t >= a && t < b - 0.02)) {
        const next = segs.find(([a]) => a > t);
        if (next) video.currentTime = next[0];
        else { video.pause(); video.currentTime = segs[0][0]; }
      }
    }
    raf = video.paused ? 0 : requestAnimationFrame(tick);
  };
  video.addEventListener("play", () => {
    const segs = getSegs();
    if (segs.length && (video.currentTime < segs[0][0] || video.currentTime >= segs[segs.length - 1][1] - 0.05)) {
      video.currentTime = segs[0][0];
    }
    if (!raf) raf = requestAnimationFrame(tick);
  });
}

function playerFor(job) {
  return h("video", {
    class: "player", src: `/api/jobs/${job.id}/preview`, controls: true, preload: "metadata", playsInline: true,
    poster: job.has_thumb ? `/api/jobs/${job.id}/thumb` : null,
  });
}

// Fusionne les coupes qui se chevauchent et les limite a la plage gardee.
function normalizeCuts(ed) {
  const cuts = ed.cuts
    .map(([a, b]) => [Math.max(ed.start, Math.min(a, b)), Math.min(ed.end, Math.max(a, b))])
    .filter(([a, b]) => b - a >= 0.05)
    .sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const c of cuts) {
    const last = out[out.length - 1];
    if (last && c[0] <= last[1] + 0.02) last[1] = Math.max(last[1], c[1]);
    else out.push([...c]);
  }
  ed.cuts = out;
}

/* Frise interactive :
   - glisser sur la barre = selectionner un passage a couper (la suite est recollee)
   - clic simple = se deplacer dans la video
   - poignees blanches aux extremites = debut / fin de la video gardee
   - clic sur un passage rouge = le remettre */
function timeline(video, dur, ed, onChange) {
  const track = h("div", { class: "tl-track" });
  const sel = h("div", { class: "tl-sel hidden" });
  const head = h("div", { class: "tl-head" });
  const hStart = h("div", { class: "tl-handle", title: "Tirer pour choisir le début" });
  const hEnd = h("div", { class: "tl-handle", title: "Tirer pour choisir la fin" });
  const bar = h("div", { class: "timeline" }, track, sel, hStart, hEnd, head);
  const ticks = h("div", { class: "tl-ticks" });
  const el = h("div", { class: "tl-wrap" }, bar, ticks);
  const pct = (t) => (t / dur) * 100 + "%";
  const round = (x) => Math.round(x * 10) / 10;

  function draw() {
    const parts = [];
    let cur = ed.start;
    for (const [a, b] of ed.cuts) {
      if (a > cur) parts.push(["keep", cur, a]);
      parts.push(["cut", a, b]);
      cur = b;
    }
    if (ed.end > cur) parts.push(["keep", cur, ed.end]);
    track.replaceChildren(...parts.map(([kind, a, b]) => {
      const seg = h("div", { class: kind === "keep" ? "tl-keep" : "tl-cut", "data-a": a, "data-b": b,
        title: kind === "cut" ? `Passage coupé ${fmtDur(a)} → ${fmtDur(b)} · clique pour le remettre` : "" },
        kind === "cut" && b - a > dur * 0.04 ? "✕" : null);
      seg.style.left = pct(a);
      seg.style.width = pct(b - a);
      return seg;
    }));
    hStart.style.left = pct(ed.start);
    hEnd.style.left = pct(ed.end);
    ticks.replaceChildren(...[0, 0.25, 0.5, 0.75, 1].map((f) => {
      const t = h("span", {}, fmtDur(round(dur * f)));
      t.style.left = f * 100 + "%";
      return t;
    }));
  }

  const move = () => { head.style.left = Math.min(100, (video.currentTime / dur) * 100) + "%"; };
  video.addEventListener("timeupdate", move);
  video.addEventListener("seeked", move);

  const timeAt = (e) => {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur));
  };
  let drag = null;
  bar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    const t = timeAt(e);
    if (e.target === hStart || e.target === hEnd) drag = { mode: e.target === hStart ? "start" : "end" };
    else drag = { mode: "select", t0: t, x0: e.clientX, target: e.target };
  });
  bar.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const t = round(timeAt(e));
    if (drag.mode === "start") { ed.start = Math.min(t, ed.end - 0.5); normalizeCuts(ed); onChange(); video.currentTime = ed.start; }
    else if (drag.mode === "end") { ed.end = Math.max(t, ed.start + 0.5); normalizeCuts(ed); onChange(); video.currentTime = ed.end; }
    else if (Math.abs(e.clientX - drag.x0) > 4) {
      const a = Math.min(drag.t0, t), b = Math.max(drag.t0, t);
      sel.classList.remove("hidden");
      sel.style.left = pct(a);
      sel.style.width = pct(b - a);
      sel.textContent = `✂ ${fmtDur(round(b - a))}`;
      video.currentTime = t;
    }
  });
  const end = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    sel.classList.add("hidden");
    if (d.mode !== "select") return;
    const t = timeAt(e);
    if (Math.abs(e.clientX - d.x0) <= 4) {
      // simple clic : sur un passage coupe -> on le remet, sinon on se deplace
      if (d.target.classList.contains("tl-cut")) {
        const a = Number(d.target.dataset.a);
        ed.cuts = ed.cuts.filter(([x]) => Math.abs(x - a) > 0.001);
        onChange();
        toast("Passage remis", "ok");
      } else {
        video.currentTime = t;
        move();
      }
      return;
    }
    ed.cuts.push([round(Math.min(d.t0, t)), round(Math.max(d.t0, t))]);
    normalizeCuts(ed);
    onChange();
    // on se place juste avant la coupe pour pouvoir verifier le raccord
    video.currentTime = Math.max(ed.start, Math.min(d.t0, t) - 1.5);
    move();
  };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", () => { drag = null; sel.classList.add("hidden"); });

  draw();
  return { el, draw };
}

function trimEditor(job, video) {
  const dur = job.duration || 0;
  const ed = {
    start: job.edit ? job.edit.start : 0,
    end: job.edit ? job.edit.end : dur,
    cuts: job.edit ? job.edit.cuts.map((c) => [...c]) : [],
  };
  const segs = () => keepSegments(ed, dur);
  const tl = timeline(video, dur, ed, () => refresh());
  attachSkipPlayback(video, segs);

  const summary = h("div", { class: "trim-sum" });
  const cutsBox = h("div", { class: "cuts" });
  const round = (x) => Math.round(x * 10) / 10;
  const now = () => round(video.currentTime || 0);

  function numInput(value, onchange) {
    const i = h("input", { type: "number", min: 0, max: dur, step: 0.1, value: round(value), class: "num-in" });
    i.addEventListener("change", () => { onchange(Math.max(0, Math.min(dur, Number(i.value) || 0))); refresh(); });
    return i;
  }
  const hereBtn = (onclick) => h("button", { type: "button", class: "btn sm", title: "Prendre la position actuelle de la vidéo", onclick: () => { onclick(now()); refresh(); } }, "⤓ ici");

  const startIn = numInput(ed.start, (v) => { ed.start = v; });
  const endIn = numInput(ed.end, (v) => { ed.end = v; });

  function refresh() {
    if (ed.end <= ed.start) ed.end = Math.min(dur, ed.start + 0.5);
    normalizeCuts(ed);
    startIn.value = round(ed.start);
    endIn.value = round(ed.end);
    cutsBox.replaceChildren(...ed.cuts.map((c, i) => h("div", { class: "cut-row" },
      h("span", { class: "cut-lbl" }, "✂ Retirer de"),
      numInput(c[0], (v) => { c[0] = v; if (c[1] <= v) c[1] = Math.min(dur, v + 0.5); }), hereBtn((v) => { c[0] = v; if (c[1] <= v) c[1] = Math.min(dur, v + 0.5); }),
      h("span", {}, "à"),
      numInput(c[1], (v) => { c[1] = Math.max(v, c[0] + 0.1); }), hereBtn((v) => { c[1] = Math.max(v, c[0] + 0.1); }),
      h("button", { type: "button", class: "icon-btn", title: "Supprimer cette coupe", onclick: () => { ed.cuts.splice(i, 1); refresh(); } }, "✕"),
    )));
    const s = segs();
    const kept = keptDuration(s);
    summary.replaceChildren(
      h("strong", {}, `Durée gardée : ${fmtDur(kept)}`),
      h("span", { class: "hint" }, ` sur ${fmtDur(dur)}`),
      kept > 180 ? h("span", { class: "warn-txt" }, " · plus de 3 min : ce ne sera pas un Short") : h("span", { class: "ok-txt" }, " · format Short ✔"),
    );
    tl.draw();
  }

  const el = h("div", { class: "trim" },
    h("h3", {}, "Durée et découpage"),
    h("ul", { class: "trim-help" },
      h("li", {}, h("strong", {}, "Glisse avec la souris"), " sur la barre bleue (sous la vidéo) pour couper un passage : il devient rouge et la suite est recollée automatiquement."),
      h("li", {}, "Tire les ", h("strong", {}, "poignées blanches"), " aux deux bouts pour choisir le début et la fin."),
      h("li", {}, "Clique sur un passage rouge pour le remettre. Clique ailleurs pour te déplacer."),
      h("li", {}, "La lecture saute déjà les passages coupés : tu vois le résultat final.")),
    h("div", { class: "trim-row" },
      h("label", {}, "Garder à partir de", startIn, "s", hereBtn((v) => { ed.start = v; })),
      h("label", {}, "jusqu'à", endIn, "s", hereBtn((v) => { ed.end = v; })),
    ),
    cutsBox,
    h("div", { class: "row" },
      h("button", { type: "button", class: "btn sm", onclick: () => { const t = now(); ed.cuts.push([t, Math.min(dur, round(t + 1))]); refresh(); } }, "✂ Retirer un passage à partir d'ici"),
      h("button", { type: "button", class: "btn sm ghost", onclick: () => { ed.start = 0; ed.end = dur; ed.cuts = []; refresh(); } }, "Tout réinitialiser"),
    ),
    summary,
  );
  refresh();
  return { el, tl, get: () => ({ start: ed.start, end: ed.end, cuts: ed.cuts }) };
}

/* ---------- Bloc "conversion / verification 4K" mis a jour en direct ---------- */

function convSignature(j) {
  return [j.status, Math.round(j.progress || 0), j.message, j.out_info ? 1 : 0, j.converting_edit_ok].join("|");
}

function renderConv(box, j) {
  const rows = [];
  if (LOADING.has(j.status)) {
    rows.push(h("p", { class: "conv-msg" }, j.message || "…"), progressBar(j.progress));
  } else if (j.status === "converting") {
    rows.push(h("p", { class: "conv-msg" }, `⏳ Conversion 4K 60 i/s en cours… ${Math.round(j.progress || 0)} %`), progressBar(j.progress));
    if (j.width) rows.push(h("p", { class: "hint" }, `Source : ${j.src_quality || `${j.width}×${j.height}`} · ${Math.round(j.fps)} i/s → 2160×3840 · 60 i/s`));
  } else if (j.status === "uploading") {
    rows.push(h("p", { class: "conv-msg" }, `⬆ Envoi vers YouTube… ${Math.round(j.progress || 0)} %`), progressBar(j.progress));
  } else if (j.status === "error") {
    rows.push(h("p", { class: "err-txt" }, "✖ " + j.message),
      h("button", { type: "button", class: "btn sm", onclick: async (e) => {
        e.target.disabled = true;
        try { await api("POST", `/api/jobs/${j.id}/retry`); await pollJobs(); } catch (err) { toast(err.message, "err"); e.target.disabled = false; }
      } }, "↻ Réessayer"),
      /cookies/i.test(j.message) ? h("button", { type: "button", class: "btn sm", onclick: () => { location.hash = "#comptes"; } }, "🍪 Importer mes cookies") : null);
  } else if (j.out_info) {
    const o = j.out_info;
    const ok = (c) => (c ? "✔" : "✖");
    const ratio = o.height / Math.max(j.height || 1, 1);
    const up = !j.width ? "" : ratio > 1.05 ? `agrandie ×${ratio.toFixed(1)} depuis ${j.width}×${j.height}` : "source déjà en 4K";
    rows.push(
      h("div", { class: "verif" },
        j.src_quality ? h("div", { class: "ok-txt" }, `✔ Source téléchargée dans la meilleure qualité proposée par ${j.platform || "le site"} : ${j.src_quality}`) : null,
        h("div", { class: o.width === 2160 && o.height === 3840 ? "ok-txt" : "err-txt" }, `${ok(o.width === 2160 && o.height === 3840)} Résolution ${o.width}×${o.height} (4K vertical) ${up ? "· " + up : ""}`),
        h("div", { class: Math.abs(o.fps - 60) < 0.5 ? "ok-txt" : "err-txt" }, `${ok(Math.abs(o.fps - 60) < 0.5)} ${Math.round(o.fps)} images/s ${j.fps ? `(source ${Math.round(j.fps)} i/s)` : ""}`),
        h("div", { class: "ok-txt" }, `✔ ${String(o.vcodec).toUpperCase()} · ${fmtDur(o.duration)}${o.has_audio ? " · son OK" : " · pas de son"}`),
      ),
      h("p", { class: "hint" }, j.message),
    );
  }
  box.replaceChildren(...rows.filter(Boolean));
}

function progressBar(p) {
  const bar = h("div", { class: "bar" });
  bar.style.width = Math.max(2, p || 0) + "%";
  return h("div", { class: "progress" }, bar);
}

/* ---------- Description + hashtags (les hashtags sont ecrits dans la description) ---------- */

const HASH_RE = /#([\p{L}\p{N}_]+)/gu;

function hashtagsIn(text) {
  const seen = new Set(), out = [];
  for (const m of (text || "").matchAll(HASH_RE)) {
    const k = m[1].toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(m[1]); }
  }
  return out;
}

function descriptionField(job, onChange = () => {}) {
  const tags = (job.hashtags || []).map((t) => "#" + t).join(" ");
  const initial = [job.description || "", tags].map((x) => x.trim()).filter(Boolean).join("\n\n");
  const area = h("textarea", { value: initial, maxLength: 5000, rows: 5 });
  area.addEventListener("input", () => onChange());
  return {
    el: area,
    tags: () => hashtagsIn(area.value),
    has: (t) => hashtagsIn(area.value).some((x) => x.toLowerCase() === t.toLowerCase()),
    add(t) {
      if (hashtagsIn(area.value).some((x) => x.toLowerCase() === t.toLowerCase())) return;
      const text = area.value.replace(/\s+$/, "");
      const lines = text.split("\n");
      const last = lines[lines.length - 1] || "";
      // la derniere ligne ne contient que des hashtags : on ajoute a la suite, sinon nouvelle ligne
      const onlyTags = last.trim() && last.trim().split(/\s+/).every((w) => w.startsWith("#"));
      area.value = !text ? "#" + t : onlyTags ? text + " #" + t : text + "\n\n#" + t;
      area.dispatchEvent(new Event("input"));
    },
  };
}

function counted(labelText, field, max, extra) {
  const counter = h("span", { class: "counter" });
  const upd = () => {
    counter.textContent = `${field.value.length}/${max}`;
    counter.classList.toggle("over", field.value.length > max);
  };
  field.addEventListener("input", upd);
  upd();
  return h("label", { class: "field" }, h("span", {}, labelText, counter), field, extra || null);
}

/* ---------- Verifications (comme l'etape « Verifications » de YouTube Studio) ---------- */

const ICON = { ok: "✔", warn: "⚠", bad: "✖", info: "ℹ", wait: "⏳" };

function computeChecks(job, v) {
  const out = [];
  const o = job.out_info;
  if (job.status === "converted" && o && job.converting_edit_ok) {
    const good = o.width === 2160 && o.height === 3840 && Math.abs(o.fps - 60) < 0.5;
    out.push({ lvl: good ? "ok" : "bad", t: "Qualité", d: good ? "4K 2160×3840 à 60 i/s vérifiée" : `Format inattendu : ${o.width}×${o.height} à ${o.fps} i/s` });
  } else if (job.status === "error") {
    out.push({ lvl: "bad", t: "Qualité", d: "La conversion a échoué : clique sur Réessayer" });
  } else {
    out.push({ lvl: "wait", t: "Qualité", d: "Conversion 4K 60 i/s en cours : tu peux déjà valider, l'envoi partira à la fin" });
  }
  out.push(v.dur <= 180
    ? { lvl: "ok", t: "Format", d: `Short (${fmtDur(v.dur)}, 3 min maximum)` }
    : { lvl: "warn", t: "Format", d: `${fmtDur(v.dur)} : au-delà de 3 min, YouTube la publie en vidéo classique, pas en Short` });
  if (!v.title.trim()) out.push({ lvl: "bad", t: "Titre", d: "Le titre est obligatoire" });
  else if (v.title.length > 100) out.push({ lvl: "bad", t: "Titre", d: "100 caractères maximum" });
  else if (/[<>]/.test(v.title)) out.push({ lvl: "bad", t: "Titre", d: "Les caractères < et > sont interdits" });
  else out.push({ lvl: "ok", t: "Titre", d: `${v.title.length}/100 caractères` });
  const n = v.tags.length;
  if (n === 0) out.push({ lvl: "warn", t: "Hashtags", d: "Aucun hashtag : ajoute-en 3 à 8 pour aider YouTube à classer la vidéo" });
  else if (n > 60) out.push({ lvl: "bad", t: "Hashtags", d: `${n} hashtags : au-delà de 60, YouTube ignore tous les hashtags de la vidéo` });
  else if (n > 15) out.push({ lvl: "warn", t: "Hashtags", d: `${n} hashtags : trop de hashtags peut être vu comme du spam, vise 3 à 10` });
  else out.push({ lvl: "ok", t: "Hashtags", d: `${n} hashtag${n > 1 ? "s" : ""} (les 3 premiers s'affichent au-dessus du titre)` });
  if (job.watermark) {
    out.push({ lvl: "warn", t: "Filigrane", d: "Logo TikTok / @pseudo détecté sur la vidéo : YouTube met moins en avant les Shorts qui portent le logo d'une autre plateforme" });
  }
  if (job.platform && !/youtube/i.test(job.platform)) {
    out.push({ lvl: "warn", t: "Monétisation", d: `Vidéo reprise de ${job.platform} : risque « contenu réutilisé ». Pour gagner de l'argent avec, il faut la transformer (montage, voix off, commentaire…)` });
  }
  out.push({ lvl: "info", t: "Droits d'auteur", d: "La musique et les images sont analysées par YouTube après l'envoi. Le résultat apparaît dans « Vidéos en ligne »" });
  out.push({ lvl: "ok", t: "Public", d: "Déclarée « non conçue pour les enfants » (commentaires et pubs personnalisées actifs)" });
  if (v.mode === "later") {
    if (!v.when) out.push({ lvl: "bad", t: "Programmation", d: "Choisis une date et une heure" });
    else if (v.when <= new Date()) out.push({ lvl: "bad", t: "Programmation", d: "L'heure choisie est déjà passée" });
    else out.push({ lvl: "ok", t: "Programmation", d: "Mise en ligne " + dateTimeFmt.format(v.when) });
  }
  return out;
}

function checksList(items) {
  return h("ul", { class: "checks" }, items.map((c) => h("li", { class: "chk chk-" + c.lvl },
    h("span", { class: "chk-i" }, ICON[c.lvl]), h("div", {}, h("strong", {}, c.t), h("div", {}, c.d)))));
}

function meter(label, val, max, fmt) {
  const pct = Math.min(100, ((val || 0) / max) * 100);
  const bar = h("div", { class: "bar" });
  bar.style.width = Math.max(1, pct) + "%";
  return h("div", { class: "meter" },
    h("div", { class: "row between" }, h("span", {}, label), h("span", { class: "hint" }, `${fmt(val || 0)} / ${fmt(max)}`)),
    h("div", { class: "progress" + (pct >= 100 ? " full" : "") }, bar));
}

async function renderMonetization(box, cid) {
  if (!cid) { box.replaceChildren(); return; }
  box.replaceChildren(h("p", { class: "hint" }, "Chargement de l'éligibilité à la monétisation…"));
  try {
    const e = await getEligibility(cid);
    const nfc = (x) => nfCompact.format(x);
    box.replaceChildren(
      h("h4", {}, "Monétisation de la chaîne"),
      e.eligible_full
        ? h("p", { class: "ok-txt" }, "✔ Seuils du Programme Partenaire atteints : si ta chaîne est acceptée, cette vidéo peut rapporter de l'argent.")
        : h("p", { class: "warn-txt" }, "⚠ Chaîne pas encore éligible au Programme Partenaire : cette vidéo ne rapportera pas d'argent pour l'instant."),
      meter("Abonnés", e.subscribers, 1000, nfc),
      h("p", { class: "hint" }, "et au choix :"),
      meter("Vues Shorts (90 derniers jours)", e.shorts_views_90, 10_000_000, nfc),
      meter("Heures de visionnage, vidéos longues (12 mois)", e.long_hours_365, 4000, nfc),
      h("p", { class: "hint" }, "Chiffres YouTube Analytics (2 à 3 jours de retard). YouTube vérifie aussi le respect de ses règles avant d'accepter une chaîne."),
    );
  } catch (err) {
    box.replaceChildren(h("p", { class: "hint" }, "Éligibilité indisponible : " + err.message));
  }
}

/* ---------- Etape 3 : formulaire de mise en ligne ---------- */

function detailsForm(job, card) {
  const suggestedTitle = job.ocr_title || job.title || "";
  const title = h("input", { type: "text", value: suggestedTitle, maxLength: 100, required: true });
  const titleAlt = h("div", { class: "alts" });
  const alts = [["Texte lu sur la vidéo", job.ocr_title], ["Titre d'origine", job.title]].filter(([, t]) => t);
  if (alts.length > 1 && alts[0][1] !== alts[1][1]) {
    titleAlt.append(...alts.map(([lbl, t]) => h("button", { type: "button", class: "alt", title: "Utiliser ce titre", onclick: () => { title.value = t.slice(0, 100); title.dispatchEvent(new Event("input")); } },
      h("span", { class: "hint" }, lbl + " : "), t)));
  } else if (job.ocr_title) {
    titleAlt.append(h("span", { class: "hint" }, "✔ Titre repris du texte affiché au début de la vidéo"));
  }
  const desc = descriptionField(job, () => { updateChecks(); drawSugg(); });

  const account = h("select", {});
  const fillAccounts = () => {
    const cur = account.value || state.active;
    account.replaceChildren(...(state.accounts.length
      ? state.accounts.map((a) => h("option", { value: a.channel_id }, a.title))
      : [h("option", { value: "" }, "Aucun compte : ajoute-en un via le menu en haut à droite")]));
    if (state.accounts.some((a) => a.channel_id === cur)) account.value = cur;
  };
  fillAccounts();
  card.refreshAccounts = fillAccounts;

  // Suggestions de hashtags
  const suggBox = h("div", { class: "sugg" });
  let sugg = null;
  function drawSugg() {
    if (!sugg) return;
    const chip = (t) => desc.has(t)
      ? h("span", { class: "chip added" }, "✔ #" + t)
      : h("button", { type: "button", class: "chip add", onclick: () => desc.add(t) }, "+ #" + t);
    suggBox.replaceChildren(
      h("div", { class: "sugg-head" }, h("strong", {}, "Suggestions"),
        h("button", { type: "button", class: "icon-btn", title: "Nouvelles suggestions", onclick: () => loadSugg(true) }, "↻")),
      sugg.related.length ? h("div", { class: "sugg-row" }, h("span", { class: "hint" }, "Liées à la vidéo :"), ...sugg.related.map(chip))
        : h("p", { class: "hint" }, "Pas assez de Shorts similaires pour proposer des hashtags liés."),
      h("div", { class: "sugg-row" }, h("span", { class: "hint" }, "Populaires :"), ...sugg.popular.map(chip)),
    );
  }
  async function loadSugg(refresh = false) {
    if (!account.value) { suggBox.replaceChildren(h("p", { class: "hint" }, "Connecte un compte pour avoir des suggestions de hashtags.")); return; }
    suggBox.replaceChildren(h("p", { class: "hint" }, "Recherche de hashtags utilisés par des Shorts similaires…"));
    try {
      const q = new URLSearchParams({ channel_id: account.value, text: title.value, refresh: refresh ? "true" : "false" });
      sugg = await api("GET", `/api/jobs/${job.id}/suggestions?${q}`);
      drawSugg();
    } catch (e) {
      suggBox.replaceChildren(h("p", { class: "hint" }, "Suggestions indisponibles : " + e.message));
    }
  }

  // Quand publier
  let mode = "later";
  const when = dateTimeField(defaultPublishDate());
  const privacy = h("select", {},
    h("option", { value: "public" }, "Publique"),
    h("option", { value: "unlisted" }, "Non répertoriée"),
    h("option", { value: "private" }, "Privée"));
  const whenHint = h("div", { class: "hint" });
  const whenBox = h("div", { class: "field" }, h("span", { class: "lbl" }, "Date et heure de mise en ligne"), when.el, whenHint,
    h("div", { class: "hint" }, "Par défaut : le jour qui suit la dernière vidéo programmée sur ce compte (y compris celles validées ici mais pas encore envoyées), à 16h30 en semaine, 14h00 le mercredi et 10h00 le week-end. La vidéo passe publique à cette heure-là, même si ton PC est éteint."));

  // Date par defaut = premier jour libre du compte choisi (tant que l'utilisateur n'a pas choisi lui-meme).
  let dateTouched = false;
  let busy = new Map();
  when.el.addEventListener("change", () => { dateTouched = true; });
  async function placeOnFreeDay() {
    const cid = account.value;
    if (!cid) return;
    whenHint.textContent = "Recherche du premier jour libre…";
    try {
      busy = busyDays(await getChannelVideos(cid), cid);
      if (account.value !== cid) return;
      const slot = firstFreeSlot(busy);
      if (!dateTouched) when.set(slot);
      whenHint.textContent = `Date proposée (jour qui suit la dernière vidéo programmée) : ${dateTimeFmt.format(slot)}`;
    } catch (e) {
      whenHint.textContent = "Calendrier du compte indisponible : " + e.message;
    }
    updateChecks();
  }
  const privBox = h("label", { class: "field hidden" }, h("span", { class: "lbl" }, "Visibilité"), privacy);
  const submit = h("button", { type: "submit", class: "btn primary" }, "Programmer");
  const seg = h("div", { class: "seg" });
  const setMode = (m) => {
    mode = m;
    for (const b of seg.children) b.classList.toggle("on", b.dataset.m === m);
    whenBox.classList.toggle("hidden", m !== "later");
    privBox.classList.toggle("hidden", m === "later");
    submit.textContent = m === "later" ? "Programmer" : "Mettre en ligne maintenant";
    updateChecks();
  };
  seg.append(
    h("button", { type: "button", "data-m": "later", class: "on", onclick: () => setMode("later") }, "🗓 Programmer"),
    h("button", { type: "button", "data-m": "now", onclick: () => setMode("now") }, "⚡ Maintenant"),
  );

  // Verifications + monetisation
  const checksBox = h("div", { class: "checks-box" });
  const monetBox = h("div", { class: "monet" });
  const finalDur = () => (job.edit ? keptDuration(keepSegments(job.edit, job.duration)) : job.duration);
  function updateChecks() {
    const list = computeChecks(card.job || job, {
      title: title.value, tags: desc.tags(), mode, when: when.get(), dur: finalDur(),
    });
    const w = when.get();
    const day = mode === "later" && w && busy.get(dayKey(w));
    if (day) {
      const n = day.pub.length + day.sched.length;
      list.push({ lvl: "warn", t: "Calendrier", d: `${n} vidéo(s) déjà ${day.pub.length ? "publiée(s)" : "programmée(s)"} ce jour-là sur ce compte` });
    }
    checksBox.replaceChildren(h("h4", {}, "Vérifications"), checksList(list));
  }
  card.updateChecks = updateChecks;
  title.addEventListener("input", updateChecks);
  whenBox.addEventListener("change", updateChecks);
  whenBox.addEventListener("input", updateChecks);
  account.addEventListener("change", () => { renderMonetization(monetBox, account.value); loadSugg(); placeOnFreeDay(); });

  const back = h("button", { type: "button", class: "btn ghost", onclick: async () => {
    try { await api("POST", `/api/jobs/${job.id}/back`); await pollJobs(); } catch (e) { toast(e.message, "err"); }
  } }, "← Modifier le découpage");

  const form = h("form", { class: "publish" },
    h("h3", {}, "Détails de la mise en ligne"),
    counted("Titre", title, 100, titleAlt),
    counted("Description et hashtags (repris de la vidéo d'origine)", desc.el, 5000),
    suggBox,
    h("label", { class: "field" }, h("span", {}, "Compte YouTube"), account),
    h("div", { class: "field" }, h("span", { class: "lbl" }, "Publication"), seg),
    whenBox, privBox,
    checksBox,
    monetBox,
    h("div", { class: "row between sticky-actions" }, back, submit),
  );

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!account.value) { toast("Ajoute d'abord un compte YouTube (menu en haut à droite).", "err"); return; }
    const body = {
      channel_id: account.value, title: title.value.trim(), description: desc.el.value.trim(),
      hashtags: desc.tags().slice(0, 30), privacy: privacy.value, publish_at: null,
    };
    if (mode === "later") {
      const dt = when.get();
      if (!dt || dt <= new Date()) { toast("Choisis une date et une heure dans le futur.", "err"); return; }
      body.publish_at = dt.toISOString();
    }
    const blocking = computeChecks(card.job || job, { title: body.title, tags: body.hashtags, mode, when: when.get(), dur: finalDur() }).filter((c) => c.lvl === "bad" && c.t !== "Qualité");
    if (blocking.length) { toast(blocking[0].t + " : " + blocking[0].d, "err"); return; }
    submit.disabled = true;
    try {
      const r = await api("POST", `/api/jobs/${job.id}/publish`, body);
      toast(r.message, "ok");
      await pollJobs();
      loadPublishCalendar();
      // les autres videos en attente passent automatiquement au jour suivant
      for (const c of state.jobs.values()) if (c !== card) c.refreshFreeDay?.();
    } catch (err) {
      toast(err.message, "err");
      submit.disabled = false;
    }
  });

  updateChecks();
  renderMonetization(monetBox, account.value);
  loadSugg();
  placeOnFreeDay();
  card.refreshFreeDay = placeOnFreeDay;
  return form;
}

/* ---------- Carte d'une video ---------- */

function cardKey(j) {
  if (j.status === "done") return "done";
  if (LOADING.has(j.status) || (j.status === "error" && !j.has_preview)) return "loading";
  return j.stage;
}

const STEPS = ["Téléchargement & 4K", "Aperçu & découpage", "Mise en ligne"];
function stepsBar(key) {
  const idx = { loading: 0, preview: 1, details: 2, submitted: 2, done: 3 }[key] ?? 0;
  return h("ol", { class: "steps" }, STEPS.map((s, i) => h("li", { class: i < idx ? "done" : i === idx ? "cur" : "" }, h("span", { class: "n" }, i < idx ? "✔" : i + 1), s)));
}

function buildMain(card, j) {
  const conv = h("div", { class: "conv" });
  card.conv = conv;
  card.convSig = null;
  card.updateChecks = null;
  card.refreshAccounts = null;
  card.refreshFreeDay = null;
  const key = card.key;

  if (key === "loading") {
    return h("div", { class: "main-loading" },
      j.has_thumb ? h("img", { class: "thumb", src: `/api/jobs/${j.id}/thumb`, alt: "" }) : h("div", { class: "thumb-ph" }, "⏳"),
      h("div", { class: "grow" }, conv));
  }

  if (key === "preview") {
    const video = playerFor(j);
    const editor = trimEditor(j, video);
    const ok = h("button", { type: "button", class: "btn primary", onclick: async () => {
      ok.disabled = true;
      try { await api("POST", `/api/jobs/${j.id}/validate`, editor.get()); await pollJobs(); }
      catch (e) { toast(e.message, "err"); ok.disabled = false; }
    } }, "✔ L'aperçu me va, passer à la mise en ligne");
    return h("div", { class: "wizard" },
      h("div", { class: "media-col" }, video, editor.tl.el),
      h("div", { class: "side-col" },
        h("div", { class: "card-in" }, h("h3", {}, "Vérification 4K"), conv),
        h("div", { class: "card-in" }, editor.el),
        ok));
  }

  if (key === "details") {
    const video = playerFor(j);
    const segs = j.edit ? keepSegments(j.edit, j.duration) : [];
    attachSkipPlayback(video, () => segs);
    return h("div", { class: "wizard" },
      h("div", { class: "media-col" }, video,
        j.edit ? h("p", { class: "hint" }, `Découpée : ${fmtDur(keptDuration(segs))} gardées sur ${fmtDur(j.duration)}`) : null,
        h("div", { class: "card-in" }, h("h3", {}, "Vérification 4K"), conv)),
      h("div", { class: "side-col" }, detailsForm(j, card)));
  }

  if (key === "submitted") {
    const p = j.publish || {};
    const acc = state.accounts.find((a) => a.channel_id === p.channel_id);
    const cancel = h("button", { type: "button", class: "btn ghost", onclick: async () => {
      try { await api("POST", `/api/jobs/${j.id}/unsubmit`); await pollJobs(); } catch (e) { toast(e.message, "err"); }
    } }, "Annuler et modifier");
    card.cancelBtn = cancel;
    return h("div", { class: "main-loading" },
      j.has_thumb ? h("img", { class: "thumb", src: `/api/jobs/${j.id}/thumb`, alt: "" }) : h("div", { class: "thumb-ph" }, "🎬"),
      h("div", { class: "grow" },
        h("h3", {}, p.title || ""),
        h("p", { class: "hint" }, `${acc ? acc.title : "Compte"} · ${p.publish_at ? "programmée " + dateTimeFmt.format(new Date(p.publish_at)) : "mise en ligne immédiate"}`),
        conv,
        h("p", { class: "hint" }, "L'envoi vers YouTube démarre automatiquement dès que la vidéo 4K est prête."),
        cancel));
  }

  // done
  const p = j.publish || {};
  const acc = state.accounts.find((a) => a.channel_id === p.channel_id);
  return h("div", { class: "main-loading" },
    j.has_thumb ? h("img", { class: "thumb sm", src: `/api/jobs/${j.id}/thumb`, alt: "" }) : null,
    h("div", { class: "grow" },
      h("h3", {}, p.title || ""),
      h("p", { class: "ok-txt" }, "✔ " + j.message + (acc ? " · " + acc.title : "")),
      h("div", { class: "row" },
        j.youtube_id ? h("button", { type: "button", class: "btn", onclick: () => {
          if (acc && acc.channel_id !== state.active) setActive(acc.channel_id);
          location.hash = `#video/${j.youtube_id}`;
        } }, "📊 Détails et statistiques") : null,
        j.youtube_id ? extLink(`https://youtu.be/${encodeURIComponent(j.youtube_id)}`, "Voir sur YouTube ↗", "btn") : null,
      )));
}

function renderJob(j) {
  let card = state.jobs.get(j.id);
  if (!card) {
    const del = h("button", { type: "button", class: "icon-btn", title: "Retirer de la liste" }, "✕");
    const badge = h("span", { class: "badge" });
    const src = h("a", { class: "src", target: "_blank", rel: "noopener noreferrer" });
    const stepsSlot = h("div", {});
    const main = h("div", { class: "job-main" });
    const el = h("article", { class: "job" }, h("div", { class: "job-head" }, badge, src, del), stepsSlot, main);
    card = { el, badge, src, del, stepsSlot, main, key: null, job: j };
    del.addEventListener("click", async () => {
      const done = card.job.status === "done";
      if (!confirm(done ? "Retirer cette carte ? (la vidéo reste en ligne sur YouTube)" : "Abandonner cette vidéo et supprimer ses fichiers locaux ?")) return;
      try { await api("DELETE", `/api/jobs/${j.id}`); el.remove(); state.jobs.delete(j.id); updateEmpty(); }
      catch (e) { toast(e.message, "err"); }
    });
    state.jobs.set(j.id, card);
  }
  card.job = j;
  card.el.className = "job st-" + j.status + " k-" + cardKey(j);
  card.badge.textContent = STATUS_LABEL[j.status] || j.status;
  card.badge.className = "badge b-" + j.status;
  card.src.textContent = (j.platform ? j.platform + " · " : "") + j.url;
  if (/^https?:\/\//.test(j.url)) card.src.href = j.url;
  card.del.disabled = ["queued", "downloading", "preparing", "uploading"].includes(j.status);

  const key = cardKey(j);
  if (card.key !== key) {
    if (card.key && key === "done" && j.publish) {
      // la video vient d'etre mise en ligne : on rafraichit le calendrier du compte
      invalidateVideos(j.publish.channel_id);
      setTimeout(() => loadPublishCalendar(true), 0);
    }
    card.key = key;
    card.stepsSlot.replaceChildren(stepsBar(key));
    try {
      card.main.replaceChildren(buildMain(card, j));
    } catch (e) {
      card.key = null;              // on retentera au prochain rafraichissement
      throw e;
    }
  }
  const sig = convSignature(j);
  if (card.conv && card.convSig !== sig) {
    card.convSig = sig;
    renderConv(card.conv, j);
    card.updateChecks?.();
    if (card.cancelBtn) card.cancelBtn.disabled = j.status === "uploading";
  }
  return card.el;
}

function updateEmpty() {
  $("#jobsEmpty").classList.toggle("hidden", state.jobs.size > 0);
}

let pollTimer;
async function pollJobs() {
  clearTimeout(pollTimer);
  let busy = false;
  try {
    const jobs = await api("GET", "/api/jobs");
    const container = $("#jobs");
    const seen = new Set();
    jobs.forEach((j, i) => {
      seen.add(j.id);
      const el = renderJob(j);
      if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
      if (BUSY.has(j.status)) busy = true;
    });
    for (const [id, c] of state.jobs) if (!seen.has(id)) { c.el.remove(); state.jobs.delete(id); }
    updateEmpty();
  } catch (e) {
    console.warn(e);
  }
  pollTimer = setTimeout(pollJobs, busy ? 1500 : 5000);
}
