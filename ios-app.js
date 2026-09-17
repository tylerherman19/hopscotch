/* ==========================================================================
   Hopscotch — Milwaukee transit
   Reads two snapshots and nothing else:
     data/static.json        GTFS-derived routes, stops, shapes (this branch)
     <data branch>/live.json vehicle positions, stop predictions, alerts
   Every number on screen is traced back to one of those two files. Nothing
   is invented; when a value is unavailable the UI says so.
   ========================================================================== */
(() => {
"use strict";

const LIVE_URL   = "https://raw.githubusercontent.com/tylerherman19/hopscotch/data/live.json";
const REFRESH_MS = 30000;   // how often we re-fetch the feed
const TICK_MS    = 15000;   // how often the countdown is redrawn from the clock
const SAVED_KEY  = "hopscotch.saved.v1";
const STALE_SECS = 180;

/* application state */
let ST = null;          // static.json
let LIVE = null;        // live.json
let map = null;
let selectedRoute = "";
let selectedDir = "0";
let focusVehicle = null;
let refreshTimer = null;
let tickTimer = null;
let lastFocusedEl = null;

/* ------------------------------------------------------------- helpers -- */
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

/* localStorage that never throws — a blocked store must not break boot */
const store = {
  read(fallback) {
    try {
      const raw = localStorage.getItem(SAVED_KEY);
      const val = raw == null ? null : JSON.parse(raw);
      return Array.isArray(val) ? val : fallback;
    } catch { return fallback; }
  },
  write(val) {
    try { localStorage.setItem(SAVED_KEY, JSON.stringify(val)); return true; }
    catch { return false; }
  },
};

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("is-shown");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("is-shown"), 2400);
}

/* Countdowns are measured against the wall clock, NOT against LIVE.ts. A
   prediction is a promise about a moment in time; if the feed stops updating,
   that moment still arrives and passes. Measuring against the feed's own
   timestamp freezes every number at whatever it read when the feed stalled,
   which shows a rider "2 min" for a bus that left twenty minutes ago. */
const wallNow = () => Math.floor(Date.now() / 1000);

/* Seconds since the collector last wrote live.json. */
const feedAge = () => (LIVE && LIVE.ts ? Math.max(0, wallNow() - LIVE.ts) : Infinity);

/* GTFS ships stop names in caps ("DR. M.L.K DRIVE & MCKINLEY"). Title-case
   them without flattening transit acronyms, directional codes or Mc- names. */
const ACRONYMS = new Set([
  "MLK", "BRT", "UWM", "MSOE", "MATC", "MCTS", "VA", "US", "AM", "PM", "JR", "SR",
  "NE", "NW", "SE", "SW", "N", "S", "E", "W",
  "KK",   // Kinnickinnic Avenue, spelled this way on 59 stop signs
  "FD",   // Fire Department
]);

function titleCaseToken(token) {
  const bare = token.replace(/[^A-Za-z0-9.]/g, "");
  if (!bare) return token;
  if (ACRONYMS.has(bare.toUpperCase())) return token.toUpperCase();
  if (/^[NSEW]\d+[A-Za-z]{0,2}$/.test(bare)) return token.toUpperCase();    // N68, S57, S9PL
  if (/^(?:[A-Za-z]\.){2,}[A-Za-z]?\.?$/.test(bare)) return token.toUpperCase(); // M.L.K
  let out = token.toLowerCase();
  if (/^[a-z]/.test(out)) out = out[0].toUpperCase() + out.slice(1);        // leaves "14th"
  return out.replace(/^Mc([a-z])/, (_, c) => "Mc" + c.toUpperCase());       // McKinley
}

function titleCase(name) {
  return String(name || "")
    .split(/([\s\-\/]+)/)
    .map((t) => (/^[\s\-\/]+$/.test(t) ? t : titleCaseToken(t)))
    .join("");
}

function routeMeta(id) {
  const key = String(id);
  if (key === "HOP") return { id: "HOP", name: "The Hop", long: "Downtown loop", color: "9237C9" };
  const found = ST && ST.routes.find((r) => String(r.id) === key);
  return found || { id: key, name: key, long: "Milwaukee", color: "0868EF" };
}

const routeColor = (id) => "#" + String(routeMeta(id).color || "0868EF").replace(/^#/, "");

function stopName(stopId) {
  if (!ST) return "Milwaukee stop";
  const row = ST.stops.find((s) => String(s[0]) === String(stopId));
  return row ? titleCase(row[1]) : "Milwaukee stop";
}

const minutesUntil = (epoch) => Math.max(0, Math.round((epoch - wallNow()) / 60));

/* Milwaukee is America/Chicago; the rider may not be. Always show its clock. */
const clockFmt = new Intl.DateTimeFormat("en-US", {
  hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
});
const clockAt = (epoch) => clockFmt.format(new Date(epoch * 1000));

function etaLabel(mins) {
  if (mins <= 0) return "Now";
  return String(mins);
}

/* ------------------------------------------------------------- geometry -- */

/* Compass bearing, degrees clockwise from north, for a short local segment. */
function segmentBearing(a, b) {
  const lat = ((a[0] + b[0]) / 2) * Math.PI / 180;
  const dy = b[0] - a[0];
  const dx = (b[1] - a[1]) * Math.cos(lat);
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

const angleGap = (a, b) => {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
};

/* Nearest point on a [lat,lon] polyline: returns squared distance + bearing. */
function nearestOnShape(shape, lat, lon) {
  let best = { dist: Infinity, bearing: null };
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1], b = shape[i];
    const dLat = b[0] - a[0], dLon = b[1] - a[1];
    const len2 = dLat * dLat + dLon * dLon;
    let t = len2 ? ((lat - a[0]) * dLat + (lon - a[1]) * dLon) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const pLat = a[0] + dLat * t, pLon = a[1] + dLon * t;
    const d = (lat - pLat) ** 2 + (lon - pLon) ** 2;
    if (d < best.dist) best = { dist: d, bearing: segmentBearing(a, b) };
  }
  return best;
}

/* --------------------------------------------------------------- routes -- */

/* Shape for one direction, as [lat,lon] pairs. */
function shapeFor(routeId, dir) {
  if (routeId === "HOP") {
    const lines = (ST.hop && ST.hop.lines) || {};
    const keys = Object.keys(lines);
    return keys.length ? lines[keys[Number(dir) % keys.length] || keys[0]] || [] : [];
  }
  const byDir = (ST.shapes || {})[routeId];
  if (!byDir) return [];
  return byDir[dir] || byDir[Object.keys(byDir)[0]] || [];
}

const directionKeys = (routeId) => {
  if (routeId === "HOP") return Object.keys((ST.hop && ST.hop.lines) || {});
  return Object.keys((ST.shapes || {})[routeId] || {});
};

const hasTwoDirections = (routeId) => directionKeys(routeId).length > 1;

/* Stops served by a route, ordered along the chosen direction's shape. */
function routeStops(routeId, dir) {
  if (routeId === "HOP") {
    return ((ST.hop && ST.hop.stops) || [])
      .filter((s) => String(s.route) === String(directionKeys("HOP")[Number(dir)] || ""))
      .map((s) => [s.id, s.name, s.lat, s.lon]);
  }
  const shape = shapeFor(routeId, dir);
  const serving = (ST.stops || []).filter(
    (s) => ((ST.stop_routes || {})[String(s[0])] || []).includes(routeId)
  );
  if (!shape.length) return serving;

  /* keep stops that sit on this direction's alignment, ordered by progress */
  const scored = serving.map((s) => {
    let best = Infinity, at = 0;
    for (let i = 0; i < shape.length; i++) {
      const d = (s[2] - shape[i][0]) ** 2 + (s[3] - shape[i][1]) ** 2;
      if (d < best) { best = d; at = i; }
    }
    return { stop: s, dist: best, at };
  });
  return scored
    .filter((x) => x.dist < 0.0000075)   // ~ 250 m
    .sort((a, b) => a.at - b.at)
    .map((x) => x.stop);
}

/* Human name for a direction: the terminal this alignment ends at. */
function directionLabel(routeId, dir) {
  const shape = shapeFor(routeId, dir);
  if (!shape.length) return routeMeta(routeId).long || "Milwaukee";
  const end = shape[shape.length - 1];
  const stops = routeStops(routeId, dir);
  const pool = stops.length ? stops : (ST.stops || []);
  let nearest = null, best = Infinity;
  for (const s of pool) {
    const d = (s[2] - end[0]) ** 2 + (s[3] - end[1]) ** 2;
    if (d < best) { best = d; nearest = s; }
  }
  return nearest ? "Toward " + titleCase(nearest[1]) : routeMeta(routeId).long;
}

/* Live vehicles on a route. When the route has two alignments, each vehicle is
   assigned to the one its heading matches — a real classification from the
   feed's own bearing field, not a guess at a schedule. */
function vehiclesFor(routeId, dir) {
  const all = routeId === "HOP"
    ? ((LIVE && LIVE.hop) || []).map((v) => ({ ...v, route: "HOP", bearing: v.heading }))
    : ((LIVE && LIVE.vehicles) || []).filter((v) => String(v.route) === String(routeId));

  const dirs = directionKeys(routeId);
  if (dirs.length < 2) return all;

  const here = shapeFor(routeId, dir);
  const other = shapeFor(routeId, dirs.find((d) => d !== dir));
  if (!here.length || !other.length) return all;

  return all.filter((v) => {
    if (typeof v.lat !== "number" || typeof v.lon !== "number") return false;
    const b = Number(v.bearing);
    if (!Number.isFinite(b) || b === 0) return true;  // no heading: show on both
    const a = nearestOnShape(here, v.lat, v.lon);
    const c = nearestOnShape(other, v.lat, v.lon);
    if (a.bearing == null || c.bearing == null) return true;
    return angleGap(b, a.bearing) <= angleGap(b, c.bearing);
  });
}

/* Which of a route's alignments a given vehicle is running, by heading. */
function directionForVehicle(routeId, vehicle) {
  const dirs = directionKeys(routeId);
  if (!vehicle || dirs.length < 2) return dirs[0] || "0";
  const b = Number(vehicle.bearing);
  if (!Number.isFinite(b) || b === 0) return dirs[0];
  let best = dirs[0], bestGap = Infinity;
  for (const d of dirs) {
    const shape = shapeFor(routeId, d);
    if (!shape.length) continue;
    const near = nearestOnShape(shape, vehicle.lat, vehicle.lon);
    if (near.bearing == null) continue;
    const gap = angleGap(b, near.bearing);
    if (gap < bestGap) { bestGap = gap; best = d; }
  }
  return best;
}

/* ----------------------------------------------------- stop predictions -- */

/* Every upcoming departure in the feed, soonest first. */
function allPredictions() {
  const now = wallNow();
  const out = [];
  for (const [stopId, preds] of Object.entries((LIVE && LIVE.stops) || {})) {
    for (const p of preds) {
      if (p[2] > now + 15) out.push({ stopId, route: String(p[0]), at: p[2], trip: p[3], mins: minutesUntil(p[2]) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function predictionsFor(routeId, stopId) {
  return allPredictions().filter(
    (x) => x.route === String(routeId) && String(x.stopId) === String(stopId)
  );
}

/* ------------------------------------------------------- saved routes -- */

const savedRoutes = () => store.read([]);

function isSaved(routeId, stopId) {
  return savedRoutes().some((s) => s.route === String(routeId) && s.stop === String(stopId));
}

function toggleSaved(routeId, stopId) {
  if (!routeId || !stopId) return null;   // nothing on the card to save yet
  const list = savedRoutes();
  const i = list.findIndex((s) => s.route === String(routeId) && s.stop === String(stopId));
  if (i >= 0) list.splice(i, 1);
  else list.unshift({ route: String(routeId), stop: String(stopId) });

  if (!store.write(list.slice(0, 8))) {
    toast("This browser is blocking storage, so saved routes will not stick.");
    return i < 0;
  }
  renderSaved();
  return i < 0;
}

function renderSaved() {
  const list = savedRoutes();
  const block = $("saved-block");
  if (!list.length) { block.hidden = true; return; }
  block.hidden = false;

  $("saved-list").innerHTML = list.map((s) => {
    const meta = routeMeta(s.route);
    const next = predictionsFor(s.route, s.stop)[0];
    const eta = next ? etaLabel(next.mins) + (next.mins > 0 ? " min" : "") : "No prediction";
    const when = next ? ` · ${clockAt(next.at)}` : "";
    return `<button class="row" type="button" data-route="${esc(s.route)}" data-stop="${esc(s.stop)}"
        style="--c:${esc(routeColor(s.route))}">
      <i></i>
      <span class="label">
        <b>${esc(meta.name)} · ${esc(meta.long)}</b>
        <small>${esc(stopName(s.stop))}${esc(when)}</small>
      </span>
      <strong>${esc(eta)}</strong>
      <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron"/></svg>
    </button>`;
  }).join("");

  bindRows($("saved-list"));
}

function bindRows(container) {
  container.querySelectorAll(".row").forEach((row) => {
    row.addEventListener("click", () => openDetails(row.dataset.route, row.dataset.stop));
  });
}

/* ---------------------------------------------------------- Today screen -- */

function ageLabel(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function renderFeedBadge() {
  const badge = $("feed-badge");
  const label = $("feed-label");
  if (!LIVE) { badge.dataset.state = "down"; label.textContent = "Offline"; return; }
  const age = feedAge();
  if (age <= STALE_SECS) {
    badge.dataset.state = "live";
    label.textContent = "Live";
  } else {
    badge.dataset.state = "stale";
    const mins = Math.round(age / 60);
    label.textContent = mins < 60 ? `${mins} min old` : `${Math.round(mins / 60)} h old`;
  }
}

/* When the collector stalls, say so plainly and name the time it stopped —
   an empty departure board with no explanation reads as a broken app. */
function renderStaleNotice() {
  const banner = $("stale-notice");
  const age = feedAge();
  if (!LIVE || age <= STALE_SECS) { banner.hidden = true; return; }
  const at = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/Chicago",
  }).format(new Date(LIVE.ts * 1000));
  banner.hidden = false;
  banner.querySelector("span").textContent =
    `Live feed last updated ${ageLabel(age)}, at ${at}. Arrival times are only as fresh as the feed, so some may already have passed.`;
}

/* The journey strip: the focused vehicle's own next stops, straight from
   the feed's `next` array. Renders nothing when the feed carries none. */
function renderJourney(vehicle, routeId) {
  const strip = $("journey");
  const upcoming = (vehicle && Array.isArray(vehicle.next) ? vehicle.next : []).slice(0, 4);
  if (upcoming.length < 2) { strip.innerHTML = ""; return; }

  strip.style.setProperty("--c", routeColor(routeId));
  strip.innerHTML = upcoming.map((n, i) => `
    <span class="leg${i === 0 ? " is-next" : ""}">
      <b>${esc(etaLabel(minutesUntil(n.at)))}</b>
      <small>${esc(titleCase(n.name || stopName(n.stop)))}</small>
    </span>`).join("");
}

function renderToday() {
  renderFeedBadge();

  const card = $("next-card");
  const preds = allPredictions();

  $("date").textContent = new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "short", day: "numeric",
  }).format(new Date());

  const buses = (LIVE && LIVE.counts && LIVE.counts.buses) || (LIVE && LIVE.vehicles || []).length;
  $("fleet-count").textContent = buses ? `${buses} vehicles running` : "Milwaukee";

  if (!preds.length) {
    card.classList.remove("is-loading");
    const stalled = feedAge() > STALE_SECS;
    $("next-route").textContent = stalled ? "The live feed has stopped updating" : "No live departures right now";
    $("next-dest").textContent = stalled
      ? `Last snapshot was ${ageLabel(feedAge())}.`
      : "The feed is connected but reporting no upcoming arrivals.";
    $("next-min").textContent = "--";
    $("next-stop").textContent = "";
    $("next-away").textContent = feedAge() > STALE_SECS
      ? "Every prediction in the last snapshot has already passed. Waiting for the collector to publish a new one."
      : "This is normal overnight and between service periods.";
    $("next-status").textContent = "Quiet";
    $("next-status").dataset.tone = "quiet";
    $("journey").innerHTML = "";
    renderStaleNotice();
    $("show-bus").disabled = true;
    $("save-route").disabled = true;
    $("save-route").setAttribute("aria-pressed", "false");
    delete card.dataset.route;
    delete card.dataset.stop;
    $("later").innerHTML = `<p class="row-empty">Nothing scheduled in the current feed window.</p>`;
    renderSystem();
    return;
  }

  const next = preds[0];
  const meta = routeMeta(next.route);
  const onRoute = ((LIVE.vehicles) || []).filter((v) => String(v.route) === next.route);
  /* Only a vehicle we can actually tie to THIS arrival — by trip id, or by the
     stop appearing in its own next-stop list. Falling back to "some bus on the
     route" would caption one vehicle's journey with another's arrival. */
  const vehicle =
    (next.trip && onRoute.find((v) => String(v.trip) === String(next.trip))) ||
    onRoute.find((v) => (v.next || []).some((n) => String(n.stop) === String(next.stopId))) ||
    null;

  card.classList.remove("is-loading");
  card.style.setProperty("--c", routeColor(next.route));
  card.dataset.route = next.route;
  card.dataset.stop = next.stopId;
  card.dataset.vehicle = (vehicle && vehicle.id) || "";

  $("next-rule").style.background = routeColor(next.route);
  $("next-route").textContent = `${meta.name} · ${meta.long}`;
  $("next-dest").textContent = hasTwoDirections(next.route)
    ? directionLabel(next.route, directionForVehicle(next.route, vehicle))
    : (meta.long || "Milwaukee");
  $("next-min").textContent = etaLabel(next.mins);
  $("next-min-unit").hidden = next.mins <= 0;
  $("next-stop").textContent = stopName(next.stopId);
  $("next-away").textContent = onRoute.length === 1
    ? "1 vehicle currently on this route"
    : `${onRoute.length} vehicles currently on this route`;
  $("show-bus").disabled = false;
  $("save-route").disabled = false;

  const delay = vehicle && Number(vehicle.delay);
  const status = $("next-status");
  if (next.mins <= 1)                      { status.textContent = "Due";      status.dataset.tone = "due"; }
  else if (Number.isFinite(delay) && delay > 300) { status.textContent = `${Math.round(delay / 60)} min late`; status.dataset.tone = "late"; }
  else                                     { status.textContent = "On time";  status.dataset.tone = "ok"; }

  renderJourney(vehicle, next.route);

  const save = $("save-route");
  save.setAttribute("aria-pressed", String(isSaved(next.route, next.stopId)));

  /* Later — the next distinct route/stop pairs after the headline one */
  /* One row per route, and far enough out to actually read as "later" —
     otherwise the citywide feed fills this list with four more "Now"s. */
  /* Next departures on other routes, soonest first. An earlier version forced
     each row to be a minute later than the last, which made this list always
     read 2/3/4/5 regardless of the feed — a constant dressed up as data. */
  const seen = new Set([next.route]);
  const later = [];
  for (const p of preds.slice(1)) {
    if (seen.has(p.route)) continue;
    seen.add(p.route);
    later.push(p);
    if (later.length === 4) break;
  }

  $("later").innerHTML = later.length ? later.map((p) => {
    const m = routeMeta(p.route);
    return `<button class="row" type="button" data-route="${esc(p.route)}" data-stop="${esc(p.stopId)}"
        style="--c:${esc(routeColor(p.route))}">
      <i></i>
      <span class="label">
        <b>${esc(m.name)} · ${esc(m.long)}</b>
        <small>${esc(stopName(p.stopId))} · ${esc(clockAt(p.at))}</small>
      </span>
      <strong>${esc(etaLabel(p.mins))}${p.mins > 0 ? " min" : ""}</strong>
      <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chevron"/></svg>
    </button>`;
  }).join("") : `<p class="row-empty">No other departures in the feed right now.</p>`;

  bindRows($("later"));
  renderStaleNotice();
  renderSaved();
  renderSystem();
}

function renderSystem() {
  const alerts = (LIVE && LIVE.alerts) || [];
  const row = $("system-row");
  const text = (LIVE && LIVE.status) ||
    (alerts.length ? `${alerts.length} active service notice${alerts.length === 1 ? "" : "s"}` : "All routes operating normally");
  $("sys-status").textContent = text;
  row.dataset.tone = alerts.length ? "alert" : "ok";
}

/* --------------------------------------------------------- Alerts screen -- */

function renderAlerts() {
  const alerts = (LIVE && LIVE.alerts) || [];
  const list = $("alerts-list");

  if (!alerts.length) {
    list.innerHTML = `<article class="alert-card">
      <i></i>
      <div>
        <h2>No active service alerts</h2>
        <p>${esc((LIVE && LIVE.status) || "The MCTS feed is connected and reporting normal service.")}</p>
      </div>
    </article>`;
    return;
  }

  list.innerHTML = alerts.map((a) => {
    const routes = Array.isArray(a.routes) ? a.routes : [];
    const effect = a.effect || "Service notice";
    /* `title` names the affected routes, `effect` classifies them. Leading the
       card with the effect alone makes every card read "Detour". */
    let heading = a.title || (routes.length ? "Routes " + routes.join(", ") : effect);
    /* Some feed titles arrive shouting ("ROUTE 57") and some do not. */
    if (heading === heading.toUpperCase() && /[A-Z]{4,}/.test(heading)) heading = titleCase(heading);
    /* The collector strips stop-id jargon, which can leave dangling punctuation. */
    const body = String(a.text || a.description || "")
      .replace(/^[\s.;,–—-]+/, "")
      .trim();
    return `<article class="alert-card" data-tone="alert">
      <i></i>
      <div>
        <span class="tag">${esc(effect)}</span>
        <h2>${esc(heading)}</h2>
        <p>${esc(body || "See RideMCTS.com for details.")}</p>
      </div>
    </article>`;
  }).join("");
}

/* ------------------------------------------------------- details modal -- */

function fillDetails(routeId, stopId) {
  const meta = routeMeta(routeId);
  const preds = predictionsFor(routeId, stopId).slice(0, 5);
  const onRoute = vehiclesFor(routeId, selectedDir);
  const sheet = $("details");

  sheet.dataset.route = routeId;
  sheet.dataset.stop = stopId || "";
  sheet.style.setProperty("--c", routeColor(routeId));
  $("detail-rule").style.background = routeColor(routeId);
  $("detail-route").textContent = `${meta.name} · ${meta.long}`;
  $("detail-dest").textContent = stopId ? "From " + stopName(stopId) : meta.long;
  $("detail-min").textContent = preds.length ? etaLabel(preds[0].mins) : "--";
  $("detail-min-unit").hidden = !preds.length || preds[0].mins <= 0;
  $("detail-away").textContent = preds.length
    ? `${onRoute.length} live vehicle${onRoute.length === 1 ? "" : "s"} · ${stopName(stopId)}`
    : "No live prediction for this stop right now.";

  const status = $("detail-status");
  status.textContent = preds.length ? "Live" : "No prediction";
  status.dataset.tone = preds.length ? "ok" : "quiet";

  $("arrivals").innerHTML = preds.length
    ? preds.map((p) => `<div class="arrival">
        <b>${esc(etaLabel(p.mins))}${p.mins > 0 ? " min" : ""}</b>
        <i></i>
        <span>${esc(stopName(p.stopId))} · ${esc(clockAt(p.at))}</span>
      </div>`).join("")
    : `<p class="row-empty">The feed carries no upcoming departures for this stop.</p>`;

  const age = feedAge();
  $("updated").querySelector("span").textContent = age < 120
    ? `Live feed updated ${age} seconds ago`
    : `Live feed last updated ${ageLabel(age)}`;

  const dirBtn = $("detail-direction");
  dirBtn.disabled = !hasTwoDirections(routeId);
  dirBtn.querySelector("span").textContent = hasTwoDirections(routeId)
    ? "Switch direction"
    : "Single direction route";
}

function openDetails(routeId, stopId) {
  if (!routeId) return;
  fillDetails(routeId, stopId);
  openModal("details");
}

function fullRoute() {
  const routeId = $("details").dataset.route || selectedRoute;
  if (!routeId) return;
  const meta = routeMeta(routeId);
  const stops = routeStops(routeId, selectedDir);

  $("full-title").textContent = `${meta.name} · ${meta.long}`;
  $("full-sub").textContent = stops.length
    ? `${stops.length} stops · ${directionLabel(routeId, selectedDir)}`
    : "Stop sequence is unavailable for this route.";
  $("full-stops").style.setProperty("--c", routeColor(routeId));
  $("full-stops").innerHTML = stops.length
    ? stops.map((s) => `<div class="stop-full"><i></i><span>${esc(titleCase(s[1]))}</span></div>`).join("")
    : `<p class="row-empty">This route has no committed stop sequence in the static pack.</p>`;

  openModal("route-modal");
}

/* ---------------------------------------------------------------- modals -- */

function openModal(id) {
  lastFocusedEl = document.activeElement;
  const el = $(id);
  el.hidden = false;
  const focusTarget = el.querySelector(".close");
  if (focusTarget) focusTarget.focus();
}

function closeModal(id) {
  $(id).hidden = true;
  if (lastFocusedEl && lastFocusedEl.isConnected) lastFocusedEl.focus();
}

/* Topmost first: the full-route list stacks above the detail sheet. */
const anyModalOpen = () => ["route-modal", "details"].find((id) => !$(id).hidden);

/* ------------------------------------------------------------ map screen -- */

function renderRouteChips() {
  const counts = new Map();
  for (const v of (LIVE && LIVE.vehicles) || []) {
    const id = String(v.route);
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  let ids = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, 12);
  if ((LIVE && LIVE.hop || []).length && !(LIVE && LIVE.hop_offline)) ids.unshift("HOP");
  if (selectedRoute && !ids.includes(selectedRoute)) ids.unshift(selectedRoute);
  if (!ids.length) ids = ST.routes.slice(0, 8).map((r) => String(r.id));
  if (!selectedRoute) selectedRoute = ids[0];

  $("route-switch").innerHTML = ids.map((id) => {
    const meta = routeMeta(id);
    const n = id === "HOP" ? ((LIVE && LIVE.hop) || []).length : (counts.get(id) || 0);
    return `<button type="button" role="tab" data-route="${esc(id)}" aria-selected="${id === selectedRoute}" style="--c:${esc(routeColor(id))}"><span class="dot"></span>${esc(meta.name)}${n ? ` · ${n}` : ""}</button>`;
  }).join("");

  $("route-switch").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => showMap(b.dataset.route));
  });
}

function showMap(routeId, vehicleId) {
  if (routeId && routeId !== selectedRoute) {
    selectedRoute = String(routeId);
    selectedDir = directionKeys(selectedRoute)[0] || "0";
  }
  focusVehicle = vehicleId || null;
  switchScreen("map-screen");
  renderRouteChips();
  renderMap();
  setTimeout(() => { if (map) { map.resize(); renderMap(); } }, 140);
}

function switchDirection() {
  const dirs = directionKeys(selectedRoute);
  if (dirs.length < 2) { toast("This route only has one alignment in the feed."); return; }
  selectedDir = dirs[(dirs.indexOf(selectedDir) + 1) % dirs.length];
  focusVehicle = null;
  renderMap();
  toast(directionLabel(selectedRoute, selectedDir));
}

function renderMap() {
  if (!ST || !selectedRoute) return;

  let vehicles = vehiclesFor(selectedRoute, selectedDir);
  if (focusVehicle) vehicles = vehicles.filter((v) => String(v.id) === String(focusVehicle));

  const coords = shapeFor(selectedRoute, selectedDir).map((p) => [p[1], p[0]]);
  const stops = routeStops(selectedRoute, selectedDir);
  const meta = routeMeta(selectedRoute);
  const color = routeColor(selectedRoute);

  drawFallback(coords, vehicles, stops, color);

  $("map-rule").style.background = color;
  $("map-sheet").style.setProperty("--c", color);
  $("map-route").textContent = selectedRoute === "HOP" ? "The Hop" : `Route ${meta.name}`;
  $("map-dest").textContent = directionLabel(selectedRoute, selectedDir);
  $("map-min").textContent = vehicles.length;
  $("map-min-unit").textContent = vehicles.length === 1 ? "vehicle" : "vehicles";
  $("map-away").textContent = focusVehicle
    ? `Showing one vehicle · ${stops.length} stops this way`
    : `Running this direction now · ${stops.length} stops this way`;

  const status = $("map-status");
  status.textContent = vehicles.length ? "Live" : "No vehicles";
  status.dataset.tone = vehicles.length ? "ok" : "quiet";

  const dirBtn = $("map-direction");
  dirBtn.disabled = !hasTwoDirections(selectedRoute);

  if (!map || !map.isStyleLoaded()) return;
  paintMapLayers(coords, vehicles, stops, color);
}

function paintMapLayers(coords, vehicles, stops, color) {
  ["vehicles", "route-stops", "route-line", "route-case"].forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
  });
  ["vehicles", "route-stops", "route-line"].forEach((id) => {
    if (map.getSource(id)) map.removeSource(id);
  });

  if (coords.length) {
    map.addSource("route-line", {
      type: "geojson",
      data: { type: "Feature", geometry: { type: "LineString", coordinates: coords } },
    });
    map.addLayer({ id: "route-case", type: "line", source: "route-line",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#fff", "line-width": 9, "line-opacity": .9 } });
    map.addLayer({ id: "route-line", type: "line", source: "route-line",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": color, "line-width": 5 } });
  }

  map.addSource("route-stops", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: stops.map((s) => ({
        type: "Feature",
        properties: { name: titleCase(s[1]) },
        geometry: { type: "Point", coordinates: [s[3], s[2]] },
      })),
    },
  });
  map.addLayer({ id: "route-stops", type: "circle", source: "route-stops",
    paint: { "circle-radius": 4, "circle-color": "#fff",
             "circle-stroke-color": color, "circle-stroke-width": 2 } });

  map.addSource("vehicles", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: vehicles
        .filter((v) => Number.isFinite(v.lon) && Number.isFinite(v.lat))
        .map((v) => ({
          type: "Feature",
          properties: {
            label: selectedRoute === "HOP" ? "H" : routeMeta(selectedRoute).name,
            id: String(v.id || ""),
          },
          geometry: { type: "Point", coordinates: [v.lon, v.lat] },
        })),
    },
  });
  map.addLayer({ id: "vehicles", type: "circle", source: "vehicles",
    paint: { "circle-radius": 11, "circle-color": color,
             "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });

  const all = coords.concat(
    vehicles.filter((v) => Number.isFinite(v.lon)).map((v) => [v.lon, v.lat])
  );
  if (all.length) {
    const bounds = all.reduce(
      (b, c) => b.extend(c), new maplibregl.LngLatBounds(all[0], all[0])
    );
    /* fitBounds throws a console warning if the padding exceeds the canvas,
       which happens while the map screen is still laying out. Scale it down. */
    const { width, height } = map.getCanvas().getBoundingClientRect();
    const padY = Math.min(95, Math.max(8, height * 0.12));
    const padBottom = Math.min(300, Math.max(8, height * 0.34));
    const padX = Math.min(35, Math.max(8, width * 0.08));
    if (width > 40 && height > 40) {
      map.fitBounds(bounds, {
        padding: { top: padY, bottom: padBottom, left: padX, right: padX },
        maxZoom: 15, duration: 500,
      });
    }
  }
}

/* Schematic fallback drawn from the same live data, used until tiles load
   (or permanently, if the tile host is unreachable). */
function drawFallback(coords, vehicles, stops, color) {
  const svg = $("fallback-svg"), box = $("fallback-vehicles");
  if (!svg || !box) return;

  const points = coords.concat(
    vehicles.filter((v) => Number.isFinite(v.lon)).map((v) => [v.lon, v.lat])
  );
  if (!points.length) {
    svg.innerHTML = "";
    box.innerHTML = "";
    return;
  }

  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const project = (p) => [
    25 + (p[0] - minX) / (maxX - minX || 1) * 315,
    80 + (maxY - p[1]) / (maxY - minY || 1) * 360,
  ];

  const step = Math.max(1, Math.floor(coords.length / 130));
  const line = coords.filter((_, i) => i % step === 0).map((p) => project(p).join(",")).join(" ");
  const dots = stops.filter((_, i) => i % 6 === 0).map((s) => project([s[3], s[2]]));

  svg.innerHTML =
    `<polyline points="${line}" fill="none" stroke="#fff" stroke-width="10" stroke-linejoin="round"/>` +
    `<polyline points="${line}" fill="none" stroke="${esc(color)}" stroke-width="5" stroke-linejoin="round"/>` +
    dots.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="4" fill="#fff" stroke="${esc(color)}" stroke-width="2"/>`).join("");

  const label = selectedRoute === "HOP" ? "H" : routeMeta(selectedRoute).name;
  box.innerHTML = vehicles.slice(0, 24).map((v) => {
    const [x, y] = project([v.lon, v.lat]);
    return `<i class="fallback-vehicle" style="left:${x}px;top:${y}px;background:${esc(color)}">${esc(label)}</i>`;
  }).join("");
}

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm", minzoom: 0, maxzoom: 19 }],
    },
    center: [-87.91, 43.04],
    zoom: 12.2,
    attributionControl: false,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
  if (location.search.includes("debug")) window.__map = map;

  map.on("load", () => {
    $("map-screen").classList.add("is-map-ready");
    renderMap();
    map.on("click", "vehicles", (e) => {
      const props = (e.features && e.features[0] && e.features[0].properties) || {};
      new maplibregl.Popup({ offset: 15, closeButton: false })
        .setLngLat(e.lngLat)
        .setHTML(`<b>${esc(props.label)} · vehicle ${esc(props.id)}</b><br><small>Live position from the MCTS feed</small>`)
        .addTo(map);
    });
    map.on("mouseenter", "vehicles", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "vehicles", () => { map.getCanvas().style.cursor = ""; });
  });

  map.on("error", (e) => {
    if (!map.loaded()) console.warn("Map tiles unavailable; keeping schematic fallback.", e && e.error);
  });
}

/* --------------------------------------------------------- sheet dragging -- */

function initSheetDrag() {
  const sheet = $("map-sheet");
  const handle = $("sheet-grab");
  let startY = 0, startOffset = 0, lastY = 0, lastT = 0, velocity = 0, dragging = false;

  const maxOffset = () => Math.max(0, sheet.offsetHeight - 76);
  const setOffset = (y) => {
    const v = Math.max(0, Math.min(maxOffset(), y));
    sheet.dataset.offset = v;
    sheet.style.transform = `translate3d(0, ${v}px, 0)`;
  };

  const begin = (y) => {
    dragging = true;
    startY = lastY = y;
    startOffset = Number(sheet.dataset.offset || 0);
    lastT = performance.now();
    velocity = 0;
    sheet.classList.add("is-dragging");
    if (map) map.dragPan.disable();
  };

  const move = (y) => {
    if (!dragging) return;
    const now = performance.now();
    velocity = (y - lastY) / Math.max(1, now - lastT);
    lastY = y; lastT = now;
    setOffset(startOffset + y - startY);
  };

  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove("is-dragging");
    if (map) map.dragPan.enable();
    const h = maxOffset();
    const projected = Number(sheet.dataset.offset || 0) + velocity * 160;
    const snaps = [0, Math.round(h * 0.48), h];
    setOffset(snaps.reduce((a, b) => (Math.abs(b - projected) < Math.abs(a - projected) ? b : a)));
    setTimeout(() => map && map.resize(), 280);
  };

  handle.addEventListener("pointerdown", (e) => {
    handle.setPointerCapture(e.pointerId);
    begin(e.clientY);
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => move(e.clientY));
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("keydown", (e) => {
    const h = maxOffset();
    const cur = Number(sheet.dataset.offset || 0);
    if (e.key === "ArrowDown") { setOffset(cur < h * 0.25 ? Math.round(h * 0.48) : h); e.preventDefault(); }
    if (e.key === "ArrowUp")   { setOffset(cur > h * 0.7 ? Math.round(h * 0.48) : 0); e.preventDefault(); }
  });

  handle.tabIndex = 0;
  handle.setAttribute("role", "slider");
  handle.setAttribute("aria-label", "Resize the route summary sheet");
  handle.setAttribute("aria-orientation", "vertical");
}

/* -------------------------------------------------------------- screens -- */

function switchScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("is-active", s.id === id));
  document.querySelectorAll(".tabs button").forEach((b) => {
    const on = b.dataset.screen === id;
    b.classList.toggle("is-on", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  if (id === "map-screen") setTimeout(() => map && map.resize(), 80);
}

/* ----------------------------------------------------------------- boot -- */

async function loadLive() {
  const res = await fetch(`${LIVE_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`live feed responded ${res.status}`);
  return res.json();
}

/* Redraw the countdowns from the clock between fetches, so the numbers move
   even while the feed is unchanged — and keep moving when it has stalled. */
function tick() {
  if (!ST || !LIVE) return;
  renderToday();
  const sheet = $("details");
  if (!sheet.hidden && sheet.dataset.route) {
    fillDetails(sheet.dataset.route, sheet.dataset.stop);
  }
}

async function refresh() {
  try {
    LIVE = await loadLive();
    renderToday();
    renderAlerts();
    renderRouteChips();
    renderMap();
  } catch (err) {
    console.warn("Live refresh failed; keeping the last good snapshot.", err);
    renderFeedBadge();
  }
}

function showFatal(message) {
  $("next-card").classList.remove("is-loading");
  $("next-route").textContent = "Hopscotch is offline";
  $("next-dest").textContent = message;
  $("next-min").textContent = "--";
  $("next-stop").textContent = "";
  $("next-away").textContent = "";
  $("show-bus").disabled = true;
  $("save-route").disabled = true;
  $("view-all").disabled = true;
  $("journey").innerHTML = "";
  $("later").innerHTML = '<p class="row-empty">No departures to show while the feed is unavailable.</p>';
  $("feed-badge").dataset.state = "down";
  $("feed-label").textContent = "Offline";
  $("sys-status").textContent = message;
}

async function boot() {
  try {
    const res = await fetch("data/static.json", { cache: "force-cache" });
    if (!res.ok) throw new Error(`static data responded ${res.status}`);
    ST = await res.json();
  } catch (err) {
    console.error(err);
    showFatal("Route and stop data could not be loaded.");
    return;
  }

  try {
    LIVE = await loadLive();
  } catch (err) {
    console.error(err);
    showFatal("The live vehicle feed is unreachable right now.");
    return;
  }

  selectedRoute = String((LIVE.vehicles && LIVE.vehicles[0] && LIVE.vehicles[0].route) || ST.routes[0].id);
  selectedDir = directionKeys(selectedRoute)[0] || "0";

  renderToday();
  renderAlerts();
  renderRouteChips();
  initSheetDrag();

  try { initMap(); }
  catch (err) { console.warn("Interactive map unavailable; using the schematic fallback.", err); }

  renderMap();

  if (location.hash === "#map") showMap(selectedRoute);

  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, REFRESH_MS);

  clearInterval(tickTimer);
  tickTimer = setInterval(() => {
    if (document.visibilityState === "visible") tick();
  }, TICK_MS);
}

/* ------------------------------------------------------------- wiring -- */

function wire() {
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.addEventListener("click", () => switchScreen(b.dataset.screen));
  });

  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => closeModal(el.dataset.close));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = anyModalOpen();
    if (open) closeModal(open);
  });

  $("show-bus").addEventListener("click", () => {
    const card = $("next-card");
    showMap(card.dataset.route, card.dataset.vehicle);
  });

  $("save-route").addEventListener("click", (e) => {
    const card = $("next-card");
    const now = toggleSaved(card.dataset.route, card.dataset.stop);
    if (now === null) { toast("There is no live departure to save yet."); return; }
    e.currentTarget.setAttribute("aria-pressed", String(now));
    toast(now ? "Saved to Today" : "Removed from saved routes");
  });

  $("view-all").addEventListener("click", () => {
    const card = $("next-card");
    openDetails(card.dataset.route, card.dataset.stop);
  });

  $("system-row").addEventListener("click", () => switchScreen("alerts"));

  $("locate").addEventListener("click", () => {
    if (!navigator.geolocation) return toast("Location is unavailable in this browser.");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!map) return toast("The interactive map is unavailable right now.");
        map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 15 });
      },
      () => toast("Location permission was declined."),
      { enableHighAccuracy: true, timeout: 7000 }
    );
  });

  $("route-details").addEventListener("click", () => {
    const stops = routeStops(selectedRoute, selectedDir);
    const withPrediction = stops.find((s) => predictionsFor(selectedRoute, s[0]).length);
    openDetails(selectedRoute, (withPrediction || stops[0] || [])[0]);
  });

  $("map-direction").addEventListener("click", switchDirection);

  $("detail-direction").addEventListener("click", () => {
    const routeId = $("details").dataset.route;
    const dirs = directionKeys(routeId);
    if (dirs.length < 2) return toast("This route only has one alignment in the feed.");
    if (routeId !== selectedRoute) {
      selectedRoute = routeId;
      selectedDir = dirs[0];
    }
    selectedDir = dirs[(dirs.indexOf(selectedDir) + 1) % dirs.length];
    renderMap();
    closeModal("details");
    switchScreen("map-screen");
    renderRouteChips();
    toast(directionLabel(routeId, selectedDir));
  });

  $("detail-map").addEventListener("click", () => {
    const routeId = $("details").dataset.route;
    closeModal("details");
    showMap(routeId);
  });

  $("full-route").addEventListener("click", fullRoute);

  $("share").addEventListener("click", async () => {
    const routeId = $("details").dataset.route || selectedRoute;
    const meta = routeMeta(routeId);
    const url = `${location.origin}${location.pathname}#map`;
    const payload = { title: "Hopscotch", text: `${meta.name} · ${meta.long} on Hopscotch`, url };
    try {
      if (navigator.share) { await navigator.share(payload); return; }
      await navigator.clipboard.writeText(url);
      toast("Link copied to your clipboard");
    } catch {
      toast("Sharing is unavailable in this browser.");
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ST) refresh();
  });
}

/* The script is loaded at the end of <body>, but guard anyway so a deferred
   or cached execution after DOMContentLoaded still starts the app. */
function start() {
  wire();
  boot().catch((err) => {
    console.error(err);
    showFatal("Something went wrong while starting up.");
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
  start();
}

})();
