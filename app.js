/* Hopscotch — Milwaukee, live.
   iOS-native two-tab build (Home / Map) to the September 21, 2026 mockup.
   Reads only our snapshots: data/static.json + data/hotroutes.json (this
   branch) and live.json (data branch). Nothing on screen is invented; where
   the feed carries nothing, the interface says so. */
"use strict";

/* ================= config & state ================= */
const LIVE_BASE = "https://raw.githubusercontent.com/tylerherman19/hopscotch/data/";
const liveUrl = (f) => LIVE_BASE + f + "?t=" + Math.floor(Date.now() / 30000);
const HELEN = [43.03873, -87.91116];
const BASE_NEAR = ["14", "30", "12", "23"];
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;

const S = {
  routes: [], routeById: {}, stops: {}, shapes2d: {}, tripIdx: {}, anchor: {},
  tt: {}, tindex: {}, calendar: {}, hop: null, hot: null, near: [], live: null,
  veh: new Map(), isoRoute: "", selVeh: null, selStop: null, followId: null,
  view: "buses", showStops: true, fails: 0, lastPoll: 0, pollTimer: null,
  map: null, vlayer: null, slayer: null, meEl: null,
  savedDir: { school: "to", lake: "to" }, editing: false, allAlerts: false,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fetchJson = async (u) => { const r = await fetch(u, { cache: "no-store" }); if (!r.ok) throw new Error(u + " " + r.status); return r.json(); };
const store = {
  get(k, fb) { try { const v = localStorage.getItem(k); return v == null ? fb : v; } catch (e) { return fb; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
const storeJson = (k, fb) => { try { const v = JSON.parse(store.get(k, null)); return v == null ? fb : v; } catch (e) { return fb; } };

const ctFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit", hour12: true });
const ctNowSec = () => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "numeric", second: "numeric", hour12: false }).formatToParts(new Date());
  const g = (t) => +p.find((x) => x.type === t).value;
  return g("hour") * 3600 + g("minute") * 60 + g("second");
};
const fmtClock = (epoch) => ctFmt.format(new Date(epoch * 1000)).replace(" ", "").toLowerCase();
const STOP_WORDS = new Set(["&", "at", "of", "the", "de", "st", "ave", "av"]);
function titleCase(s) {
  s = String(s || "");
  if (!s || s !== s.toUpperCase()) return s; // only fix shouty GTFS names
  return s.toLowerCase().replace(/(^|\s|[-/&])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/\bSt\b/g, "St.").replace(/\bAve\b/g, "Ave.").replace(/\buwm\b/gi, "UWM").replace(/\bbrt\b/gi, "BRT").replace(/\bmcts\b/gi, "MCTS").replace(/\bubus\b/gi, "UBus");
}
function fmtIn(sec) {
  if (sec < 45) return "due";
  const m = Math.round(sec / 60);
  return m < 60 ? m + " min" : Math.floor(m / 60) + "h " + (m % 60) + "m";
}
const delayText = (d) => d == null ? "no signal" : d < 300 ? "Out now" : "+" + Math.round(d / 60) + " min";
const pillFor = (d) => d == null ? ["sched", "Scheduled"] : d < 300 ? ["ok", "Out now"] : d < 600 ? ["warn", "+" + Math.round(d / 60) + " min late"] : ["late", "10+ late"];

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ================= static data ================= */
async function loadStatic() {
  const st = await fetchJson("data/static.json");
  S.routes = st.routes; S.hop = st.hop; S.tindex = st.tindex || {}; S.calendar = st.calendar || {};
  S.stops = {};
  for (const [sid, name, lat, lon] of st.stops) S.stops[sid] = { name: titleCase(name), lat, lon };
  for (const r of S.routes) S.routeById[r.id] = r;
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
  const la1 = a[0] * Math.PI / 180, la2 = b[1] * Math.PI / 180;
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
function activeServices() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()).replace(/-/g, "");
  const list = S.calendar[parts];
  if (list) return new Set(list);
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const part = d.getDay() === 0 ? "SUN" : d.getDay() === 6 ? "SAT" : "WK";
  const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"][d.getMonth()];
  return { has: (s) => typeof s === "string" && s.includes("_" + part) && s.includes(mon + "_") };
}
const ctMidEpoch = () => Math.floor(Date.now() / 1000) - ctNowSec();
function schedDepartures(rid, stopId, now, n) {
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
    out.push({ at, sched: true });
  }
  out.sort((a, b) => a.at - b.at);
  const ded = [];
  for (const d of out) { if (!ded.length || d.at - ded[ded.length - 1].at > 90) ded.push(d); if (ded.length >= n) break; }
  return ded;
}

/* ================= shape math ================= */
function projectToShape(lat, lon, sh) {
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
      best = { s: sh.cum[i] + t * (sh.cum[i + 1] - sh.cum[i]), dist };
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
const tripDir = (tripId) => { const t = S.tripIdx[+tripId]; return t ? t.dir : null; };
const tripHs = (tripId) => { const t = S.tripIdx[+tripId]; return t ? t.hs : ""; };
function vehicleShapeKey(v) {
  if (v.hop) return "HOP|" + v.route;
  const dir = tripDir(v.trip);
  const exact = dir != null ? v.route + "|" + dir : null;
  if (exact && shapeAt(exact)) return exact;
  let bestK = null, bd = 1e12;
  for (const [key, sh] of Object.entries(S.shapes2d)) {
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
  el.innerHTML = `<svg><use href="#${st.hop ? "i-tram" : "i-bus"}"/></svg><span class="vnum">${esc(st.hop ? "H" : st.route)}</span>`;
  el.setAttribute("aria-label", (st.hop ? "Hop streetcar " : "Route " + st.route + " bus ") + st.id);
  el.addEventListener("click", (e) => { e.stopPropagation(); S._vehClicked = true; selectVehicle(st.id); });
  return el;
}
function ingestVehicles(list, isHop) {
  const now = Date.now() / 1000;
  const seen = new Set();
  for (const v of list) {
    const id = (isHop ? "H" : "B") + v.id;
    seen.add(id);
    const vv = isHop ? { ...v, trip: null, bearing: v.heading } : v;
    const key = vehicleShapeKey({ ...vv, hop: isHop });
    const sh = key ? shapeAt(key) : null;
    const proj = sh ? projectToShape(v.lat, v.lon, sh) : null;
    const target = proj ? proj.s : null;
    let st = S.veh.get(id);
    if (!st) {
      st = { id, hop: isHop, route: isHop ? "HOP" : v.route, v: vv, key, s: target ?? 0, sT: target ?? 0, s0: null, lastUpd: now, speed: v.speed || 0, delay: vv.delay ?? null, el: null };
      st.el = makeVehEl(st);
      if (S.vlayer) S.vlayer.appendChild(st.el);
      S.veh.set(id, st);
    } else {
      if (target != null) { st.sT = target; st.s0 = st.s; st.sT0 = now; }
      st.v = vv; st.key = key; st.lastUpd = now; st.speed = v.speed || 0; st.delay = vv.delay ?? null;
    }
    if (st.el && !st.el.isConnected && S.vlayer) S.vlayer.appendChild(st.el);
  }
  for (const [id, st] of S.veh) {
    if (!seen.has(id) && now - st.lastUpd > 180) {
      if (S.selVeh === id) clearSelection();
      if (S.followId === id) S.followId = null;
      st.el?.remove(); S.veh.delete(id);
    }
  }
}
let lastFrame = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (ts - lastFrame) / 1000 || 0.016);
  lastFrame = ts;
  const now = Date.now() / 1000;
  const frozen = document.documentElement.classList.contains("frozen") || RM;
  for (const st of S.veh.values()) {
    const el = st.el; if (!el) continue;
    const age = now - st.lastUpd;
    if (!frozen && st.key) {
      st.s += (st.speed || 0) * dt;
      if (st.sT != null && st.s0 != null) {
        const k = 1 - Math.exp(-dt * 2.2);
        st.s += (st.sT - st.s) * k;
        if (Math.abs(st.sT - st.s) < 0.5) st.s0 = null;
      }
    }
    const sh = st.key ? shapeAt(st.key) : null;
    const ll = sh ? pointAtS(sh, st.s) : [st.v.lat, st.v.lon];
    st._ll = ll;
    const p = S.map.project([ll[1], ll[0]]);
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    el.style.display = vehVisible(st) ? "" : "none";
    el.classList.toggle("stale", age > 120);
    el.classList.toggle("sel", S.selVeh === st.id);
    el.classList.toggle("dim", !!S.isoRoute && st.route !== S.isoRoute && !(S.isoRoute === "HOP" && st.hop));
    if (S.followId === st.id && S.map) {
      const c = S.map.getCenter();
      S.map.jumpTo({ center: [c.lng + (ll[1] - c.lng) * Math.min(1, dt * 3), c.lat + (ll[0] - c.lat) * Math.min(1, dt * 3)] });
    }
    if (S.selVeh === st.id) positionCallout(p);
  }
  if (S.meEl && S.mePos) {
    const p = S.map.project([S.mePos[1], S.mePos[0]]);
    S.meEl.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
  }
  positionStops();
}
function vehVisible(st) {
  if (st.id === S.followId || st.id === S.selVeh) return true;
  if (S.view === "hop") return st.hop;
  if (S.view === "nearby") return st.hop || S.near.includes(st.route);
  return true; // buses: everything, like the mockup
}

/* ================= map ================= */
function initMap() {
  S.map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [HELEN[1], HELEN[0]], zoom: 13.6,
    attributionControl: { compact: true },
  });
  const mc = S.map.getContainer();
  S.slayer = document.createElement("div"); S.slayer.id = "slayer"; mc.appendChild(S.slayer);
  S.vlayer = document.createElement("div"); S.vlayer.id = "vlayer"; mc.appendChild(S.vlayer);
  const st = S.slayer.style, vt = S.vlayer.style;
  st.position = vt.position = "absolute"; st.inset = vt.inset = "0"; st.pointerEvents = "none"; vt.pointerEvents = "none";
  S.map.on("load", () => {
    S.map.addSource("rlines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    S.map.addLayer({
      id: "rlines", type: "line", source: "rlines",
      paint: {
        "line-width": ["case", ["boolean", ["get", "iso"], false], 5, 3.5],
        "line-color": ["get", "color"],
        "line-opacity": ["case", ["boolean", ["get", "iso"], false], 1, ["boolean", ["get", "dim"], false], 0.25, 0.85],
      },
    });
    drawRouteLines(); drawStops();
  });
  S.map.on("click", (e) => {
    if (S._vehClicked) { S._vehClicked = false; return; }
    const f = S.map.queryRenderedFeatures(e.point, { layers: ["rlines"] });
    if (f.length && f[0].properties.rid) isolateRoute(f[0].properties.rid);
    else clearSelection();
  });
  S.map.on("zoomend", drawStops);
}
function drawRouteLines() {
  if (!S.map || !S.map.getSource("rlines")) return;
  const feats = [];
  const wanted = new Set(S.near);
  if (S.isoRoute) wanted.add(S.isoRoute);
  for (const rid of wanted) {
    if (rid === "HOP") {
      for (const hr of S.hop.routes) {
        const pts = S.hop.lines[hr.id]; if (!pts) continue;
        feats.push({ type: "Feature", properties: { rid: "HOP", color: "#34c759", iso: S.view === "hop", dim: S.view === "buses" }, geometry: { type: "LineString", coordinates: pts.map((p) => [p[1], p[0]]) } });
      }
      continue;
    }
    for (const [key, sh] of Object.entries(S.shapes2d)) {
      if (!key.startsWith(rid + "|")) continue;
      feats.push({ type: "Feature", properties: { rid, color: "#0a84ff", iso: S.isoRoute === rid, dim: S.view === "hop" }, geometry: { type: "LineString", coordinates: sh.ll.map((p) => [p[1], p[0]]) } });
    }
  }
  S.map.getSource("rlines").setData({ type: "FeatureCollection", features: feats });
}
function drawStops() {
  if (!S.slayer || !S.map) return;
  S.slayer.innerHTML = "";
  if (!S.showStops) return;
  if (S.map.getZoom() < 13.2 && S.view !== "nearby") return;
  const seen = new Set();
  for (const rid of S.near) {
    if (rid === "HOP") continue;
    const pack = S.tt[rid]; if (!pack) continue;
    for (const pat of Object.values(pack.stops)) {
      for (const sid of pat) {
        if (seen.has(sid)) continue; seen.add(sid);
        const s = S.stops[sid]; if (!s) continue;
        const d = document.createElement("button");
        d.className = "stopdot"; d.title = s.name; d.style.pointerEvents = "auto";
        d.setAttribute("aria-label", "Stop " + sid + ", " + s.name);
        d.dataset.lat = s.lat; d.dataset.lon = s.lon;
        d.addEventListener("click", (e) => { e.stopPropagation(); S._vehClicked = true; selectStop(sid); });
        S.slayer.appendChild(d);
      }
    }
  }
  positionStops();
}
function positionStops() {
  if (!S.slayer || !S.map) return;
  S.slayer.querySelectorAll(".stopdot").forEach((el) => {
    const p = S.map.project([+el.dataset.lon, +el.dataset.lat]);
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
  });
}
function positionCallout(p) {
  const c = $("callout");
  c.style.left = p.x.toFixed(1) + "px";
  c.style.top = (p.y - 22).toFixed(1) + "px";
}

/* ================= selection + sheet ================= */
function anchorNext(st) {
  const v = st.v;
  const next = v.next || [];
  if (st.hop) return { i: 0, n: null };
  const anchor = S.anchor[st.route];
  const i = next.findIndex((n) => String(n.stop) === String(anchor));
  return { i: i >= 0 ? i : 0, n: next[i >= 0 ? i : 0] };
}
async function isolateRoute(rid) {
  S.isoRoute = S.isoRoute === rid ? "" : rid;
  if (S.isoRoute && !S.near.includes(S.isoRoute)) S.near.push(S.isoRoute);
  if (S.isoRoute && S.isoRoute !== "HOP" && !S.tt[S.isoRoute]) await loadTtFor([S.isoRoute]);
  drawRouteLines(); drawStops();
}
function selectVehicle(id) {
  const st = S.veh.get(id); if (!st) return;
  S.selVeh = id; S.selStop = null;
  if (!st.hop && st.route !== S.isoRoute && !S.tt[st.route]) loadTtFor([st.route]).then(() => renderSheet());
  if (!st.hop && st.route !== S.isoRoute) { S.isoRoute = st.route; drawRouteLines(); }
  openSheetVehicle(st);
  const ll = st._ll || [st.v.lat, st.v.lon];
  if (S.map && !S.followId) S.map.easeTo({ center: [ll[1], ll[0]], duration: RM ? 0 : 400 });
}
function selectStop(sid) {
  const s = S.stops[sid]; if (!s) return;
  S.selStop = sid; S.selVeh = null;
  if (S.map) S.map.easeTo({ center: [s.lon, s.lat], duration: RM ? 0 : 400 });
  openSheetStop(sid);
}
function clearSelection() {
  S.selVeh = null; S.selStop = null; S.followId = null;
  $("sh-following").hidden = true;
  const fb = $("sh-follow");
  fb.innerHTML = `<svg><use href="#i-nav"/></svg>Follow bus`; fb.classList.remove("stop");
  $("callout").hidden = true; $("sheet").hidden = true;
  if (S.isoRoute) { S.isoRoute = ""; drawRouteLines(); }
}
function openSheetVehicle(st) {
  const sheet = $("sheet");
  sheet.classList.remove("stopmode");
  sheet.hidden = false;
  sheet.classList.remove("half", "dragging");
  sheet.style.transform = "";
  renderSheet();
  updateCallout(st);
}
function renderSheet() {
  const st = S.veh.get(S.selVeh); if (!st) return;
  const v = st.v;
  const badge = $("sh-badge");
  badge.classList.toggle("hop", !!st.hop);
  badge.innerHTML = `<svg><use href="#${st.hop ? "i-tram" : "i-bus"}"/></svg>`;
  const dir = st.hop ? "" : tripDir(v.trip);
  const hs = st.hop ? "The Hop" : titleCase((tripHs(v.trip) || "").replace(/^To /i, ""));
  $("sh-title").textContent = st.hop ? "THE HOP" : (dirWord(st.route, dir) || (st.route + (hs ? " · " + hs : "")));
  $("sh-sub").textContent = (st.hop ? (v.name || "Streetcar " + v.id) : "Vehicle #" + v.id) + (hs && !st.hop ? " · " + hs : "");
  const [cls, txt] = st.hop ? (st.v.delayed ? ["warn", "Delayed"] : ["ok", "Out now"]) : pillFor(st.delay);
  const pill = $("sh-pill");
  pill.className = "pill " + cls; pill.textContent = txt;
  const fb = $("sh-follow");
  fb.style.display = "";
  if (S.followId === st.id) { fb.textContent = "Stop following"; fb.classList.add("stop"); }
  else { fb.innerHTML = `<svg><use href="#i-nav"/></svg>` + (st.hop ? "Follow streetcar" : "Follow bus"); fb.classList.remove("stop"); }
  renderSheetStops(st);
  tickSheetEta();
}
function dirWord(rid, dir) {
  // "WEST"-style label from the route's headsigns when we have them
  const pack = S.tt[rid];
  if (pack && dir != null) {
    const hs = (pack.headsign[String(dir)] || "").replace(/^To /i, "");
    if (hs) return rid + " · " + titleCase(hs);
  }
  return null;
}
function renderSheetStops(st) {
  const now = Date.now() / 1000;
  let rows;
  if (st.hop) {
    const hs = nearestHopStop();
    rows = ((S.live?.hop_stops || {})[hs] || []).slice(0, 6).map((p, i) =>
      `<div class="srow${i === 0 ? " here" : ""}"><span class="n">${esc(hopStopName(hs))}</span><span class="t" data-at="${p[1]}">${esc(fmtIn(p[1] - now))}</span></div>`).join("");
    $("sh-stop").textContent = hopStopName(hs);
  } else {
    const next = st.v.next || [];
    rows = next.slice(0, 7).map((n, i) =>
      `<div class="srow${i === 0 ? " here" : ""}"><span class="n">${esc(titleCase(n.name) || "Stop " + n.stop)}</span><span class="t" data-at="${Math.round(n.at)}">${esc(fmtIn(n.at - now))}</span></div>`).join("");
    $("sh-stop").textContent = next[0] ? (titleCase(next[0].name) || "Stop " + next[0].stop) : "Not reported";
  }
  $("sh-stops").innerHTML = rows || '<div class="empty">No upcoming stops reported.</div>';
}
function tickSheetEta() {
  const st = S.veh.get(S.selVeh);
  if (st && !st.hop) {
    const n = (st.v.next || [])[0];
    $("sh-eta").textContent = n ? "~ " + fmtIn(Math.max(0, Math.round(n.at - Date.now() / 1000))) : "—";
  } else if (st && st.hop) {
    const hs = nearestHopStop();
    const p = ((S.live?.hop_stops || {})[hs] || [])[0];
    $("sh-eta").textContent = p ? "~ " + fmtIn(Math.max(0, Math.round(p[1] - Date.now() / 1000))) : "—";
  }
  const co = $("callout");
  if (st && !co.hidden) {
    const { n } = anchorNext(st);
    const now = Date.now() / 1000;
    if (st.hop) {
      $("co-head").textContent = "The Hop";
      $("co-eta").textContent = "streetcar";
    } else {
      $("co-head").textContent = titleCase((tripHs(st.v.trip) || "Route " + st.route).replace(/^To /i, ""));
      $("co-eta").textContent = n ? fmtIn(Math.max(0, Math.round(n.at - now))) + " to " + (titleCase(n.name) || "your stop") : "signal lost";
    }
  }
}
function openSheetStop(sid) {
  const s = S.stops[sid];
  const sheet = $("sheet");
  sheet.hidden = false; sheet.classList.remove("half", "dragging"); sheet.style.transform = "";
  sheet.classList.add("stopmode");
  $("callout").hidden = true;
  const badge = $("sh-badge");
  badge.classList.remove("hop");
  badge.innerHTML = `<svg><use href="#i-stop"/></svg>`;
  $("sh-title").textContent = s.name;
  $("sh-sub").textContent = "Stop " + sid;
  const pill = $("sh-pill"); pill.className = "pill sched"; pill.textContent = "Stop";
  $("sh-stop").textContent = s.name;
  $("sh-eta").textContent = "";
  $("sh-follow").style.display = "none";
  $("sh-following").hidden = true;
  const now = Date.now() / 1000;
  const preds = ((S.live?.stops || {})[sid] || []).slice().sort((a, b) => a[2] - b[2]).slice(0, 8);
  $("sh-stops").innerHTML = preds.map((p) =>
    `<div class="srow"><span class="n"><b>${esc(p[0])}</b> ${esc((tripHs(p[3]) || "").replace(/^To /i, ""))}</span><span class="t" data-at="${Math.round(p[2])}">${esc(fmtIn(p[2] - now))}</span></div>`).join("")
    || '<div class="empty">No live departures at this stop right now.</div>';
}
const nearestHopStop = () => {
  let best = null, bd = 1e9;
  for (const s of S.hop.stops) { const d = (s.lat - HELEN[0]) ** 2 + (s.lon - HELEN[1]) ** 2; if (d < bd) { bd = d; best = s.id; } }
  return best;
};
const hopStopName = (id) => S.hop.stops.find((s) => s.id === id)?.name || ("Stop " + id);
function updateCallout(st) {
  const co = $("callout");
  co.hidden = false;
  co.classList.toggle("hopco", !!st.hop);
  $("co-num").textContent = st.hop ? "H" : st.route;
  tickSheetEta();
}

/* ================= saved routes (Home) ================= */
const SAVED = [
  { key: "school", name: "To school", backName: "Back home", trips: { to: "helen-law", back: "law-helen" } },
  { key: "lake", name: "To the lake", backName: "Back home", trips: { to: "helen-lake", back: "lake-helen" } },
];
function savedTrip(card) {
  const dir = S.savedDir[card.key] || "to";
  const id = card.trips[dir];
  return { trip: (S.hot || []).find((t) => t.id === id) || null, dir };
}
function tripLeg(t) { return t?.legs.find((l) => l.kind !== "walk") || null; }
function tripPredictions(t) {
  const leg = tripLeg(t); if (!leg || !S.live) return { sid: null, list: [] };
  const sid = String(leg.board);
  const list = ((S.live.stops || {})[sid] || [])
    .filter((x) => (leg.routes || []).includes(x[0]))
    .sort((a, b) => a[2] - b[2])
    .map((x) => ({ route: x[0], in: x[1], at: x[2], trip: x[3], live: true }));
  return { sid, list, leg };
}
function vehForTrip(tripId) {
  return [...S.veh.values()].find((s) => !s.hop && String(s.v.trip) === String(tripId)) || null;
}
function renderSaved() {
  const el = $("saved");
  if (!S.hot) { el.innerHTML = '<div class="skel-card"><i class="w1"></i><i class="w2"></i><i class="w3"></i></div>'; return; }
  const now = Date.now() / 1000;
  el.innerHTML = SAVED.map((card) => {
    const { trip: t, dir } = savedTrip(card);
    const leg = tripLeg(t);
    if (!t || !leg) return "";
    const { sid, list } = tripPredictions(t);
    const live = list.filter((p) => p.at > now - 60);
    let times = live.slice(0, 3).map((p) => ({ at: p.at, trip: p.trip, sched: false }));
    let sched = false;
    if (!times.length) {
      sched = true;
      const per = (leg.routes || []).flatMap((r) => schedDepartures(r, String(leg.board), now, 3));
      times = per.slice(0, 3).map((d) => ({ at: d.at, sched: true }));
    }
    const first = times[0];
    const alts = times.slice(1);
    // first followable vehicle anywhere in the prediction list
    let veh = null;
    if (!sched) for (const p of times) { const m = p.trip && vehForTrip(p.trip); if (m) { veh = m; break; } }
    const firstVeh = first && first.trip ? vehForTrip(first.trip) : null;
    const [pcls, ptxt] = sched ? ["sched", "Scheduled"] : (firstVeh ? pillFor(firstVeh.delay) : ["ok", "Out now"]);
    const name = dir === "to" ? card.name : (card.backName + " from " + (card.key === "school" ? "school" : "the lake"));
    const routesText = leg.kind === "hop" ? "THE HOP" : (leg.routes || []).join(" / ") + (t.route_note ? " · " + t.route_note.toUpperCase() : "");
    const stopName = S.stops[String(leg.board)]?.name || "her stop";
    const editRow = `<div class="rc-edit">
        <button data-card="${card.key}" data-dir="to" class="${dir === "to" ? "on" : ""}">${esc(card.name.replace(/^To /, "To "))}</button>
        <button data-card="${card.key}" data-dir="back" class="${dir === "back" ? "on" : ""}">Back home</button>
      </div>`;
    return `<div class="route-card" data-card="${card.key}">
      <div class="rc-top">
        <svg class="star"><use href="#i-star"/></svg>
        <span class="rc-name">${esc(name)}</span>
        <svg class="rc-chev"><use href="#i-chev"/></svg>
      </div>
      <div class="rc-routes">${esc(routesText)}</div>
      ${S.editing ? editRow : `
      <div class="rc-main">
        <span class="rc-big${sched ? " sched" : ""}" ${first ? `data-at="${Math.round(first.at)}"` : ""}>${first ? esc(fmtIn(first.at - now)) : "—"}</span>
        <span class="pill ${pcls}">${esc(ptxt)}</span>
      </div>
      <div class="rc-alts">${alts.map((a) => `<span ${a.at - now > 90 * 60 ? "" : `data-at="${Math.round(a.at)}"`}>${esc(a.at - now > 90 * 60 ? "at " + fmtClock(a.at) : fmtIn(a.at - now))}</span>`).join("<br>") || '<span class="past">No more buses listed soon</span>'}</div>
      <div class="rc-stop">
        <svg><use href="#i-stop"/></svg>
        <span class="lbl">Stop:</span><span class="nm">${esc(stopName)}</span>
        <svg class="chev"><use href="#i-chev"/></svg>
      </div>
      <button class="followbtn" data-follow="${card.key}" ${veh ? "" : "disabled"}>
        <svg><use href="#i-nav"/></svg>${veh ? "Follow bus" : "No bus to follow"}
      </button>`}
    </div>`;
  }).join("");
  if (S.hot && !S.hot.length) el.innerHTML = '<div class="empty">No saved routes found.</div>';
  el.querySelectorAll("[data-follow]").forEach((b) => b.addEventListener("click", () => followSaved(b.dataset.follow)));
  el.querySelectorAll(".rc-edit button").forEach((b) => b.addEventListener("click", () => {
    S.savedDir[b.dataset.card] = b.dataset.dir;
    store.set("hop_saved_dir", JSON.stringify(S.savedDir));
    renderSaved();
  }));
  el.querySelectorAll(".route-card").forEach((c) => c.addEventListener("click", (e) => {
    if (S.editing || e.target.closest(".followbtn")) return;
    const card = SAVED.find((x) => x.key === c.dataset.card);
    const { trip: t } = savedTrip(card);
    const leg = tripLeg(t);
    if (!leg) return;
    switchTab("map");
    isolateRoute(leg.kind === "hop" ? "HOP" : leg.routes[0]);
  }));
}
function followSaved(key) {
  const card = SAVED.find((x) => x.key === key);
  const { trip: t } = savedTrip(card);
  const { list } = tripPredictions(t);
  const now = Date.now() / 1000;
  const veh = list.filter((x) => x.at > now - 60).map((x) => vehForTrip(x.trip)).find(Boolean) || null;
  if (!veh) { toast("No live bus on this trip yet."); return; }
  switchTab("map");
  selectVehicle(veh.id);
  startFollow(veh.id);
}
function startFollow(id) {
  S.followId = id;
  const st = S.veh.get(id);
  $("sh-following").hidden = false;
  const fb = $("sh-follow");
  fb.textContent = "Stop following"; fb.classList.add("stop");
  updateCallout(st);
  toast(st?.hop ? "Following the streetcar." : "Following this bus.");
}
function stopFollow() {
  const st = S.veh.get(S.followId);
  S.followId = null;
  $("sh-following").hidden = true;
  const fb = $("sh-follow");
  fb.innerHTML = `<svg><use href="#i-nav"/></svg>` + (st?.hop ? "Follow streetcar" : "Follow bus"); fb.classList.remove("stop");
  $("callout").hidden = true;
}

/* ================= service updates (Home) ================= */
function watchedRoutes() {
  const r = new Set();
  for (const t of S.hot || []) for (const l of t.legs) if (l.kind === "bus") for (const x of l.routes) r.add(x);
  return [...r];
}
function renderUpdates() {
  const el = $("updates");
  const alerts = S.live?.alerts || [];
  if (S.allAlerts) {
    el.innerHTML = alerts.length ? alerts.map((a) => `
      <div class="update-card bad">
        <svg><use href="#i-warn"/></svg>
        <div><b>${esc(a.title || a.effect || "Service alert")}</b>
        <p>${esc(a.text || "")}</p></div>
      </div>`).join("") : '<div class="empty">No active alerts anywhere on the system.</div>';
    return;
  }
  const watched = watchedRoutes();
  const cards = [];
  for (const rid of watched) {
    const hit = alerts.filter((a) => (a.routes || []).includes(rid));
    if (hit.length) {
      for (const a of hit.slice(0, 2)) cards.push(`<div class="update-card bad"><svg><use href="#i-warn"/></svg><div><b>${esc(rid)} – ${esc(a.effect || "Alert")}</b><p>${esc(a.text || "")}</p></div></div>`);
    } else {
      cards.push(`<div class="update-card good"><svg><use href="#i-check"/></svg><div><b>${esc(rid)} – Good service</b><p>Normal service operating.</p></div></div>`);
    }
  }
  const hopAlerts = alerts.filter((a) => (a.routes || []).includes("HOP") || (a.routes || []).includes("7"));
  if (S.live?.hop_offline) {
    cards.push(`<div class="update-card bad"><svg><use href="#i-warn"/></svg><div><b>The Hop – No live positions</b><p>The streetcar feed is offline right now. Cars may still be running.</p></div></div>`);
  } else if (hopAlerts.length) {
    for (const a of hopAlerts.slice(0, 2)) cards.push(`<div class="update-card bad"><svg><use href="#i-warn"/></svg><div><b>The Hop – ${esc(a.effect || "Alert")}</b><p>${esc(a.text || "")}</p></div></div>`);
  } else {
    cards.push(`<div class="update-card good"><svg><use href="#i-check"/></svg><div><b>The Hop – Good service</b><p>Normal service operating.</p></div></div>`);
  }
  el.innerHTML = cards.join("");
}

/* ================= live polling ================= */
async function refresh() {
  try {
    const live = await fetchJson(liveUrl("live.json"));
    S.fails = 0; S.live = live; S.lastPoll = Date.now();
    ingestVehicles(live.vehicles || [], false);
    if (!live.hop_offline) ingestVehicles(live.hop || [], true);
    renderSaved(); renderUpdates();
    if (S.selVeh && S.veh.has(S.selVeh)) { renderSheet(); updateCallout(S.veh.get(S.selVeh)); }
    if (S.selStop) openSheetStop(S.selStop);
    updateFeedStat();
  } catch (e) {
    S.fails++;
    console.warn("live fetch failed", e);
    updateFeedStat();
  }
  clearTimeout(S.pollTimer);
  let delay = S.followId || S.selVeh ? 15000 : 30000;
  if (S.fails) delay = Math.max(delay, Math.min(300000, 30000 * 2 ** Math.min(S.fails - 1, 4)));
  S.pollTimer = setTimeout(refresh, delay);
}
function updateFeedStat() {
  const el = $("set-feed");
  if (!S.live) { el.textContent = S.fails ? "Feed down — retrying" : "Connecting…"; el.classList.remove("live"); return; }
  const age = Math.round((Date.now() - S.lastPoll) / 1000);
  const n = S.live.counts?.buses ?? S.veh.size;
  el.textContent = `Live · ${n} buses on the map · updated ${age}s ago` + (age > 300 ? " (stale)" : "");
  el.classList.toggle("live", age <= 300);
}

/* per-second ticking for every [data-at] on screen */
function tickTimes() {
  const now = Date.now() / 1000;
  document.querySelectorAll("[data-at]").forEach((c) => {
    c.textContent = fmtIn(Math.round(+c.dataset.at - now));
  });
  tickSheetEta();
  updateFeedStat();
}

/* ================= search ================= */
function renderSearch(q) {
  q = q.trim().toLowerCase();
  const box = $("searchresults");
  const routes = S.routes.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.long || "").toLowerCase().includes(q)).slice(0, 6);
  const stops = Object.entries(S.stops).filter(([id, s]) => q && (s.name.toLowerCase().includes(q) || id.includes(q))).slice(0, 8);
  box.innerHTML =
    routes.map((r) => `<button class="sr-row" data-r="${esc(r.id)}"><span class="sr-badge" style="background:var(--blue)">${esc(r.name)}</span><span>${esc(r.long || "")}</span><span class="mut">route</span></button>`).join("") +
    stops.map(([id, s]) => `<button class="sr-row" data-s="${esc(id)}"><span class="sr-badge" style="background:var(--fill);color:var(--gray)">●</span><span>${esc(s.name)}</span><span class="mut">stop ${esc(id)}</span></button>`).join("")
    || '<div class="empty">No matches.</div>';
  box.hidden = false;
  box.querySelectorAll("[data-r]").forEach((b) => b.addEventListener("click", async () => { box.hidden = true; $("searchinput").value = ""; await isolateRoute(b.dataset.r); toast("Route " + b.dataset.r + " highlighted."); }));
  box.querySelectorAll("[data-s]").forEach((b) => b.addEventListener("click", () => { box.hidden = true; $("searchinput").value = ""; selectStop(b.dataset.s); }));
}

/* ================= tabs + settings + wiring ================= */
function switchTab(name) {
  document.querySelectorAll(".tabbtn").forEach((b) => b.classList.toggle("on", b.dataset.screen === name));
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.id === "screen-" + name));
  if (name === "map" && S.map) setTimeout(() => S.map.resize(), 60);
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}
function wireUI() {
  document.querySelectorAll(".tabbtn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.screen)));
  $("introcard").addEventListener("click", () => switchTab("map"));
  $("btn-edit").addEventListener("click", () => {
    S.editing = !S.editing;
    $("btn-edit").textContent = S.editing ? "Done" : "Edit";
    $("saved").classList.toggle("editing", S.editing);
    renderSaved();
  });
  $("btn-allalerts").addEventListener("click", () => {
    S.allAlerts = !S.allAlerts;
    $("btn-allalerts").textContent = S.allAlerts ? "Show less" : "See all";
    renderUpdates();
  });
  /* settings */
  $("btn-settings").addEventListener("click", () => { $("settings").hidden = false; updateFeedStat(); });
  $("set-close").addEventListener("click", () => { $("settings").hidden = true; });
  $("settings").addEventListener("click", (e) => { if (e.target.id === "settings") $("settings").hidden = true; });
  $("set-stops").addEventListener("change", (e) => {
    S.showStops = e.target.checked; store.set("hop_stops_dots", S.showStops ? "1" : "0");
    $("btn-layers").classList.toggle("on", S.showStops);
    drawStops();
  });
  $("set-motion").addEventListener("change", (e) => {
    document.documentElement.classList.toggle("frozen", e.target.checked);
    store.set("hop_frozen", e.target.checked ? "1" : "0");
  });
  /* segmented */
  document.querySelectorAll(".segbtn").forEach((b) => b.addEventListener("click", () => {
    S.view = b.dataset.view;
    document.querySelectorAll(".segbtn").forEach((x) => x.classList.toggle("on", x === b));
    drawRouteLines(); drawStops();
    if (S.view === "hop" && S.map) {
      const sh = shapeAt("HOP|" + S.hop.routes[0]?.id);
      if (sh) {
        const mid = sh.ll[Math.floor(sh.ll.length / 2)];
        S.map.easeTo({ center: [mid[1], mid[0]], zoom: 14, duration: RM ? 0 : 600 });
      }
    }
    if (S.view === "nearby" && S.map) S.map.easeTo({ center: [HELEN[1], HELEN[0]], zoom: 14.6, duration: RM ? 0 : 600 });
  }));
  /* search */
  const si = $("searchinput");
  si.addEventListener("input", () => renderSearch(si.value));
  si.addEventListener("focus", () => renderSearch(si.value));
  si.addEventListener("keydown", (e) => { if (e.key === "Enter") { const f = $("searchresults").querySelector(".sr-row"); if (f) f.click(); } });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".searchwrap")) $("searchresults").hidden = true;
  });
  /* locate */
  const locate = () => {
    if (!navigator.geolocation) { toast("Location is not available in this browser."); return; }
    navigator.geolocation.getCurrentPosition((pos) => {
      S.mePos = [pos.coords.latitude, pos.coords.longitude];
      if (!S.meEl) {
        S.meEl = document.createElement("div");
        S.meEl.className = "me-dot";
        S.slayer.appendChild(S.meEl);
      }
      S.map?.easeTo({ center: [S.mePos[1], S.mePos[0]], zoom: Math.max(S.map.getZoom(), 14.5), duration: RM ? 0 : 700 });
    }, () => toast("Could not get your location."), { enableHighAccuracy: true, timeout: 8000 });
  };
  $("btn-locate").addEventListener("click", locate);
  $("btn-locate2").addEventListener("click", locate);
  /* layers toggle */
  $("btn-layers").addEventListener("click", () => {
    S.showStops = !S.showStops;
    $("btn-layers").classList.toggle("on", S.showStops);
    $("set-stops").checked = S.showStops;
    store.set("hop_stops_dots", S.showStops ? "1" : "0");
    drawStops();
  });
  /* sheet follow + drag */
  $("sh-follow").addEventListener("click", () => {
    const st = S.veh.get(S.selVeh); if (!st) return;
    if (S.followId === st.id) stopFollow();
    else startFollow(st.id);
  });
  const grab = $("sheetgrab"), sheet = $("sheet");
  let sy = 0, dragging = false, base = 0;
  const peekH = () => parseFloat(getComputedStyle(sheet).getPropertyValue("--peek")) || 190;
  grab.addEventListener("pointerdown", (e) => { dragging = true; sy = e.clientY; base = sheet.classList.contains("half") ? 0 : sheet.offsetHeight - peekH(); sheet.classList.add("dragging"); grab.setPointerCapture(e.pointerId); });
  grab.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = Math.max(0, base + (e.clientY - sy));
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const endDrag = (e) => {
    if (!dragging) return; dragging = false;
    sheet.classList.remove("dragging");
    const dy = e.clientY - sy;
    sheet.style.transform = "";
    if (dy < -60) sheet.classList.add("half");
    else sheet.classList.remove("half");
  };
  grab.addEventListener("pointerup", endDrag);
  grab.addEventListener("pointercancel", endDrag);
  grab.addEventListener("click", () => { if (Math.abs(dragY0) < 4) sheet.classList.toggle("half"); });
  let dragY0 = 0;
  grab.addEventListener("pointerdown", (e) => { dragY0 = 0; });
  grab.addEventListener("pointermove", (e) => { dragY0 = e.clientY - sy; });
}

/* ================= boot ================= */
async function boot() {
  S.savedDir = { ...S.savedDir, ...(storeJson("hop_saved_dir", {}) || {}) };
  if (store.get("hop_stops_dots", "1") === "0") { S.showStops = false; $("set-stops").checked = false; $("btn-layers").classList.remove("on"); }
  if (store.get("hop_frozen", "0") === "1") { document.documentElement.classList.add("frozen"); $("set-motion").checked = true; }
  renderSaved();
  try {
    await loadStatic();
  } catch (e) {
    console.error(e);
    $("saved").innerHTML = '<div class="empty">Route data failed to load. Check your connection and reopen.</div>';
    return;
  }
  try { S.hot = (await fetchJson("data/hotroutes.json")).routes || []; } catch { S.hot = []; }
  S.near = [...new Set([...BASE_NEAR, ...watchedRoutes()])].filter((r) => S.routeById[r]);
  S.near.push("HOP");
  wireUI();
  try { initMap(); } catch (e) { console.error(e); S.map = null; }
  await loadTtFor(S.near.filter((r) => r !== "HOP"));
  drawStops();
  await refresh();
  if (S.map) { lastFrame = performance.now(); requestAnimationFrame(frame); }
  setInterval(tickTimes, 1000);
  if (location.hash === "#map") switchTab("map");
}
document.addEventListener("DOMContentLoaded", boot);
