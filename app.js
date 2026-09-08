/* Hopscotch - MKE live transit. One collector, many readers:
   the site reads only our snapshots on the data branch, never the feeds. */
"use strict";

const LIVE_BASE = "https://raw.githubusercontent.com/tylerherman19/hopscotch/data/";
const liveUrl = (f) => LIVE_BASE + f + "?cb=" + Math.floor(Date.now() / 20000);
const DOWNTOWN = [43.0405, -87.9055];

const S = {
  map: null, markers: null, shapeLayer: null, stopLayer: null,
  routes: [], routeById: {}, shapes: {}, stops: {}, stopRoutes: {}, calendar: {}, hop: null,
  live: null, summary: undefined,
  selectedRoute: "", selectedVehicle: null,
  pins: new Set(JSON.parse(localStorage.getItem("hop_pins") || "[]")),
  pollTimer: null, lastPoll: 0,
  planCache: {},
};

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtMin = (sec) => sec <= 45 ? "now" : Math.round(sec / 60) + " min";
const fmtClock = (epoch) => new Date(epoch * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
const ctNowSec = () => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts();
  const g = (t) => +p.find((x) => x.type === t).value;
  return (g("hour") % 24) * 3600 + g("minute") * 60 + g("second");
};
const ctDateKey = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 864e5);
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return g("year") + g("month") + g("day");
};
const hav = (a, b) => {
  const R = 6371000, toR = (x) => x * Math.PI / 180;
  const dLa = toR(b[0] - a[0]), dLo = toR(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(toR(a[0])) * Math.cos(toR(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const delayClass = (d) => d == null ? "unk" : d < 180 ? "good" : d < 480 ? "warn" : "bad";
const delayColor = (d) => ({ good: "#1a7f37", warn: "#9a6700", bad: "#cf222e", unk: "#8b919a" })[delayClass(d)];
const delayText = (d) => d == null ? "no schedule match" : d < 60 ? "on time" : d < 480 ? Math.round(d / 60) + " min late" : Math.round(d / 60) + " min late";
const walkMin = (m) => Math.max(1, Math.round(m / 80)); // ~3 mph

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(url + " -> " + r.status);
  return r.json();
}

/* ---------- boot ---------- */
async function boot() {
  const st = await fetchJson("data/static.json");
  const { routes, shapes, stops: stopsArr, stop_routes: stopRoutes, calendar, hop } = st;
  S.tindex = st.tindex || {};
  S.routes = routes; S.routeById = Object.fromEntries(routes.map((r) => [r.id, r]));
  S.shapes = shapes; S.stopRoutes = stopRoutes; S.calendar = calendar; S.hop = hop;
  S.stops = Object.fromEntries(stopsArr.map((s) => [s[0], { name: s[1], lat: s[2], lon: s[3] }]));
  initMap();
  buildRoutePicker();
  renderRouteTable();
  wireNav(); wireToggles(); wirePlan();
  refresh();
}

/* ---------- map ---------- */
function initMap() {
  S.map = L.map("map", { zoomControl: false, attributionControl: true }).setView(DOWNTOWN, 14);
  L.control.zoom({ position: "bottomright" }).addTo(S.map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: 'Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | transit data MCTS / the Hop',
    maxZoom: 16,
  }).addTo(S.map);
  S.markers = L.layerGroup().addTo(S.map);
  S.shapeLayer = L.layerGroup().addTo(S.map);
  S.stopLayer = L.layerGroup().addTo(S.map);
  S.map.on("click", () => clearSelection());
  $("sheetclose").onclick = () => clearSelection();
}

function vehIcon(color) {
  return L.divIcon({ className: "", html: `<div class="veh-pin" style="width:12px;height:12px;border-radius:50%;background:${color}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
}
function hopIcon(color) {
  return L.divIcon({ className: "", html: `<div class="hop-pin" style="width:15px;height:15px;border-radius:4px;background:${color}">H</div>`, iconSize: [19, 19], iconAnchor: [9, 9] });
}

function renderVehicles() {
  if (!S.live) return;
  S.markers.clearLayers();
  const showBus = $("tg-bus").checked, showHop = $("tg-hop").checked, mine = $("tg-mine").checked;
  const only = S.selectedRoute;
  for (const v of S.live.vehicles) {
    if (!showBus) continue;
    if (only && v.route !== only) continue;
    if (mine && !S.pins.has(v.route)) continue;
    const m = L.marker([v.lat, v.lon], { icon: vehIcon(delayColor(v.delay)), zIndexOffset: 100 })
      .on("click", (e) => { L.DomEvent.stopPropagation(e); selectVehicle(v); });
    m.addTo(S.markers);
  }
  for (const h of S.live.hop) {
    if (!showHop) continue;
    if (only && only !== "HOP:" + h.route) continue;
    if (mine && !S.pins.has("HOP:" + h.route)) continue;
    const line = S.hop.routes.find((r) => r.id === h.route);
    L.marker([h.lat, h.lon], { icon: hopIcon("#" + (line ? line.color : "3A81DE")), zIndexOffset: 200 })
      .on("click", (e) => { L.DomEvent.stopPropagation(e); selectHop(h); })
      .addTo(S.markers);
  }
}

function drawShape(routeId) {
  S.shapeLayer.clearLayers(); S.stopLayer.clearLayers();
  if (routeId.startsWith("HOP:")) {
    const rid = routeId.slice(4);
    const line = S.hop.lines[rid] || [];
    const color = "#" + ((S.hop.routes.find((r) => String(r.id) === rid) || {}).color || "3A81DE");
    L.polyline(line, { color: "#fff", weight: 7, opacity: 0.9 }).addTo(S.shapeLayer);
    L.polyline(line, { color, weight: 4 }).addTo(S.shapeLayer);
    for (const st of S.hop.stops.filter((s) => String(s.route) === rid)) {
      L.marker([st.lat, st.lon], { icon: L.divIcon({ className: "", html: '<div class="stop-dot" style="width:9px;height:9px;border-radius:50%"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }) })
        .on("click", (e) => { L.DomEvent.stopPropagation(e); selectHopStop(st); })
        .addTo(S.stopLayer);
    }
    if (line.length) S.map.fitBounds(L.latLngBounds(line.map((p) => p)), { padding: [40, 40] });
    return;
  }
  const dirs = S.shapes[routeId] || {};
  let bounds = [];
  for (const d of Object.keys(dirs)) {
    const pts = dirs[d];
    const color = "#" + (S.routeById[routeId]?.color || "333333");
    L.polyline(pts, { color: "#fff", weight: 7, opacity: 0.9 }).addTo(S.shapeLayer);
    L.polyline(pts, { color, weight: 4, dashArray: d === "1" ? "1 6" : null }).addTo(S.shapeLayer);
    bounds = bounds.concat(pts);
  }
  // stops for this route
  const seen = new Set();
  for (const [sid, rids] of Object.entries(S.stopRoutes)) {
    if (!rids.includes(routeId) || seen.has(sid)) continue;
    seen.add(sid);
    const st = S.stops[sid]; if (!st) continue;
    L.marker([st.lat, st.lon], { icon: L.divIcon({ className: "", html: '<div class="stop-dot" style="width:9px;height:9px;border-radius:50%"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }) })
      .on("click", (e) => { L.DomEvent.stopPropagation(e); selectStop(sid); })
      .addTo(S.stopLayer);
  }
  if (bounds.length) S.map.fitBounds(L.latLngBounds(bounds.map((p) => p)), { padding: [40, 40] });
}

/* ---------- selection / sheet ---------- */
function sheet(html) {
  $("sheetbody").innerHTML = html;
  $("sheet").hidden = false;
}
function clearSelection() {
  S.selectedVehicle = null; S.selectedRoute = "";
  $("routepick").value = "";
  S.shapeLayer.clearLayers(); S.stopLayer.clearLayers();
  $("sheet").hidden = true;
  renderVehicles(); schedulePoll();
}

function selectVehicle(v) {
  S.selectedVehicle = v; S.selectedRoute = v.route;
  $("routepick").value = v.route;
  drawShape(v.route); renderVehicles();
  const r = S.routeById[v.route] || { name: v.route, long: "" };
  const next = (v.next || []).map((n) =>
    `<tr><td>${esc(n.name)}</td><td class="arr">${fmtMin(n.in)}</td><td class="arr">${fmtClock(n.at)}</td></tr>`).join("");
  sheet(`
    <h3><span class="routenum" style="border-left-color:#${r.color || "333"}">${esc(r.name)}</span>
      ${esc(r.long || "")} <span class="delaychip ${delayClass(v.delay)}">${delayText(v.delay)}</span></h3>
    <div class="sub">Bus ${esc(v.id)} &middot; next stops</div>
    <table class="ledger"><tbody>${next || '<tr><td>No upcoming stops in the feed.</td></tr>'}</tbody></table>
    <div class="sub" style="margin-top:8px">${pinButtonHtml(v.route)} ${textsNote()}</div>`);
  schedulePoll();
}

function selectHop(h) {
  S.selectedRoute = "HOP:" + h.route;
  drawShape("HOP:" + h.route); renderVehicles();
  const line = S.hop.routes.find((r) => r.id === h.route) || { name: "Hop" };
  const stops = S.hop.stops.filter((s) => s.route === h.route);
  const rows = stops.map((st) => {
    const arr = (S.live.hop_stops || {})[String(st.id)] || [];
    const txt = arr.length ? arr.slice(0, 2).map((a) => fmtMin(a[0])).join(", ") : "-";
    return `<tr><td>${esc(st.name)}</td><td class="arr">${txt} <span class="est">est</span></td></tr>`;
  }).join("");
  sheet(`
    <h3><span class="routenum" style="border-left-color:#${line.color}">HOP</span> ${esc(line.name)} Line
      <span class="delaychip ${h.delayed ? "warn" : "good"}">${h.delayed ? "delayed" : "running"}</span></h3>
    <div class="sub">${esc(h.name)} &middot; arrivals are estimates</div>
    <table class="ledger"><tbody>${rows}</tbody></table>`);
  schedulePoll();
}

function selectStop(sid) {
  const st = S.stops[sid]; if (!st) return;
  const preds = (S.live.stops || {})[sid] || [];
  const rows = preds.map((p) => {
    const r = S.routeById[p[0]] || { name: p[0], color: "333" };
    return `<tr><td><span class="routenum" style="border-left-color:#${r.color}">${esc(r.name)}</span></td>
      <td class="arr">${fmtMin(p[1])}</td><td class="arr">${fmtClock(p[2])}</td></tr>`;
  }).join("");
  sheet(`
    <h3>${esc(st.name)}</h3>
    <div class="sub">Next arrivals (live predictions)</div>
    <table class="ledger"><tbody>${rows || '<tr><td>Nothing predicted here soon.</td></tr>'}</tbody></table>`);
}

function selectHopStop(st) {
  const arr = (S.live.hop_stops || {})[String(st.id)] || [];
  const rows = arr.map((a) => `<tr><td class="arr">${fmtMin(a[0])}</td><td class="arr">${fmtClock(a[1])}</td></tr>`).join("");
  sheet(`
    <h3>${esc(st.name)}</h3>
    <div class="sub">Hop arrivals &middot; always estimates</div>
    <table class="ledger"><tbody>${rows || '<tr><td>No arrivals listed soon.</td></tr>'}</tbody></table>`);
}

function pinButtonHtml(routeId) {
  const pinned = S.pins.has(routeId);
  return `<button class="btn" style="padding:7px 12px;font-size:0.8rem" onclick="togglePin('${esc(routeId)}')">${pinned ? "Pinned to My routes" : "Pin to My routes"}</button>`;
}
function textsNote() {
  const ready = S.live && S.live.sms_ready;
  return ready
    ? `<span class="sub">Text alerts are on their way in a follow-up.</span>`
    : `<span class="sub">Text alerts: off. They turn on once the mail line is connected (one-time setup).</span>`;
}
window.togglePin = (routeId) => {
  S.pins.has(routeId) ? S.pins.delete(routeId) : S.pins.add(routeId);
  localStorage.setItem("hop_pins", JSON.stringify([...S.pins]));
  renderRouteTable(); renderVehicles();
  if (!$("sheet").hidden && S.selectedVehicle) selectVehicle(S.selectedVehicle);
};

/* ---------- route picker + table ---------- */
function buildRoutePicker() {
  const sel = $("routepick");
  for (const line of S.hop.routes) {
    const o = document.createElement("option");
    o.value = "HOP:" + line.id; o.textContent = "Hop " + line.name;
    sel.appendChild(o);
  }
  for (const r of S.routes) {
    const o = document.createElement("option");
    o.value = r.id; o.textContent = r.name + " - " + (r.long || "");
    sel.appendChild(o);
  }
  sel.onchange = () => {
    const v = sel.value;
    if (!v) return clearSelection();
    S.selectedRoute = v; S.selectedVehicle = null;
    drawShape(v); renderVehicles(); schedulePoll();
    if (v.startsWith("HOP:")) {
      const rid = +v.slice(4);
      const line = S.hop.routes.find((x) => x.id === rid);
      sheet(`<h3><span class="routenum" style="border-left-color:#${line.color}">HOP</span> ${esc(line.name)} Line</h3>
        <div class="sub">Tap a streetcar or a stop for arrivals (always estimates). ${pinButtonHtml(v)}</div>`);
    } else {
      showRouteSheet(v);
    }
  };
}

function showRouteSheet(rid) {
  const r = S.routeById[rid];
  const preds = [];
  for (const v of S.live?.vehicles || []) if (v.route === rid) preds.push(v);
  const late = preds.filter((v) => v.delay != null && v.delay >= 480).length;
  sheet(`<h3><span class="routenum" style="border-left-color:#${r.color}">${esc(r.name)}</span> ${esc(r.long || "")}</h3>
    <div class="sub">${preds.length} out now &middot; ${late ? late + " running 8+ min late" : "nothing badly late"} &middot; tap a bus or stop</div>
    <div class="sub">${pinButtonHtml(rid)} ${textsNote()}</div>`);
}

function renderRouteTable() {
  const tb = document.querySelector("#routetable tbody");
  const byRoute = {};
  for (const v of S.live?.vehicles || []) {
    const e = byRoute[v.route] = byRoute[v.route] || { n: 0, worst: null };
    e.n++;
    if (v.delay != null) e.worst = Math.max(e.worst ?? -1e9, v.delay);
  }
  tb.innerHTML = S.routes.map((r) => {
    const e = byRoute[r.id] || { n: 0, worst: null };
    const pinned = S.pins.has(r.id);
    return `<tr class="clickable" data-route="${esc(r.id)}">
      <td><button class="pinbtn ${pinned ? "pinned" : ""}" data-pin="${esc(r.id)}" title="Pin to My routes">${pinned ? "&#9733;" : "&#9734;"}</button></td>
      <td><span class="routenum" style="border-left-color:#${r.color}">${esc(r.name)}</span> <span class="rname">${esc(r.long || "")}</span></td>
      <td class="num">${e.n || ""}</td>
      <td class="num">${e.worst != null && e.worst >= 60 ? Math.round(e.worst / 60) + " min" : e.n ? "ok" : ""}</td>
      <td class="num">&rsaquo;</td></tr>`;
  }).join("");
  tb.querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", (ev) => {
    if (ev.target.dataset.pin) return;
    const rid = tr.dataset.route;
    switchView("map");
    $("routepick").value = rid;
    S.selectedRoute = rid; S.selectedVehicle = null;
    drawShape(rid); renderVehicles(); showRouteSheet(rid); schedulePoll();
  }));
  tb.querySelectorAll("[data-pin]").forEach((b) => b.addEventListener("click", () => togglePin(b.dataset.pin)));
}

/* ---------- live polling ---------- */
async function refresh() {
  const btn = $("liveage");
  try {
    const live = await fetchJson(liveUrl("live.json"));
    S.live = live; S.lastPoll = Date.now();
    $("statusline").textContent = live.status || "All quiet";
    $("hopbanner").hidden = !live.hop_offline;
    renderVehicles(); renderRouteTable(); renderAlerts(); renderGhosts();
    const nb = (live.alerts?.length || 0) + (live.ghosts?.length || 0);
    $("alertbadge").hidden = nb === 0; $("alertbadge").textContent = nb;
  } catch (e) {
    console.warn("live fetch failed", e);
  }
  schedulePoll();
}
function schedulePoll() {
  clearTimeout(S.pollTimer);
  const poking = !!(S.selectedRoute || S.selectedVehicle || !$("sheet").hidden);
  S.pollTimer = setTimeout(refresh, poking ? 20000 : 60000);
  tickAge();
  clearInterval(S.ageTimer);
  S.ageTimer = setInterval(tickAge, 5000);
}
function tickAge() {
  const dot = $("livedot"), lbl = $("liveage");
  if (!S.live) { dot.className = ""; lbl.textContent = "connecting..."; return; }
  const age = Math.max(0, Math.floor(Date.now() / 1000 - S.live.ts));
  dot.className = age < 90 ? "fresh" : age < 300 ? "stale" : "dead";
  dot.id = "livedot";
  lbl.textContent = age < 15 ? "live just now" : age < 90 ? `live ${age}s ago` : age < 3600 ? `last seen ${Math.floor(age / 60)} min ago` : "collector is down - showing last snapshot";
}

/* ---------- alerts / ghosts ---------- */
function renderAlerts() {
  const el = $("alertlist");
  const alerts = S.live?.alerts || [];
  el.innerHTML = alerts.length ? alerts.map((a) => `
    <div class="alertrow">
      <span class="effect ${a.effect === "No Service" ? "noservice" : ""}">${esc(a.effect)}</span>
      <span class="title">${esc(a.title)}</span>
      ${a.text ? `<div class="text">${esc(a.text)}</div>` : ""}
      ${a.routes?.length ? `<div class="routes">Routes: ${a.routes.map(esc).join(", ")}</div>` : ""}
    </div>`).join("") : '<div class="empty">No active alerts. Enjoy it.</div>';
}
function renderGhosts() {
  const tb = document.querySelector("#ghosttable tbody");
  const ghosts = S.live?.ghosts || [];
  tb.innerHTML = ghosts.length ? ghosts.map((g) => {
    const r = S.routeById[g.route] || { name: g.route, color: "333" };
    return `<tr><td><span class="routenum" style="border-left-color:#${r.color}">${esc(r.name)}</span></td>
      <td class="num">${esc(g.sched)}</td><td>${esc(g.headsign || "")}</td></tr>`;
  }).join("") : '<tr><td colspan="3" class="empty">None caught today. The schedule is honest so far.</td></tr>';
}

/* ---------- yesterday ---------- */
async function renderSummary() {
  const el = $("summary");
  if (S.summary === undefined) {
    try { S.summary = await fetchJson(liveUrl("summary.json")); }
    catch { S.summary = null; }
  }
  const s = S.summary;
  if (!s) {
    el.innerHTML = '<div class="empty">No card yet. The collector starts writing history tonight; the first "Yesterday in MKE transit" lands tomorrow morning.</div>';
    return;
  }
  const rows = [
    ["Date", s.date],
    ["Trips that ran", s.trips_run?.toLocaleString?.() ?? s.trips_run],
    ["Worst delay", s.worst_delays?.[0] ? `Route ${s.worst_delays[0].route} - ${s.worst_delays[0].min} min late` : "-"],
    ["Longest gap", s.longest_gaps?.[0] ? `Route ${s.longest_gaps[0].route} - ${s.longest_gaps[0].min} min with no bus` : "-"],
    ["Worst routes", (s.worst_routes || []).join(", ") || "-"],
    ["Snapshots kept", s.snapshots],
  ];
  el.innerHTML = `<div class="sumcard"><div class="row" style="font-weight:700"><span>Yesterday in MKE transit</span><span></span></div>` +
    rows.map(([l, v]) => `<div class="row"><span class="lbl">${esc(l)}</span><span class="val">${esc(v)}</span></div>`).join("") + "</div>";
}

/* ---------- nav ---------- */
function switchView(name) {
  document.querySelectorAll(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "map") setTimeout(() => S.map.invalidateSize(), 50);
  if (name === "yesterday") renderSummary();
}
function wireNav() {
  document.querySelectorAll(".navbtn").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
}
function wireToggles() {
  for (const id of ["tg-bus", "tg-hop", "tg-mine"]) $(id).addEventListener("change", renderVehicles);
}

/* ---------- plan (CSA over today's timetable, <=1 transfer) ---------- */
function wirePlan() {
  $("plan-go").addEventListener("click", runPlan);
}
async function geocode(q) {
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&viewbox=-88.07,42.84,-87.82,43.20&bounded=0&q=" + encodeURIComponent(q + ", Milwaukee, WI");
  const r = await fetchJson(url, { headers: { "Accept-Language": "en" } });
  if (!r.length) throw new Error("no geocode for " + q);
  return { lat: +r[0].lat, lon: +r[0].lon, label: r[0].display_name.split(",")[0] };
}
function nearestStops(lat, lon, maxM, cap) {
  const out = [];
  for (const [sid, st] of Object.entries(S.stops)) {
    const d = hav([lat, lon], [st.lat, st.lon]);
    if (d <= maxM) out.push([sid, d]);
  }
  out.sort((a, b) => a[1] - b[1]);
  return out.slice(0, cap);
}
async function loadTimetable(rid) {
  if (S.planCache[rid]) return S.planCache[rid];
  const n = (S.tindex || {})[rid];
  if (n == null) return null;
  if (!S.planPacks) S.planPacks = {};
  if (!S.planPacks[n]) S.planPacks[n] = fetchJson("data/tt-" + n + ".json");
  const pack = await S.planPacks[n];
  for (const k of Object.keys(pack)) S.planCache[k] = pack[k];
  return S.planCache[rid] || null;
}
function activeServicesToday() {
  return new Set(S.calendar[ctDateKey()] || []);
}
function hhmm(sec) {
  let h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12;
  return h + ":" + String(m).padStart(2, "0") + " " + ap;
}
async function runPlan() {
  const btn = $("plan-go"), out = $("plan-out");
  const fromQ = $("plan-from").value.trim(), toQ = $("plan-to").value.trim();
  if (!fromQ || !toQ) { out.innerHTML = '<p class="planmeta">Give me both ends.</p>'; return; }
  btn.disabled = true; btn.textContent = "Working...";
  out.innerHTML = '<p class="planmeta">Finding your trip...</p>';
  try {
    const [from, to] = await Promise.all([geocode(fromQ), geocode(toQ)]);
    const dist = hav([from.lat, from.lon], [to.lat, to.lon]);
    const nowSec = ctNowSec();
    const oStops = nearestStops(from.lat, from.lon, 800, 6);
    const dStops = nearestStops(to.lat, to.lon, 800, 6);
    const itins = [];
    if (dist < 900) {
      itins.push({ legs: [{ kind: "walk", from: from.label, to: to.label, min: walkMin(dist) }], total: walkMin(dist), note: "Honestly, just walk it." });
    }
    // candidate routes
    const oRoutes = new Set(), dRoutes = new Set();
    for (const [sid] of oStops) (S.stopRoutes[sid] || []).forEach((r) => oRoutes.add(r));
    for (const [sid] of dStops) (S.stopRoutes[sid] || []).forEach((r) => dRoutes.add(r));
    const svcs = activeServicesToday();
    const direct = [...oRoutes].filter((r) => dRoutes.has(r));
    // load timetables
    const transferRoutes = new Set([...direct]);
    const dOnly = [...dRoutes].filter((r) => !direct.includes(r));
    const oOnly = [...oRoutes].filter((r) => !direct.includes(r));
    oOnly.forEach((r) => transferRoutes.add(r));
    dOnly.forEach((r) => transferRoutes.add(r));
    const tts = {};
    await Promise.all([...transferRoutes].map(async (r) => { tts[r] = await loadTimetable(r).catch(() => null); }));
    // direct trips
    for (const rid of direct) {
      const tt = tts[rid]; if (!tt) continue;
      const best = findTrip(tt, svcs, rid, oStops, dStops, nowSec);
      if (best) itins.push(best);
    }
    // one transfer
    if (!itins.length) {
      outer:
      for (const r1 of oOnly) {
        const tt1 = tts[r1]; if (!tt1) continue;
        for (const r2 of dOnly) {
          const tt2 = tts[r2]; if (!tt2) continue;
          // shared stops between r1 and r2
          const shared = new Set();
          for (const key of Object.keys(tt1.stops)) for (const sid of tt1.stops[key]) {
            if ((S.stopRoutes[sid] || []).includes(r2)) shared.add(sid);
          }
          if (!shared.size) continue;
          const best = findTransfer(tt1, tt2, svcs, r1, r2, oStops, dStops, shared, nowSec);
          if (best) { itins.push(best); break outer; }
        }
      }
    }
    // Hop variant
    const hopItin = hopVariant(from, to);
    if (hopItin) itins.push(hopItin);
    renderItins(out, itins, from, to);
  } catch (e) {
    console.warn(e);
    out.innerHTML = '<p class="planmeta">Could not plan that one. Try a street address or a known spot (e.g. "Fiserv Forum", "Mitchell Park Domes").</p>';
  }
  btn.disabled = false; btn.textContent = "Plan my trip";
}

function ttTrips(tt, svcs) {
  const out = [];
  const svclist = tt.services || [];
  for (const tr of tt.trips || []) {
    const [tid, si, key, deltas] = tr;
    if (si >= svclist.length || !svcs.has(svclist[si])) continue;
    let acc = 0; const t = deltas.map((d) => (acc += d));
    out.push({ id: tid, k: key, t, stops: tt.stops[key] });
  }
  return out;
}
function findTrip(tt, svcs, rid, oStops, dStops, nowSec) {
  const oIds = new Map(oStops), dIds = new Map(dStops);
  let best = null;
  for (const tr of ttTrips(tt, svcs)) {
    const stops = tr.stops;
    let bi = -1, ai = -1;
    for (let i = 0; i < stops.length; i++) {
      if (bi < 0 && oIds.has(stops[i])) bi = i;
      if (bi >= 0 && dIds.has(stops[i])) { ai = i; break; }
    }
    if (bi < 0 || ai < 0 || ai <= bi) continue;
    const dep = tr.t[bi], arr = tr.t[ai];
    if (dep < nowSec - 60) continue;
    if (!best || dep < best.dep) {
      const bSid = stops[bi], aSid = stops[ai];
      best = { dep, arr, rid, bSid, aSid, dir: tt.headsign[tr.k.split(".")[0]] || "",
        walkO: walkMin(oIds.get(bSid)), walkD: walkMin(dIds.get(aSid)) };
    }
  }
  if (!best) return null;
  const r = S.routeById[rid] || { name: rid };
  return {
    legs: [
      { kind: "walk", to: S.stops[best.bSid].name, min: best.walkO },
      { kind: "bus", route: r.name, color: r.color, dir: best.dir, at: best.dep, board: S.stops[best.bSid].name,
        off: S.stops[best.aSid].name, arr: best.arr, min: Math.round((best.arr - best.dep) / 60) },
      { kind: "walk", from: S.stops[best.aSid].name, min: best.walkD },
    ],
    total: Math.round((best.arr - nowSec) / 60) + best.walkD,
    live: liveAdjust(best),
  };
}
function liveAdjust(best) {
  const preds = (S.live?.stops || {})[best.bSid] || [];
  const p = preds.find((x) => x[0] === best.rid && Math.abs(x[2] - (Date.now() / 1000 - ctNowSec() + best.dep)) < 900);
  if (!p) return null;
  const midnight = Date.now() / 1000 - ctNowSec();
  return { dep: Math.round(p[2] - midnight), live: true };
}
function findTransfer(tt1, tt2, svcs, r1, r2, oStops, dStops, shared, nowSec) {
  const oIds = new Map(oStops), dIds = new Map(dStops);
  let best = null;
  const trips1 = ttTrips(tt1, svcs), trips2 = ttTrips(tt2, svcs);
  for (const tr1 of trips1) {
    const stops1 = tr1.stops;
    let bi = -1, xi = -1;
    for (let i = 0; i < stops1.length; i++) {
      if (bi < 0 && oIds.has(stops1[i])) bi = i;
      if (bi >= 0 && shared.has(stops1[i])) { xi = i; break; }
    }
    if (bi < 0 || xi < 0 || tr1.t[bi] < nowSec - 60) continue;
    const xSid = stops1[xi], arrX = tr1.t[xi];
    for (const tr2 of trips2) {
      const stops2 = tr2.stops;
      const xi2 = stops2.indexOf(xSid);
      if (xi2 < 0) continue;
      let ai = -1;
      for (let i = xi2 + 1; i < stops2.length; i++) if (dIds.has(stops2[i])) { ai = i; break; }
      if (ai < 0) continue;
      const dep2 = tr2.t[xi2];
      if (dep2 < arrX + 180) continue;
      if (!best || tr2.t[ai] < best.arr) {
        best = { dep: tr1.t[bi], arr: tr2.t[ai], r1, r2, bSid: stops1[bi], xSid, aSid: stops2[ai],
          dep2, arrX, dir1: tt1.headsign[tr1.k.split(".")[0]] || "", dir2: tt2.headsign[tr2.k.split(".")[0]] || "",
          walkO: walkMin(oIds.get(stops1[bi])), walkD: walkMin(dIds.get(stops2[ai])) };
      }
    }
  }
  if (!best) return null;
  const R1 = S.routeById[r1] || { name: r1 }, R2 = S.routeById[r2] || { name: r2 };
  return {
    legs: [
      { kind: "walk", to: S.stops[best.bSid].name, min: best.walkO },
      { kind: "bus", route: R1.name, color: R1.color, dir: best.dir1, at: best.dep, board: S.stops[best.bSid].name, off: S.stops[best.xSid].name, arr: best.arrX, min: Math.round((best.arrX - best.dep) / 60) },
      { kind: "transfer", at: S.stops[best.xSid].name, wait: Math.round((best.dep2 - best.arrX) / 60) },
      { kind: "bus", route: R2.name, color: R2.color, dir: best.dir2, at: best.dep2, board: S.stops[best.xSid].name, off: S.stops[best.aSid].name, arr: best.arr, min: Math.round((best.arr - best.dep2) / 60) },
      { kind: "walk", from: S.stops[best.aSid].name, min: best.walkD },
    ],
    total: Math.round((best.arr - nowSec) / 60) + best.walkD,
  };
}
function hopVariant(from, to) {
  if (!S.live || S.live.hop_offline) return null;
  const hstops = S.hop.stops;
  const near = (pt, cap) => hstops.map((s) => [s, hav(pt, [s.lat, s.lon])]).filter((x) => x[1] < 500).sort((a, b) => a[1] - b[1])[0];
  const o = near([from.lat, from.lon]), d = near([to.lat, to.lon]);
  if (!o || !d || o[0].id === d[0].id || o[0].route !== d[0].route) return null;
  const arr = (S.live.hop_stops || {})[String(o[0].id)];
  if (!arr || !arr.length) return null;
  const line = S.hop.routes.find((r) => r.id === o[0].route);
  const stopsBetween = Math.abs(hstops.filter((s) => s.route === o[0].route).findIndex((s) => s.id === o[0].id) -
    hstops.filter((s) => s.route === o[0].route).findIndex((s) => s.id === d[0].id));
  const rideMin = Math.max(2, stopsBetween * 3);
  const depSec = arr[0][0];
  const midnight = Date.now() / 1000 - ctNowSec();
  const atSec = Math.round(arr[0][1] - midnight);
  return {
    legs: [
      { kind: "walk", to: o[0].name + " (Hop)", min: walkMin(o[1]) },
      { kind: "bus", route: "Hop " + line.name, color: line.color, dir: "", at: atSec, board: o[0].name, off: d[0].name, arr: atSec + rideMin * 60, min: rideMin, est: true },
      { kind: "walk", from: d[0].name + " (Hop)", min: walkMin(d[1]) },
    ],
    total: Math.round(depSec / 60) + rideMin + walkMin(d[1]),
    note: "Hop times are estimates.",
  };
}
function renderItins(out, itins, from, to) {
  if (!itins.length) {
    out.innerHTML = '<p class="planmeta">No bus gets that done soon. Try different endpoints or check back closer to rush hour.</p>';
    return;
  }
  itins.sort((a, b) => a.total - b.total);
  out.innerHTML = itins.slice(0, 3).map((it) => {
    const legs = it.legs.map((l) => {
      if (l.kind === "walk") return `<div class="leg walk"><span class="when"></span><span>Walk ${l.min} min${l.to ? " to " + esc(l.to) : l.from ? " from " + esc(l.from) : ""}</span></div>`;
      if (l.kind === "transfer") return `<div class="leg walk"><span class="when"></span><span>Transfer at ${esc(l.at)} - ${l.wait} min wait</span></div>`;
      return `<div class="leg"><span class="when">${hhmm(l.at)}</span>
        <span>Take the <b>${esc(l.route)}</b>${l.dir ? " " + esc(l.dir.toLowerCase()) : ""}, ${l.min} min, off at ${esc(l.off)}${l.est ? ' <span class="arr"><span class="est">est</span></span>' : ""}</span></div>`;
    }).join("");
    const arrLeg = [...it.legs].reverse().find((l) => l.kind === "bus");
    return `<div class="itin">
      <div class="itin-head"><span>About ${it.total} min</span><span class="num">${arrLeg ? "there by " + hhmm(arrLeg.arr) : ""}</span></div>
      ${legs}
      ${it.note ? `<div class="leg walk"><span class="when"></span><span>${esc(it.note)}</span></div>` : ""}
    </div>`;
  }).join("") + `<p class="planmeta">From ${esc(from.label)} to ${esc(to.label)}. Scheduled times${itins.some(i=>i.live) ? ", first leg adjusted live where marked" : ""}.</p>`;
}

boot().catch((e) => { $("statusline").textContent = "failed to load - " + e.message; });
