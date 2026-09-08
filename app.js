/* Hopscotch - MKE live transit. One collector, many readers:
   the site reads only our snapshots on the data branch, never the feeds. */
"use strict";

const LIVE_BASE = "https://raw.githubusercontent.com/tylerherman19/hopscotch/data/";
const liveUrl = (f) => LIVE_BASE + f + "?cb=" + Math.floor(Date.now() / 20000);
const HELENS = [43.03873, -87.91116]; // Wisconsin & Plankinton, the stop by Helen's home

const S = {
  map: null, markers: null, shapeLayer: null, stopLayer: null,
  routes: [], routeById: {}, shapes: {}, stops: {}, stopRoutes: {}, calendar: {}, hop: null,
  live: null, summary: undefined,
  selectedRoute: "", selectedVehicle: null,
  tracking: null, mapMode: "all",
  pins: new Set(JSON.parse(localStorage.getItem("hop_pins") || "[]")),
  pollTimer: null, lastPoll: 0,
  planCache: {}, hot: null,
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
  wireNav(); wireToggles(); loadHotRoutes().then(() => { renderHotRoutes(); renderMapQuickRoutes(); renderRouteTable(); wireAlerts(); });
  refresh();
}

/* ---------- map ---------- */
function initMap() {
  S.map = L.map("map", { zoomControl: false, attributionControl: true }).setView(HELENS, 15);
  L.control.zoom({ position: "bottomright" }).addTo(S.map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: 'Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors | transit data MCTS / the Hop',
    maxZoom: 16,
  }).addTo(S.map);
  S.markers = L.layerGroup().addTo(S.map);
  S.shapeLayer = L.layerGroup().addTo(S.map);
  S.stopLayer = L.layerGroup().addTo(S.map);
  L.circleMarker(HELENS, { radius: 7, color: "#111827", weight: 2, fillColor: "#ffffff", fillOpacity: 1 })
    .bindTooltip("Helen's area", { direction: "top", offset: [0, -8] }).addTo(S.map);
  S.map.on("click", () => clearSelection());
  $("sheetclose").onclick = () => clearSelection();
}

function vehIcon(color, route) {
  return L.divIcon({ className: "", html: `<div class="veh-pin" style="background:${color}">${esc(route)}</div>`, iconSize: [30, 22], iconAnchor: [15, 11] });
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
    if (S.tracking && String(v.trip) !== String(S.tracking.tripId)) continue;
    if (only && v.route !== only) continue;
    if (mine && !S.pins.has(v.route)) continue;
    const m = L.marker([v.lat, v.lon], { icon: vehIcon(delayColor(v.delay), v.route), zIndexOffset: 100 })
      .on("click", (e) => { L.DomEvent.stopPropagation(e); S.tracking ? updateBusTracking() : selectVehicle(v); });
    m.addTo(S.markers);
  }
  for (const h of S.live.hop) {
    if (S.tracking) continue;
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
      L.marker([st.lat, st.lon], { icon: L.divIcon({ className: "", html: '<div class="hop-stop-dot"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }) })
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

function drawHopNetwork() {
  S.shapeLayer.clearLayers();
  S.stopLayer.clearLayers();
  let bounds = [];
  for (const route of S.hop.routes || []) {
    const line = S.hop.lines[String(route.id)] || [];
    if (!line.length) continue;
    const color = "#" + (route.color || "3A81DE");
    L.polyline(line, { color: "#fff", weight: 8, opacity: .92 }).addTo(S.shapeLayer);
    L.polyline(line, { color, weight: 5, opacity: .9 }).addTo(S.shapeLayer);
    bounds = bounds.concat(line);
  }
  const seen = new Set();
  for (const st of S.hop.stops || []) {
    const key = String(st.id);
    if (seen.has(key)) continue;
    seen.add(key);
    L.marker([st.lat, st.lon], {
      icon: L.divIcon({ className: "", html: '<div class="hop-stop-dot"></div>', iconSize: [12, 12], iconAnchor: [6, 6] })
    }).on("click", (e) => {
      L.DomEvent.stopPropagation(e);
      selectHopStop(st);
    }).addTo(S.stopLayer);
  }
  if (bounds.length) S.map.fitBounds(L.latLngBounds(bounds.map((p) => p)), { padding: [35, 35] });
}

/* ---------- selection / sheet ---------- */
function sheet(html, mode = "") {
  $("sheetbody").innerHTML = html;
  $("sheet").classList.toggle("tracking-sheet", mode === "tracking");
  $("sheet").hidden = false;
}
function setTrackingChrome(active) {
  for (const id of ["mapcontrols", "mapkey", "refreshnote"]) {
    const el = $(id);
    if (el) el.hidden = active;
  }
}
function clearSelection() {
  S.selectedVehicle = null; S.selectedRoute = ""; S.tracking = null;
  setTrackingChrome(false);
  $("routepick").value = "";
  S.shapeLayer.clearLayers(); S.stopLayer.clearLayers();
  if (S.mapMode === "hop") drawHopNetwork();
  $("sheet").hidden = true;
  renderVehicles(); schedulePoll();
}

function selectVehicle(v) {
  syncLayerMode("bus");
  S.selectedVehicle = v; S.selectedRoute = v.route;
  $("routepick").value = v.route;
  drawShape(v.route); renderVehicles();
  const r = S.routeById[v.route] || { name: v.route, long: "" };
  const next = (v.next || []).map((n) =>
    `<tr><td>${esc(n.name)}</td><td class="arr">${fmtMin(n.in)}</td><td class="arr">${fmtClock(n.at)}</td></tr>`).join("");
  sheet(`
    <h3><span class="mode bus">Bus</span> <span class="routenum" style="border-left-color:#${r.color || "333"}">${esc(r.name)}</span>
      ${esc(r.long || "")} <span class="delaychip ${delayClass(v.delay)}">${delayText(v.delay)}</span></h3>
    <div class="sub">Bus ${esc(v.id)} &middot; next stops</div>
    <table class="ledger"><tbody>${next || '<tr><td>No upcoming stops in the feed.</td></tr>'}</tbody></table>
    <div class="sub" style="margin-top:8px">${pinButtonHtml(v.route)} ${textsNote()}</div>`);
  schedulePoll();
}

function selectHop(h) {
  syncLayerMode("hop");
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
    <h3><span class="mode hop">Hop</span> <span class="routenum" style="border-left-color:#${line.color}">HOP</span> ${esc(line.name)} Line
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
    o.value = "HOP:" + line.id; o.textContent = "Hop streetcar — " + line.name;
    sel.appendChild(o);
  }
  for (const r of S.routes) {
    const o = document.createElement("option");
    o.value = r.id; o.textContent = "Bus " + r.name + " — " + routeDestination(r);
    sel.appendChild(o);
  }
  sel.onchange = () => {
    const v = sel.value;
    if (!v) return clearSelection();
    S.tracking = null;
    setTrackingChrome(false);
    syncLayerMode(v.startsWith("HOP:") ? "hop" : "bus");
    S.selectedRoute = v; S.selectedVehicle = null;
    drawShape(v); renderVehicles(); schedulePoll();
    if (v.startsWith("HOP:")) {
      const rid = +v.slice(4);
      const line = S.hop.routes.find((x) => x.id === rid);
      sheet(`<h3><span class="mode hop">Hop</span> <span class="routenum" style="border-left-color:#${line.color}">HOP</span> ${esc(line.name)} Line</h3>
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
  sheet(`<h3><span class="mode bus">Bus</span> <span class="routenum" style="border-left-color:#${r.color}">${esc(r.name)}</span> ${esc(routeDestination(r))}</h3>
    <div class="sub">On ${esc(r.long || "this route")} &middot; ${preds.length} out now &middot; ${late ? late + " running 8+ min late" : "no major delay right now"} &middot; tap a bus or stop</div>
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
  const near = new Set((S.hot || []).flatMap((trip) => trip.legs || []).filter((l) => l.kind === "bus").flatMap((l) => l.routes));
  const ordered = [...S.routes].sort((a, b) => Number(near.has(b.id)) - Number(near.has(a.id)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  tb.innerHTML = ordered.map((r) => {
    const e = byRoute[r.id] || { n: 0, worst: null };
    const pinned = S.pins.has(r.id);
    return `<tr class="clickable" data-route="${esc(r.id)}">
      <td><button class="pinbtn ${pinned ? "pinned" : ""}" data-pin="${esc(r.id)}" title="Pin to My routes">${pinned ? "&#9733;" : "&#9734;"}</button></td>
      <td><span class="mode bus">Bus</span> <span class="routenum" style="border-left-color:#${r.color}">${esc(r.name)}</span> <span class="rname">${esc(routeDestination(r))}</span><small>via ${esc(r.long || "")}${near.has(r.id) ? " · near Helen" : ""}</small></td>
      <td class="num">${e.n ? e.n + " buses" : "—"}</td>
      <td class="num">${e.worst != null && e.worst >= 60 ? Math.round(e.worst / 60) + " min late" : e.n ? "On time" : "—"}</td>
      <td class="num">&rsaquo;</td></tr>`;
  }).join("");
  tb.querySelectorAll("tr").forEach((tr) => tr.addEventListener("click", (ev) => {
    if (ev.target.dataset.pin) return;
    const rid = tr.dataset.route;
    S.tracking = null;
    setTrackingChrome(false);
    syncLayerMode("bus");
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
    updateBusTracking(); renderVehicles(); renderRouteTable(); renderAlerts(); renderGhosts(); renderHotRoutes();
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
  S.pollTimer = setTimeout(refresh, S.tracking ? 15000 : poking ? 20000 : 60000);
  tickAge();
  clearInterval(S.ageTimer);
  S.ageTimer = setInterval(tickAge, 5000);
}
function tickAge() {
  const dot = $("livedot"), lbl = $("liveage");
  if (!S.live) { dot.className = ""; lbl.textContent = "connecting live locations..."; return; }
  const age = Math.max(0, Math.floor(Date.now() / 1000 - S.live.ts));
  dot.className = age < 90 ? "fresh" : age < 300 ? "stale" : "dead";
  dot.id = "livedot";
  lbl.textContent = age < 15 ? "locations updated just now" : age < 90 ? `locations updated ${age}s ago` : age < 3600 ? `locations updated ${Math.floor(age / 60)} min ago` : "location feed is down — showing last confirmed positions";
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
  const hotStats = (s.reliability || []).filter((r) => ["14", "30"].includes(r.route));
  const reliability = hotStats.length && (s.snapshots || 0) >= 24
    ? `<div class="reliability-grid">${hotStats.map((r) => `<div><strong>${esc(r.route)}</strong><span>${esc(r.on_time_pct)}% on time</span><small>${esc(r.samples)} checks</small></div>`).join("")}</div>`
    : `<p class="viewnote">We have ${esc(s.snapshots || 0)} archived check${s.snapshots === 1 ? "" : "s"} so far—enough to confirm the collector works, not enough to call a route reliable. The percentage appears after 24 checks.</p>`;
  el.innerHTML = `<div class="summary-intro"><p class="eyebrow">Not just where it is now</p><h1>How did your routes actually do?</h1><p>“On time” means the live feed was under 3 minutes late when we checked it.</p></div>${reliability}<div class="sumcard"><div class="row" style="font-weight:700"><span>Yesterday across MCTS</span><span></span></div>` +
    rows.map(([l, v]) => `<div class="row"><span class="lbl">${esc(l)}</span><span class="val">${esc(v)}</span></div>`).join("") + "</div>";
}

/* ---------- nav ---------- */
function switchView(name) {
  document.querySelectorAll(".navbtn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  if (name === "map") setTimeout(() => S.map.invalidateSize(), 50);
  if (name === "yesterday") renderSummary();
  if (name === "alerts") setTimeout(() => $("alerttrip")?.focus(), 60);
}
function wireNav() {
  document.querySelectorAll(".navbtn").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
}
function syncLayerMode(mode) {
  S.mapMode = mode;
  $("tg-bus").checked = mode !== "hop";
  $("tg-hop").checked = mode !== "bus";
  document.querySelectorAll("[data-layer-mode]").forEach(
    (button) => button.classList.toggle("active", button.dataset.layerMode === mode)
  );
}

function setLayerMode(mode) {
  S.tracking = null;
  S.selectedVehicle = null;
  S.selectedRoute = "";
  setTrackingChrome(false);
  syncLayerMode(mode);
  $("routepick").value = "";
  $("sheet").hidden = true;
  S.shapeLayer.clearLayers();
  S.stopLayer.clearLayers();
  if (mode === "hop") drawHopNetwork();
  renderVehicles();
  schedulePoll();
}

function wireToggles() {
  $("tg-mine").addEventListener("change", renderVehicles);
  document.querySelectorAll("[data-layer-mode]").forEach(
    (button) => button.addEventListener("click", () => setLayerMode(button.dataset.layerMode))
  );
}

function routeDestination(r) {
  const destinations = {
    "14": "Downtown, East Side & Bay View", "30": "Marquette & Sherman Park",
    "MCTS CONNECT 1": "Downtown & Wauwatosa", "18": "Downtown & Greenfield",
  };
  return destinations[r.id] || r.long || "See stops and direction";
}

/* ---------- hot routes (preset trips, watched live) ---------- */
async function loadHotRoutes() {
  try { S.hot = (await fetchJson("data/hotroutes.json")).routes || []; }
  catch { S.hot = []; }
}
function legLive(leg) {
  if (!S.live) return '<span class="arr">connecting...</span>';
  if (leg.kind === "bus") {
    const preds = ((S.live.stops || {})[leg.board] || []).filter((p) => leg.routes.includes(p[0]));
    const nextTwo = preds.slice(0, 2).map((p) => `${fmtMin(p[1])} <span class="est">${fmtClock(p[2])}</span>`).join(", ");
    const worst = Math.max(0, ...(S.live.vehicles || []).filter((v) => leg.routes.includes(v.route) && v.delay != null).map((v) => v.delay));
    const chip = worst >= 240 ? ` <span class="delaychip ${delayClass(worst)}">${delayText(worst)}</span>` : "";
    return nextTwo ? `<span class="arr">${nextTwo}</span>${chip}` : '<span class="arr">nothing listed soon</span>';
  }
  if (leg.kind === "hop") {
    const preds = (S.live.hop_stops || {})[String(leg.board)] || [];
    const nextTwo = preds.slice(0, 2).map((a) => `${fmtMin(a[0])} <span class="est">${fmtClock(a[1])} est</span>`).join(", ");
    return nextTwo ? `<span class="arr">${nextTwo}</span>` : '<span class="arr">nothing listed soon</span>';
  }
  return "";
}

function nextBusForTrip(trip) {
  const leg = trip?.legs.find((l) => l.kind === "bus");
  if (!leg || !S.live) return null;
  const predictions = ((S.live.stops || {})[String(leg.board)] || [])
    .filter((p) => leg.routes.includes(p[0]))
    .sort((a, b) => a[2] - b[2]);
  const prediction = predictions[0];
  if (!prediction) return null;

  let vehicle = (S.live.vehicles || []).find((v) =>
    prediction[3] != null && String(v.trip) === String(prediction[3])
  );
  if (!vehicle) {
    vehicle = (S.live.vehicles || [])
      .filter((v) => v.route === prediction[0])
      .map((v) => {
        const atStop = (v.next || []).find((n) => String(n.stop) === String(leg.board));
        return { vehicle: v, gap: atStop ? Math.abs(atStop.at - prediction[2]) : Infinity };
      })
      .filter((candidate) => candidate.gap <= 180)
      .sort((a, b) => a.gap - b.gap)[0]?.vehicle;
  }
  const tripId = prediction[3] != null ? prediction[3] : vehicle?.trip;
  return tripId == null ? null : { leg, prediction, vehicle, tripId };
}

function findTripPrediction(stopId, tripId, route, expectedEpoch) {
  const predictions = (S.live?.stops || {})[String(stopId)] || [];
  const exact = predictions.find(
    (p) => p[3] != null && String(p[3]) === String(tripId)
  );
  if (exact) return exact;
  if (!route || !expectedEpoch) return null;
  const closest = predictions
    .filter((p) => p[0] === route)
    .map((p) => ({ prediction: p, gap: Math.abs(p[2] - expectedEpoch) }))
    .sort((a, b) => a.gap - b.gap)[0];
  return closest && closest.gap <= 600 ? closest.prediction : null;
}

function startBusTracking(tripId) {
  const trip = S.hot?.find((r) => r.id === tripId);
  const next = nextBusForTrip(trip);
  if (!trip || !next) return;
  const fallbackArrival = next.prediction[2] + (trip.travel_min || 20) * 60;
  const destinationPrediction = findTripPrediction(
    next.leg.alight, next.tripId, next.prediction[0], fallbackArrival
  );
  S.tracking = {
    tripId: next.tripId,
    route: next.prediction[0],
    destinationStop: next.leg.alight,
    destinationName: trip.to,
    tripName: trip.name,
    expectedArrival: destinationPrediction?.[2] || fallbackArrival,
    sawDestination: !!destinationPrediction,
    focused: false,
  };
  S.selectedRoute = next.prediction[0];
  S.selectedVehicle = null;
  syncLayerMode("bus");
  setTrackingChrome(true);
  switchView("map");
  $("routepick").value = S.selectedRoute;
  drawShape(S.selectedRoute);
  renderVehicles();
  updateBusTracking();
  schedulePoll();
}

function stopBusTracking(arrived) {
  const tracked = S.tracking;
  if (!tracked) return;
  if (!arrived) {
    clearSelection();
    return;
  }
  S.tracking = null;
  S.selectedVehicle = null;
  S.selectedRoute = "";
  syncLayerMode("bus");
  setTrackingChrome(false);
  $("routepick").value = "";
  S.shapeLayer.clearLayers();
  S.stopLayer.clearLayers();
  renderVehicles();
  sheet(
    '<h3><span class="mode bus">Bus</span> Arrived</h3>' +
    '<div class="sub">Bus ' + esc(tracked.route) + ' reached ' + esc(tracked.destinationName) + '. Showing all buses again.</div>'
  );
  schedulePoll();
}

function renderTrackedBusSheet(vehicle, destinationPrediction) {
  const nextStop = (vehicle.next || []).find((n) => n.in >= -30) || (vehicle.next || [])[0];
  const arrival = destinationPrediction?.[2] || S.tracking.expectedArrival;
  const nextName = nextStop?.name || "Waiting for the next reported stop";
  const nextTime = nextStop ? fmtMin(nextStop.in) : "updating";
  sheet(
    '<h3><span class="mode bus">Bus</span> Tracking bus ' + esc(S.tracking.route) + "</h3>" +
    '<div class="tracking-summary">' +
      '<div class="tracking-destination"><span>To ' + esc(S.tracking.destinationName) + '</span><strong>' + esc(fmtClock(arrival)) + "</strong></div>" +
      '<div class="tracking-next"><span>Next stop</span><strong>' + esc(nextName) + '</strong><em>' + esc(nextTime) + "</em></div>" +
    "</div>" +
    '<div class="tracking-footer"><span>Live location · updates every 15 sec</span><button class="btn" data-stop-tracking>Show all buses</button></div>',
    "tracking"
  );
  const stopButton = document.querySelector("[data-stop-tracking]");
  if (stopButton) stopButton.onclick = () => stopBusTracking(false);
}

function updateBusTracking() {
  const tracked = S.tracking;
  if (!tracked || !S.live) return;
  const vehicle = (S.live.vehicles || []).find((v) => String(v.trip) === String(tracked.tripId));
  const destinationPrediction = findTripPrediction(
    tracked.destinationStop, tracked.tripId, tracked.route, tracked.expectedArrival
  );
  if (destinationPrediction) {
    tracked.expectedArrival = destinationPrediction[2];
    tracked.sawDestination = true;
  }
  const now = Math.floor(Date.now() / 1000);
  if ((destinationPrediction && destinationPrediction[1] <= 0) ||
      (!destinationPrediction && tracked.sawDestination && now >= tracked.expectedArrival) ||
      (!destinationPrediction && !vehicle && now >= tracked.expectedArrival + 120)) {
    stopBusTracking(true);
    return;
  }
  if (!vehicle) {
    sheet(
      '<h3><span class="mode bus">Bus</span> Finding bus ' + esc(tracked.route) + "</h3>" +
      '<div class="sub">This is the next scheduled bus for ' + esc(tracked.tripName) +
      ". Its live location will appear here as soon as MCTS reports it.</div>",
      "tracking"
    );
    return;
  }
  const point = [vehicle.lat, vehicle.lon];
  if (tracked.focused) S.map.panTo(point, { animate: true });
  else S.map.setView(point, Math.max(15, S.map.getZoom()));
  tracked.focused = true;
  S.selectedVehicle = vehicle;
  renderTrackedBusSheet(vehicle, destinationPrediction);
}

function renderHotRoutes() {
  const el = $("hotroutes");
  if (!el) return;
  if (!S.hot) { el.innerHTML = '<div class="empty">Loading...</div>'; return; }
  if (!S.hot.length) { el.innerHTML = '<div class="empty">No hot routes set up yet.</div>'; return; }
  el.innerHTML = S.hot.map((r) => {
    const transitLeg = r.legs.find((l) => l.kind !== "walk");
    const nextBus = nextBusForTrip(r);
    const type = transitLeg?.kind === "hop" ? "hop" : "bus";
    const line = transitLeg?.kind === "hop" ? "Hop streetcar" : `Bus ${transitLeg?.routes?.join(" or ") || ""}`;
    return `<article class="trip-card ${type}" data-trip="${esc(r.id)}">
      <div class="trip-top"><span class="mode ${type}">${type === "hop" ? "Hop" : "Bus"}</span><span class="trip-route">${esc(line)} · ${esc(r.route_note || "")}</span></div>
      <h2>${esc(r.name)}</h2>
      ${tripNextSummary(r, transitLeg)}
      <p class="trip-stops">${esc(r.from)} <b>→</b> ${esc(r.to)}</p>
      <div class="trip-steps">${r.legs.map((l) => l.kind === "walk"
        ? `<span class="walk-step">${esc(l.text)}</span>`
        : `<span><strong>${esc(l.text)}</strong></span>`).join("")}</div>
      <div class="trip-actions"><button class="textbtn" data-trip-map="${esc(r.id)}">See route</button><button class="textbtn" data-trip-track="${esc(r.id)}" ${nextBus ? "" : "disabled"}>${nextBus ? "Show me this bus" : "Bus not live yet"}</button><button class="textbtn" data-trip-alert="${esc(r.id)}">Alert me</button></div>
    </article>`;
  }).join("");
  el.querySelectorAll("[data-trip-map]").forEach((b) => b.addEventListener("click", () => openTripOnMap(b.dataset.tripMap)));
  el.querySelectorAll("[data-trip-track]").forEach((b) => b.addEventListener("click", () => startBusTracking(b.dataset.tripTrack)));
  el.querySelectorAll("[data-trip-alert]").forEach((b) => b.addEventListener("click", () => openTripAlerts(b.dataset.tripAlert)));
}

function tripNextSummary(trip, leg) {
  if (!S.live || !leg) return '<div class="next-summary"><span>Finding the next vehicle here…</span></div>';
  let prediction, routeLabel, departureEpoch;
  if (leg.kind === "bus") {
    const preds = ((S.live.stops || {})[leg.board] || []).filter((p) => leg.routes.includes(p[0])).sort((a, b) => a[2] - b[2]);
    prediction = preds[0];
    routeLabel = prediction ? `Bus ${prediction[0]}` : "Bus";
    departureEpoch = prediction?.[2];
  } else {
    const preds = (S.live.hop_stops || {})[String(leg.board)] || [];
    prediction = preds[0]; routeLabel = "Hop streetcar"; departureEpoch = prediction?.[1];
  }
  if (!prediction || !departureEpoch) return `<div class="next-summary"><span class="next-label">Next ${esc(routeLabel)} to ${esc(trip.to)}</span><strong>No live departure is listed yet</strong><small>Check the route map for live vehicle locations.</small></div>`;
  const inSecs = leg.kind === "bus" ? prediction[1] : prediction[0];
  const arrivalEpoch = departureEpoch + (trip.travel_min || 20) * 60;
  const delay = leg.kind === "bus" ? Math.max(0, ...(S.live.vehicles || []).filter((v) => leg.routes.includes(v.route) && v.delay != null).map((v) => v.delay)) : null;
  return `<div class="next-summary"><span class="next-label">Next ${esc(routeLabel)} to ${esc(trip.to)}</span><strong><span class="next-minutes">${esc(fmtMin(inSecs))}</span> <span>until it is here</span></strong><span class="depart-line">Leaves ${esc(fmtClock(departureEpoch))}</span><span class="arrival-line">At ${esc(trip.to)} about <b>${esc(fmtClock(arrivalEpoch))}</b>${leg.kind === "hop" ? " · estimate" : ""}</span>${delay >= 240 ? `<span class="delaychip ${delayClass(delay)}">${delayText(delay)}</span>` : ""}</div>`;
}

function renderMapQuickRoutes() {
  const el = $("mapquick");
  if (!el || !S.hot) return;
  el.innerHTML = S.hot.map((trip) => `<button data-trip-map="${esc(trip.id)}">${esc(trip.name)}</button>`).join("");
  el.querySelectorAll("[data-trip-map]").forEach((button) => button.addEventListener("click", () => openTripOnMap(button.dataset.tripMap)));
}

function openTripOnMap(tripId) {
  S.tracking = null;
  setTrackingChrome(false);
  const trip = S.hot?.find((r) => r.id === tripId);
  const leg = trip?.legs.find((l) => l.kind !== "walk");
  if (!leg) return;
  syncLayerMode(leg.kind === "hop" ? "hop" : "bus");
  switchView("map");
  const rid = leg.kind === "hop" ? "HOP:" + leg.route : leg.routes[0];
  $("routepick").value = rid; S.selectedRoute = rid; drawShape(rid); renderVehicles();
  if (leg.kind === "hop") return;
  showRouteSheet(rid); schedulePoll();
}

function openTripAlerts(tripId) {
  switchView("alerts");
  $("alerttrip").value = tripId;
  updateLeavePlan();
}

function wireAlerts() {
  const select = $("alerttrip"), form = $("alertform"), arriveBy = $("arriveby");
  if (!select || !form) return;
  select.innerHTML = (S.hot || []).map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  arriveBy.value = "08:30";
  select.addEventListener("change", updateLeavePlan);
  arriveBy.addEventListener("input", updateLeavePlan);
  form.querySelectorAll("input[name=day]").forEach((input) => input.addEventListener("change", updateLeavePlan));
  form.querySelectorAll("[data-day-preset]").forEach((button) => button.addEventListener("click", () => {
    const school = button.dataset.dayPreset === "school";
    form.querySelectorAll("input[name=day]").forEach((input) => {
      input.checked = button.dataset.dayPreset === "every" || (school && !["Sat", "Sun"].includes(input.value));
    });
    updateLeavePlan();
  }));
  document.querySelectorAll("[data-open-alerts]").forEach((b) => b.addEventListener("click", () => switchView("alerts")));
  updateLeavePlan();
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const trip = S.hot.find((r) => r.id === select.value);
    const leg = trip?.legs.find((l) => l.kind !== "walk");
    const phone = $("alertphone").value.replace(/\D/g, "");
    const kinds = [...form.querySelectorAll("input[name=kind]:checked")].map((i) => i.value);
    const days = [...form.querySelectorAll("input[name=day]:checked")].map((i) => i.value);
    const leaveBy = calculateLeaveBy(trip, arriveBy.value);
    if (phone.length !== 10 || !leg || !kinds.length || !days.length || !leaveBy) { $("alertsetupnote").textContent = "Enter a 10-digit number, an arrival time, and choose at least one alert and one day."; return; }
    const watch = { trip: trip.id, phone, carrier: $("alertcarrier").value, route: leg.kind === "hop" ? "HOP" : leg.routes[0], stop: leg.board, kinds, days, arrive_by: arriveBy.value, leave_by: leaveBy };
    const watches = JSON.parse(localStorage.getItem("hop_alert_preferences") || "[]").filter((w) => w.trip !== watch.trip);
    watches.push(watch); localStorage.setItem("hop_alert_preferences", JSON.stringify(watches));
    $("alertsetupnote").innerHTML = `<strong>Saved on this phone.</strong> ${esc(trip.name)} is set for ${esc(days.join(", "))}: arrive by ${esc(formatTime(arriveBy.value))}, leave by ${esc(formatTime(leaveBy))}. SMS delivery still needs the collector's private alert list; this screen keeps the exact location, schedule, and alert preference ready for it.`;
  });
}

function calculateLeaveBy(trip, arriveBy) {
  if (!arriveBy || !trip) return "";
  const [hour, minute] = arriveBy.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return "";
  const minutes = (hour * 60 + minute - (trip.travel_min || 20) - 5 + 1440) % 1440;
  return String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
}
function formatTime(value) {
  if (!value) return "—";
  const [hour, minute] = value.split(":").map(Number);
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(2020, 0, 1, hour, minute));
}
function updateLeavePlan() {
  const select = $("alerttrip"), arriveBy = $("arriveby"), plan = $("leaveplan");
  if (!select || !arriveBy || !plan) return;
  const trip = S.hot?.find((r) => r.id === select.value);
  const leaveBy = calculateLeaveBy(trip, arriveBy.value);
  const days = [...document.querySelectorAll("#alertform input[name=day]:checked")].map((i) => i.value);
  if (!trip || !leaveBy) { plan.textContent = "Choose a trip and arrival time to see the leave-by plan."; return; }
  plan.innerHTML = `<strong>Leave by ${esc(formatTime(leaveBy))}</strong><span>${esc(trip.travel_min || 20)} min trip + 5 min buffer · ${esc(days.join(", ") || "choose days")}</span>`;
}
boot().catch((e) => { $("statusline").textContent = "failed to load - " + e.message; });
