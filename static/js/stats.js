"use strict";

/* ---------- Statistiques ---------- */

for (const b of document.querySelectorAll("#periodSeg button")) {
  b.addEventListener("click", () => {
    state.days = Number(b.dataset.days);
    for (const x of document.querySelectorAll("#periodSeg button")) x.classList.toggle("on", x === b);
    loadStats();
  });
}

function needAccount(container) {
  container.replaceChildren(h("div", { class: "empty" }, "Connecte un compte YouTube pour voir cette page. ",
    h("a", { href: "#comptes" }, "Aller aux comptes")));
}

let statsSeq = 0;
async function loadStats() {
  const body = $("#statsBody");
  const acc = activeAccount();
  if (!acc) return needAccount(body);
  $("#statsTitle").textContent = "Statistiques · " + acc.title;
  const seq = ++statsSeq;
  body.replaceChildren(h("p", { class: "empty" }, "Chargement des statistiques..."));
  let s;
  try {
    s = await api("GET", `/api/stats/${acc.channel_id}?days=${state.days}`);
  } catch (e) {
    if (seq === statsSeq) body.replaceChildren(h("p", { class: "note" }, e.message));
    return;
  }
  if (seq !== statsSeq) return;

  const series = s.series;
  const sum = (k) => series.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const netSubs = sum("subscribersGained") - sum("subscribersLost");
  const kpi = (label, val, sub) => h("div", { class: "kpi" }, h("div", { class: "k-label" }, label), h("div", { class: "k-val" }, val), sub ? h("div", { class: "k-sub" }, sub) : null);
  const per = `sur ${state.days} jours`;

  const kpis = h("div", { class: "kpis" },
    kpi("Abonnés", s.totals.subscribers === null ? "masqué" : nf.format(s.totals.subscribers), "total"),
    kpi("Vues totales", nf.format(s.totals.views), `en direct · ${nf.format(s.totals.videos)} vidéos publiques`),
    kpi("Vues", nf.format(sum("views")), per),
    kpi("Heures regardées", nf.format(Math.round(sum("estimatedMinutesWatched") / 60)), per),
    kpi("Abonnés gagnés", (netSubs > 0 ? "+" : "") + nf.format(netSubs), per),
    kpi("J'aime", nf.format(sum("likes")), per),
    kpi("Revenus estimés", s.revenue_available ? eur.format(sum("estimatedRevenue")) : "—", s.revenue_available ? per : "non disponible"),
  );

  const charts = h("div", { class: "charts" });
  const PRIV = { public: "Publique", unlisted: "Non répertoriée", private: "Privée" };
  const recent = s.recent && s.recent.length ? [
    h("h2", {}, "Dernières vidéos"),
    h("p", { class: "hint" }, "Compteurs en direct, identiques à ceux affichés sur YouTube."),
    h("table", { class: "top" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Vidéo"), h("th", {}, "Visibilité"), h("th", { class: "num" }, "Vues"), h("th", { class: "num" }, "J'aime"), h("th", { class: "num" }, "Commentaires"))),
      h("tbody", {}, s.recent.map((v) => h("tr", {},
        h("td", {}, safeGoogleImg(v.thumb) ? h("img", { src: v.thumb, alt: "" }) : ""),
        h("td", {}, h("a", { href: `https://youtu.be/${encodeURIComponent(v.id)}`, target: "_blank", rel: "noopener noreferrer" }, v.title),
          h("div", { class: "hint" }, v.published ? new Date(v.published).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "")),
        h("td", {}, PRIV[v.privacy] || v.privacy),
        h("td", { class: "num" }, nf.format(v.views)),
        h("td", { class: "num" }, nf.format(v.likes)),
        h("td", { class: "num" }, nf.format(v.comments)),
      ))),
    ),
    h("h2", { class: "mt" }, `Évolution sur ${state.days} jours`),
    h("p", { class: "hint" }, "Graphiques et chiffres « sur " + state.days + " jours » : données YouTube Analytics, avec 2 à 3 jours de retard sur YouTube."),
  ] : [];

  const parts = [
    s.note ? h("p", { class: "note" }, s.note) : null,
    kpis,
    ...recent,
    series.length ? charts : h("p", { class: "empty" }, "Pas encore de données sur cette période (YouTube Analytics a 2 à 3 jours de retard)."),
  ];

  if (s.top.length) {
    parts.push(h("h2", { class: "mt" }, "Top vidéos de la période"));
    parts.push(h("table", { class: "top" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Vidéo"), h("th", { class: "num" }, "Vues"), h("th", { class: "num" }, "Heures"), h("th", { class: "num" }, "J'aime"))),
      h("tbody", {}, s.top.map((v) => h("tr", {},
        h("td", {}, safeGoogleImg(v.thumb) ? h("img", { src: v.thumb, alt: "" }) : ""),
        h("td", {}, h("a", { href: `https://youtu.be/${encodeURIComponent(v.id)}`, target: "_blank", rel: "noopener noreferrer" }, v.title)),
        h("td", { class: "num" }, nf.format(v.views)),
        h("td", { class: "num" }, nf.format(Math.round(v.minutes / 60))),
        h("td", { class: "num" }, nf.format(v.likes)),
      ))),
    ));
  }
  body.replaceChildren(...parts.filter(Boolean));

  if (series.length) {
    const pts = (fn) => series.map((r) => ({ d: r.day, v: fn(r) }));
    lineChart(charts, "Vues par jour", nf.format(sum("views")) + " vues " + per, pts((r) => r.views), (v) => nf.format(v));
    lineChart(charts, "Abonnés gagnés par jour (net)", (netSubs > 0 ? "+" : "") + nf.format(netSubs) + " " + per,
      pts((r) => r.subscribersGained - r.subscribersLost), (v) => (v > 0 ? "+" : "") + nf.format(v));
    if (s.revenue_available) {
      lineChart(charts, "Revenus estimés par jour", eur.format(sum("estimatedRevenue")) + " " + per,
        pts((r) => r.estimatedRevenue), (v) => eur.format(v));
    }
    lineChart(charts, "Temps de visionnage par jour", nf.format(Math.round(sum("estimatedMinutesWatched") / 60)) + " h " + per,
      pts((r) => r.estimatedMinutesWatched / 60), (v) => nf.format(Math.round(v * 10) / 10) + " h");
  }
}

const SVGNS = "http://www.w3.org/2000/svg";
function s(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const dayFmtLong = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "long", year: "numeric" });

function lineChart(container, title, total, points, fmt) {
  const card = h("div", { class: "chart-card" }, h("h3", {}, title), h("div", { class: "c-total" }, total));
  const svg = s("svg", {});
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `${title} : ${total}`);
  const tip = h("div", { class: "tip hidden" });
  card.append(svg, tip);
  container.append(card);

  function draw() {
    const W = svg.clientWidth || 480, H = 180;
    const L = 44, R = 8, T = 8, B = 22;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.replaceChildren();
    const vals = points.map((p) => Number(p.v) || 0);
    const minV = Math.min(0, ...vals);
    const maxV = niceMax(Math.max(...vals, minV < 0 ? 0 : 1));
    const lo = minV < 0 ? -niceMax(-minV) : 0;
    const x = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i / (points.length - 1)) * (W - L - R));
    const y = (v) => T + (1 - (v - lo) / (maxV - lo)) * (H - T - B);

    for (let k = 0; k <= 4; k++) {
      const v = lo + ((maxV - lo) * k) / 4;
      svg.append(s("line", { class: "grid", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      const t = s("text", { class: "axis", x: L - 6, y: y(v) + 4, "text-anchor": "end" });
      t.textContent = nfCompact.format(Math.round(v * 100) / 100);
      svg.append(t);
    }
    const idx = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
    for (const i of idx) {
      const t = s("text", { class: "axis", x: x(i), y: H - 4, "text-anchor": i === 0 ? "start" : i === points.length - 1 ? "end" : "middle" });
      t.textContent = dayFmt.format(new Date(points[i].d + "T12:00:00"));
      svg.append(t);
    }
    const d = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    svg.append(s("path", { class: "area", d: `${d}L${x(vals.length - 1)},${y(Math.max(lo, 0))}L${x(0)},${y(Math.max(lo, 0))}Z` }));
    svg.append(s("path", { class: "line", d }));

    const cross = s("line", { class: "cross", y1: T, y2: H - B, visibility: "hidden" });
    const dot = s("circle", { class: "dot", r: 5, visibility: "hidden" });
    const hit = s("rect", { x: L, y: 0, width: W - L - R, height: H, fill: "transparent" });
    svg.append(cross, dot, hit);
    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1))));
      const cx = x(i), cy = y(vals[i]);
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", cx); dot.setAttribute("cy", cy); dot.setAttribute("visibility", "visible");
      tip.replaceChildren(h("b", {}, fmt(vals[i])), dayFmtLong.format(new Date(points[i].d + "T12:00:00")));
      tip.classList.remove("hidden");
      tip.style.left = (svg.offsetLeft + (cx / W) * rect.width) + "px";
      tip.style.top = (svg.offsetTop + (cy / H) * rect.height - 6) + "px";
    };
    hit.addEventListener("mousemove", move);
    hit.addEventListener("mouseleave", () => {
      cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.classList.add("hidden");
    });
  }
  draw();
  new ResizeObserver(() => draw()).observe(card);
}

/* ---------- Profil ---------- */

const COUNTRIES = [["", "Non défini"], ["FR", "France"], ["BE", "Belgique"], ["CH", "Suisse"], ["CA", "Canada"],
  ["LU", "Luxembourg"], ["MA", "Maroc"], ["DZ", "Algérie"], ["TN", "Tunisie"], ["SN", "Sénégal"], ["CI", "Côte d'Ivoire"],
  ["US", "États-Unis"], ["GB", "Royaume-Uni"], ["DE", "Allemagne"], ["ES", "Espagne"], ["IT", "Italie"], ["PT", "Portugal"]];

let profileSeq = 0;
async function loadProfile() {
  const body = $("#profileBody");
  const acc = activeAccount();
  if (!acc) return needAccount(body);
  const seq = ++profileSeq;
  body.replaceChildren(h("p", { class: "empty" }, "Chargement du profil..."));
  let p;
  try { p = await api("GET", `/api/profile/${acc.channel_id}`); }
  catch (e) { if (seq === profileSeq) body.replaceChildren(h("p", { class: "note" }, e.message)); return; }
  if (seq !== profileSeq) return;

  const banner = h("div", { class: "banner" });
  const bannerUrl = safeGoogleImg(p.banner);
  if (bannerUrl) banner.style.backgroundImage = `url("${bannerUrl.replace(/["\\\n]/g, "")}")`;
  const studio = /^https:\/\/studio\.youtube\.com\//.test(p.studio_url) ? p.studio_url : "https://studio.youtube.com";

  const desc = h("textarea", { value: p.description, maxLength: 1000, rows: 6 });
  const kw = h("input", { type: "text", value: p.keywords, maxLength: 500, placeholder: "mots-clés séparés par des espaces" });
  const country = h("select", {}, COUNTRIES.map(([c, n]) => h("option", { value: c }, n)));
  if (p.country && !COUNTRIES.some(([c]) => c === p.country)) country.append(h("option", { value: p.country }, p.country));
  country.value = p.country || "";
  const save = h("button", { type: "submit", class: "btn primary" }, "Enregistrer");
  const form = h("form", { class: "card" },
    h("h3", {}, "Description et informations"),
    counted("Description de la chaîne", desc, 1000),
    h("label", { class: "field" }, h("span", {}, "Mots-clés de la chaîne"), kw),
    h("label", { class: "field" }, h("span", {}, "Pays"), country),
    save,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      await api("PUT", `/api/profile/${acc.channel_id}`, { description: desc.value, keywords: kw.value, country: country.value });
      toast("Profil mis à jour ✔", "ok");
    } catch (err) { toast(err.message, "err"); } finally { save.disabled = false; }
  });

  const file = h("input", { type: "file", accept: "image/jpeg,image/png,image/webp" });
  const up = h("button", { type: "button", class: "btn" }, "Envoyer la bannière");
  up.addEventListener("click", async () => {
    if (!file.files[0]) { toast("Choisis une image.", "err"); return; }
    const fd = new FormData();
    fd.append("file", file.files[0]);
    up.disabled = true;
    try {
      await api("POST", `/api/profile/${acc.channel_id}/banner`, fd);
      toast("Bannière mise à jour ✔ (peut prendre quelques minutes à apparaître)", "ok");
      loadProfile();
    } catch (err) { toast(err.message, "err"); } finally { up.disabled = false; }
  });

  body.replaceChildren(
    banner,
    h("div", { class: "profile-head" },
      safeGoogleImg(p.avatar) ? h("img", { class: "avatar xl", src: p.avatar, alt: "" }) : h("div", { class: "avatar xl" }),
      h("div", {}, h("h2", {}, p.title), h("div", { class: "hint" },
        [p.custom_url, p.subscribers !== undefined && p.subscribers !== null ? nf.format(p.subscribers) + " abonnés" : null].filter(Boolean).join(" · "))),
    ),
    h("div", { class: "card" },
      h("h3", {}, "Nom et photo de profil"),
      h("p", { class: "hint" }, "YouTube n'autorise pas les applications externes à changer le nom ni la photo de profil d'une chaîne. Le bouton ouvre directement la bonne page de YouTube Studio pour ce compte."),
      h("a", { class: "btn", href: studio, target: "_blank", rel: "noopener noreferrer" }, "Modifier le nom / la photo dans YouTube Studio ↗"),
    ),
    form,
    h("div", { class: "card" },
      h("h3", {}, "Bannière"),
      h("p", { class: "hint" }, "JPG, PNG ou WEBP. L'image est automatiquement recadrée en 2560×1440 (16:9)."),
      h("div", { class: "row" }, file, up),
    ),
  );
}

/* ---------- Comptes ---------- */

/* ---------- Cookies (videos reservees aux comptes connectes) ---------- */

async function renderCookies() {
  const box = $("#cookiesBox");
  let st = { present: false };
  try { st = await api("GET", "/api/cookies"); } catch { /* ignore */ }
  const file = h("input", { type: "file", accept: ".txt,text/plain" });
  const up = h("button", { type: "button", class: "btn primary sm" }, "Importer cookies.txt");
  up.addEventListener("click", async () => {
    if (!file.files[0]) { toast("Choisis d'abord le fichier cookies.txt.", "err"); return; }
    const fd = new FormData();
    fd.append("file", file.files[0]);
    up.disabled = true;
    try { await api("POST", "/api/cookies", fd); toast("Cookies importés ✔ Tu peux cliquer sur Réessayer.", "ok"); renderCookies(); }
    catch (e) { toast(e.message, "err"); up.disabled = false; }
  });
  const del = h("button", { type: "button", class: "btn sm danger", onclick: async () => {
    if (!confirm("Supprimer les cookies enregistrés ?")) return;
    await api("DELETE", "/api/cookies"); toast("Cookies supprimés", "ok"); renderCookies();
  } }, "Supprimer");
  box.replaceChildren(
    h("h3", {}, "🍪 Cookies : vidéos réservées aux comptes connectés"),
    h("p", { class: "hint" }, "Certaines vidéos TikTok (contenu « sensible » / +18), Instagram ou privées ne sont visibles que connecté. Le site utilise alors ta session de navigateur, via un fichier cookies.txt."),
    st.present
      ? h("p", { class: "ok-txt" }, `✔ Cookies enregistrés le ${new Date(st.updated * 1000).toLocaleString("fr-FR")} · sites : ${st.sites.join(", ") || "?"}`)
      : h("p", { class: "warn-txt" }, "Aucun cookie enregistré."),
    h("ol", { class: "steps-help" },
      h("li", {}, "Dans Chrome, installe l'extension ", extLink("https://chromewebstore.google.com/search/Get%20cookies.txt%20LOCALLY", "« Get cookies.txt LOCALLY »"), "."),
      h("li", {}, "Ouvre tiktok.com et connecte-toi (avec un compte majeur pour le contenu sensible)."),
      h("li", {}, "Clique sur l'extension → « Export » : un fichier cookies.txt est téléchargé (le site exporte pour le site ouvert : refais-le pour Instagram si besoin, en gardant tout dans un seul fichier avec « Export All Cookies »)."),
      h("li", {}, "Importe ce fichier ci-dessous, puis clique sur « Réessayer » sur la vidéo.")),
    h("div", { class: "row" }, file, up, st.present ? del : null),
    h("p", { class: "hint" }, "⚠ Ce fichier donne accès à tes comptes : il reste uniquement sur ton PC (dossier data), ne le partage jamais. Les cookies expirent au bout de quelques semaines : réimporte-les si l'erreur revient."),
  );
}

function renderAccountsView() {
  renderCookies();
  const setup = $("#setupBox");
  if (state.status && !state.status.client_configured) {
    setup.replaceChildren(h("div", { class: "setup" },
      h("h3", {}, "Configuration à faire une seule fois"),
      h("ol", {},
        h("li", {}, "Suis les étapes du fichier LISEZMOI.md (création d'un projet Google Cloud, ~5 minutes)."),
        h("li", {}, "Place le fichier téléchargé dans ", h("code", {}, "AUTO_YTB\\data\\client_secret.json"), "."),
        h("li", {}, "Recharge cette page puis clique sur « Connecter un compte YouTube »."),
      ),
    ));
  } else {
    setup.replaceChildren(h("p", { class: "note" },
      "Si une vidéo reste bloquée en privé à l’heure prévue, ton projet Google doit passer l’audit YouTube (voir LISEZMOI.md)."));
  }

  const list = $("#accountsList");
  list.replaceChildren(...state.accounts.map((a) => h("div", { class: "account-row" },
    safeGoogleImg(a.thumbnail) ? h("img", { class: "avatar", src: a.thumbnail, alt: "" }) : h("div", { class: "avatar" }),
    h("span", { class: "name" }, a.title, a.channel_id === state.active ? h("span", { class: "hint" }, "  · actif") : null),
    a.channel_id !== state.active ? h("button", { type: "button", class: "btn", onclick: () => setActive(a.channel_id) }, "Utiliser") : null,
    h("button", { type: "button", class: "btn", title: "À faire si Google a coupé l'accès (expiration)", onclick: () => connectAccount() }, "Reconnecter"),
    h("button", {
      type: "button", class: "btn danger", onclick: async () => {
        if (!confirm(`Déconnecter « ${a.title} » ? L'autorisation sera aussi révoquée côté Google.`)) return;
        try { await api("DELETE", `/api/accounts/${a.channel_id}`); await refreshAccounts(); renderAccountsView(); toast("Compte déconnecté", "ok"); }
        catch (e) { toast(e.message, "err"); }
      },
    }, "Déconnecter"),
  )));
  if (!state.accounts.length) list.append(h("p", { class: "hint" }, "Aucun compte connecté."));
  $("#connectBtn").disabled = !!(state.status && !state.status.client_configured);
}
$("#connectBtn").addEventListener("click", connectAccount);

