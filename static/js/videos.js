"use strict";

/* =====================================================================
   VIDEOS EN LIGNE : liste, programmation, modification, suppression, stats
   ===================================================================== */

let videoFilter = "all";
let videosCache = { cid: null, list: [] };
let videosSeq = 0;

for (const b of document.querySelectorAll("#videoFilter button")) {
  b.addEventListener("click", () => {
    videoFilter = b.dataset.f;
    for (const x of document.querySelectorAll("#videoFilter button")) x.classList.toggle("on", x === b);
    drawVideos();
  });
}
$("#videosRefresh").addEventListener("click", () => reloadVideos());

const REJECTION = {
  claim: "revendication de droits d'auteur", copyright: "atteinte aux droits d'auteur", duplicate: "vidéo en double",
  inappropriate: "contenu inapproprié", legal: "problème juridique", length: "vidéo trop longue",
  termsOfUse: "non-respect des conditions d'utilisation", trademark: "atteinte à une marque", uploaderAccountClosed: "compte fermé",
  uploaderAccountSuspended: "compte suspendu",
};

function videoState(v) {
  if (v.upload_status === "rejected") return { cls: "bad", label: "Refusée", detail: "Refusée par YouTube : " + (REJECTION[v.rejection] || v.rejection || "raison inconnue") };
  if (v.upload_status === "failed") return { cls: "bad", label: "Échec", detail: "Échec du traitement : " + (v.failure || "raison inconnue") };
  if (v.upload_status === "uploaded") return { cls: "wait", label: "En traitement", detail: "YouTube traite encore la vidéo" };
  if (v.publish_at && v.privacy === "private") return { cls: "sched", label: "Programmée", detail: "Mise en ligne " + dateTimeFmt.format(new Date(v.publish_at)) };
  if (v.privacy === "public") return { cls: "pub", label: "Publique", detail: "Publiée " + dateTimeFmt.format(new Date(v.published)) };
  if (v.privacy === "unlisted") return { cls: "other", label: "Non répertoriée", detail: "Accessible seulement avec le lien" };
  return { cls: "other", label: "Privée", detail: "Visible seulement par toi" };
}

// Miniature ; les videos privees/programmees n'ont pas de miniature publique : on met un visuel neutre.
function thumbImg(url, cls = "") {
  const ph = () => h("div", { class: "thumb-ph " + cls }, "🎬");
  if (!safeGoogleImg(url)) return ph();
  const img = h("img", { src: url, alt: "", class: cls });
  img.addEventListener("error", () => img.replaceWith(ph()), { once: true });
  return img;
}

function videoProblems(v) {
  const out = [];
  if (v.blocked && v.blocked.length) out.push(`⚠ Bloquée dans ${v.blocked.length} pays (droits d'auteur probables)`);
  if (v.allowed) out.push(`⚠ Visible seulement dans ${v.allowed.length} pays`);
  if (v.made_for_kids) out.push("ℹ Marquée « conçue pour les enfants » : pas de commentaires ni de pubs personnalisées");
  return out;
}

async function loadVideos(force = false) {
  const body = $("#videosBody");
  const acc = activeAccount();
  if (!acc) return needAccount(body);
  $("#videosTitle").textContent = "Vidéos en ligne · " + acc.title;
  const seq = ++videosSeq;
  if (videosCache.cid !== acc.channel_id) body.replaceChildren(h("p", { class: "empty" }, "Chargement des vidéos…"));
  try {
    const list = await getChannelVideos(acc.channel_id, force);
    if (seq !== videosSeq) return;
    videosCache = { cid: acc.channel_id, list };
    drawVideos();
  } catch (e) {
    if (seq === videosSeq) body.replaceChildren(h("p", { class: "note" }, e.message));
  }
}

// Apres une modification : on recharge depuis YouTube (et le calendrier de la page Publier suivra).
function reloadVideos() {
  invalidateVideos(videosCache.cid);
  loadVideos(true);
}

function drawVideos() {
  const body = $("#videosBody");
  const all = videosCache.list;
  const f = {
    all: () => true,
    scheduled: (v) => v.publish_at && v.privacy === "private",
    public: (v) => v.privacy === "public",
    other: (v) => v.privacy !== "public" && !(v.publish_at && v.privacy === "private"),
  }[videoFilter];
  const list = all.filter(f);
  const counts = { sched: all.filter((v) => v.publish_at && v.privacy === "private").length, pub: all.filter((v) => v.privacy === "public").length };

  const calBox = h("div", {});
  const drawCal = () => calBox.replaceChildren(performanceCalendar(all, videosCache.cid, drawCal));
  drawCal();

  body.replaceChildren(
    calBox,
    insightsCharts(all),
    h("h3", { class: "mt" }, "Toutes les vidéos"),
    h("p", { class: "hint" }, `${all.length} vidéo(s) · ${counts.pub} publique(s) · ${counts.sched} programmée(s) · compteurs de vues en direct`),
    list.length ? h("div", { class: "vlist" }, list.map(videoRow))
      : h("p", { class: "empty" }, all.length ? "Aucune vidéo dans ce filtre." : "Aucune vidéo sur cette chaîne pour l'instant."),
  );
}

function videoRow(v) {
  const st = videoState(v);
  const cid = videosCache.cid;
  const editSlot = h("div", { class: "v-edit" });
  const problems = videoProblems(v);

  const actions = [];
  actions.push(h("button", { type: "button", class: "btn sm", onclick: () => { location.hash = `#video/${v.id}`; } }, "📊 Statistiques"));
  if (st.cls === "sched") {
    actions.push(h("button", { type: "button", class: "btn sm", onclick: () => toggleEdit(editSlot, scheduleEditor(v)) }, "🗓 Changer la date"));
    actions.push(h("button", { type: "button", class: "btn sm", onclick: () => publishNow(v) }, "⚡ Publier maintenant"));
  } else if (v.privacy !== "public" && v.upload_status === "processed") {
    actions.push(h("button", { type: "button", class: "btn sm", onclick: () => toggleEdit(editSlot, scheduleEditor(v)) }, "🗓 Programmer"));
    actions.push(h("button", { type: "button", class: "btn sm", onclick: () => publishNow(v) }, "⚡ Rendre publique"));
  }
  actions.push(h("button", { type: "button", class: "btn sm", onclick: () => toggleEdit(editSlot, metaEditor(v)) }, "✎ Modifier"));
  actions.push(h("button", { type: "button", class: "btn sm danger", onclick: () => deleteVideo(v) }, "🗑 Supprimer"));

  return h("article", { class: "vrow" },
    h("a", { href: `#video/${v.id}`, class: "vthumb" }, thumbImg(v.thumb),
      v.duration ? h("span", { class: "vdur" }, v.duration <= 180 ? "Short" : fmtDur(v.duration)) : null),
    h("div", { class: "vinfo" },
      h("a", { href: `#video/${v.id}`, class: "vtitle" }, v.title),
      h("div", { class: "row" }, h("span", { class: "pill p-" + st.cls }, st.label), h("span", { class: "hint" }, st.detail)),
      problems.length ? h("div", { class: "warn-txt small" }, problems.join(" · ")) : null,
      h("div", { class: "vstats" },
        h("span", {}, "👁 ", nf.format(v.views)), h("span", {}, "👍 ", nf.format(v.likes)), h("span", {}, "💬 ", nf.format(v.comments))),
      h("div", { class: "row vactions" }, actions,
        extLink(`https://studio.youtube.com/video/${encodeURIComponent(v.id)}/edit`, "Studio ↗", "btn sm ghost")),
      editSlot),
  );

  function toggleEdit(slot, content) {
    if (slot.firstChild && slot.dataset.kind === content.dataset.kind) { slot.replaceChildren(); slot.dataset.kind = ""; return; }
    slot.dataset.kind = content.dataset.kind;
    slot.replaceChildren(content);
  }

  function scheduleEditor(video) {
    const initial = video.publish_at ? new Date(video.publish_at) : defaultPublishDate();
    const dt = dateTimeField(initial);
    const save = h("button", { type: "submit", class: "btn primary sm" }, "Enregistrer la date");
    const form = h("form", { class: "inline-form", "data-kind": "sched" }, h("span", {}, "Mettre en ligne le"), dt.el, save);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = dt.get();
      if (!d || d <= new Date()) { toast("Choisis une date dans le futur.", "err"); return; }
      save.disabled = true;
      try {
        await api("PATCH", `/api/videos/${cid}/${video.id}`, { publish_at: d.toISOString() });
        toast("Programmée " + dateTimeFmt.format(d) + " ✔", "ok");
        reloadVideos();
      } catch (err) { toast(err.message, "err"); save.disabled = false; }
    });
    return form;
  }

  function metaEditor(video) {
    const title = h("input", { type: "text", value: video.title, maxLength: 100 });
    const desc = h("textarea", { value: video.description, maxLength: 5000, rows: 4 });
    const tags = h("input", { type: "text", value: (video.tags || []).join(", "), placeholder: "tags séparés par des virgules" });
    const vis = h("select", {},
      h("option", { value: "" }, "Ne pas changer"),
      h("option", { value: "public" }, "Publique"),
      h("option", { value: "unlisted" }, "Non répertoriée"),
      h("option", { value: "private" }, "Privée"));
    const save = h("button", { type: "submit", class: "btn primary sm" }, "Enregistrer");
    const form = h("form", { class: "meta-form", "data-kind": "meta" },
      counted("Titre", title, 100), counted("Description", desc, 5000),
      h("label", { class: "field" }, h("span", {}, "Tags"), tags),
      h("label", { class: "field" }, h("span", {}, "Visibilité" + (video.publish_at && video.privacy === "private" ? " (changer annule la programmation)" : "")), vis),
      save);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = {
        title: title.value.trim(), description: desc.value,
        tags: tags.value.split(",").map((t) => t.trim().replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "")).filter(Boolean),
      };
      if (vis.value) body.privacy = vis.value;
      save.disabled = true;
      try { await api("PATCH", `/api/videos/${cid}/${video.id}`, body); toast("Vidéo mise à jour ✔", "ok"); reloadVideos(); }
      catch (err) { toast(err.message, "err"); save.disabled = false; }
    });
    return form;
  }
}

async function publishNow(v) {
  if (!confirm(`Rendre « ${v.title} » publique maintenant ?`)) return;
  try { await api("PATCH", `/api/videos/${videosCache.cid}/${v.id}`, { privacy: "public" }); toast("Vidéo publiée ✔", "ok"); reloadVideos(); }
  catch (e) { toast(e.message, "err"); }
}

async function deleteVideo(v) {
  if (!confirm(`Supprimer DÉFINITIVEMENT « ${v.title} » de YouTube ?\n\nLes vues, commentaires et revenus associés seront perdus. Impossible d'annuler.`)) return;
  try { await api("DELETE", `/api/videos/${videosCache.cid}/${v.id}`); toast("Vidéo supprimée", "ok"); reloadVideos(); }
  catch (e) { toast(e.message, "err"); }
}

/* ---------- Statistiques d'une video ---------- */

const TRAFFIC = {
  SHORTS: "Flux Shorts", RELATED_VIDEO: "Vidéos suggérées", YT_SEARCH: "Recherche YouTube", SUBSCRIBER: "Flux abonnements",
  YT_CHANNEL: "Page de la chaîne", EXT_URL: "Sites externes", NO_LINK_OTHER: "Accès direct / inconnu", NOTIFICATION: "Notifications",
  PLAYLIST: "Playlists", YT_PLAYLIST_PAGE: "Pages de playlist", YT_OTHER_PAGE: "Autres pages YouTube", HASHTAGS: "Pages hashtag",
  SOUND_PAGE: "Pages de sons", END_SCREEN: "Écrans de fin", ADVERTISING: "Publicité", NO_LINK_EMBEDDED: "Lecteurs intégrés",
  VIDEO_REMIXES: "Remix", ANNOTATION: "Fiches", CAMPAIGN_CARD: "Fiches de campagne", LIVE_REDIRECT: "Redirection live",
  PRODUCT_PAGE: "Pages produit", PROMOTED: "Promotion", SHORTS_CONTENT_LINKS: "Liens depuis des Shorts",
};
let videoDays = 0;
let videoSeq = 0;

async function loadVideoDetail(vid) {
  const body = $("#videoBody");
  const acc = activeAccount();
  if (!acc) return needAccount(body);
  if (!/^[\w-]{11}$/.test(vid || "")) { body.replaceChildren(h("p", { class: "note" }, "Vidéo introuvable.")); return; }
  const seq = ++videoSeq;
  body.replaceChildren(h("p", { class: "empty" }, "Chargement des statistiques de la vidéo…"));
  let s;
  try { s = await api("GET", `/api/videos/${acc.channel_id}/${vid}/stats?days=${videoDays}`); }
  catch (e) { if (seq === videoSeq) body.replaceChildren(h("a", { href: "#videos" }, "← Vidéos en ligne"), h("p", { class: "note" }, e.message)); return; }
  if (seq !== videoSeq) return;

  const v = s.video, t = s.totals || {}, st = videoState(v);
  const kpi = (label, val, sub) => h("div", { class: "kpi" }, h("div", { class: "k-label" }, label), h("div", { class: "k-val" }, val), sub ? h("div", { class: "k-sub" }, sub) : null);
  const per = videoDays ? `sur ${videoDays} jours` : "depuis la mise en ligne";
  const num = (k) => (t[k] === undefined ? "—" : nf.format(Math.round(t[k])));

  const periods = h("div", { class: "seg" }, [[0, "Depuis la mise en ligne"], [7, "7 j"], [28, "28 j"], [90, "90 j"], [365, "1 an"]].map(([d, l]) =>
    h("button", { type: "button", class: d === videoDays ? "on" : "", onclick: () => { videoDays = d; loadVideoDetail(vid); } }, l)));

  const problems = [st.detail, ...videoProblems(v)];
  const charts = h("div", { class: "charts" });
  const parts = [
    h("a", { href: "#videos", class: "back" }, "← Vidéos en ligne"),
    h("div", { class: "vhead" },
      thumbImg(v.thumb, "vhead-img"),
      h("div", { class: "grow" },
        h("h2", {}, v.title),
        h("div", { class: "row" }, h("span", { class: "pill p-" + st.cls }, st.label), h("span", { class: "hint" }, problems.join(" · "))),
        h("div", { class: "row mt-s" },
          extLink(`https://youtu.be/${encodeURIComponent(v.id)}`, "Voir sur YouTube ↗", "btn sm"),
          extLink(`https://studio.youtube.com/video/${encodeURIComponent(v.id)}/analytics`, "Analytics Studio ↗", "btn sm ghost")))),
    h("div", { class: "row between mt" }, h("h3", {}, "Statistiques"), periods),
    h("div", { class: "kpis" },
      kpi("Vues", nf.format(v.views), "compteur en direct"),
      kpi("Vues (Analytics)", num("views"), per),
      kpi("Durée moyenne regardée", t.averageViewDuration === undefined ? "—" : fmtDur(t.averageViewDuration), v.duration ? `sur ${fmtDur(v.duration)}` : ""),
      kpi("% moyen regardé", t.averageViewPercentage === undefined ? "—" : Math.round(t.averageViewPercentage) + " %", "rétention"),
      kpi("Heures regardées", t.estimatedMinutesWatched === undefined ? "—" : nf.format(Math.round(t.estimatedMinutesWatched / 6) / 10), per),
      kpi("J'aime", nf.format(v.likes), "en direct"),
      kpi("Commentaires", nf.format(v.comments), "en direct"),
      kpi("Partages", num("shares"), per),
      kpi("Abonnés gagnés", num("subscribersGained"), per),
      kpi("Revenus estimés", s.revenue_available && t.estimatedRevenue !== undefined ? eur.format(t.estimatedRevenue) : "—", per),
    ),
    h("p", { class: "hint" }, "« en direct » = identique au compteur YouTube. Les autres chiffres viennent de YouTube Analytics (2 à 3 jours de retard)."),
  ];
  if (s.series.length) parts.push(charts);
  else parts.push(h("p", { class: "empty" }, "Pas encore de données Analytics pour cette vidéo (2 à 3 jours de retard)."));

  const totalTraffic = s.traffic.reduce((a, r) => a + r.views, 0);
  if (s.traffic.length) {
    parts.push(h("h3", { class: "mt" }, "D'où viennent les vues"), h("div", { class: "sources" }, s.traffic.map((r) => {
      const pct = totalTraffic ? (r.views / totalTraffic) * 100 : 0;
      const bar = h("div", { class: "bar" });
      bar.style.width = Math.max(1, pct) + "%";
      return h("div", { class: "src-row" },
        h("div", { class: "row between" }, h("span", {}, TRAFFIC[r.insightTrafficSourceType] || r.insightTrafficSourceType), h("span", { class: "hint" }, `${nf.format(r.views)} · ${pct.toFixed(1)} %`)),
        h("div", { class: "progress" }, bar));
    })));
  }
  if (s.countries.length) {
    const regions = new Intl.DisplayNames(["fr"], { type: "region" });
    parts.push(h("h3", { class: "mt" }, "Pays"), h("table", { class: "top" },
      h("tbody", {}, s.countries.map((r) => h("tr", {}, h("td", {}, (() => { try { return regions.of(r.country); } catch { return r.country; } })()), h("td", { class: "num" }, nf.format(r.views)))))));
  }
  body.replaceChildren(...parts);

  if (s.series.length) {
    const pts = (fn) => s.series.map((r) => ({ d: r.day, v: fn(r) }));
    lineChart(charts, "Vues par jour", `${num("views")} vues ${per}`, pts((r) => r.views), (x) => nf.format(x));
    lineChart(charts, "Abonnés gagnés par jour", `${num("subscribersGained")} ${per}`, pts((r) => r.subscribersGained), (x) => nf.format(x));
  }
}
