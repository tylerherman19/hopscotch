/* Hopscotch shared core: data + motion rulebook. Plain JS, no libraries. */
(function(){
"use strict";

/* ---- the motion rulebook (one system, every concept obeys it) ---- */
const FROZEN = /frozen/.test(location.search);
if(FROZEN) document.documentElement.classList.add("frozen");
const MOTION = {
  standard: "cubic-bezier(.2,.7,.2,1)",   /* quick start, soft landing */
  settle:   "cubic-bezier(.16,1,.3,1)",   /* draws, room changes */
  press: 120, micro: 240, panel: 420, room: 620, draw: 700,
  rise: 8,                                 /* reveals never travel more than 8px */
};
function easeOutCubic(t){ return 1 - Math.pow(1-t, 3); }

/* Rolling number: counts up from old value, fast start, settles on the digit. */
function countUp(el, to, opts){
  opts = opts || {};
  if(FROZEN){ el.textContent = to.toLocaleString("en-US"); el._cv = to; return; }
  const dur = opts.dur || MOTION.room;
  const from = el._cv || 0;
  const start = performance.now();
  if(el._raf) cancelAnimationFrame(el._raf);
  function frame(now){
    const t = Math.min(1, (now-start)/dur);
    const v = Math.round(from + (to-from)*easeOutCubic(t));
    el.textContent = v.toLocaleString("en-US");
    if(t < 1){ el._raf = requestAnimationFrame(frame); }
    else { el._cv = to; el._raf = null; }
  }
  el._raf = requestAnimationFrame(frame);
}

/* Stroke draw-on for an SVG path: sketch itself, quick start soft landing. */
function drawOn(path, dur, delay, done){
  if(FROZEN){ done && done(); return; }
  const len = path.getTotalLength();
  path.style.strokeDasharray = len;
  path.style.strokeDashoffset = len;
  path.getBoundingClientRect();
  path.style.transition = "none";
  requestAnimationFrame(()=>{
    path.style.transition = "stroke-dashoffset " + dur + "ms " + MOTION.settle + " " + delay + "ms";
    path.style.strokeDashoffset = "0";
    if(done) setTimeout(done, dur + delay);
  });
}

/* ---- data ---- */
const LIVE_URL = "https://raw.githack.com/tylerherman19/hopscotch/data/live.json";
let STATIC = null, LIVE = null;

async function loadStatic(){
  if(STATIC) return STATIC;
  const r = await fetch("data/static.json", {cache:"force-cache"});
  STATIC = await r.json();
  STATIC._routeMap = {};
  STATIC.routes.forEach(rt => { STATIC._routeMap[rt.id] = rt; });
  STATIC._stopMap = {};
  STATIC.stops.forEach(s => { STATIC._stopMap[s[0]] = {id:s[0], name:s[1], lat:s[2], lon:s[3]}; });
  return STATIC;
}
async function loadLive(){
  const r = await fetch(LIVE_URL + "?cb=" + Date.now(), {cache:"no-store"});
  LIVE = await r.json();
  LIVE._ts = Date.now();
  return LIVE;
}
function routeColor(id){
  if(id === "HOP" || id === 4 || id === 7) return "#8c6d1f";
  const rt = STATIC._routeMap[id];
  return rt ? "#" + rt.color : "#16130e";
}
function routeName(id){
  const rt = STATIC._routeMap[id];
  return rt ? rt.long : (id === 4 ? "The Hop L-Line" : id === 7 ? "The Hop M-Line" : id);
}

/* ---- geo ---- */
/* equirectangular fit: returns {x,y} for lat/lon inside w x h with padding */
function fitter(bounds, w, h, pad){
  const [minLat, maxLat, minLon, maxLon] = bounds;
  const latC = (minLat+maxLat)/2;
  const kx = Math.cos(latC*Math.PI/180);
  const sx = (w-2*pad)/((maxLon-minLon)*kx), sy = (h-2*pad)/(maxLat-minLat);
  const s = Math.min(sx, sy);
  const ox = pad + ((w-2*pad) - (maxLon-minLon)*kx*s)/2;
  const oy = pad + ((h-2*pad) - (maxLat-minLat)*s)/2;
  return function(lat, lon){
    return { x: ox + (lon-minLon)*kx*s, y: h - (oy + (lat-minLat)*s) };
  };
}
function polylineMetrics(pts){
  const cum = [0];
  let total = 0;
  for(let i=1;i<pts.length;i++){
    total += Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
    cum.push(total);
  }
  return {cum, total};
}
function pointAtFrac(pts, m, f){
  f = Math.max(0, Math.min(1, f));
  const d = f*m.total;
  let i = 1;
  while(i < m.cum.length-1 && m.cum[i] < d) i++;
  const seg = m.cum[i]-m.cum[i-1] || 1;
  const t = (d-m.cum[i-1])/seg;
  return [ pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t, pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t ];
}
/* fraction along polyline nearest to lat/lon */
function projectFrac(pts, m, lat, lon){
  let best = 0, bestD = 1e9;
  for(let i=1;i<pts.length;i++){
    const ax=pts[i-1][0], ay=pts[i-1][1], bx=pts[i][0], by=pts[i][1];
    const dx=bx-ax, dy=by-ay;
    const L2 = dx*dx+dy*dy || 1e-9;
    let t = ((lon-ax)*dx + (lat-ay)*dy)/L2;
    t = Math.max(0, Math.min(1, t));
    const px = ax+dx*t, py = ay+dy*t;
    const d = (lon-px)*(lon-px)+(lat-py)*(lat-py);
    if(d < bestD){ bestD = d; best = (m.cum[i-1] + Math.sqrt(L2)*t)/m.total; }
  }
  return best;
}

/* Vehicle tracker: eases each vehicle's fraction toward its latest fix. */
function makeTracker(){
  const pos = {}; /* key -> {cur, target} */
  return {
    set(key, frac){
      if(!pos[key]) pos[key] = {cur: frac, target: frac};
      else pos[key].target = frac;
    },
    get(key){ return pos[key] ? pos[key].cur : null; },
    has(key){ return !!pos[key]; },
    dropMissing(keys){
      Object.keys(pos).forEach(k => { if(keys.indexOf(k) < 0) delete pos[k]; });
    },
    tick(){
      Object.values(pos).forEach(p => { p.cur += (p.target-p.cur)*0.06; });
    }
  };
}

window.HOPCORE = { FROZEN, MOTION, easeOutCubic, countUp, drawOn,
  loadStatic, loadLive, routeColor, routeName,
  fitter, polylineMetrics, pointAtFrac, projectFrac, makeTracker,
  get STATIC(){ return STATIC; }, get LIVE(){ return LIVE; } };
})();
