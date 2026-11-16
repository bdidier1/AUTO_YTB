"use strict";

/* =====================================================================
   Calendrier mensuel reutilisable
   dayInfo(key, date) -> { cls, label, tip, items } (ou null pour un jour vide)
   ===================================================================== */

const MONTH_FMT = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });
const WEEKDAYS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];

function monthCalendar({ month, dayInfo, onMonth, onDay, legend }) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;              // semaine commencant le lundi
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const todayKey = dayKey(new Date());

  const cells = [];
  for (let i = 0; i < offset; i++) cells.push(h("div", { class: "cal-cell cal-out" }));
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(month.getFullYear(), month.getMonth(), d);
    const key = dayKey(date);
    const info = dayInfo(key, date) || { cls: "cal-none" };
    const cell = h("button", {
      type: "button", class: `cal-cell ${info.cls}${key === todayKey ? " cal-today" : ""}`,
      title: info.tip || "", onclick: () => onDay && onDay(key, date, info),
    }, h("span", { class: "cal-num" }, d), info.label ? h("span", { class: "cal-lbl" }, info.label) : null);
    cells.push(cell);
  }
  const nav = (delta) => () => onMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1));
  const title = MONTH_FMT.format(month);
  return h("div", { class: "cal" },
    h("div", { class: "cal-head" },
      h("button", { type: "button", class: "icon-btn", title: "Mois précédent", onclick: nav(-1) }, "‹"),
      h("strong", {}, title.charAt(0).toUpperCase() + title.slice(1)),
      h("button", { type: "button", class: "icon-btn", title: "Mois suivant", onclick: nav(1) }, "›"),
      h("button", { type: "button", class: "btn sm ghost", onclick: () => onMonth(new Date()) }, "Aujourd'hui")),
    h("div", { class: "cal-grid" }, WEEKDAYS.map((w) => h("div", { class: "cal-wd" }, w)), cells),
    legend ? h("div", { class: "cal-legend" }, legend.map(([cls, txt]) => h("span", {}, h("i", { class: "cal-sw " + cls }), txt))) : null,
  );
}

/* ---------- Page Publier : calendrier publiees / programmees ---------- */

let pubMonth = new Date();
let pubCalSeq = 0;
let pubSelected = null;

async function loadPublishCalendar(force = false) {
  const box = $("#pubCalendar");
  const acc = activeAccount();
  if (!acc) { box.replaceChildren(); return; }
  const seq = ++pubCalSeq;
  if (!box.firstChild) box.replaceChildren(h("p", { class: "hint" }, "Chargement du calendrier…"));
  let videos;
  try { videos = await getChannelVideos(acc.channel_id, force); }
  catch (e) { if (seq === pubCalSeq) box.replaceChildren(h("p", { class: "hint" }, "Calendrier indisponible : " + e.message)); return; }
  if (seq !== pubCalSeq) return;
  const days = busyDays(videos, acc.channel_id);
  const free = firstFreeSlot(days);

  const details = h("div", { class: "cal-details" });
  const showDay = (key) => {
    pubSelected = key;
    const d = days.get(key);
    const label = new Date(key + "T12:00:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
    if (!d) { details.replaceChildren(h("p", { class: "hint" }, `${label} : rien de publié ni de programmé.`)); return; }
    const row = (it, kind) => h("li", {}, h("span", { class: "pill " + (kind === "pub" ? "p-pub" : "p-sched") }, kind === "pub" ? "Publiée" : "Programmée"),
      " ", new Date(it.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }), " · ",
      it.id ? h("a", { href: `#video/${it.id}` }, it.title) : it.title,
      kind === "pub" && it.views !== undefined ? h("span", { class: "hint" }, ` · ${nf.format(it.views)} vues`) : null);
    details.replaceChildren(h("strong", {}, label), h("ul", { class: "cal-list" }, d.pub.map((it) => row(it, "pub")), d.sched.map((it) => row(it, "sched"))));
  };

  box.replaceChildren(
    h("div", { class: "row between" },
      h("h3", {}, `Calendrier · ${acc.title}`),
      h("span", { class: "hint" }, "Prochaine date proposée : ", h("strong", {}, dateTimeFmt.format(free)))),
    monthCalendar({
      month: pubMonth,
      onMonth: (m) => { pubMonth = m; loadPublishCalendar(); },
      onDay: (key) => showDay(key),
      dayInfo: (key) => {
        const d = days.get(key);
        if (!d) return null;
        const n = d.pub.length + d.sched.length;
        const cls = d.pub.length && d.sched.length ? "cal-both" : d.pub.length ? "cal-pub" : "cal-sched";
        const tip = [...d.pub.map((x) => "✔ " + x.title), ...d.sched.map((x) => "🕓 " + x.title)].join("\n");
        return { cls, label: n > 1 ? `${n} vidéos` : d.pub.length ? "publiée" : "programmée", tip };
      },
      legend: [["cal-pub", "Publiée"], ["cal-sched", "Programmée"], ["cal-none", "Rien"]],
    }),
    details,
  );
  if (pubSelected) showDay(pubSelected);
}

/* ---------- Videos en ligne : calendrier de performance ---------- */

let perfMonth = new Date();

// Niveau de performance : vues des videos du jour comparees a la mediane de la chaine.
function perfLevel(ratio) {
  if (ratio >= 2) return 5;
  if (ratio >= 1.25) return 4;
  if (ratio > 0.8) return 3;
  if (ratio > 0.4) return 2;
  return 1;
}
const fmtRatio = (r, d = 1) => r.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
const PERF_LABEL = { 1: "Très en dessous", 2: "En dessous", 3: "Dans la moyenne", 4: "Au-dessus", 5: "Très au-dessus" };

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function performanceCalendar(videos, cid, rerender) {
  const pub = videos.filter((v) => v.privacy === "public");
  const med = median(pub.map((v) => v.views)) || 1;
  const days = busyDays(videos, cid);
  return h("div", { class: "card" },
    h("div", { class: "row between" }, h("h3", {}, "Performance par jour de publication"),
      h("span", { class: "hint" }, `Comparée à la médiane de la chaîne : ${nf.format(Math.round(med))} vues par vidéo`)),
    monthCalendar({
      month: perfMonth,
      onMonth: (m) => { perfMonth = m; rerender(); },
      onDay: (key) => {
        const d = days.get(key);
        const first = d && (d.pub[0] || d.sched[0]);
        if (first && first.id) location.hash = `#video/${first.id}`;
      },
      dayInfo: (key) => {
        const d = days.get(key);
        if (!d) return null;
        if (!d.pub.length) return { cls: "cal-sched", label: "programmée", tip: d.sched.map((x) => "🕓 " + x.title).join("\n") };
        const views = d.pub.reduce((t, x) => t + (x.views || 0), 0) / d.pub.length;
        const ratio = views / med;
        const lvl = perfLevel(ratio);
        return {
          cls: "perf-" + lvl,
          label: `${nfCompact.format(views)} · ×${fmtRatio(ratio)}`,
          tip: `${PERF_LABEL[lvl]} (×${fmtRatio(ratio, 2)} la médiane)\n` + d.pub.map((x) => `${x.title} : ${nf.format(x.views)} vues`).join("\n"),
        };
      },
      legend: [["perf-1", PERF_LABEL[1]], ["perf-2", PERF_LABEL[2]], ["perf-3", PERF_LABEL[3]], ["perf-4", PERF_LABEL[4]], ["perf-5", PERF_LABEL[5]], ["cal-sched", "Programmée"]],
    }),
    h("p", { class: "hint" }, "Chaque case affiche les vues en direct des vidéos du jour et le rapport à la médiane (×1,0 = vidéo typique de ta chaîne). Une vidéo récente a forcément moins de vues : compare-la plutôt après quelques jours."),
  );
}

/* ---------- Videos en ligne : statistiques par hashtag / type ---------- */

function videoHashtags(v) {
  const tags = hashtagsIn(`${v.title}\n${v.description}`);
  return tags.length ? tags : (v.tags || []);
}

function barChart(title, subtitle, rows, fmt) {
  // rows : [{ label, value, n }] ; une seule serie -> une seule couleur, valeurs ecrites en clair.
  const max = Math.max(...rows.map((r) => r.value), 1);
  return h("div", { class: "chart-card" },
    h("h3", {}, title), h("div", { class: "c-total" }, subtitle),
    rows.length ? h("div", { class: "bars" }, rows.map((r) => {
      const fill = h("div", { class: "bar-fill" });
      fill.style.width = Math.max(1, (r.value / max) * 100) + "%";
      return h("div", { class: "bar-row", title: `${r.label} : ${fmt(r.value)} en moyenne sur ${r.n} vidéo(s)` },
        h("span", { class: "bar-lbl" }, r.label),
        h("div", { class: "bar-track" }, fill),
        h("span", { class: "bar-val" }, fmt(r.value), h("span", { class: "hint" }, ` · ${r.n}`)));
    })) : h("p", { class: "hint" }, "Pas encore assez de vidéos publiques."));
}

function groupAvg(videos, keysOf) {
  const g = new Map();
  for (const v of videos) {
    for (const k of keysOf(v)) {
      const e = g.get(k) || { label: k, sum: 0, n: 0 };
      e.sum += v.views;
      e.n += 1;
      g.set(k, e);
    }
  }
  return [...g.values()].map((e) => ({ label: e.label, value: e.sum / e.n, n: e.n }));
}

function insightsCharts(videos) {
  const pub = videos.filter((v) => v.privacy === "public");
  const fmt = (x) => nfCompact.format(Math.round(x));
  const byTag = groupAvg(pub, (v) => videoHashtags(v).map((t) => "#" + t.toLowerCase()))
    .sort((a, b) => b.value - a.value).slice(0, 10);
  const byFormat = groupAvg(pub, (v) => [v.duration && v.duration > 180 ? "Vidéo longue" : "Short"]);
  const BUCKETS = [[15, "< 15 s"], [30, "15-30 s"], [60, "30-60 s"], [180, "1-3 min"], [Infinity, "> 3 min"]];
  const byDur = groupAvg(pub, (v) => [BUCKETS.find(([max]) => (v.duration || 0) < max)[1]])
    .sort((a, b) => BUCKETS.findIndex((x) => x[1] === a.label) - BUCKETS.findIndex((x) => x[1] === b.label));
  const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
  const byDay = groupAvg(pub, (v) => [DAYS[(new Date(v.published).getDay() + 6) % 7]])
    .sort((a, b) => DAYS.indexOf(a.label) - DAYS.indexOf(b.label));
  const byHour = groupAvg(pub, (v) => [`${pad2(new Date(v.published).getHours())}h`])
    .sort((a, b) => a.label.localeCompare(b.label));
  return h("div", {},
    h("h3", { class: "mt" }, "Ce qui marche le mieux"),
    h("p", { class: "hint" }, `Vues moyennes par vidéo (compteurs en direct), sur ${pub.length} vidéo(s) publique(s). Le chiffre après le point = nombre de vidéos.`),
    h("div", { class: "charts" },
      barChart("Par hashtag", "Top 10 des hashtags par vues moyennes", byTag, fmt),
      barChart("Par type de vidéo", "Short (3 min max) ou vidéo longue", byFormat, fmt),
      barChart("Par durée", "Durée de la vidéo", byDur, fmt),
      barChart("Par jour de publication", "Jour de mise en ligne", byDay, fmt),
      barChart("Par heure de publication", "Heure de mise en ligne", byHour, fmt),
    ));
}
