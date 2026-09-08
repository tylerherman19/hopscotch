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
  wireNav(); wireToggles(); loadHotRoutes().then(renderHotRoutes);
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
    renderVehicles(); renderRouteTable(); renderAlerts(); renderGhosts(); renderHotRoutes();
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
function renderHotRoutes() {
  const el = $("hotroutes");
  if (!el) return;
  if (!S.hot) { el.innerHTML = '<div class="empty">Loading...</div>'; return; }
  if (!S.hot.length) { el.innerHTML = '<div class="empty">No hot routes set up yet.</div>'; return; }
  el.innerHTML = S.hot.map((r) => `
    <div class="itin">
      <div class="itin-head"><span>${esc(r.name)}</span><span class="num">${esc(r.from)} &rarr; ${esc(r.to)}</span></div>
      ${r.legs.map((l) => l.kind === "walk"
        ? `<div class="leg walk"><span class="when"></span><span>${esc(l.text)}</span></div>`
        : `<div class="leg"><span class="when">${l.kind === "hop" ? "HOP" : esc(l.routes.join("/"))}</span>
             <span>${esc(l.text)}<br>${legLive(l)}</span></div>`).join("")}
    </div>`).join("");
}
boot().catch((e) => { $("statusline").textContent = "failed to load - " + e.message; });
