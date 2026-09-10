/* Hopscotch — MKE live transit console.
   Reads only our snapshots (data branch live.json + main-branch static packs), never the feeds. */
"use strict";

/* ================= config ================= */
const LIVE_BASE = "https://raw.githubusercontent.com/tylerherman19/hopscotch/data/";
const liveUrl = (f) => LIVE_BASE + f + "?cb=" + Math.floor(Date.now() / 30000);
const HELEN = [43.03873, -87.91116];            // Wisconsin & Plankinton
const HELEN_NAME = "Wisconsin & Plankinton";
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const MOBILE = matchMedia("(max-width: 760px)").matches;

/* ================= state ================= */
const S = {
  map: null, vlayer: null, proj: null,
  routes: [], routeById: {}, shapes: {}, stops: {}, stopRoutes: {}, calendar: {}, hop: null, tindex: {},
  tt: {}, tripIdx: {}, schedIdx: {},   // tt packs, trip->dir, route->pattern info
  anchor: {},                          // routeId -> nearest stop id to Helen
  near: [],                            // route ids near Helen (+ pinned)
  pins: new Set(JSON.parse(localStorage.getItem("hop_pins") || "[]")),
  live: null, summary: null, hot: null,
  veh: new Map(),                       // id -> vehicle render state
  isoRoute: "", selVeh: null, followId: null, selStop: null,
  showBus: true, showHop: true,
  lastPoll: 0, pollTimer: null, fails: 0,
  shapes2d: {},                         // route|dir -> {pts:[[x,y]], cum:[], total}
  lineSrc: null,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ================= time ================= */
const ctParts = (d = new Date()) => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return { y: +g("year"), mo: +g("month"), d: +g("day"), h: +g("hour") % 24, mi: +g("minute"), s: +g("second") };
};
const ctNowSec = () => { const c = ctParts(); return c.h * 3600 + c.mi * 60 + c.s; };
const ctDateKey = (off = 0) => { const c = ctParts(new Date(Date.now() + off * 864e5)); return `${c.y}${String(c.mo).padStart(2, "0")}${String(c.d).padStart(2, "0")}`; };
const ctMidEpoch = () => Math.floor(Date.now() / 1000) - ctNowSec();
const fmtClock = (ep) => new Date(ep * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });
function fmtIn(sec) {
  if (sec <= 45) return "now";
  if (sec < 120) { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; }
  return `${Math.round(sec / 60)} min`;
}
const delayClass = (d) => d == null ? "" : d < 180 ? "good" : d < 480 ? "warn" : "bad";
const delayText = (d) => d == null ? "" : d < 60 ? "on time" : `+${Math.round(d / 60)} min`;

/* ================= geo ================= */
const hav = (a, b) => {
  const R = 6371000, t = (x) => x * Math.PI / 180;
  const dLa = t(b[0] - a[0]), dLo = t(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(t(a[0])) * Math.cos(t(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const routeColor = (r) => {
  if (r === "HOP") return "#" + ((S.hop?.routes[0]?.color || "8F7B25").replace("#", ""));
  return "#" + (S.routeById[r]?.color || "3a81de").replace("#", "");
};

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + " -> " + r.status);
  return r.json();
}
function toast(msg, ms = 2600) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), ms);
}

/* ================= boot data ================= */
async function loadStatic() {
  const st = await fetchJson("data/static.json");
  S.routes = st.routes; S.routeById = Object.fromEntries(st.routes.map((r) => [r.id, r]));
  S.shapes = st.shapes; S.calendar = st.calendar; S.hop = st.hop; S.tindex = st.tindex || {};
  S.stopRoutes = st.stop_routes || {};
  S.stops = Object.fromEntries(st.stops.map((s) => [s[0], { name: s[1], lat: s[2], lon: s[3] }]));
  // anchor stop per route: nearest stop to Helen served by the route
  for (const r of S.routes) {
    const sids = S.stopRoutes[r.id] || [];
    let best = null, bd = 1e12;
    for (const sid of sids) {
      const stp = S.stops[sid]; if (!stp) continue;
      const d = hav(HELEN, [stp.lat, stp.lon]);
      if (d < bd) { bd = d; best = sid; }
    }
    if (best) S.anchor[r.id] = best;
  }
  // shape arc-length tables
  for (const [rid, dirs] of Object.entries(S.shapes))
    for (const [d, pts] of Object.entries(dirs)) {
      const xy = pts.map((p) => [p[1], p[0]]);
      const cum = [0];
      for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + hav(pts[i - 1], pts[i]));
      S.shapes2d[rid + "|" + d] = { pts: xy, cum, total: cum[cum.length - 1] || 1, ll: pts };
    }
  // hop lines
  for (const [rid, line] of Object.entries(S.hop.lines || {})) {
    const xy = line.map((p) => [p[1], p[0]]);
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + hav(line[i - 1], line[i]));
    S.shapes2d["HOP|" + rid] = { pts: xy, cum, total: cum[cum.length - 1] || 1, ll: line };
  }
}

async function loadTtFor(routes) {
  const need = new Set();
  for (const r of routes) { const i = S.tindex[r]; if (i != null && !S.tt[i]) need.add(i); }
  for (const i of need) {
    try {
      const pack = await fetchJson(`data/tt-${i}.json`);
      S.tt[i] = pack;
      for (const [rid, pr] of Object.entries(pack)) {
        for (const t of pr.trips) S.tripIdx[t[0]] = { r: rid, dir: t[2].split(".")[0], hs: (pr.headsign[t[2].split(".")[0]] || "").trim() };
        S.schedIdx[rid] = pr;
      }
    } catch (e) { console.warn("tt pack failed", i, e); }
  }
}

function nearRoutes() {
  const fromHot = new Set((S.hot || []).flatMap((t) => (t.legs || []).filter((l) => l.kind === "bus").flatMap((l) => l.routes || [])));
  const ids = [...new Set([...fromHot, ...S.pins])].filter((id) => S.routeById[id] && S.anchor[id]);
  const key = (id) => (fromHot.has(id) ? 0 : 1);
  return ids.sort((a, b) => key(a) - key(b) || a.localeCompare(b, undefined, { numeric: true }));
}

/* ================= map ================= */
async function ensureMapLibre() {
  if (window.maplibregl) return;
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js";
    s.onload = res; s.onerror = rej; document.head.appendChild(s);
  });
}

function initMap() {
  S.map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        dark: {
          type: "raster",
          tiles: ["https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                  "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
                  "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"],
          tileSize: 256, maxzoom: 19,
          attribution: "© OpenStreetMap contributors © CARTO",
        },
      },
      layers: [{ id: "dark", type: "raster", source: "dark", paint: { "raster-opacity": 0.92 } }],
    },
    center: [HELEN[1], HELEN[0]], zoom: 14.2, minZoom: 10.5, maxZoom: 17.5,
    attributionControl: { compact: true }, fadeDuration: RM ? 0 : 200,
  });
  S.map.on("load", () => {
    S.map.addSource("rlines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    S.map.addLayer({ id: "rlines-case", type: "line", source: "rlines",
      paint: { "line-color": "#05080e", "line-width": 7, "line-opacity": 0.9 } });
    S.map.addLayer({ id: "rlines", type: "line", source: "rlines",
      paint: { "line-color": ["get", "color"], "line-width": 3.5, "line-opacity": ["get", "op"] } });
    S.map.addLayer({ id: "rlines-dash", type: "line", source: "rlines",
      filter: ["==", ["get", "dash"], true],
      paint: { "line-color": "#ffffff", "line-width": 1.5, "line-dasharray": [2, 3], "line-opacity": 0.5 } });
    drawRouteLines(true);
  });
  // vehicle + stop overlay (raw divs, projected each frame — no marker churn)
  S.vlayer = document.createElement("div");
  S.vlayer.id = "vlayer";
  S.map.getContainer().appendChild(S.vlayer);
  S.proj = (lat, lon) => S.map.project([lon, lat]);

  // home marker
  const hm = document.createElement("div");
  hm.className = "homemarker"; hm.innerHTML = '<div class="hd"></div>';
  hm.title = "Helen's corner — " + HELEN_NAME;
  S.vlayer.appendChild(hm); S.homeEl = hm;

  S.map.on("move", positionOverlays);
  S.map.on("click", () => { if (!S._vehClicked) clearSelection(); S._vehClicked = false; });
  S.map.on("mousemove", (e) => {
    $("coords").textContent = `${Math.abs(e.lngLat.lat).toFixed(4)}°${e.lngLat.lat >= 0 ? "N" : "S"} · ${Math.abs(e.lngLat.lng).toFixed(4)}°${e.lngLat.lng >= 0 ? "E" : "W"}`;
  });
  // custom cursor
  const cur = $("mapcursor");
  S.map.getContainer().addEventListener("mousemove", (e) => {
    cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px";
    document.body.classList.add("maphover");
  });
  S.map.getContainer().addEventListener("mouseleave", () => document.body.classList.remove("maphover"));
}

/* ---- shape engine: arc-length param, projection, dead reckoning ---- */
function shapeAt(key) { return S.shapes2d[key]; }
function projectToShape(lat, lon, key) {
  const sh = shapeAt(key); if (!sh) return null;
  let bi = 0, bf = 0, bd = 1e18;
  for (let i = 0; i < sh.ll.length - 1; i++) {
    const a = sh.ll[i], b = sh.ll[i + 1];
    const abx = b[1] - a[1], aby = b[0] - a[0];
    const t = clamp(((lon - a[1]) * abx + (lat - a[0]) * aby) / (abx * abx + aby * aby || 1e-12), 0, 1);
    const px = a[0] + t * aby, py = a[1] + t * abx;
    const d = hav([lat, lon], [px, py]);
    if (d < bd) { bd = d; bi = i; bf = t; }
  }
  return { s: sh.cum[bi] + bf * (sh.cum[bi + 1] - sh.cum[bi]), dist: bd, seg: bi, frac: bf };
}
function pointAtS(key, s) {
  const sh = shapeAt(key); if (!sh) return null;
  s = clamp(s, 0, sh.total);
  let lo = 0, hi = sh.cum.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (sh.cum[m] <= s) lo = m; else hi = m; }
  const span = sh.cum[hi] - sh.cum[lo] || 1, t = (s - sh.cum[lo]) / span;
  const a = sh.ll[lo], b = sh.ll[hi];
  const dLa = b[0] - a[0], dLo = b[1] - a[1];
  return { lat: a[0] + t * dLa, lon: a[1] + t * dLo,
           bearing: (Math.atan2(dLo, dLa) * 180 / Math.PI + 360) % 360 };
}
function vehicleShapeKey(v) {
  if (v.hop) return "HOP|" + v.route;
  const ti = S.tripIdx[+v.trip];
  if (ti && shapeAt(v.route + "|" + ti.dir)) return v.route + "|" + ti.dir;
  // fallback: nearest shape of the route
  let best = null, bd = 1e18;
  for (const k of Object.keys(S.shapes2d)) {
    if (!k.startsWith(v.route + "|")) continue;
    const p = projectToShape(v.lat, v.lon, k);
    if (p && p.dist < bd) { bd = p.dist; best = k; }
  }
  return best;
}

/* ================= vehicle engine ================= */
function ingestVehicles(list, isHop) {
  const now = Date.now(), seen = new Set();
  for (const v of list) {
    const id = (isHop ? "H" : "B") + v.id;
    seen.add(id);
    let st = S.veh.get(id);
    const key = vehicleShapeKey({ ...v, hop: isHop });
    const proj = key ? projectToShape(v.lat, v.lon, key) : null;
    const target = proj ? proj.s : null;
    if (!st) {
      const el = document.createElement("div");
      el.className = "veh" + (RM ? "" : " pop");
      const color = isHop ? routeColor("HOP") : routeColor(v.route);
      const label = isHop ? "H" : esc(v.route);
      el.innerHTML = `<div class="chev"></div><div class="pin" style="background:${color}">${label}</div>`;
      el.addEventListener("click", (e) => { e.stopPropagation(); S._vehClicked = true; selectVehicle(id); });
      el.addEventListener("mouseenter", () => $("mapcursor").classList.add("hot"));
      el.addEventListener("mouseleave", () => $("mapcursor").classList.remove("hot"));
      if (!RM) el.style.animationDelay = Math.random() * 0.4 + "s";
      S.vlayer.appendChild(el);
      st = { id, el, s: target ?? 0, sT: target ?? 0, key, first: true };
      S.veh.set(id, st);
    } else {
      st.first = false;
      if (key && key !== st.key) { st.key = key; st.s = target ?? st.s; st.sT = target ?? st.sT; }
      else if (target != null) st.sT = target;
    }
    st.v = v; st.hop = isHop; st.seen = now;
    st.speed = clamp(isHop ? (v.speed || 8) : (v.speed || 0), 0, 28);
    st.bearing = isHop ? (v.heading ?? 0) : (v.bearing ?? 0);
    st.delay = isHop ? (v.delayed ? 300 : 0) : v.delay;
    st.route = isHop ? "HOP" : v.route;
  }
  // retire vehicles gone from the feed
  for (const [id, st] of S.veh) {
    if (seen.has(id)) continue;
    if (!st.goneAt) st.goneAt = now;
    if (now - st.goneAt > 180000) { st.el.remove(); S.veh.delete(id); }
    else st.el.classList.add("ghost");
  }
}

let lastFrame = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = clamp((ts - lastFrame) / 1000 || 0.016, 0, 0.12);
  lastFrame = ts;
  const now = Date.now();
  const iso = S.isoRoute, sel = S.selVeh;
  const showBus = S.showBus, showHop = S.showHop;
  for (const st of S.veh.values()) {
    const ok = st.hop ? showHop : showBus;
    if (!ok) { st.el.style.display = "none"; continue; }
    st.el.style.display = "";
    // advance along shape (dead reckoning) + ease toward latest reported position
    if (!RM && st.key) {
      st.s = clamp(st.s + st.speed * dt, 0, shapeAt(st.key).total);
      const k = 1 - Math.exp(-dt / 0.9);
      st.s += (st.sT - st.s) * k;
    } else if (st.key) st.s = st.sT;
    const p = pointAtS(st.key, st.s) || { lat: st.v.lat, lon: st.v.lon, bearing: st.bearing };
    const age = now - st.seen;
    st.el.classList.toggle("ghost", age > 120000);
    st.el.classList.toggle("sel", sel === st.id);
    st.el.classList.toggle("dim", !!iso && st.route !== iso && !(iso === "HOP" && st.hop));
    const pt = S.proj(p.lat, p.lon);
    st.el.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px)`;
    const chev = st.el.firstChild;
    if (chev) chev.style.transform = `rotate(${(p.bearing - 45).toFixed(0)}deg)`;
    st._pos = p;
  }
  // home marker
  if (S.homeEl) {
    const pt = S.proj(HELEN[0], HELEN[1]);
    S.homeEl.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
  }
  positionStops();
  // follow mode: damped camera
  if (S.followId) {
    const st = S.veh.get(S.followId);
    if (st && st._pos) {
      const c = S.map.getCenter();
      const nx = c.lng + (st._pos.lon - c.lng) * 0.12, ny = c.lat + (st._pos.lat - c.lat) * 0.12;
      S.map.setCenter([nx, ny]);
    }
  }
}

function positionOverlays() { /* positions refresh on next rAF automatically */ }

/* ---- stop dots (zoom-gated) ---- */
let stopEls = [];
function drawStops() {
  for (const e of stopEls) e.remove();
  stopEls = [];
  if (S.map.getZoom() < 13.2) return;
  const routes = S.isoRoute ? [S.isoRoute] : S.near;
  const seen = new Set();
  for (const rid of routes) {
    const pr = S.schedIdx[rid]; if (!pr) continue;
    for (const pat of Object.values(pr.stops)) for (const sid of pat) {
      if (seen.has(sid)) continue; seen.add(sid);
      const s = S.stops[sid]; if (!s) continue;
      const el = document.createElement("div");
      el.className = "stopdot"; el.innerHTML = "<i></i>"; el.title = s.name;
      el.addEventListener("click", (e) => { e.stopPropagation(); S._vehClicked = true; selectStop(sid); });
      S.vlayer.appendChild(el);
      el._lat = s.lat; el._lon = s.lon;
      stopEls.push(el);
    }
  }
  positionStops();
}
function positionStops() {
  for (const el of stopEls) {
    const pt = S.proj(el._lat, el._lon);
    el.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
  }
}

/* ---- route lines ---- */
function drawRouteLines(first) {
  if (!S.map.getSource("rlines")) return;
  const feats = [];
  const disrupted = new Set((S.live?.alerts || []).flatMap((a) => a.routes || []));
  const routes = [...new Set([...S.near, ...(S.isoRoute ? [S.isoRoute] : [])])];
  for (const rid of routes) {
    const iso = S.isoRoute === rid;
    const op = S.isoRoute ? (iso ? 1 : 0.12) : 0.8;
    const dash = disrupted.has(rid);
    const push = (key, color) => {
      const sh = shapeAt(key); if (!sh) return;
      feats.push({ type: "Feature", properties: { color, op, dash },
        geometry: { type: "LineString", coordinates: sh.pts } });
    };
    if (rid === "HOP") {
      for (const hr of S.hop.routes) push("HOP|" + hr.id, "#" + hr.color.replace("#", ""));
    } else {
      for (const d of Object.keys(S.shapes[rid] || {})) push(rid + "|" + d, routeColor(rid));
    }
    if (first && !RM) {
      // draw-on animation: dashoffset trick via a temporary layer is skipped; rely on fade
    }
  }
  S.map.getSource("rlines").setData({ type: "FeatureCollection", features: feats });
}

/* ================= departures ================= */
function tripDir(tripId) { return S.tripIdx[+tripId]?.dir ?? null; }
function tripHs(tripId) { return S.tripIdx[+tripId]?.hs || ""; }

// scheduled departures at a stop for a route, from tt packs
function schedDepartures(rid, stopId, fromEp, n = 4) {
  const pr = S.schedIdx[rid]; if (!pr) return [];
  const active = new Set(S.calendar[ctDateKey()] || []);
  const out = [];
  for (const t of pr.trips) {
    if (!active.has(pr.services[t[1]])) continue;
    const pat = pr.stops[t[2]]; if (!pat) continue;
    const i = pat.indexOf(stopId); if (i < 0) continue;
    let at = ctMidEpoch() + t[3][0];
    for (let k = 1; k <= i; k++) at += t[3][k];
    if (at < fromEp - 60) continue;
    const dir = t[2].split(".")[0];
    out.push({ at, in: at - Math.floor(Date.now() / 1000), dir, hs: (pr.headsign[dir] || "").trim(), live: false });
  }
  return out.sort((a, b) => a.at - b.at).slice(0, n);
}

// merged live + scheduled departures grouped by direction for one route
function routeDepartures(rid) {
  const now = Math.floor(Date.now() / 1000);
  const stopId = S.anchor[rid];
  const groups = new Map(); // dir -> {hs, deps:[]}
  const g = (dir, hs) => {
    if (!groups.has(dir)) groups.set(dir, { hs: hs || "", deps: [] });
    return groups.get(dir);
  };
  if (rid === "HOP") {
    const hs = "The Hop · " + ((S.hop.routes[0] || {}).name || "Streetcar");
    const grp = g("0", hs);
    const hstop = nearestHopStop();
    for (const p of ((S.live?.hop_stops || {})[hstop] || []))
      grp.deps.push({ at: p[1], in: p[0], live: true, dir: "0", hs });
    if (!grp.deps.length) { /* scheduled fallback unavailable for Hop; leave empty */ }
    return { stopId: hstop, stopName: hopStopName(hstop), groups: [...groups.values()] };
  }
  const preds = ((S.live?.stops || {})[stopId] || []).filter((p) => p[0] === rid).sort((a, b) => a[1] - b[1]);
  for (const p of preds.slice(0, 6)) {
    const dir = tripDir(p[3]) ?? "0";
    const grp = g(dir, tripHs(p[3]));
    if (p[1] > -90) grp.deps.push({ at: p[2], in: p[1], live: true, dir, hs: grp.hs, trip: p[3] });
  }
  // fill with scheduled where live is thin
  for (const [dir, grp] of groups) {
    if (grp.deps.filter((d) => d.live).length >= 3) continue;
    for (const s of schedDepartures(rid, stopId, now)) {
      if (s.dir !== dir) continue;
      if (grp.deps.some((d) => Math.abs(d.at - s.at) < 90)) continue;
      grp.deps.push({ ...s, hs: grp.hs || s.hs });
      if (grp.deps.filter((d) => d.live).length + grp.deps.filter((d) => !d.live).length >= 3) break;
    }
    grp.deps.sort((a, b) => a.at - b.at);
    grp.deps = grp.deps.slice(0, 3);
  }
  // scheduled-only directions (no live vehicles yet)
  for (const s of schedDepartures(rid, stopId, now, 6)) {
    const grp = g(s.dir, s.hs);
    if (!grp.deps.some((d) => Math.abs(d.at - s.at) < 90)) grp.deps.push(s);
    grp.deps.sort((a, b) => a.at - b.at);
  }
  for (const grp of groups.values()) grp.deps = grp.deps.slice(0, 3);
  const stp = S.stops[stopId];
  return { stopId, stopName: stp?.name, groups: [...groups.values()].sort((a, b) => (a.deps[0]?.at || 1e15) - (b.deps[0]?.at || 1e15)) };
}

function nearestHopStop() {
  let best = null, bd = 1e12;
  for (const s of S.hop.stops || []) {
    const d = hav(HELEN, [s.lat, s.lon]);
    if (d < bd) { bd = d; best = s.id; }
  }
  return best;
}
function hopStopName(id) {
  const s = (S.hop.stops || []).find((x) => x.id === id);
  return s ? s.name : "Hop stop";
}

/* ---- hero: the single soonest departure ---- */
function computeHero() {
  let best = null;
  for (const rid of S.near) {
    const { groups, stopName } = routeDepartures(rid);
    for (const grp of groups) {
      const d0 = grp.deps[0]; if (!d0) continue;
      if (!best || d0.at < best.at) best = { ...d0, rid, stopName, hs: grp.hs };
    }
  }
  return best;
}

function renderHero() {
  const h = computeHero();
  const hero = $("hero"), t = $("hero-time");
  if (!h) {
    hero.dataset.ghost = "--";
    t.textContent = "--:--"; $("hero-unit").textContent = "";
    $("hero-dest").textContent = "No departures right now";
    $("hero-sub").textContent = "Check back shortly — the feed may be quiet overnight.";
    $("hero-route").style.display = "none";
    hero.classList.remove("boarding");
    hero._at = null; return;
  }
  $("hero-route").style.display = "";
  const r = S.routeById[h.rid];
  const rb = $("hero-route");
  rb.textContent = h.rid === "HOP" ? "H" : (r?.name || h.rid);
  rb.style.background = h.rid === "HOP" ? "#" + (S.hop.routes[0]?.color || "8F7B25").replace("#", "") : routeColor(h.rid);
  const dest = h.hs ? h.hs.replace(/^To /i, "") : (r?.long || "");
  $("hero-dest").textContent = (h.rid === "HOP" ? "Hop · " : "") + dest;
  $("hero-sub").innerHTML = `${esc(h.stopName || "")} · ${h.live ? '<span style="color:var(--green)">live</span>' : '<span style="color:var(--dim)">scheduled</span>'}`;
  $("hero-stop").textContent = "Helen's corner";
  hero.dataset.ghost = h.rid === "HOP" ? "H" : (r?.name || "");
  hero._at = h.at; hero._dep = h;
  tickHero();
}
function tickHero() {
  const hero = $("hero"); if (hero._at == null) return;
  const sec = Math.round(hero._at - Date.now() / 1000);
  const t = $("hero-time"), u = $("hero-unit");
  const boarding = sec <= 30;
  hero.classList.toggle("boarding", boarding);
  t.classList.toggle("boarding", boarding);
  if (boarding) { t.textContent = "BOARD"; u.textContent = "leaving now"; }
  else { t.textContent = fmtIn(sec); u.textContent = sec < 120 ? "until departure" : ""; }
  const rail = $("hero-rail").firstElementChild;
  if (rail) rail.style.transform = `scaleX(${clamp(1 - sec / 1500, 0.02, 1)})`;
}

/* ---- board ---- */
function routeDelayChip(rid) {
  let worst = null, n = 0;
  for (const st of S.veh.values()) {
    if (st.hop || st.route !== rid) continue;
    n++;
    if (st.delay != null) worst = Math.max(worst ?? -1e9, st.delay);
  }
  if (!n) return "";
  if (worst != null && worst >= 480) return `<span class="dchip bad">${delayText(worst)}</span>`;
  if (worst != null && worst >= 180) return `<span class="dchip warn">${delayText(worst)}</span>`;
  return `<span class="dchip good">on time</span>`;
}

function renderBoard() {
  const el = $("board");
  const old = new Map([...el.querySelectorAll(".chip[data-at]")].map((c) => [c.dataset.k, c.textContent]));
  el.innerHTML = S.near.map((rid, i) => {
    const r = S.routeById[rid];
    const { groups, stopName } = routeDepartures(rid);
    const name = rid === "HOP" ? "The Hop" : `Route ${r?.name || rid}`;
    const via = rid === "HOP" ? "streetcar · downtown loop" : esc(r?.long || "");
    const pinned = S.pins.has(rid);
    const gs = groups.map((grp, gi) => {
      if (!grp.deps.length) return "";
      const chips = grp.deps.map((d, ci) => {
        const cls = "chip" + (d.live ? (ci === 0 ? " next" : "") : " sched") + (d.in <= 30 && d.live ? " boarding" : "");
        return `<span class="${cls}" data-at="${d.at}" data-k="${rid}|${grp.dir ?? gi}|${ci}">${esc(fmtIn(d.in))}</span>`;
      }).join("");
      const dot = grp.deps[0].live ? '<i class="dot live"></i>' : '<i class="dot sched"></i>';
      const dest = esc((grp.hs || "").replace(/^To /i, "") || "—");
      return `<div class="bgroup"><div class="bdest">${dot}<span class="dst">${dest}</span><span class="stopname">${esc(stopName || "")}</span></div><div class="chips">${chips}</div></div>`;
    }).join("");
    const body = gs || `<div class="bnote">No departures listed — ${esc(nextServiceNote(rid))}</div>`;
    return `<div class="brow${S.isoRoute === rid ? " isolated" : ""}" data-route="${esc(rid)}" style="animation-delay:${i * 45}ms">
      <button class="brow-head" data-act="iso">
        <span class="rbullet" style="background:${rid === "HOP" ? "#" + (S.hop.routes[0]?.color || "8F7B25").replace("#", "") : routeColor(rid)}">${rid === "HOP" ? "H" : esc(r?.name || rid)}</span>
        <span class="rname">${esc(name)}<small>${via}</small></span>
        ${routeDelayChip(rid)}
      </button>${body}</div>`;
  }).join("");
  // flash changed values (in-place update language)
  for (const c of el.querySelectorAll(".chip[data-at]")) {
    if (old.has(c.dataset.k) && old.get(c.dataset.k) !== c.textContent) c.classList.add("flash");
  }
  el.querySelectorAll(".brow-head").forEach((b) =>
    b.addEventListener("click", () => isolateRoute(b.closest(".brow").dataset.route)));
  tickChips();
}

function nextServiceNote(rid) {
  const now = Math.floor(Date.now() / 1000);
  const stopId = S.anchor[rid];
  const pr = S.schedIdx[rid];
  if (!pr || !stopId) return "no schedule data";
  const active = new Set(S.calendar[ctDateKey()] || []);
  let best = null;
  for (const t of pr.trips) {
    if (!active.has(pr.services[t[1]])) continue;
    const pat = pr.stops[t[2]]; const i = pat ? pat.indexOf(stopId) : -1; if (i < 0) continue;
    let at = ctMidEpoch() + t[3][0];
    for (let k = 1; k <= i; k++) at += t[3][k];
    if (at > now && (!best || at < best)) best = at;
  }
  return best ? `service resumes ${fmtClock(best)}` : "no more service today";
}

// 1s ticker: countdown chips + hero + freshness + ETA pill
function tickChips() {
  const now = Date.now() / 1000;
  for (const c of document.querySelectorAll(".chip[data-at]")) {
    const sec = Math.round(+c.dataset.at - now);
    const txt = fmtIn(sec);
    if (c.textContent !== txt) { c.textContent = txt; c.classList.add("flash"); setTimeout(() => c.classList.remove("flash"), 550); }
    c.classList.toggle("boarding", sec <= 30 && sec > -60 && !c.classList.contains("sched"));
  }
  tickHero(); tickFresh(); tickEtaPill();
  if (!$("triprail").hidden && S._railVeh) tickRailCounts();
}

function tickFresh() {
  const dot = $("livedot"), age = $("age"), vc = $("vehcount");
  if (!S.live) { dot.className = "dot"; age.textContent = "…"; return; }
  const a = Math.max(0, Math.floor(Date.now() / 1000 - S.live.ts));
  dot.className = "dot " + (a < 90 ? "fresh" : a < 300 ? "stale" : "dead");
  age.textContent = a < 15 ? "just now" : a < 90 ? `${a}s ago` : a < 3600 ? `${Math.floor(a / 60)}m ago` : "feed down";
  const n = (S.live.counts?.buses ?? S.live.vehicles?.length ?? 0) + (S.live.counts?.hop ?? S.live.hop?.length ?? 0);
  vc.textContent = n || "—";
}

/* ================= selection ================= */
async function isolateRoute(rid) {
  S.isoRoute = S.isoRoute === rid ? "" : rid;
  if (S.isoRoute && !S.near.includes(S.isoRoute)) S.near.push(S.isoRoute);
  if (S.isoRoute && S.isoRoute !== "HOP" && !S.schedIdx[S.isoRoute]) {
    await loadTtFor([S.isoRoute]); // fetch its timetable on demand
  }
  drawRouteLines(); renderBoard(); drawStops();
  if (S.isoRoute) {
    const key = S.isoRoute === "HOP" ? "HOP|" + S.hop.routes[0]?.id : S.isoRoute + "|0";
    const sh = shapeAt(key);
    if (sh) {
      const mid = sh.ll[Math.floor(sh.ll.length / 2)];
      S.map.flyTo({ center: [mid[1], mid[0]], zoom: Math.max(S.map.getZoom(), 12.5), duration: RM ? 0 : 900 });
    }
  }
}

function selectVehicle(id) {
  const st = S.veh.get(id); if (!st) return;
  S.selVeh = id; S.selStop = null;
  if (st.route !== "HOP" && st.route !== S.isoRoute) { S.isoRoute = st.route; drawRouteLines(); renderBoard(); }
  openRailVehicle(st);
}
function selectStop(sid) {
  const s = S.stops[sid]; if (!s) return;
  S.selStop = sid; S.selVeh = null;
  S.map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(S.map.getZoom(), 15), duration: RM ? 0 : 800 });
  openRailStop(sid);
}
function clearSelection() {
  S.selVeh = null; S.selStop = null; S.followId = null;
  $("triprail").hidden = true; $("etapill").hidden = true;
  if (S.isoRoute) { S.isoRoute = ""; drawRouteLines(); renderBoard(); drawStops(); }
  $("rail-track").textContent = "Follow this bus";
}

/* ---- trip rail: vehicle mode ---- */
function openRailVehicle(st) {
  S._railVeh = st; S._railStop = null;
  const v = st.v;
  const rb = $("rail-route");
  rb.textContent = st.hop ? "H" : st.route;
  rb.style.background = st.hop ? "#" + (S.hop.routes[0]?.color || "8F7B25").replace("#", "") : routeColor(st.route);
  const hs = st.hop ? "The Hop · streetcar" : (tripHs(v.trip) || S.routeById[st.route]?.long || "");
  $("rail-dest").textContent = (hs || "").replace(/^To /i, "") || `Route ${st.route}`;
  $("rail-sub").textContent = st.hop ? `car ${v.id} · ${Math.round(v.heading ?? 0)}°` : `bus ${v.id} · trip ${v.trip}`;
  $("rail-track").textContent = S.followId === st.id ? "Following ✓" : (st.hop ? "Follow streetcar" : "Follow this bus");
  // Hop vehicles carry no per-vehicle predictions; synthesize from the nearest stop's board
  if (st.hop) {
    const hs = nearestHopStop();
    st.v._synth = ((S.live?.hop_stops || {})[hs] || []).map((p) => ({ stop: hs, at: p[1], in: p[0], name: hopStopName(hs) }));
  }
  const rail = $("triprail"); rail.hidden = false;
  tickRailCounts(); renderRailStops();
  if (MOBILE) $("panel").classList.remove("half", "full");
}
function anchorNext(st) {
  const v = st.v;
  const anchor = st.hop ? String(nearestHopStop()) : S.anchor[st.route];
  const next = v.next || v._synth || [];
  const i = next.findIndex((n) => String(n.stop) === String(anchor));
  return { i: i >= 0 ? i : 0, anchor, n: next[i >= 0 ? i : 0] };
}
function tickRailCounts() {
  const st = S._railVeh; if (!st || $("triprail").hidden) return;
  const v = st.v, now = Date.now() / 1000;
  const { i, n } = anchorNext(st);
  const sec = n ? Math.max(0, Math.round(n.at - now)) : null;
  $("rail-eta").textContent = sec == null ? "—" : fmtIn(sec);
  $("rail-left").textContent = n ? String(i + 1) : "—";
  const d = st.delay, el = $("rail-status");
  el.textContent = d == null ? "no data" : d < 60 ? "on time" : `+${Math.round(d / 60)}m`;
  el.className = delayClass(d);
  el.id = "rail-status";
}
function renderRailStops() {
  const st = S._railVeh; if (!st) return;
  const v = st.v, now = Date.now() / 1000;
  const el = $("rail-stops");
  const next = v.next || v._synth || [];
  el.innerHTML = next.slice(0, 10).map((n, i) => {
    const sec = Math.round(n.at - now);
    return `<div class="rstop${i === 0 ? " here" : ""}">
      <span class="nd"></span><span class="sn">${esc(n.name || "Stop " + n.stop)}</span>
      <span class="st${st.delay >= 240 ? " late" : ""}">${sec <= 45 ? "due" : fmtIn(sec)}</span></div>`;
  }).join("") || '<div class="empty">No upcoming stops reported.</div>';
}

/* ---- trip rail: stop mode ---- */
function openRailStop(sid) {
  S._railStop = sid; S._railVeh = null;
  const s = S.stops[sid];
  $("rail-route").textContent = "◉"; $("rail-route").style.background = "#1c2942";
  $("rail-dest").textContent = `Stop ${sid}`;
  $("rail-sub").textContent = s.name;
  $("rail-eta").textContent = "—"; $("rail-left").textContent = "—";
  const se = $("rail-status"); se.textContent = "stop"; se.className = ""; se.id = "rail-status";
  const preds = ((S.live?.stops || {})[sid] || []).slice().sort((a, b) => a[1] - b[1]).slice(0, 8);
  const now = Date.now() / 1000;
  $("rail-stops").innerHTML = preds.map((p) => {
    const sec = Math.round(p[2] - now);
    const hs = tripHs(p[3]);
    return `<div class="rstop"><span class="nd"></span>
      <span class="sn"><b class="mono">${esc(p[0])}</b> · ${esc((hs || "").replace(/^To /i, ""))}</span>
      <span class="st">${fmtIn(sec)}</span></div>`;
  }).join("") || '<div class="empty">No live departures at this stop right now.</div>';
  $("rail-track").textContent = "Notify me";
  $("triprail").hidden = false;
}

/* ---- ETA pill ---- */
function tickEtaPill() {
  const pill = $("etapill");
  if (!S.followId) { pill.hidden = true; return; }
  const st = S.veh.get(S.followId);
  if (!st) { pill.hidden = true; S.followId = null; return; }
  pill.hidden = false;
  const { n } = anchorNext(st);
  const sec = n ? Math.max(0, Math.round(n.at - Date.now() / 1000)) : null;
  $("etapill-text").textContent = sec == null ? "tracking…" : `${fmtIn(sec)} to your stop`;
  const rb = $("etapill-route");
  rb.textContent = st.hop ? "H" : st.route;
  rb.style.background = st.hop ? "#" + (S.hop.routes[0]?.color || "8F7B25").replace("#", "") : routeColor(st.route);
}

/* ================= live polling ================= */
async function refresh() {
  try {
    const live = await fetchJson(liveUrl("live.json"));
    S.fails = 0; S.live = live; S.lastPoll = Date.now();
    ingestVehicles(live.vehicles || [], false);
    ingestVehicles(live.hop || [], true);
    renderHero(); renderBoard(); renderTrips(); renderIntel(); updateAlertBanner();
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
  } catch (e) { S.fails++; console.warn("live fetch failed", e); }
  clearTimeout(S.pollTimer);
  const active = S.followId || S.isoRoute || S.selVeh || !$("triprail").hidden;
  let delay = active ? 15000 : 30000;
  if (S.fails) delay = Math.max(delay, Math.min(300000, 30000 * 2 ** Math.min(S.fails - 1, 4)));
  S.pollTimer = setTimeout(refresh, delay);
  tickFresh();
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
  el.innerHTML = S.hot.map((t, i) => {
    const leg = t.legs.find((l) => l.kind !== "walk");
    const pred = legPrediction(leg);
    const line = leg.kind === "hop" ? "Hop streetcar" : `Bus ${leg.routes.join(" or ")}`;
    const big = pred ? `<span class="t">${esc(fmtIn(pred.in))}</span><span class="lbl">until it reaches you</span>`
      : `<span class="t sched">—</span><span class="lbl">no live bus listed yet</span>`;
    const meta = pred ? `<span>Leaves <b>${esc(fmtClock(pred.at))}</b></span><span>At ${esc(t.to)} ~<b>${esc(fmtClock(pred.at + (t.travel_min || 20) * 60))}</b></span>` : "";
    const steps = t.legs.map((l) => l.kind === "walk"
      ? `<div class="leg"><i>🚶</i><span>${esc(l.text)}</span></div>`
      : `<div class="leg"><i>🚌</i><span><b>${esc(l.text)}</b></span></div>`).join("");
    return `<div class="tcard" style="animation-delay:${i * 60}ms">
      <div class="tcard-top">${esc(line.toUpperCase())} · ${esc(t.route_note || "")}</div>
      <h3>${esc(t.name)}</h3>
      <div class="route-line">${esc(t.from)} → ${esc(t.to)}</div>
      <div class="tnext">${big}</div><div class="tmeta">${meta}</div>
      <div class="tsteps">${steps}</div>
      <div class="tactions">
        <button class="btn" data-a="map" data-t="${esc(t.id)}">See route</button>
        <button class="btn" data-a="follow" data-t="${esc(t.id)}" ${pred?.trip ? "" : "disabled"}>${pred?.trip ? "Follow bus" : "No bus"}</button>
        <button class="btn" data-a="notify" data-t="${esc(t.id)}">Notify me</button>
      </div></div>`;
  }).join("");
  el.querySelectorAll("[data-a]").forEach((b) => b.addEventListener("click", () => {
    const t = S.hot.find((x) => x.id === b.dataset.t);
    const leg = t?.legs.find((l) => l.kind !== "walk");
    if (!t || !leg) return;
    if (b.dataset.a === "map") { isolateRoute(leg.kind === "hop" ? "HOP" : leg.routes[0]); switchTab("departures"); if (MOBILE) $("panel").classList.add("half"); }
    if (b.dataset.a === "follow") {
      const p = legPrediction(leg);
      const st = [...S.veh.values()].find((s) => !s.hop && String(s.v.trip) === String(p?.trip));
      if (st) { selectVehicle(st.id); startFollow(st.id); }
    }
    if (b.dataset.a === "notify") { saveWatch({ trip: t.id, label: t.name }); b.classList.add("saved"); b.textContent = "Watching ✓"; }
  }));
}
function startFollow(id) {
  S.followId = id;
  $("rail-track").textContent = "Following ✓";
  toast("Following — the map stays with your bus");
}
function saveWatch(w) {
  const all = JSON.parse(localStorage.getItem("hop_watches") || "[]").filter((x) => x.label !== w.label);
  all.push({ ...w, at: Date.now() });
  localStorage.setItem("hop_watches", JSON.stringify(all));
  toast("Watch saved on this device ✓");
}

/* ================= intel tab ================= */
function updateAlertBanner() {
  const b = $("alertbanner");
  const rel = (S.live?.alerts || []).filter((a) => (a.routes || []).some((r) => S.near.includes(r)));
  if (!rel.length) { b.hidden = true; return; }
  b.hidden = false;
  $("alertbanner-text").textContent = `${rel[0].title || "Service alert"} — ${(rel[0].text || "").slice(0, 90)}`;
  b.querySelector(".ab-edge").style.background = routeColor(rel[0].routes[0]);
}
function renderIntel() {
  // alerts
  const al = $("intel-alerts");
  const alerts = S.live?.alerts || [];
  al.innerHTML = alerts.length ? alerts.slice(0, 10).map((a) =>
    `<div class="alert-card"><div class="aroutes">${(a.routes || []).map((r) =>
      `<span class="rbullet sm" style="background:${routeColor(r)}">${esc(r)}</span>`).join("")}</div>
      <h4>${esc(a.title || a.effect || "Alert")}</h4><p>${esc(a.text || "")}</p></div>`).join("")
    : '<div class="empty">No active alerts. Smooth sailing.</div>';
  // ghosts
  const gh = $("intel-ghosts");
  const ghosts = (S.live?.ghosts || []).slice(0, 14);
  gh.innerHTML = ghosts.length
    ? `<table class="gtable">${ghosts.map((g) =>
      `<tr><td><span class="rbullet sm" style="background:${routeColor(g.route)}">${esc(g.route)}</span></td>
       <td style="text-align:left">${esc((g.headsign || "").replace(/^To /i, ""))}</td><td>was due ${esc(g.sched)}</td></tr>`).join("")}</table>`
    : '<div class="empty">No ghost buses yesterday — every scheduled trip showed up.</div>';
  renderRely();
}
async function renderRely() {
  const el = $("intel-rely");
  if (S.summary === undefined) { try { S.summary = await fetchJson(liveUrl("summary.json")); } catch { S.summary = null; } }
  const s = S.summary;
  if (!s) { el.innerHTML = '<div class="empty">Reliability stats are still collecting.</div>'; return; }
  const rows = s.routes || s.byRoute || [];
  if (!rows.length) {
    el.innerHTML = `<div class="empty">“On time” means the live feed showed under 3 min delay when checked. ${esc(s.snapshots || 0)} checks archived so far.</div>`;
    return;
  }
  el.innerHTML = rows.slice(0, 10).map((r) => {
    const pct = Math.round((r.onTime ?? r.pct ?? 0));
    return `<div class="rel-row"><span class="rbullet sm" style="background:${routeColor(r.route || r.id)}">${esc(r.route || r.id)}</span>
      <div class="rel-bar"><i style="width:${pct}%"></i></div><b>${pct}%</b></div>`;
  }).join("");
}

/* ================= ui wiring ================= */
function switchTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("on", p.id === "tab-" + name));
}
function wireUI() {
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  const tgl = (id, key) => $(id).addEventListener("click", () => { S[key] = !S[key]; $(id).classList.toggle("on", S[key]); });
  tgl("tg-bus", "showBus"); tgl("tg-hop", "showHop");
  $("freshpill").addEventListener("click", () => { switchTab("intel"); if (MOBILE) $("panel").classList.add("half"); });
  $("alertbanner-more").addEventListener("click", () => switchTab("intel"));
  $("rail-close").addEventListener("click", clearSelection);
  $("rail-track").addEventListener("click", () => {
    if (S._railStop) { saveWatch({ stop: S._railStop, label: "Stop " + S._railStop }); return; }
    const st = S._railVeh; if (!st) return;
    if (S.followId === st.id) { S.followId = null; $("etapill").hidden = true; $("rail-track").textContent = "Follow this bus"; }
    else startFollow(st.id);
  });
  $("rail-notify").addEventListener("click", () => {
    if (S._railStop) {
      const s = S.stops[S._railStop];
      saveWatch({ stop: S._railStop, label: `Stop ${S._railStop} — ${s?.name || ""}` });
      return;
    }
    const st = S._railVeh;
    saveWatch(st ? { route: st.route, stop: S.anchor[st.route], label: `Route ${st.route} at ${S.stops[S.anchor[st.route]]?.name}` } : { label: "Hopscotch watch" });
  });
  $("etapill").addEventListener("click", (e) => {
    if (e.target.id === "etapill-x" || e.target.closest("#etapill-x")) { S.followId = null; $("etapill").hidden = true; if (S._railVeh) $("rail-track").textContent = "Follow this bus"; }
    else if (S.followId) selectVehicle(S.followId);
  });
  // search
  const sb = $("searchbox"), si = $("searchinput");
  const openSearch = () => { sb.hidden = false; si.value = ""; renderSearch(""); setTimeout(() => si.focus(), 30); };
  $("btn-search").addEventListener("click", () => sb.hidden ? openSearch() : sb.hidden = true);
  si.addEventListener("input", () => renderSearch(si.value));
  si.addEventListener("keydown", (e) => { if (e.key === "Enter") { const f = $("searchresults").querySelector(".sr-row"); if (f) f.click(); } });
  // keyboard
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== si) { e.preventDefault(); openSearch(); }
    else if (e.key === "Escape") {
      if (!sb.hidden) sb.hidden = true;
      else if (S.selVeh || S.selStop) clearSelection();
      else if (S.isoRoute) isolateRoute(S.isoRoute);
    } else if (/^[1-9]$/.test(e.key) && document.activeElement !== si) {
      const rid = S.near[+e.key - 1]; if (rid) isolateRoute(rid);
    }
  });
  // mobile sheet drag
  const grab = $("sheetgrab"), panel = $("panel");
  let sy = 0, dy = 0, dragging = false;
  grab.addEventListener("pointerdown", (e) => { dragging = true; sy = e.clientY; grab.setPointerCapture(e.pointerId); });
  grab.addEventListener("pointermove", (e) => { if (dragging) dy = e.clientY - sy; });
  grab.addEventListener("pointerup", () => {
    if (!dragging) return; dragging = false;
    panel.classList.remove("half", "full");
    if (dy < -60) panel.classList.add("full");
    else if (dy < 40 && panel.classList.contains("full")) panel.classList.add("half");
    else if (dy < -10) panel.classList.add("half");
    dy = 0;
  });
  grab.addEventListener("click", () => {
    if (panel.classList.contains("full")) panel.classList.remove("full");
    else if (panel.classList.contains("half")) { panel.classList.remove("half"); panel.classList.add("full"); }
    else panel.classList.add("half");
  });
  S.map.on("zoomend", drawStops);
}
function renderSearch(q) {
  q = q.trim().toLowerCase();
  const box = $("searchresults");
  const routes = S.routes.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.long || "").toLowerCase().includes(q)).slice(0, 6);
  const stops = Object.entries(S.stops).filter(([id, s]) => !q || s.name.toLowerCase().includes(q) || id.includes(q)).slice(0, 8);
  box.innerHTML =
    routes.map((r) => `<button class="sr-row" data-r="${esc(r.id)}"><span class="rbullet sm" style="background:${routeColor(r.id)}">${esc(r.name)}</span><span>${esc(r.long || "")}</span><span class="mut">route</span></button>`).join("") +
    stops.map(([id, s]) => `<button class="sr-row" data-s="${esc(id)}"><span class="mut mono">◉</span><span>${esc(s.name)}</span><span class="mut">stop ${esc(id)}</span></button>`).join("")
    || '<div class="empty">No matches.</div>';
  box.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", () => { $("searchbox").hidden = true; isolateRoute(b.dataset.r); }));
  box.querySelectorAll("[data-s]").forEach((b) => b.addEventListener("click", () => { $("searchbox").hidden = true; selectStop(b.dataset.s); }));
}

/* ================= boot ================= */
async function boot() {
  try { await ensureMapLibre(); } catch (e) { toast("Map library failed to load — check connection"); }
  if (!window.maplibregl) { $("boot").innerHTML = '<div class="boot-inner"><div class="boot-sub">MAP FAILED TO LOAD</div></div>'; return; }
  try {
    await loadStatic();
  } catch (e) { console.error(e); toast("Static data failed to load"); return; }
  try { S.hot = (await fetchJson("data/hotroutes.json")).routes || []; } catch { S.hot = []; }
  S.near = [...nearRoutes(), "HOP"].filter((r, i, a) => a.indexOf(r) === i);
  initMap();
  await loadTtFor(S.near.filter((r) => r !== "HOP"));
  S.near = [...nearRoutes(), "HOP"].filter((r, i, a) => a.indexOf(r) === i);
  wireUI();
  await refresh();
  drawStops();
  requestAnimationFrame((t) => { lastFrame = t; requestAnimationFrame(frame); });
  setInterval(tickChips, 1000);
  // choreographed reveal
  requestAnimationFrame(() => document.body.classList.add("ready"));
  setTimeout(() => $("boot").classList.add("done"), RM ? 50 : 700);
}
document.addEventListener("DOMContentLoaded", boot);
