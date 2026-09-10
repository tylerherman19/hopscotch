/* Hopscotch — Milwaukee live transit, station-timetable edition.
   Light, flat, typographic. Reads only our snapshots (data branch live.json
   + main-branch static packs), never the feeds. Motion is functional only:
   vehicles interpolate along GTFS shapes between polls; countdowns tick;
   rows flash on refresh. No decorative animation. */
"use strict";

/* ================= config & state ================= */
const LIVE_BASE = "https://raw.githubusercontent.com/tylerherman19/hopscotch/data/";
const liveUrl = (f) => LIVE_BASE + f + "?t=" + Math.floor(Date.now() / 30000);
const HELEN = [43.03873, -87.91116];
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MOBILE = matchMedia("(max-width: 860px)").matches;

const S = {
  routes: [], routeById: {}, stops: {}, shapes2d: {}, tripIdx: {}, anchor: {},
  tt: {}, tindex: {}, calendar: {}, hop: null, hot: [], near: [], live: null, summary: undefined,
  veh: new Map(), isoRoute: "", selVeh: null, selStop: null, followId: null,
  showBus: true, showHop: true, fails: 0, lastPoll: 0, pollTimer: null,
  map: null, vlayer: null, slayer: null, proj: null, lastFrame: 0,
  _railVeh: null, _railStop: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fetchJson = async (u) => (await fetch(u, { cache: "no-store" })).json();

/* central-time helpers */
const ctFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true });
const ctDateFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric" });
const ctNowSec = () => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "numeric", second: "numeric", hour12: false }).formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return g("hour") * 3600 + g("minute") * 60 + g("second");
};
const fmtClock = (epoch) => ctFmt.format(new Date(epoch * 1000)).replace(" ", "").toLowerCase();
function fmtIn(sec) {
  if (sec < 0) return "due";
  if (sec < 60) return sec <= 20 ? "due" : sec + "s";
  const m = Math.floor(sec / 60);
  return m < 60 ? m + " min" : Math.floor(m / 60) + "h " + (m % 60) + "m";
}
function fmtCount(sec) { // hero: big tabular
  if (sec < 0) return "due";
  if (sec < 120) { const s = Math.max(0, Math.round(sec)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  const m = Math.round(sec / 60);
  return m < 60 ? m + " min" : Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0");
}

const routeColor = (r) => {
  if (r === "HOP") return "#" + ((S.hop?.routes[0]?.color || "8F7B25").replace("#", ""));
  return "#" + (S.routeById[r]?.color || "444444").replace("#", "");
};
const delayClass = (d) => d == null ? "" : d < 60 ? "ok" : d < 300 ? "late" : "bad";
const delayText = (d) => d == null ? "no data" : d < 60 ? "on time" : "+" + Math.round(d / 60) + " min";

/* ================= static data ================= */
async function loadStatic() {
  const st = await fetchJson("data/static.json");
  S.routes = st.routes; S.hop = st.hop; S.tindex = st.tindex || {}; S.calendar = st.calendar || {};
  S.stops = {};
  for (const [sid, name, lat, lon] of st.stops) S.stops[sid] = { name, lat, lon };
  for (const r of S.routes) S.routeById[r.id] = r;
  // anchor stop: nearest stop to Helen on each route (via stop_routes inversion)
  const routeStops = {};
  for (const [sid, rids] of Object.entries(st.stop_routes || {})) {
    for (const rid of rids) (routeStops[rid] ||= []).push(sid);
  }
  for (const r of S.routes) {
    let best = null, bd = 1e9;
    for (const sid of routeStops[r.id] || []) {
      const s = S.stops[sid]; if (!s) continue;
      const d = (s.lat - HELEN[0]) ** 2 + (s.lon - HELEN[1]) ** 2;
      if (d < bd) { bd = d; best = sid; }
    }
    if (best) S.anchor[r.id] = best;
  }
  // shape preprocessing: flatten rid|dir keys, cumulative meters + latlon arrays
  for (const [rid, dirs] of Object.entries(st.shapes)) {
    for (const [dir, pts] of Object.entries(dirs)) {
      const ll = pts.map((p) => [p[0], p[1]]), cum = [0];
      for (let i = 1; i < ll.length; i++) cum.push(cum[i - 1] + segLen(ll[i - 1], ll[i]));
      S.shapes2d[rid + "|" + dir] = { ll, cum, total: cum[cum.length - 1] };
    }
  }
  if (S.hop) for (const [rid, pts] of Object.entries(S.hop.lines)) {
    const ll = pts.map((p) => [p[0], p[1]]), cum = [0];
    for (let i = 1; i < ll.length; i++) cum.push(cum[i - 1] + segLen(ll[i - 1], ll[i]));
    S.shapes2d["HOP|" + rid] = { ll, cum, total: cum[cum.length - 1] };
  }
}
function segLen(a, b) {
  const R = 6371000, dLa = (b[0] - a[0]) * Math.PI / 180, dLo = (b[1] - a[1]) * Math.PI / 180;
  const la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
async function loadTtFor(routeIds) {
  const files = [...new Set(routeIds.map((r) => S.tindex[r]).filter((n) => n != null).map((n) => "data/tt-" + n + ".json"))];
  const packs = await Promise.all(files.map(fetchJson));
  for (const p of packs) {
    for (const [rid, pack] of Object.entries(p)) {
      S.tt[rid] = pack;
      for (const t of pack.trips) {
        S.tripIdx[+t[0]] = { route: rid, svc: t[1], pat: t[2], dir: +String(t[2]).split(".")[0], deltas: t[3], hs: pack.headsign[String(t[2]).split(".")[0]] || "" };
      }
    }
  }
}
/* active GTFS services for today (central), via static calendar */
function activeServices() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).replace(/-/g, "");
  const list = S.calendar[parts];
  if (list) return new Set(list);
  // fallback: month + weekday-part heuristic
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const part = d.getDay() === 0 ? "SUN" : d.getDay() === 6 ? "SAT" : "WK";
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()];
  return { has: (s) => typeof s === "string" && s.includes("_" + part) && s.includes(mon + "_") };
}
function nearRoutes() {
  const pins = JSON.parse(localStorage.getItem("hop_pins") || "[]").filter((r) => S.routeById[r] && S.anchor[r]);
  const hot = (S.hot || []).flatMap((t) => t.legs.filter((l) => l.kind === "bus").flatMap((l) => l.routes)).filter((r) => S.routeById[r] && S.anchor[r]);
  return [...new Set([...hot, ...pins, "14", "30", "12", "23"])].filter((r) => S.routeById[r] && S.anchor[r]);
}
function nearestHopStop() {
  let best = null, bd = 1e9;
  for (const s of S.hop.stops) { const d = (s.lat - HELEN[0]) ** 2 + (s.lon - HELEN[1]) ** 2; if (d < bd) { bd = d; best = s.id; } }
  return best;
}
function hopStopName(id) { return S.hop.stops.find((s) => s.id === id)?.name || ("Stop " + id); }

/* ================= map ================= */
function ensureMapLibre() {
  return new Promise((res, rej) => {
    if (window.maplibregl) return res();
    const s = document.createElement("script");
    s.src = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}
function initMap() {
  S.map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [HELEN[1], HELEN[0]], zoom: 14.2,
    attributionControl: { compact: true },
  });
  S.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  const mc = S.map.getContainer();
  S.vlayer = document.createElement("div"); S.vlayer.id = "vlayer"; mc.appendChild(S.vlayer);
  S.slayer = document.createElement("div"); S.slayer.id = "slayer"; mc.appendChild(S.slayer);
  S.map.on("load", () => {
    S.map.addSource("rlines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    S.map.addLayer({
      id: "rlines", type: "line", source: "rlines",
      paint: {
        "line-width": ["case", ["boolean", ["get", "iso"], false], 5, ["boolean", ["get", "alert"], false], 3.5, 3.5],
        "line-color": ["get", "color"], "line-opacity": ["case", ["boolean", ["get", "iso"], false], 1, 0.3],
        "line-dasharray": ["case", ["boolean", ["get", "alert"], false], ["literal", [5, 4]], ["literal", [1, 0]]],
      },
    });
    drawRouteLines(true); drawStops();
  });
  S.map.on("move", positionOverlays);
  S.map.on("click", (e) => {
    if (S._vehClicked) { S._vehClicked = false; return; }
    const f = S.map.queryRenderedFeatures(e.point, { layers: ["rlines"] });
    if (f.length && f[0].properties.rid) isolateRoute(f[0].properties.rid);
    else clearSelection();
  });
  S.map.on("mousemove", (e) => { $("coords").textContent = e.lngLat.lat.toFixed(4) + ", " + e.lngLat.lng.toFixed(4); });
}
function drawRouteLines(first) {
  if (!S.map || !S.map.getSource("rlines")) return;
  const feats = [];
  const alertRoutes = new Set((S.live?.alerts || []).flatMap((a) => a.routes || []));
  for (const rid of S.near) {
    if (rid === "HOP") {
      for (const hr of S.hop.routes) {
        const pts = S.hop.lines[hr.id]; if (!pts) continue;
        feats.push({ type: "Feature", properties: { rid: "HOP", color: routeColor("HOP"), iso: S.isoRoute === "HOP", alert: alertRoutes.has("HOP") || alertRoutes.has(hr.id) }, geometry: { type: "LineString", coordinates: pts.map((p) => [p[1], p[0]]) } });
      }
      continue;
    }
    for (const [key, sh] of Object.entries(S.shapes2d)) {
      if (!key.startsWith(rid + "|")) continue;
      feats.push({ type: "Feature", properties: { rid, color: routeColor(rid), iso: !!S.isoRoute && S.isoRoute === rid, alert: alertRoutes.has(rid) }, geometry: { type: "LineString", coordinates: sh.ll.map((p) => [p[1], p[0]]) } });
    }
  }
  S.map.getSource("rlines").setData({ type: "FeatureCollection", features: feats });
}
function drawStops() {
  if (!S.slayer || !S.map) return;
  S.slayer.innerHTML = "";
  if (S.map.getZoom() < 13.5) return;
  const seen = new Set();
  for (const rid of S.near) {
    if (rid === "HOP") continue;
    const pack = S.tt[rid]; if (!pack) continue;
    for (const pat of Object.values(pack.stops)) {
      for (const sid of pat) {
        if (seen.has(sid)) continue; seen.add(sid);
        const s = S.stops[sid]; if (!s) continue;
        const d = document.createElement("button");
        d.className = "stopdot"; d.title = s.name; d.setAttribute("aria-label", "Stop " + sid + ", " + s.name);
        d.dataset.lat = s.lat; d.dataset.lon = s.lon;
        d.addEventListener("click", (e) => { e.stopPropagation(); selectStop(sid); });
        S.slayer.appendChild(d);
      }
    }
  }
  positionOverlays();
}
function positionOverlays() {
  if (!S.map) return;
  const place = (el) => {
    const p = S.map.project([+el.dataset.lon, +el.dataset.lat]);
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
  };
  S.slayer.querySelectorAll(".stopdot").forEach(place);
}

/* ================= shape math ================= */
function projectToShape(lat, lon, sh) {
  // equirectangular projection is fine at this scale
  const kx = 82300, ky = 111320;
  const x = lon * kx, y = lat * ky;
  let best = null;
  for (let i = 0; i < sh.ll.length - 1; i++) {
    const ax = sh.ll[i][1] * kx, ay = sh.ll[i][0] * ky;
    const bx = sh.ll[i + 1][1] * kx, by = sh.ll[i + 1][0] * ky;
    const dx = bx - ax, dy = by - ay;
    const L2 = dx * dx + dy * dy; if (!L2) continue;
    let t = ((x - ax) * dx + (y - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx, py = ay + t * dy;
    const dist = Math.hypot(x - px, y - py);
    if (!best || dist < best.dist) {
      const segLenM = sh.cum[i + 1] - sh.cum[i];
      best = { s: sh.cum[i] + t * segLenM, dist, seg: i, frac: t };
    }
  }
  return best;
}
function pointAtS(sh, s) {
  s = Math.max(0, Math.min(sh.total, s));
  let lo = 0, hi = sh.cum.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (sh.cum[m] <= s) lo = m; else hi = m; }
  const segLenM = sh.cum[lo + 1] - sh.cum[lo] || 1;
  const t = (s - sh.cum[lo]) / segLenM;
  return [sh.ll[lo][0] + t * (sh.ll[lo + 1][0] - sh.ll[lo][0]), sh.ll[lo][1] + t * (sh.ll[lo + 1][1] - sh.ll[lo][1])];
}
const shapeAt = (key) => S.shapes2d[key];
function tripDir(tripId) { const t = S.tripIdx[+tripId]; return t ? t.dir : null; }
function tripHs(tripId) { const t = S.tripIdx[+tripId]; return t ? t.hs : ""; }
function vehicleShapeKey(v) {
  if (v.hop) return "HOP|" + v.route;
  const dir = tripDir(v.trip);
  const exact = dir != null ? v.route + "|" + dir : null;
  if (exact && shapeAt(exact)) return exact;
  // fallback: nearest shape of this route+direction
  let bestK = null, bd = 1e12;
  for (const [key, sh] of Object.entries(S.shapes2d)) {
    if (!key.startsWith(v.route + "|")) continue;
    if (dir != null && !key.endsWith("|" + dir) && !key.endsWith("|" + (1 - dir))) continue;
    const p = projectToShape(v.lat, v.lon, sh);
    if (p && p.dist < bd) { bd = p.dist; bestK = key; }
  }
  if (!bestK) for (const [key, sh] of Object.entries(S.shapes2d)) {
    if (!key.startsWith(v.route + "|")) continue;
    const p = projectToShape(v.lat, v.lon, sh);
    if (p && p.dist < bd) { bd = p.dist; bestK = key; }
  }
  return bestK;
}

/* ================= vehicles ================= */
function makeVehEl(st) {
  const el = document.createElement("button");
  el.className = "veh" + (st.hop ? " hopv" : "");
  el.style.setProperty("--vc", st.color);
  el.innerHTML = `<span class="tickwrap"><span class="tick"></span></span><span class="vnum">${esc(st.hop ? "H" : st.route)}</span>`;
  el.setAttribute("aria-label", (st.hop ? "Hop streetcar " : "Bus ") + st.id);
  el.addEventListener("click", (e) => { e.stopPropagation(); S._vehClicked = true; selectVehicle(st.id); });
  return el;
}
function ingestVehicles(list, isHop) {
  const now = Date.now() / 1000;
  const seen = new Set();
  for (const v of list) {
    const id = (isHop ? "H" : "B") + v.id;
    seen.add(id);
    const key = vehicleShapeKey({ ...v, hop: isHop });
    const sh = key ? shapeAt(key) : null;
    const proj = sh ? projectToShape(v.lat, v.lon, sh) : null;
    const target = proj ? proj.s : null;
    const color = isHop ? routeColor("HOP") : routeColor(v.route);
    let st = S.veh.get(id);
    if (!st) {
      st = {
        id, hop: isHop, route: isHop ? "HOP" : v.route, color,
        v, key, s: target ?? 0, sT: target ?? 0, lastUpd: now,
        speed: v.speed || 0, delay: v.delay ?? null,
        stale: false, el: null, x: 0, y: 0,
      };
      st.el = makeVehEl(st);
      S.vlayer.appendChild(st.el);
      S.veh.set(id, st);
    } else {
      // retarget: ease toward the new fix over ~1s
      if (target != null) { st.sT = target; st.s0 = st.s; st.sT0 = now; }
      st.v = v; st.key = key; st.lastUpd = now;
      st.speed = v.speed || 0; st.delay = v.delay ?? null;
    }
    if (st.el && !st.el.isConnected) S.vlayer.appendChild(st.el);
  }
  // retire vehicles gone >3 min (they ghost first via stale class)
  for (const [id, st] of S.veh) {
    if (!seen.has(id) && now - st.lastUpd > 180) { st.el?.remove(); S.veh.delete(id); }
  }
}

/* per-frame: dead reckoning + eased correction, flat markers */
let lastFrame = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (ts - lastFrame) / 1000 || 0.016);
  lastFrame = ts;
  const now = Date.now() / 1000;
  const iso = S.isoRoute;
  const show = (st) => (st.hop ? S.showHop : S.showBus);
  for (const st of S.veh.values()) {
    const el = st.el; if (!el) continue;
    const age = now - st.lastUpd;
    st.stale = age > 120;
    if (!RM && st.key) {
      // dead reckoning along shape + exponential ease to latest fix
      st.s += (st.speed || 0) * dt;
      if (st.sT != null && st.s0 != null) {
        const k = 1 - Math.exp(-dt * 2.2);
        st.s += (st.sT - st.s) * k;
        if (Math.abs(st.sT - st.s) < 0.5) st.s0 = null;
      }
    }
    const sh = st.key ? shapeAt(st.key) : null;
    const ll = sh ? pointAtS(sh, st.s) : [st.v.lat, st.v.lon];
    const p = S.map.project([ll[1], ll[0]]);
    st.x = p.x; st.y = p.y;
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    el.style.display = show(st) ? "" : "none";
    el.classList.toggle("stale", st.stale);
    el.classList.toggle("sel", S.selVeh === st.id);
    el.classList.toggle("dim", !!iso && st.route !== iso);
    const tw = el.firstChild;
    if (tw && st.v.heading != null && !st.stale) {
      tw.style.transform = `rotate(${st.v.heading}deg)`;
      tw.style.display = "";
    } else if (tw) tw.style.display = "none";
    // damped follow
    if (S.followId === st.id) {
      const c = S.map.getCenter();
      const nx = c.lng + (ll[1] - c.lng) * Math.min(1, dt * 3);
      const ny = c.lat + (ll[0] - c.lat) * Math.min(1, dt * 3);
      S.map.jumpTo({ center: [nx, ny] });
    }
  }
}

/* ================= selection ================= */
async function isolateRoute(rid) {
  S.isoRoute = S.isoRoute === rid ? "" : rid;
  if (S.isoRoute && !S.near.includes(S.isoRoute)) S.near.push(S.isoRoute);
  if (S.isoRoute && S.isoRoute !== "HOP" && !S.schedIdx[S.isoRoute]) await loadTtFor([S.isoRoute]);
  drawRouteLines(); renderBoard(); drawStops();
  if (S.isoRoute && S.map) {
    const key = S.isoRoute === "HOP" ? "HOP|" + S.hop.routes[0]?.id : S.isoRoute + "|0";
    const sh = shapeAt(key);
    if (sh) {
      const mid = sh.ll[Math.floor(sh.ll.length / 2)];
      S.map.flyTo({ center: [mid[1], mid[0]], zoom: Math.max(S.map.getZoom(), 12.5), duration: RM ? 0 : 700 });
    }
  }
}
function selectVehicle(id) {
  const st = S.veh.get(id); if (!st) return;
  S.selVeh = id; S.selStop = null;
  if (!st.hop && st.route !== S.isoRoute) { S.isoRoute = st.route; drawRouteLines(); renderBoard(); }
  openRailVehicle(st);
}
function selectStop(sid) {
  const s = S.stops[sid]; if (!s) return;
  S.selStop = sid; S.selVeh = null;
  if (S.map) S.map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(S.map.getZoom(), 15), duration: RM ? 0 : 600 });
  openRailStop(sid);
}
function clearSelection() {
  S.selVeh = null; S.selStop = null; S.followId = null;
  $("rail").hidden = true; $("etapill").hidden = true;
  if (S.isoRoute) { S.isoRoute = ""; drawRouteLines(); renderBoard(); drawStops(); }
  $("rail-track").textContent = "Follow this bus";
}

/* ================= departures ================= */
const ctMidEpoch = () => Math.floor(Date.now() / 1000) - ctNowSec();
function schedDepartures(rid, stopId, now, n) {
  // trip: [tripId, svcIdx, patternKey, deltas]; deltas[0] = sec since central
  // midnight at first stop, deltas[i] = seconds since previous stop (cumulative)
  const pack = S.tt[rid];
  if (!pack) return [];
  const mid = ctMidEpoch(), out = [];
  const active = activeServices();
  for (const t of pack.trips) {
    if (!active.has(pack.services[t[1]])) continue;
    const pat = pack.stops[t[2]]; if (!pat) continue;
    const idx = pat.indexOf(stopId);
    if (idx < 0) continue;
    let cum = t[3][0];
    for (let i = 1; i <= idx; i++) cum += t[3][i];
    const at = mid + cum;
    if (at < now - 120 || at > now + 3 * 3600) continue;
    const dir = +String(t[2]).split(".")[0];
    out.push({ at, in: at - now, dir, hs: pack.headsign[String(dir)] || "", sched: true });
  }
  out.sort((a, b) => a.at - b.at);
  const ded = [];
  for (const d of out) { if (!ded.length || d.at - ded[ded.length - 1].at > 90) ded.push(d); if (ded.length >= n) break; }
  return ded;
}
function routeDepartures(rid, now) {
  if (rid === "HOP") {
    const hs = nearestHopStop();
    const live = ((S.live?.hop_stops || {})[hs] || []).map((p) => ({ in: p[0], at: p[1], live: true, hs: "The Hop" }));
    return [{ dir: 0, hs: "The Hop · streetcar", deps: live.slice(0, 4) }];
  }
  const stopId = S.anchor[rid];
  const groups = new Map();
  const g = (dir, hs) => { if (!groups.has(dir)) groups.set(dir, { dir, hs: hs || "", deps: [] }); return groups.get(dir); };
  for (const p of (S.live?.stops || {})[stopId] || []) {
    const dir = tripDir(p[3]);
    g(dir ?? 0, tripHs(p[3])).deps.push({ in: p[1], at: p[2], live: true, dir, tripId: p[3] });
  }
  for (const s of schedDepartures(rid, stopId, now, 6)) g(s.dir, s.hs).deps.push(s);
  const out = [];
  for (const grp of groups.values()) {
    grp.deps.sort((a, b) => (b.live - a.live) || (a.at - b.at));
    const seen = new Set(); grp.deps = grp.deps.filter((d) => { const k = Math.round(d.at / 90); if (seen.has(k)) return false; seen.add(k); return true; });
    out.push(grp);
  }
  return out.sort((a, b) => (a.deps[0]?.at ?? 1e15) - (b.deps[0]?.at ?? 1e15));
}
function routeDelayChip(rid) {
  let worst = null, n = 0;
  for (const st of S.veh.values()) {
    if (st.route !== rid || st.stale) continue;
    n++; if (st.delay != null && (worst == null || st.delay > worst)) worst = st.delay;
  }
  if (!n) return "";
  return `<span class="delaychip ${delayClass(worst)}">${esc(delayText(worst))}</span>`;
}
function timeChip(d) {
  const sec = Math.round(d.at - Date.now() / 1000);
  const cls = "time" + (d.sched ? " sched" : "") + (sec <= 45 && !d.sched ? " due" : "");
  return `<span class="${cls}" data-at="${Math.round(d.at)}">${esc(fmtIn(sec))}</span>`;
}
function renderBoard() {
  const el = $("departboard");
  const now = Date.now() / 1000;
  el.innerHTML = S.near.map((rid) => {
    const groups = routeDepartures(rid, now);
    const r = S.routeById[rid];
    const dest = rid === "HOP" ? "The Hop" : (r?.long || ("Route " + rid));
    const sub = rid === "HOP" ? "Streetcar · " + esc(hopStopName(nearestHopStop())) : "Stop " + esc(S.anchor[rid]) + " · " + esc(S.stops[S.anchor[rid]]?.name || "");
    const body = groups.length ? groups.map((grp, gi) => `
      <div class="dgroup">
        <div class="dir">${esc((grp.hs || "").replace(/^To /i, "")) || "Departures"}</div>
        <div class="times">${grp.deps.slice(0, 3).map(timeChip).join("")}</div>
      </div>`).join("")
      : `<div class="brow-note">No departures in the next 3 hours.</div>`;
    return `<div class="brow${S.isoRoute === rid ? " isolated" : ""}" data-r="${esc(rid)}">
      <button class="brow-head" data-act="iso" aria-label="Isolate route ${esc(rid)}">
        <span class="routesq" style="background:${routeColor(rid)}">${esc(rid === "HOP" ? "H" : rid)}</span>
        <span class="dest"><b>${esc(dest)}</b><span>${sub}</span></span>
        ${routeDelayChip(rid)}
        <span class="go">→</span>
      </button>${body}</div>`;
  }).join("") || '<div class="empty">No routes pinned. Search for a route to add it.</div>';
  el.querySelectorAll(".brow-head").forEach((b) => b.addEventListener("click", () => {
    const rid = b.closest(".brow").dataset.r;
    isolateRoute(rid);
    if (MOBILE) $("board").classList.add("half");
  }));
}
function boardSkeleton() {
  $("departboard").innerHTML = Array.from({ length: 5 }, () =>
    `<div class="skel"><i class="w1"></i><i class="w2"></i><i class="w3"></i></div>`).join("");
}
/* per-second: tick countdowns, hero, feed stamp — values update in place, no re-render */
function tickChips() {
  const now = Date.now() / 1000;
  document.querySelectorAll("#departboard .time[data-at], .trip .t[data-at]").forEach((c) => {
    const sec = Math.round(+c.dataset.at - now);
    c.textContent = fmtIn(sec);
    c.classList.toggle("due", sec <= 45 && sec > -60 && !c.classList.contains("sched"));
  });
  tickHero(); tickFeed(); tickEtaPill(); tickRailCounts();
}
function heroDeparture() {
  const now = Date.now() / 1000;
  let best = null;
  for (const rid of S.near) {
    for (const grp of routeDepartures(rid, now)) {
      for (const d of grp.deps) {
        if (d.at < now - 60) continue;
        if (!best || d.at < best.d.at) best = { rid, grp, d };
      }
    }
  }
  return best;
}
function renderHero() {
  const h = heroDeparture(), hero = $("hero");
  if (!h) {
    hero.classList.add("nolive"); hero.classList.remove("boarding");
    $("hero-route").style.display = "none";
    $("hero-dest").textContent = "No departures right now";
    $("hero-count").textContent = "—";
    $("hero-status").textContent = S.live ? "check back shortly" : "waiting for feed";
    hero._at = null; return;
  }
  $("hero-route").style.display = "";
  const hr = $("hero-route");
  hr.textContent = h.rid === "HOP" ? "H" : h.rid;
  hr.style.background = routeColor(h.rid);
  $("hero-dest").textContent = (h.grp.hs || "").replace(/^To /i, "") || h.rid;
  const sec = Math.round(h.d.at - Date.now() / 1000);
  hero.classList.toggle("boarding", sec <= 30 && sec > -60 && !h.d.sched);
  hero.classList.remove("nolive");
  $("hero-status").textContent = h.d.sched ? "scheduled · " + fmtClock(h.d.at)
    : (h.rid === "HOP" ? "live · streetcar" : delayText([...S.veh.values()].find((s) => !s.hop && String(s.v.trip) === String(h.d.tripId))?.delay));
  hero._at = h.d.at;
  tickHero();
}
function tickHero() {
  const hero = $("hero");
  if (hero._at == null) return;
  const sec = Math.round(hero._at - Date.now() / 1000);
  $("hero-count").textContent = fmtCount(sec);
  $("hero-clock").textContent = fmtClock(hero._at);
  hero.classList.toggle("boarding", sec <= 30 && sec > -60 && !$("hero-status").textContent.startsWith("scheduled"));
}
function tickFeed() {
  const el = $("feedstat");
  if (!S.live) { el.textContent = "CONNECTING"; el.classList.remove("stale"); return; }
  const age = Math.round((Date.now() - S.lastPoll) / 1000);
  const n = S.live.counts?.buses ?? S.veh.size;
  el.textContent = `FEED LIVE · ${n} VEHICLES · ${age}S AGO`;
  el.classList.toggle("stale", age > 300);
  $("mast-date").textContent = ctDateFmt.format(new Date()).toUpperCase();
}

/* ================= trip rail ================= */
function openRailVehicle(st) {
  S._railVeh = st; S._railStop = null;
  const v = st.v;
  const rb = $("rail-route");
  rb.textContent = st.hop ? "H" : st.route;
  rb.style.background = st.color;
  $("rail-dest").textContent = (tripHs(v.trip) || "").replace(/^To /i, "") || (st.hop ? "The Hop" : "Route " + st.route);
  $("rail-sub").textContent = st.hop ? "streetcar " + v.id : "bus " + v.id + " · trip " + v.trip;
  $("rail-track").textContent = S.followId === st.id ? "Following" : (st.hop ? "Follow streetcar" : "Follow this bus");
  if (st.hop) {
    const hs = nearestHopStop();
    v._synth = ((S.live?.hop_stops || {})[hs] || []).map((p) => ({ stop: hs, at: p[1], in: p[0], name: hopStopName(hs) }));
  }
  $("rail").hidden = false;
  tickRailCounts(); renderRailStops();
  if (MOBILE) $("board").classList.remove("half", "full");
}
function anchorNext(st) {
  const v = st.v;
  const anchor = st.hop ? String(nearestHopStop()) : S.anchor[st.route];
  const next = v.next || v._synth || [];
  const i = next.findIndex((n) => String(n.stop) === String(anchor));
  return { i: i >= 0 ? i : 0, anchor, n: next[i >= 0 ? i : 0] };
}
function tickRailCounts() {
  const st = S._railVeh; if (!st || $("rail").hidden) return;
  const now = Date.now() / 1000;
  const { i, n } = anchorNext(st);
  const sec = n ? Math.max(0, Math.round(n.at - now)) : null;
  $("rail-eta").textContent = sec == null ? "—" : fmtIn(sec);
  $("rail-left").textContent = n ? String(i + 1) : "—";
  $("rail-status").textContent = delayText(st.delay);
}
function renderRailStops() {
  const st = S._railVeh; if (!st) return;
  const v = st.v, now = Date.now() / 1000;
  const next = v.next || v._synth || [];
  $("rail-stops").innerHTML = next.slice(0, 10).map((n, i) => {
    const sec = Math.round(n.at - now);
    return `<div class="rstop${i === 0 ? " here" : ""}">
      <span class="nd"></span><span class="sn">${esc(n.name || "Stop " + n.stop)}</span>
      <span class="st">${fmtIn(sec)}</span></div>`;
  }).join("") || '<div class="empty">No upcoming stops reported.</div>';
}
function openRailStop(sid) {
  S._railStop = sid; S._railVeh = null;
  const s = S.stops[sid];
  const rb = $("rail-route");
  rb.textContent = "S"; rb.style.background = "var(--ink)";
  $("rail-dest").textContent = "Stop " + sid;
  $("rail-sub").textContent = s.name;
  $("rail-eta").textContent = "—"; $("rail-left").textContent = "—"; $("rail-status").textContent = "stop";
  const preds = ((S.live?.stops || {})[sid] || []).slice().sort((a, b) => a[1] - b[1]).slice(0, 8);
  const now = Date.now() / 1000;
  $("rail-stops").innerHTML = preds.map((p) =>
    `<div class="rstop"><span class="nd"></span>
      <span class="sn"><b class="mono">${esc(p[0])}</b> · ${esc((tripHs(p[3]) || "").replace(/^To /i, ""))}</span>
      <span class="st">${fmtIn(Math.round(p[2] - now))}</span></div>`).join("")
    || '<div class="empty">No live departures at this stop right now.</div>';
  $("rail-track").textContent = "Notify me";
  $("rail").hidden = false;
}
function tickEtaPill() {
  const pill = $("etapill");
  if (!S.followId) { pill.hidden = true; return; }
  const st = S.veh.get(S.followId);
  if (!st) { pill.hidden = true; S.followId = null; return; }
  pill.hidden = false;
  const { n } = anchorNext(st);
  const sec = n ? Math.max(0, Math.round(n.at - Date.now() / 1000)) : null;
  $("etapill-text").textContent = sec == null ? "tracking" : fmtIn(sec) + " to your stop";
  const rb = $("etapill-route");
  rb.textContent = st.hop ? "H" : st.route;
  rb.style.background = st.color;
}
function startFollow(id) {
  S.followId = id;
  $("rail-track").textContent = "Following";
  toast("Following. The map stays with your bus.");
}
function saveWatch(w) {
  const all = JSON.parse(localStorage.getItem("hop_watches") || "[]").filter((x) => x.label !== w.label);
  all.push({ ...w, at: Date.now() });
  localStorage.setItem("hop_watches", JSON.stringify(all));
  toast("Watch saved on this device.");
}
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ================= live polling ================= */
async function refresh() {
  try {
    const live = await fetchJson(liveUrl("live.json"));
    S.fails = 0; S.live = live; S.lastPoll = Date.now();
    $("board-error").hidden = true;
    ingestVehicles(live.vehicles || [], false);
    ingestVehicles(live.hop || [], true);
    renderHero(); renderBoard(); renderTrips(); renderIntel(); updateDisrupt();
    drawRouteLines(); drawStops();
    if (S._railVeh) {
      if (!S.veh.has(S._railVeh.id)) { $("rail-sub").textContent += " · signal lost"; }
      else {
        if (S._railVeh.hop) {
          const hs = nearestHopStop();
          S._railVeh.v._synth = ((S.live?.hop_stops || {})[hs] || []).map((p) => ({ stop: hs, at: p[1], in: p[0], name: hopStopName(hs) }));
        }
        tickRailCounts(); renderRailStops();
      }
    }
    // subtle flash on the updated board so refreshes read as state changes
    document.querySelectorAll("#departboard .brow").forEach((b) => {
      b.classList.add("flash"); setTimeout(() => b.classList.remove("flash"), 450);
    });
  } catch (e) {
    S.fails++;
    console.warn("live fetch failed", e);
    const be = $("board-error");
    be.hidden = false;
    $("board-error-text").textContent = "FEED DOWN" + (S.lastPoll ? " · LAST UPDATE " + new Date(S.lastPoll).toLocaleTimeString("en-US", { hour12: false }) : "") + " · RETRYING";
  }
  clearTimeout(S.pollTimer);
  const active = S.followId || S.isoRoute || S.selVeh || !$("rail").hidden;
  let delay = active ? 15000 : 30000;
  if (S.fails) delay = Math.max(delay, Math.min(300000, 30000 * 2 ** Math.min(S.fails - 1, 4)));
  S.pollTimer = setTimeout(refresh, delay);
  tickChips();
}

/* ================= trips tab ================= */
function legPrediction(leg) {
  if (!S.live || !leg) return null;
  if (leg.kind === "hop") {
    const p = ((S.live.hop_stops || {})[String(leg.board)] || [])[0];
    return p ? { in: p[0], at: p[1], live: true } : null;
  }
  const p = ((S.live.stops || {})[leg.board] || []).filter((x) => leg.routes.includes(x[0])).sort((a, b) => a[1] - b[1])[0];
  return p ? { in: p[1], at: p[2], live: true, trip: p[3], route: p[0] } : null;
}
function renderTrips() {
  const el = $("trips"); if (!el || !S.hot) return;
  el.innerHTML = S.hot.map((t) => {
    const leg = t.legs.find((l) => l.kind !== "walk");
    const pred = legPrediction(leg);
    const line = leg.kind === "hop" ? "Hop streetcar" : "Bus " + leg.routes.join(" or ");
    const big = pred
      ? `<span class="t" data-at="${Math.round(pred.at)}">${esc(fmtIn(pred.in))}</span><span class="lbl">until it reaches you</span>`
      : `<span class="t sched">—</span><span class="lbl">no live bus listed yet</span>`;
    const meta = pred ? `<span>Leaves <b>${esc(fmtClock(pred.at))}</b></span><span>At ${esc(t.to)} about <b>${esc(fmtClock(pred.at + (t.travel_min || 20) * 60))}</b></span>` : "";
    const steps = t.legs.map((l) => `<div>${l.kind === "walk" ? esc(l.text) : "<b>" + esc(l.text) + "</b>"}</div>`).join("");
    return `<div class="trip">
      <div class="tline">${esc(line.toUpperCase())}${t.route_note ? " · " + esc(t.route_note) : ""}</div>
      <h3>${esc(t.name)}</h3>
      <div class="troute">${esc(t.from)} to ${esc(t.to)}</div>
      <div class="tnext">${big}</div><div class="tmeta">${meta}</div>
      <div class="tsteps">${steps}</div>
      <div class="tactions">
        <button class="btn ghost" data-a="map" data-t="${esc(t.id)}">See route</button>
        <button class="btn ghost" data-a="follow" data-t="${esc(t.id)}" ${pred?.trip ? "" : "disabled"}>${pred?.trip ? "Follow bus" : "No bus"}</button>
        <button class="btn ghost" data-a="notify" data-t="${esc(t.id)}">Notify me</button>
      </div></div>`;
  }).join("");
  el.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", () => {
    const t = S.hot.find((x) => x.id === b.dataset.t);
    const leg = t?.legs.find((l) => l.kind !== "walk");
    if (!t || !leg) return;
    if (b.dataset.a === "map") { isolateRoute(leg.kind === "hop" ? "HOP" : leg.routes[0]); switchTab("departures"); }
    if (b.dataset.a === "follow") {
      const p = legPrediction(leg);
      const st = [...S.veh.values()].find((s) => !s.hop && String(s.v.trip) === String(p?.trip));
      if (st) { selectVehicle(st.id); startFollow(st.id); }
    }
    if (b.dataset.a === "notify") { saveWatch({ trip: t.id, label: t.name }); b.classList.add("saved"); b.textContent = "Watching"; }
  }));
}

/* ================= intel tab ================= */
function updateDisrupt() {
  const d = $("disrupt");
  const rel = (S.live?.alerts || []).filter((a) => (a.routes || []).some((r) => S.near.includes(r)));
  if (!rel.length) { d.hidden = true; return; }
  d.hidden = false;
  $("disrupt-text").textContent = ((rel[0].title || "Service alert") + ": " + (rel[0].text || "")).slice(0, 140);
}
function renderIntel() {
  const alerts = S.live?.alerts || [];
  $("intel-alerts").innerHTML = alerts.length ? alerts.slice(0, 10).map((a) =>
    `<div class="alert"><div class="aroutes">${(a.routes || []).map((r) =>
      `<span class="routesq sm" style="background:${routeColor(r)}">${esc(r)}</span>`).join("")}</div>
      <h4>${esc(a.title || a.effect || "Alert")}</h4><p>${esc(a.text || "")}</p></div>`).join("")
    : '<div class="empty">No active alerts.</div>';
  const ghosts = (S.live?.ghosts || []).slice(0, 14);
  $("intel-ghosts").innerHTML = ghosts.length
    ? `<table class="gtable">${ghosts.map((g) =>
      `<tr><td><span class="routesq sm" style="background:${routeColor(g.route)}">${esc(g.route)}</span></td>
       <td>${esc((g.headsign || "").replace(/^To /i, ""))}</td><td>was due ${esc(g.sched)}</td></tr>`).join("")}</table>`
    : '<div class="empty">No ghost buses yesterday. Every scheduled trip showed up.</div>';
  renderRely();
}
async function renderRely() {
  const el = $("intel-rely");
  if (S.summary === undefined) { try { S.summary = await fetchJson(liveUrl("summary.json")); } catch { S.summary = null; } }
  const s = S.summary;
  if (!s) { el.innerHTML = '<div class="empty">Reliability stats are still collecting.</div>'; return; }
  const rows = s.routes || s.byRoute || [];
  if (!rows.length) {
    el.innerHTML = `<div class="empty">On time means the live feed showed under 3 min delay when checked. ${esc(s.snapshots || 0)} checks archived so far.</div>`;
    return;
  }
  el.innerHTML = rows.slice(0, 10).map((r) => {
    const pct = Math.round(r.onTime ?? r.pct ?? 0);
    return `<div class="rel-row"><span class="routesq sm" style="background:${routeColor(r.route || r.id)}">${esc(r.route || r.id)}</span>
      <div class="rel-bar"><i style="width:${pct}%"></i></div><b>${pct}%</b></div>`;
  }).join("");
}

/* ================= wiring ================= */
function switchTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("on", p.id === "tab-" + name));
}
function wireUI() {
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  const tgl = (id, key) => $(id).addEventListener("click", () => {
    S[key] = !S[key]; $(id).classList.toggle("on", S[key]); $(id).setAttribute("aria-pressed", S[key]);
  });
  tgl("tg-bus", "showBus"); tgl("tg-hop", "showHop");
  $("feedstat").addEventListener("click", () => { switchTab("intel"); if (MOBILE) $("board").classList.add("half"); });
  $("disrupt-more").addEventListener("click", () => switchTab("intel"));
  $("board-retry").addEventListener("click", () => { clearTimeout(S.pollTimer); refresh(); });
  $("rail-close").addEventListener("click", clearSelection);
  $("rail-track").addEventListener("click", () => {
    if (S._railStop) { const s = S.stops[S._railStop]; saveWatch({ stop: S._railStop, label: "Stop " + S._railStop + " · " + (s?.name || "") }); return; }
    const st = S._railVeh; if (!st) return;
    if (S.followId === st.id) { S.followId = null; $("etapill").hidden = true; $("rail-track").textContent = "Follow this bus"; }
    else startFollow(st.id);
  });
  $("rail-notify").addEventListener("click", () => {
    if (S._railStop) {
      const s = S.stops[S._railStop];
      saveWatch({ stop: S._railStop, label: "Stop " + S._railStop + " · " + (s?.name || "") });
      return;
    }
    const st = S._railVeh;
    saveWatch(st ? { route: st.route, stop: S.anchor[st.route], label: "Route " + st.route + " at " + (S.stops[S.anchor[st.route]]?.name || "") } : { label: "Hopscotch watch" });
  });
  $("etapill").addEventListener("click", (e) => {
    if (e.target.id === "etapill-x" || e.target.closest("#etapill-x")) {
      S.followId = null; $("etapill").hidden = true;
      if (S._railVeh) $("rail-track").textContent = "Follow this bus";
    } else if (S.followId) selectVehicle(S.followId);
  });
  // search
  const sb = $("searchbox"), si = $("searchinput");
  $("btn-search").addEventListener("click", () => {
    sb.hidden = !sb.hidden;
    if (!sb.hidden) { si.value = ""; renderSearch(""); setTimeout(() => si.focus(), 30); }
  });
  si.addEventListener("input", () => renderSearch(si.value));
  si.addEventListener("keydown", (e) => { if (e.key === "Enter") { const f = $("searchresults").querySelector(".sr-row"); if (f) f.click(); } });
  // keyboard
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== si) { e.preventDefault(); sb.hidden = false; si.value = ""; renderSearch(""); setTimeout(() => si.focus(), 30); }
    else if (e.key === "Escape") {
      if (!sb.hidden) sb.hidden = true;
      else if (S.selVeh || S.selStop) clearSelection();
      else if (S.isoRoute) isolateRoute(S.isoRoute);
    } else if (/^[1-9]$/.test(e.key) && document.activeElement !== si) {
      const rid = S.near[+e.key - 1]; if (rid) isolateRoute(rid);
    }
  });
  // mobile sheet: drag + tap to cycle detents
  const grab = $("sheetgrab"), board = $("board");
  let sy = 0, dragging = false;
  grab.addEventListener("pointerdown", (e) => { dragging = true; sy = e.clientY; grab.setPointerCapture(e.pointerId); });
  grab.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = e.clientY - sy;
    board.style.transition = "none";
    const base = board.classList.contains("full") ? 0 : board.classList.contains("half") ? board.offsetHeight * 0.38 : board.offsetHeight - 168;
    board.style.transform = `translateY(${Math.max(0, base + dy)}px)`;
  });
  const endDrag = (e) => {
    if (!dragging) return; dragging = false;
    board.style.transition = ""; board.style.transform = "";
    const dy = e.clientY - sy;
    board.classList.remove("half", "full");
    if (dy < -60) board.classList.add("full");
    else if (dy > 60) { /* stays peeked */ }
    else board.classList.add("half");
  };
  grab.addEventListener("pointerup", endDrag);
  grab.addEventListener("pointercancel", endDrag);
  grab.addEventListener("click", () => {
    if (board.classList.contains("full")) board.classList.remove("full");
    else if (board.classList.contains("half")) { board.classList.remove("half"); board.classList.add("full"); }
    else board.classList.add("half");
  });
  if (S.map) S.map.on("zoomend", drawStops);
}
function renderSearch(q) {
  q = q.trim().toLowerCase();
  const box = $("searchresults");
  const routes = S.routes.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.long || "").toLowerCase().includes(q)).slice(0, 6);
  const stops = Object.entries(S.stops).filter(([id, s]) => !q || s.name.toLowerCase().includes(q) || id.includes(q)).slice(0, 8);
  box.innerHTML =
    routes.map((r) => `<button class="sr-row" data-r="${esc(r.id)}"><span class="routesq sm" style="background:${routeColor(r.id)}">${esc(r.name)}</span><span>${esc(r.long || "")}</span><span class="mut">route</span></button>`).join("") +
    stops.map(([id, s]) => `<button class="sr-row" data-s="${esc(id)}"><span class="mut mono">▪</span><span>${esc(s.name)}</span><span class="mut">stop ${esc(id)}</span></button>`).join("")
    || '<div class="empty">No matches.</div>';
  box.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => { $("searchbox").hidden = true; isolateRoute(b.dataset.r); }));
  box.querySelectorAll("[data-s]").forEach((b) => b.addEventListener("click", () => { $("searchbox").hidden = true; selectStop(b.dataset.s); }));
}

/* ================= boot: instant shell, skeleton rows, no choreography ================= */
async function boot() {
  boardSkeleton();
  $("mast-date").textContent = ctDateFmt.format(new Date()).toUpperCase();
  try { await ensureMapLibre(); } catch (e) { /* map failed; board still works */ }
  if (window.maplibregl) initMap();
  try {
    await loadStatic();
  } catch (e) { console.error(e); $("board-error").hidden = false; $("board-error-text").textContent = "STATIC DATA FAILED TO LOAD · RETRYING"; return; }
  try { S.hot = (await fetchJson("data/hotroutes.json")).routes || []; } catch { S.hot = []; }
  S.near = [...nearRoutes(), "HOP"].filter((r, i, a) => a.indexOf(r) === i);
  wireUI();
  await loadTtFor(S.near.filter((r) => r !== "HOP"));
  await refresh();
  drawStops();
  if (S.map) {
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  }
  setInterval(tickChips, 1000);
}
document.addEventListener("DOMContentLoaded", boot);
