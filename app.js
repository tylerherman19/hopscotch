/* Hopscotch: agency predictions, explicit schedule fallback, personal stop boards. */
"use strict";
const LIVE_BASE = "https://raw.githubusercontent.com/tylerherman19/hopscotch/data/";
const MILWAUKEE = [43.0389, -87.9065];
const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  set(k,v) { try { localStorage.setItem(k,JSON.stringify(v)); } catch {} }
};
const S = {
  routes:[], routeById:{}, stops:{}, stopRoutes:{}, tt:{}, packs:{}, static:null, hot:[], live:null,
  veh:new Map(), map:null, lines:null, slayer:null, vlayer:null, mapReady:false,
  savedDir:store.get('hop_saved_dir',{school:'to',lake:'to'}), favorites:store.get('hop_favorites',[]),
  pinnedRoutes:store.get('hop_pinned_routes',[]), showStops:store.get('hop_stops_dots',1)!==0,
  reduced:store.get('hop_frozen',0)===1, isoRoute:'', selVeh:null, selStop:null,
  followId:null, view:'buses', screen:'home', allAlerts:false, editing:false, mePos:null,
  pollTimer:null, polling:false, fails:0, ready:false
};
for(const key of ['favorites','pinnedRoutes'])if(!Array.isArray(S[key]))S[key]=[];
if(!S.savedDir || typeof S.savedDir!=='object')S.savedDir={school:'to',lake:'to'};
const clock = epoch => new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',hour:'numeric',minute:'2-digit'}).format(new Date(epoch*1000));
function titleCase(s) {
  s=String(s||'');
  if(s===s.toUpperCase()) s=s.toLowerCase().replace(/(^|\s|[-/&])([a-z])/g,(m,p,c)=>p+c.toUpperCase());
  return s.replace(/\buwm\b/gi,'UWM').replace(/\bbrt\b/gi,'BRT').replace(/\bmcts\b/gi,'MCTS').replace(/\bubus\b/gi,'UBus');
}
function fmtIn(sec) {
  if(sec < -15) return 'Departed';
  if(sec < 45) return 'Due';
  const m=Math.ceil(sec/60);
  return m<60 ? m+' min' : Math.floor(m/60)+'h '+m%60+'m';
}
function ageText(ts) { const n=Math.max(0,Math.floor(Date.now()/1000-ts)); return n<60?n+'s ago':n<3600?Math.floor(n/60)+'m ago':Math.floor(n/3600)+'h ago'; }
function toast(msg) { $('toast').textContent=msg; $('toast').classList.add('show'); clearTimeout(S.toastTimer); S.toastTimer=setTimeout(()=>$('toast').classList.remove('show'),3500); }
async function fetchJson(url) {
  const r=await fetch(url,{cache:'no-store',signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error('Request failed: '+r.status);
  return r.json();
}
const freshSource = source => navigator.onLine && Transit.fresh(Transit.sourceTime(S.live,source));
const stopName = sid => S.stops[sid]?.name || 'Stop '+sid;
const hopStop = sid => S.static?.hop?.stops.find(s=>'H'+s.id===String(sid));
const position = () => S.mePos || MILWAUKEE;
function distance(a,b) { const rad=Math.PI/180, x=(b[1]-a[1])*rad*Math.cos((a[0]+b[0])*rad/2), y=(b[0]-a[0])*rad; return Math.hypot(x,y)*6371000; }
function servicesAvailable() { return !!S.static?.calendar[Transit.dayKey(Date.now()/1000)]; }
function headsign(rid,tid) { return titleCase(Transit.tripInfo(S.tt[rid],tid)?.headsign || '').replace(/^To /i,''); }
async function loadTtFor(routeIds) {
  const indexes=[...new Set(routeIds.map(r=>S.static?.tindex[r]).filter(n=>n!=null))];
  await Promise.all(indexes.map(async n=>{
    if(!S.packs[n]) S.packs[n]=fetchJson('data/tt-'+n+'.json').then(p=>Object.assign(S.tt,p)).catch(e=>{delete S.packs[n];throw e;});
    await S.packs[n];
  }));
}
function departures(sid,routes,alight,limit=8) {
  if(hopStop(sid)) {
    if(!freshSource('hop_arrivals') || S.live?.schema<2) return [];
    return (S.live.hop_stops?.[String(sid).slice(1)]||[]).filter(p=>p[1]>=Date.now()/1000-15).map(p=>({route:'HOP',at:p[1],sched:p[2]!==false,vehicle:p[3],headsign:hopStop(sid).name})).slice(0,limit);
  }
  return Transit.departures({packs:S.tt,calendar:S.static?.calendar||{},live:navigator.onLine?S.live:null,sid,routes:routes||S.stopRoutes[sid]||[],alight,limit});
}
function departureRows(list) {
  return list.map(p=>`<div class="departure-row"><span class="route-token${p.route==='HOP'?' hop-token':''}">${esc(p.route)}</span><div class="departure-dest">${esc(titleCase(p.headsign).replace(/^To /i,'')) || 'Destination not reported'}<small>${p.sched?'Scheduled · '+esc(clock(p.at)):'Live prediction · '+esc(clock(p.at))}</small></div><strong class="${p.sched?'scheduled-time':'live-time'}" data-at="${p.at}">${esc(fmtIn(p.at-Date.now()/1000))}</strong></div>`).join('');
}
function noDepartures(sid) { return hopStop(sid)?'No streetcar arrivals reported. Check the official tracker for current service.':servicesAvailable()?'No departures listed in the next four hours. Live data may be unavailable.':'The published timetable does not cover today. Only current live predictions can be shown.'; }

/* Raster map: works on phones and browsers without WebGL. */
function moveMap(ll,zoom,animate=true) {
  if(!S.map)return;
  S.map.setView(ll,zoom??S.map.getZoom(),{animate:animate&&!RM&&!S.reduced});
}
function initMap() {
  if(S.map || typeof L==='undefined') {
    if(!S.map) $('map-error').hidden=false;
    return;
  }
  S.map=L.map('map',{zoomControl:false,preferCanvas:false}).setView(MILWAUKEE,14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',maxZoom:19
  }).on('tileerror',()=>{$('map-error').hidden=false;}).on('load',()=>{$('map-error').hidden=true;}).addTo(S.map);
  L.control.zoom({position:'bottomright'}).addTo(S.map);
  S.lines=L.layerGroup().addTo(S.map);
  S.slayer=document.createElement('div'); S.slayer.id='slayer';
  S.vlayer=document.createElement('div'); S.vlayer.id='vlayer';
  S.map.getContainer().append(S.slayer,S.vlayer);
  L.DomEvent.disableClickPropagation(S.slayer); L.DomEvent.disableClickPropagation(S.vlayer);
  S.map.on('move zoom',positionOverlays);
  S.map.on('moveend zoomend',()=>{drawStops();renderNearby();});
  S.map.on('dragstart',()=>{if(S.followId)stopFollow();});
  S.map.on('click',()=>{if(S.selStop||S.selVeh)clearSelection();});
  S.mapReady=true;
  drawRouteLines();drawStops();positionOverlays();
}
function routeIdsOnMap() {
  if(S.isoRoute)return [S.isoRoute];
  if(S.view==='hop')return ['HOP'];
  if(S.view==='nearby')return [...new Set(nearbyStops().flatMap(([id])=>hopStop(id)?['HOP']:S.stopRoutes[id]||[]))];
  return [...new Set(['14','30','12','23',...S.pinnedRoutes])];
}
function drawRouteLines() {
  if(!S.lines)return;
  S.lines.clearLayers();
  for(const rid of routeIdsOnMap()) {
    const shapes=rid==='HOP'?S.static?.hop?.lines:S.static?.shapes[rid];
    for(const [dir,pts] of Object.entries(shapes||{})) {
      if(S.isoRoute&&S.routeDir!=null&&String(dir)!==String(S.routeDir))continue;
      if(pts.length<2)continue;
      L.polyline(pts,{color:window.Experience?Experience.color(rid).bg:rid==='HOP'?'#1e8e3e':'#0a84ff',weight:S.isoRoute?4:2.5,opacity:S.isoRoute?0.85:0.48}).addTo(S.lines).on('click',e=>{L.DomEvent.stopPropagation(e);showRoute(rid);});
    }
  }
}
function nearbyStops() {
  const ll=S.view==='nearby'&&S.map ? [S.map.getCenter().lat,S.map.getCenter().lng] : position();
  return Object.entries(S.stops).map(([id,s])=>[id,s,distance(ll,[s.lat,s.lon])]).filter(x=>x[2]<1500).sort((a,b)=>a[2]-b[2]).slice(0,12);
}
function drawStops() {
  if(!S.slayer)return;
  S.slayer.replaceChildren();
  if(S.showStops && S.map.getZoom()>=13) {
    const bounds=S.map.getBounds().pad(0.08),wanted=routeIdsOnMap();
    for(const [sid,s] of Object.entries(S.stops)) {
      if(!bounds.contains([s.lat,s.lon]))continue;
      if(S.isoRoute && !(S.isoRoute==='HOP'?hopStop(sid):(S.stopRoutes[sid]||[]).includes(S.isoRoute)))continue;
      if(S.view==='hop'&&!hopStop(sid))continue;
      if(S.view==='buses'&&!S.isoRoute&&!hopStop(sid)&&!(S.stopRoutes[sid]||[]).some(r=>wanted.includes(r)))continue;
      const b=document.createElement('button'); b.className='stopdot'+(hopStop(sid)?' hop-stop':'');
      b.title=s.name; b.setAttribute('aria-label','Stop '+sid+', '+s.name);b.dataset.sid=sid;
      b.addEventListener('click',e=>{e.stopPropagation();selectStop(sid);});S.slayer.append(b);
    }
  }
  if(S.mePos) {
    const me=document.createElement('div');me.className='me-dot';me.dataset.me='1';S.slayer.append(me);
  }
  positionOverlays();
}
function positionOverlays() {
  if(!S.map||!(S.screen==='map'||matchMedia('(min-width: 1000px)').matches))return;
  S.slayer?.querySelectorAll('[data-sid], [data-me]').forEach(el=>{
    const s=S.stops[el.dataset.sid],ll=el.dataset.me?S.mePos:[s.lat,s.lon];
    const p=S.map.latLngToContainerPoint(ll);el.style.transform=`translate(${p.x}px,${p.y}px)`;
  });
  for(const v of S.veh.values()) {
    const p=S.map.latLngToContainerPoint([v.v.lat,v.v.lon]);
    v.el.style.transform=`translate(${p.x}px,${p.y}px)`;
    v.el.hidden=!vehicleVisible(v);
    v.el.classList.toggle('stale',Date.now()/1000-v.ts>120);
    v.el.classList.toggle('sel',S.selVeh===v.id);
    if(S.selVeh===v.id) {$('callout').style.left=p.x+'px';$('callout').style.top=(p.y-22)+'px';}
  }
}
function vehicleVisible(v) {
  if(!Transit.fresh(v.ts))return false;
  if(S.isoRoute&&v.route!==S.isoRoute)return false;
  if(S.view==='hop')return v.hop;
  if(S.view==='nearby')return distance([S.map.getCenter().lat,S.map.getCenter().lng],[v.v.lat,v.v.lon])<1800;
  return true;
}
function ingestVehicles() {
  const seen=new Set();
  for(const isHop of [false,true]) {
    const source=isHop?'hop':'vehicles';
    if(!freshSource(source))continue;
    for(const raw of (isHop?S.live.hop:S.live.vehicles)||[]) {
      const ts=+(raw.ts||Transit.sourceTime(S.live,source));
      if(!Transit.fresh(ts)||!Number.isFinite(raw.lat)||!Number.isFinite(raw.lon))continue;
      const id=(isHop?'H':'B')+raw.id;seen.add(id);
      let v=S.veh.get(id);
      if(!v) {
        const el=document.createElement('button');el.className='veh'+(isHop?' hopv':'');
        el.addEventListener('click',e=>{e.stopPropagation();selectVehicle(id);});
        v={id,el};S.veh.set(id,v);S.vlayer?.append(el);
      }
      Object.assign(v,{v:raw,route:isHop?'HOP':String(raw.route),hop:isHop,ts});
      v.el.innerHTML=`<svg><use href="#${isHop?'i-tram':'i-bus'}"/></svg><span class="vnum">${esc(isHop?'H':raw.route)}</span>`;
      if(window.Experience){const c=Experience.color(v.route);v.el.style.backgroundColor=c.bg;v.el.style.color=c.ink;}
      v.el.setAttribute('aria-label',(isHop?'Hop streetcar ':'Route '+raw.route+' bus ')+raw.id);
    }
  }
  for(const [id,v] of S.veh)if(!seen.has(id)) {
    v.el.remove();S.veh.delete(id);
    if(S.selVeh===id){clearSelection();toast('That vehicle is no longer reporting a current position.');}
  }
  positionOverlays();
  if(S.followId) {const v=S.veh.get(S.followId);if(v)moveMap([v.v.lat,v.v.lon]);}
}
async function showRoute(rid) {
  clearSelection();S.isoRoute=rid;S.view=rid==='HOP'?'hop':'buses';syncView();switchTab('map');
  try {await loadTtFor(rid==='HOP'?[]:[rid]);}catch {toast('Timetable could not load. Try again.');}
  drawRouteLines();drawStops();
  const pts=rid==='HOP'?Object.values(S.static.hop?.lines||{}).flat():Object.values(S.static.shapes[rid]||{}).flat();
  if(pts.length&&S.map)S.map.fitBounds(L.latLngBounds(pts),{paddingTopLeft:[35,145],paddingBottomRight:[35,220],animate:false,maxZoom:15});
  renderRoute(rid);
}
function sheet(title,sub,icon='i-stop') {
  $('nearby-panel').hidden=true;
  if($('sheet').hidden)$('sheet').classList.add('half');$('sheet').hidden=false;$('sheet').classList.remove('dragging');$('sheet').style.transform='';
  $('sheet').classList.add('stopmode');$('sh-title').textContent=title;$('sh-sub').textContent=sub;
  $('sh-badge').innerHTML=`<svg><use href="#${icon}"/></svg>`;$('sh-pill').textContent='';$('sh-pill').className='pill sched';
  $('sh-follow').style.display='none';$('sh-following').hidden=true;$('callout').hidden=true;
}
function pinButton(sid) {return `<button class="board-action" id="pin-stop"><svg><use href="#i-star"/></svg>${S.favorites.includes(sid)?'Remove saved stop':'Save this stop'}</button>`;}
function renderRoute(rid) {
  if(window.Experience){Experience.routeDetails(rid);return;}
  sheet(rid==='HOP'?'The Hop':'Route '+rid,rid==='HOP'?'Streetcar routes':titleCase(S.routeById[rid]?.long||''),'i-bus');
  const saved=S.pinnedRoutes.includes(rid),count=[...S.veh.values()].filter(v=>v.route===rid).length;
  $('sh-stops').innerHTML=`<button class="board-action" id="pin-route"><svg><use href="#i-star"/></svg>${saved?'Unsave route':'Save route'}</button><p class="board-note">${count} vehicles reporting · Choose a stop for departures. Lines show the published route; detours may differ.</p>`+
    Object.entries(S.stops).filter(([id])=>rid==='HOP'?hopStop(id):(S.stopRoutes[id]||[]).includes(rid)).map(([id,s])=>`<button class="stop-choice" data-stop="${esc(id)}"><span>${esc(s.name)}</span><small>${esc(id)}</small></button>`).join('');
  $('pin-route').onclick=()=>{S.pinnedRoutes=saved?S.pinnedRoutes.filter(r=>r!==rid):[...S.pinnedRoutes,rid];store.set('hop_pinned_routes',S.pinnedRoutes);renderRoute(rid);renderPinned();drawRouteLines();};
  wireStopChoices($('sh-stops'));
}
function wireStopChoices(el) {el.querySelectorAll('[data-stop]').forEach(b=>b.onclick=()=>selectStop(b.dataset.stop));}
async function selectStop(sid) {
  if(!S.stops[sid])return;
  S.selStop=String(sid);S.selVeh=null;S.followId=null;
  if(S.isoRoute && !(hopStop(sid)?S.isoRoute==='HOP':(S.stopRoutes[sid]||[]).includes(S.isoRoute)))S.isoRoute='';
  S.view=hopStop(sid)?'hop':S.view==='nearby'?'nearby':'buses';syncView();drawRouteLines();drawStops();
  switchTab('map');moveMap([S.stops[sid].lat,S.stops[sid].lon],Math.max(S.map?.getZoom()||14,15));
  renderStop();
  try {await loadTtFor(S.stopRoutes[sid]||[]);if(S.selStop===String(sid))renderStop();}catch {toast('Schedule unavailable. Live predictions are still shown when available.');}
}
function renderStop() {
  const sid=S.selStop;if(!sid)return;
  sheet(stopName(sid),(hopStop(sid)?'The Hop · ':'MCTS · ')+'Stop '+sid);
  const list=departures(sid);
  $('sh-stops').innerHTML=pinButton(sid)+`<div class="board-note">${(S.stopRoutes[sid]||[]).map(esc).join(' · ')}${hopStop(sid)?'Streetcar stop':''}</div>`+
    (departureRows(list)||`<div class="empty">${esc(noDepartures(sid))}</div>`)+
    `<a class="board-action" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${S.stops[sid].lat},${S.stops[sid].lon}&travelmode=walking">Walking directions to this stop</a>`;
  window.Experience?.decorateStop(sid);
  $('pin-stop').onclick=()=>{S.favorites=S.favorites.includes(sid)?S.favorites.filter(x=>x!==sid):[...S.favorites,sid];store.set('hop_favorites',S.favorites);renderStop();renderFavorites();};
}
function nextStops(v) {return freshSource('trips')?(v.v.next||[]).filter(n=>n.at>=Date.now()/1000-15):[];}
async function selectVehicle(id) {
  const v=S.veh.get(id);if(!v)return;
  S.selVeh=id;S.selStop=null;S.followId=null;S.routeDir=null;S.isoRoute=v.route;S.view=v.hop?'hop':'buses';syncView();
  drawRouteLines();drawStops();renderVehicle();moveMap([v.v.lat,v.v.lon],Math.max(S.map?.getZoom()||14,15));
  if(!v.hop)try {await loadTtFor([v.route]);if(S.selVeh===id)renderVehicle();}catch {toast('Destination details unavailable.');}
}
function renderVehicle() {
  const v=S.veh.get(S.selVeh);if(!v)return;
  const raw=v.v,hs=v.hop?S.static.hop?.routes.find(r=>String(r.id)===String(raw.route))?.name:headsign(v.route,raw.trip);
  sheet(v.hop?'The Hop':'Route '+v.route,(hs?hs+' · ':'')+(raw.name||'Vehicle #'+raw.id),'i-'+(v.hop?'tram':'bus'));
  $('sheet').classList.remove('stopmode');$('sh-follow').style.display='';
  $('sh-follow').textContent=S.followId===v.id?'Stop following':v.hop?'Follow streetcar':'Follow bus';$('sh-following').hidden=S.followId!==v.id;
  const d=freshSource('trips')?raw.delay:null,pill=$('sh-pill');
  pill.textContent=Date.now()/1000-v.ts>120?'Old position':d==null?'Position only':d < -60?Math.ceil(-d/60)+' min early':d>=180?Math.round(d/60)+' min late':'On time';
  pill.className='pill '+(d>=600?'late':d>=180||d < -60?'warn':d==null?'sched':'ok');
  const ns=nextStops(v);$('sh-stop').textContent=v.hop?'Tap a streetcar stop for arrivals':ns[0]?stopName(ns[0].stop):'Not reported';
  $('sh-eta').textContent=ns[0]?fmtIn(ns[0].at-Date.now()/1000):'';
  $('sh-stops').innerHTML=`<p class="board-note">GPS reported ${esc(ageText(v.ts))}. Marker shows the last reported position.</p>`+(v.hop?'<p class="board-note">Streetcar arrival estimates belong to stops. Select a stop on the map to see them.</p>':ns.slice(0,8).map(n=>`<button class="stop-choice" data-stop="${esc(n.stop)}"><span>${esc(stopName(n.stop))}</span><strong data-at="${n.at}">${esc(fmtIn(n.at-Date.now()/1000))}</strong></button>`).join('')||'<div class="empty">No upcoming stops reported.</div>');
  wireStopChoices($('sh-stops'));
  $('callout').hidden=false;$('co-num').textContent=v.hop?'H':v.route;$('co-head').textContent=hs||'Position only';$('co-eta').textContent='GPS '+ageText(v.ts);positionOverlays();
}
function clearSelection() {S.routeDir=null;S.selStop=null;S.selVeh=null;S.followId=null;S.isoRoute='';$('sheet').hidden=true;$('callout').hidden=true;drawRouteLines();drawStops();}
function stopFollow(){S.followId=null;$('sh-following').hidden=true;renderVehicle();}
function startFollow(id){const v=S.veh.get(id);if(!v)return;S.followId=id;renderVehicle();moveMap([v.v.lat,v.v.lon]);toast(v.hop?'Following this streetcar.':'Following this bus.');}

/* Personal boards and verified stop-to-stop commutes. */
const SAVED=[{key:'school',name:'To Marquette',backName:'To Downtown',trips:{to:'downtown-marquette',back:'marquette-downtown'}},{key:'lake',name:'To the lakefront',backName:'To Downtown',trips:{to:'downtown-lakefront',back:'lakefront-downtown'}}];
function savedTrip(card){return S.hot.find(t=>t.id===card.trips[S.savedDir[card.key]||'to']);}
function tripLeg(t){return t?.legs.find(l=>l.kind!=='walk');}
function tripPredictions(t){const l=tripLeg(t);return l?departures(String(l.board),l.routes,String(l.alight),3):[];}
function vehicleFor(p){return p&&!p.sched?[...S.veh.values()].find(v=>!v.hop&&String(v.v.trip)===String(p.trip)&&Transit.fresh(v.ts)):null;}
function renderSaved() {
  if(!S.ready)return;
  const openDetails=new Set([...$('saved').querySelectorAll('[data-trip-card] details[open]')].map(d=>d.closest('[data-trip-card]').dataset.tripCard));
  $('saved').innerHTML=SAVED.map(card=>{
    const t=savedTrip(card),leg=tripLeg(t);if(!leg)return '';
    const list=tripPredictions(t),p=list[0],v=vehicleFor(p),dir=S.savedDir[card.key]||'to';
    return `<article class="route-card" data-trip-card="${card.key}"><div class="rc-top"><svg class="star"><use href="#i-star"/></svg><span class="rc-name">${esc(dir==='to'?card.name:card.backName)}</span></div><div class="trip-switch" aria-label="Trip direction">${['to','back'].map(d=>`<button data-card="${card.key}" data-dir="${d}" aria-pressed="${d===dir}">${d==='to'?esc(card.name):'Return trip'}</button>`).join('')}</div><div class="rc-routes">${esc(leg.routes.join(' / '))} · ${esc(t.route_note)}</div><div class="rc-main"><span class="rc-big${p?.sched?' sched':''}" ${p?`data-at="${p.at}"`:''}>${p?esc(fmtIn(p.at-Date.now()/1000)):'—'}</span><span class="pill ${!p||p.sched?'sched':'ok'}">${p?(p.sched?'Scheduled':'Live prediction'):'No departures'}</span></div><div class="rc-alts">${list.slice(1).map(x=>`<span>${esc(x.route)} · ${esc(clock(x.at))} · ${x.sched?'Scheduled':'Live'}</span>`).join('<br>')||'<span class="past">'+esc(p?'No later departures listed':noDepartures(leg.board))+'</span>'}</div><button class="rc-stop" data-stop="${esc(leg.board)}"><svg><use href="#i-stop"/></svg><span class="nm">${esc(stopName(leg.board))}</span><svg class="chev"><use href="#i-chev"/></svg></button><details class="trip-details" ${openDetails.has(card.key)?'open':''}><summary>Walking and ride directions</summary><ol>${t.legs.map(l=>`<li>${esc(l.text)}</li>`).join('')}</ol><small>Board stop ${esc(leg.board)} · Get off at ${esc(stopName(leg.alight))} (${esc(leg.alight)}). Allow time to walk; countdown is at the stop.</small></details><button class="followbtn" data-trip="${card.key}" ${v?'':'disabled'}><svg><use href="#i-nav"/></svg>${v?'Follow next bus':'No live vehicle for next departure'}</button></article>`;
  }).join('')||'<div class="empty">No saved trips configured.</div>';
  wireStopChoices($('saved'));
  $('saved').querySelectorAll('[data-dir]').forEach(b=>b.onclick=()=>{S.savedDir[b.dataset.card]=b.dataset.dir;store.set('hop_saved_dir',S.savedDir);renderSaved();});
  $('saved').querySelectorAll('[data-trip]').forEach(b=>b.onclick=async()=>{const p=tripPredictions(savedTrip(SAVED.find(c=>c.key===b.dataset.trip)))[0],v=vehicleFor(p);if(v){switchTab('map');await selectVehicle(v.id);startFollow(v.id);}});
}
function renderPinned(){ $('pinned-routes').innerHTML=S.pinnedRoutes.map(r=>`<button class="route-chip" data-route="${esc(r)}">${esc(r==='HOP'?'The Hop':r)}</button>`).join('');$('pinned-routes').querySelectorAll('[data-route]').forEach(b=>b.onclick=()=>showRoute(b.dataset.route)); }
function renderFavorites(){
  $('favorites').innerHTML=S.favorites.filter(id=>S.stops[id]).map(id=>{const p=departures(id,undefined,undefined,2);return `<button class="favorite-stop" data-stop="${esc(id)}"><svg class="star"><use href="#i-star"/></svg><div><b>${esc(stopName(id))}</b><small>Stop ${esc(id)} · ${p.length?p.map(x=>x.route+' '+fmtIn(x.at-Date.now()/1000)+(x.sched?' scheduled':' live')).map(esc).join(' · '):'No departures listed'}</small></div><svg><use href="#i-chev"/></svg></button>`;}).join('')||'<p class="board-note">Save any stop from the map to keep its departure board here.</p>';
  wireStopChoices($('favorites'));
}
function renderNearby(){
  if(window.Experience){Experience.mapBoard();return;}
  const show=S.view==='nearby'&&S.screen==='map'&&!S.selStop&&!S.selVeh&&!S.isoRoute;
  $('nearby-panel').hidden=!show;if(!show)return;
  $('nearby-panel').innerHTML='<b>Stops near map center</b>'+nearbyStops().slice(0,6).map(([id,s,d])=>`<button class="stop-choice" data-stop="${esc(id)}"><span>${esc(s.name)}<small>${hopStop(id)?'The Hop':esc((S.stopRoutes[id]||[]).join(' / '))} · Stop ${esc(id)}</small></span><small>${Math.round(d)} m</small></button>`).join('');
  if(!nearbyStops().length)$('nearby-panel').innerHTML+='<p class="board-note">No stops within 1.5 km. Move the map closer to a transit route.</p>';
  wireStopChoices($('nearby-panel'));
}
function currentAlerts(){const now=Date.now()/1000;return (S.live?.alerts||[]).filter(a=>!a.periods?.length||a.periods.some(p=>(!p.start||p.start<=now)&&(!p.end||now<p.end)));}
function renderUpdates(){
  const known=freshSource('alerts'),watched=new Set([...S.pinnedRoutes,...S.hot.flatMap(t=>tripLeg(t)?.routes||[])]);
  let alerts=currentAlerts();if(!S.allAlerts)alerts=alerts.filter(a=>!a.routes?.length||a.routes.some(r=>watched.has(r)));
  $('updates').innerHTML=(!known?'<div class="update-card bad"><svg><use href="#i-warn"/></svg><div><b>Service alerts unavailable</b><p>Check MCTS for current detours and disruptions.</p></div></div>':'')+
    alerts.map(a=>`<div class="update-card bad"><svg><use href="#i-warn"/></svg><div><b>${esc(a.title||a.effect)}</b><p>${esc(a.text)}</p>${!known?'<small>Last received alert · may be outdated</small>':''}</div></div>`).join('')+
    (known&&!alerts.length?'<div class="update-card good"><svg><use href="#i-check"/></svg><div><b>No alerts reported'+(S.allAlerts?'':' for your routes')+'</b><p>An empty alert feed does not guarantee on-time service.</p></div></div>':'')+
    `<div class="agency-links"><a target="_blank" rel="noopener" href="https://www.ridemcts.com/alerts">MCTS service alerts</a><a target="_blank" rel="noopener" href="https://thehopmke.com/">The Hop service information</a></div>`;
}
function renderHome(){renderSaved();renderPinned();renderFavorites();renderUpdates();window.Experience?.renderHome();renderNearby();}

/* Actual feed timestamps determine freshness, never the browser download time. */
function updateFeedStat(){
  let msg='Connecting to transit feeds…',ok=false;
  if(!navigator.onLine)msg='Offline · Live arrivals unavailable';
  else if(S.live){
    ok=freshSource('vehicles')&&freshSource('trips');
    const ts=Math.min(Transit.sourceTime(S.live,'vehicles'),Transit.sourceTime(S.live,'trips'));
    msg=ok?`${[...S.veh.values()].filter(v=>!v.hop&&Transit.fresh(v.ts)).length} buses · Updated ${ageText(ts)}`:ts?'Live data is stale · Last update '+ageText(ts):'Some live feeds are unavailable';
    if(S.fails)msg+=' · Reconnecting';
  }else if(S.fails)msg='Live feed unavailable · Showing published schedules';
  for(const id of ['feed-status','map-feed-status','set-feed']) {$(id).textContent=msg;$(id).classList.toggle('live',ok);}
  $('schedule-warning').hidden=!S.ready||servicesAvailable();
  $('btn-refresh').disabled=S.polling;$('btn-refresh').textContent=S.polling?'Updating…':'Refresh';
}
async function currentSnapshot(){
  let candidate=null, failure=null;
  try { candidate=await fetchJson(LIVE_BASE+'live.json?t='+Math.floor(Date.now()/1000/15)); }
  catch(e){failure=e;}
  const needsRecovery=!candidate || !Transit.fresh(+candidate.ts) || (S.live && candidate.ts<S.live.ts);
  // Raw branch URLs can stay cached for minutes. Resolve an immutable commit
  // only when needed, at most once per 90 seconds across this device's tabs.
  if(needsRecovery && Date.now()-store.get('hop_api_recovery',0)>=90000){
    store.set('hop_api_recovery',Date.now());
    try {
      const ref=await fetchJson('https://api.github.com/repos/tylerherman19/hopscotch/git/ref/heads/data');
      if(!/^[a-f0-9]{40}$/.test(ref.object?.sha||''))throw new Error('Invalid data revision');
      const latest=await fetchJson('https://raw.githubusercontent.com/tylerherman19/hopscotch/'+ref.object.sha+'/live.json');
      if(!candidate || latest.ts>candidate.ts)candidate=latest;
    }catch(e){console.warn('Current revision lookup unavailable',e);}
  }
  if(S.live && (!candidate || S.live.ts>candidate.ts))candidate=S.live;
  if(!candidate)throw failure||new Error('Live data unavailable');
  return candidate;
}
async function refresh(){
  if(S.polling||!S.ready)return;
  clearTimeout(S.pollTimer);S.polling=true;updateFeedStat();
  try{
    const live=await currentSnapshot();
    if(!Number.isFinite(live.ts)||!Array.isArray(live.vehicles))throw new Error('Invalid live snapshot');
    S.live=live;S.fails=0;ingestVehicles();renderHome();window.Experience?.loadNearby();window.Experience?.onRefresh();
    if(S.selStop)renderStop();else if(S.selVeh)renderVehicle();
  }catch(e){S.fails++;console.warn('Live data unavailable',e);renderHome();}
  finally{S.polling=false;updateFeedStat();if(!document.hidden)S.pollTimer=setTimeout(refresh,S.fails?Math.min(120000,15000*2**S.fails):15000);}
}
function tick(){
  updateFeedStat();
  const freshKey=['vehicles','trips','alerts','hop','hop_arrivals'].map(freshSource).join('|');
  if(S.freshKey!==freshKey&&S.ready){S.freshKey=freshKey;renderHome();window.Experience?.onRefresh();if(S.selStop)renderStop();else if(S.selVeh)renderVehicle();}
  let expired=false;
  document.querySelectorAll('[data-at]').forEach(el=>{const sec=+el.dataset.at-Date.now()/1000;el.textContent=fmtIn(sec);if(sec < -15)expired=true;});
  if(expired&&S.ready){renderHome();if(S.selStop)renderStop();else if(S.selVeh)renderVehicle();}
  for(const [id,v] of S.veh)if(!Transit.fresh(v.ts)){v.el.remove();S.veh.delete(id);if(S.selVeh===id)clearSelection();}
  positionOverlays();
}
function renderSearch(q){
  const box=$('searchresults');q=q.trim().toLowerCase();
  if(!S.ready){box.innerHTML='<div class="empty">Loading routes and stops…</div>';box.hidden=false;return;}
  const routes=S.routes.filter(r=>!q||String(r.name).toLowerCase().includes(q)||(r.long||'').toLowerCase().includes(q)).sort((a,b)=>(a.name.toLowerCase()===q?-1:0)-(b.name.toLowerCase()===q?-1:0)).slice(0,6);
  const stops=q?Object.entries(S.stops).filter(([id,s])=>id.toLowerCase()===q||s.name.toLowerCase().includes(q)||id.includes(q)).sort((a,b)=>(a[0]===q?-1:0)-(b[0]===q?-1:0)||distance(position(),[a[1].lat,a[1].lon])-distance(position(),[b[1].lat,b[1].lon])).slice(0,8):[];
  box.innerHTML=routes.map(r=>`<button class="sr-row" data-r="${esc(r.id)}"><span class="sr-badge">${esc(r.name)}</span><span>${esc(titleCase(r.long))}</span></button>`).join('')+stops.map(([id,s])=>`<button class="sr-row" data-stop="${esc(id)}"><svg><use href="#${hopStop(id)?'i-tram':'i-stop'}"/></svg><span>${esc(s.name)}<small>Stop ${esc(id)}</small></span></button>`).join('')||'<div class="empty">No matching routes or stops.</div>';
  // A precise stop number takes priority over partial route-number matches.
  if(!S.routes.some(r=>String(r.id).toLowerCase()===q || String(r.name).toLowerCase()===q)) {
    const exact=[...box.querySelectorAll('[data-stop]')].find(b=>b.dataset.stop.toLowerCase()===q);
    if(exact)box.prepend(exact);
  }
  box.hidden=false;wireStopChoices(box);
  box.querySelectorAll('[data-r]').forEach(b=>b.onclick=()=>showRoute(b.dataset.r));
  box.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{box.hidden=true;$('searchinput').value='';}));
}
function switchTab(name){
  if(!['home','map','plan'].includes(name))name='home';
  S.screen=name;$('app').dataset.screen=name;document.querySelectorAll('.screen').forEach(el=>el.classList.toggle('on',el.id==='screen-'+name));
  document.querySelectorAll('.tabbtn').forEach(b=>{b.classList.toggle('on',b.dataset.screen===name);b.setAttribute('aria-current',b.dataset.screen===name?'page':'false');});
  if(location.hash!=='#'+name)history.replaceState(null,'','#'+name);
  if(name==='map'||matchMedia('(min-width: 1000px)').matches){initMap();if(S.map){S.map.invalidateSize();positionOverlays();}renderNearby();}
}
function syncView(){document.querySelectorAll('.segbtn').forEach(b=>{b.classList.toggle('on',b.dataset.view===S.view);b.setAttribute('aria-pressed',b.dataset.view===S.view);});renderNearby();}
function locate(){
  if(!navigator.geolocation){toast('Location is unavailable in this browser. You can still search for a stop.');return;}
  navigator.geolocation.getCurrentPosition(pos=>{
    S.mePos=[pos.coords.latitude,pos.coords.longitude];moveMap(S.mePos,15);drawStops();renderNearby();window.Experience?.located();
  },err=>toast(err.code===1?'Location permission was denied. Search for a stop instead.':'Could not locate you. Search for a stop instead.'),{enableHighAccuracy:true,timeout:10000,maximumAge:30000});
}
function wireUI(){
  document.querySelectorAll('.tabbtn').forEach(b=>b.onclick=()=>switchTab(b.dataset.screen));
  $('introcard').onclick=()=>switchTab('map');$('btn-edit').hidden=true;
  $('btn-allalerts').onclick=()=>{S.allAlerts=!S.allAlerts;$('btn-allalerts').textContent=S.allAlerts?'Your routes':'See all';renderUpdates();};
  $('btn-settings').onclick=()=>{$('settings').hidden=false;$('set-close').focus();};
  $('set-close').onclick=()=>{$('settings').hidden=true;$('btn-settings').focus();};
  $('settings').onclick=e=>{if(e.target===$('settings'))$('set-close').click();};
  $('set-stops').checked=S.showStops;$('btn-layers').classList.toggle('on',S.showStops);
  const toggleStops=checked=>{S.showStops=checked;store.set('hop_stops_dots',checked?1:0);$('set-stops').checked=checked;$('btn-layers').classList.toggle('on',checked);$('btn-layers').setAttribute('aria-pressed',checked);drawStops();};
  $('set-stops').onchange=e=>toggleStops(e.target.checked);$('btn-layers').onclick=()=>toggleStops(!S.showStops);
  $('set-motion').checked=S.reduced;$('set-motion').onchange=e=>{S.reduced=e.target.checked;store.set('hop_frozen',S.reduced?1:0);document.documentElement.classList.toggle('frozen',S.reduced);};
  document.documentElement.classList.toggle('frozen',S.reduced);
  document.querySelectorAll('.segbtn').forEach(b=>b.onclick=()=>{clearSelection();S.view=b.dataset.view;syncView();drawRouteLines();drawStops();if(S.view==='hop'){const pts=Object.values(S.static?.hop?.lines||{}).flat();if(S.map&&pts.length)S.map.fitBounds(L.latLngBounds(pts),{padding:[50,140],maxZoom:15});}if(S.view==='nearby')moveMap(position(),15);renderNearby();});
  $('searchinput').oninput=e=>renderSearch(e.target.value);$('searchinput').onfocus=e=>renderSearch(e.target.value);
  $('searchinput').onkeydown=e=>{if(e.key==='Escape')$('searchresults').hidden=true;if(e.key==='Enter')$('searchresults').querySelector('button')?.click();if(e.key==='ArrowDown'){$('searchresults').querySelector('button')?.focus();e.preventDefault();}};
  document.addEventListener('click',e=>{if(!e.target.closest('.searchwrap'))$('searchresults').hidden=true;});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(!$('settings').hidden)$('set-close').click();else clearSelection();$('searchresults').hidden=true;}});
  $('btn-locate').onclick=locate;$('btn-locate2').onclick=locate;
  $('sh-follow').onclick=()=>S.followId?stopFollow():startFollow(S.selVeh);
  $('sheet-close').onclick=()=>{clearSelection();renderNearby();};
  $('sheetgrab').onclick=()=>$('sheet').classList.toggle('half');
  $('btn-refresh').onclick=refresh;
  $('retry-start').onclick=loadApp;
  window.addEventListener('hashchange',()=>switchTab(location.hash.slice(1)||'home'));
  document.addEventListener('visibilitychange',()=>{clearTimeout(S.pollTimer);if(!document.hidden){tick();refresh();}});
  window.addEventListener('online',refresh);window.addEventListener('offline',()=>{updateFeedStat();renderHome();});
}
async function loadApp(){
  $('start-error').hidden=true;
  try{
    const st=await fetchJson('data/static.json');
    if(!Array.isArray(st.routes)||!Array.isArray(st.stops))throw new Error('Invalid route data');
    S.static=st;S.routes=st.routes;S.routeById=Object.fromEntries(st.routes.map(r=>[r.id,r]));S.stopRoutes=st.stop_routes||{};
    S.stops=Object.fromEntries(st.stops.map(([id,name,lat,lon])=>[String(id),{name:titleCase(name),lat,lon}]));
    for(const s of st.hop?.stops||[])S.stops['H'+s.id]={name:s.name,lat:s.lat,lon:s.lon};
    try{S.hot=(await fetchJson('data/hotroutes.json')).routes||[];}catch{S.hot=[];}
    S.ready=true;
    if($('searchinput').value.trim())renderSearch($('searchinput').value);
    renderHome();initMap();drawRouteLines();drawStops();window.Experience?.loadNearby();
    // Timetable failure never prevents live polling or navigation.
    loadTtFor([...new Set([...S.hot.flatMap(t=>tripLeg(t)?.routes||[]),...S.favorites.flatMap(id=>S.stopRoutes[id]||[])])]).then(renderHome).catch(()=>toast('Some schedules could not load. Retry by opening the stop.'));
    if(S.map)for(const v of S.veh.values())S.vlayer.append(v.el);
    await refresh();
  }catch(e){console.error('Startup failed',e);$('start-error').hidden=false;$('saved').innerHTML='';}
}
document.addEventListener('DOMContentLoaded',()=>{wireUI();switchTab(location.hash.slice(1)||'home');loadApp();setInterval(tick,1000);});
