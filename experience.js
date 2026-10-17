/* Rider-focused discovery, planning and saved journeys. Personal data stays local. */
window.Experience=(()=>{
  'use strict';
  const E={filter:'all',from:{kind:'place',name:'Downtown Milwaukee',lat:MILWAUKEE[0],lon:MILWAUKEE[1]},to:null,results:[],saved:store.get('hop_journeys',[]),busy:false,nearKey:'',nearLoading:false};
  if(!Array.isArray(E.saved))E.saved=[];
  E.saved=E.saved.filter(x=>x&&x.from&&x.to&&typeof x.id==='string').slice(0,20);
  const icon=id=>`<svg aria-hidden="true"><use href="#${id}"/></svg>`;
  function color(rid){
    const hex=rid==='HOP'?'188653':String(S.routeById[rid]?.color||'245DC5').replace(/^#/,'');
    const bg=/^[0-9a-f]{6}$/i.test(hex)?'#'+hex:'#245dc5';
    const rgb=bg.slice(1).match(/../g).map(h=>parseInt(h,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
    return {bg,ink:rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722>.179?'#000000':'#ffffff'};
  }
  function badge(rid){const c=color(rid);return `<span class="line-badge" style="--line:${c.bg};--line-ink:${c.ink}">${esc(rid==='HOP'?'H':rid)}</span>`;}
  const walkText=seconds=>seconds<30?'At this stop':'~'+Math.ceil(seconds/60)+' min walk';
  const stopEndpoint=id=>({kind:'stop',stop:String(id),name:stopName(id)});
  function featured(){return [
    {name:'Marquette University',anchor:'9643',detail:'Wisconsin & N12 BRT station'},
    {name:'Lakefront',anchor:'H115',detail:'The Hop · Lakefront stop'},
    {name:'Intermodal Station',anchor:'H94',detail:'The Hop · Intermodal stop'},
    {name:'Downtown Milwaukee',anchor:'9650',detail:'Wisconsin & Van Buren BRT station'},
    {name:'Milwaukee Mitchell Airport',anchor:'7168',detail:'GreenLine airport stop'},
    {name:'UW–Milwaukee',anchor:'265',detail:'Near Kenwood & Maryland'},
    {name:'Fiserv Forum',anchor:'7122',detail:'Near N6 & Juneau'},
    {name:'Milwaukee Public Market',anchor:'635',detail:'Near Water & St Paul'}
  ].filter(p=>S.stops[p.anchor]).map(p=>({...p,kind:'place',lat:S.stops[p.anchor].lat,lon:S.stops[p.anchor].lon}));}
  function around(ll,max=1000){return Object.entries(S.stops).map(([id,s])=>({id,s,d:distance(ll,[s.lat,s.lon])})).filter(x=>x.d<=max).sort((a,b)=>a.d-b.d);}
  const directionsCache=new WeakMap();
  function stopDirections(pack){
    if(directionsCache.has(pack))return directionsCache.get(pack);
    const out={};for(const [key,ids] of Object.entries(pack.stops))for(const id of ids)(out[id]||=new Set()).add(key.split('.')[0]);
    directionsCache.set(pack,out);return out;
  }
  function nearbyLines(ll,limit=10){
    const rows=[],seen=new Set();
    for(const n of around(ll)){
      if(hopStop(n.id)){
        const h=hopStop(n.id),key='HOP|'+h.route+'|'+h.name;
        if(seen.has(key))continue;seen.add(key);
        if(E.filter==='saved'&&!S.pinnedRoutes.includes('HOP')&&!S.favorites.includes(n.id))continue;
        const p=departures(n.id,undefined,undefined,3);
        rows.push({...n,route:'HOP',headsign:(S.static.hop.routes.find(r=>r.id===h.route)?.name||'The Hop')+' · '+h.name,times:p});continue;
      }
      if(E.filter==='hop')continue;
      for(const rid of S.stopRoutes[n.id]||[]){
        if(E.filter==='saved'&&!S.pinnedRoutes.includes(rid)&&!S.favorites.includes(n.id))continue;
        const pack=S.tt[rid],dirs=pack?[...(stopDirections(pack)[n.id]||[])]:['?'];
        for(const dir of dirs){
          const key=rid+'|'+dir;if(seen.has(key))continue;seen.add(key);
          const p=departures(n.id,[rid],undefined,20).filter(x=>dir==='?'||String(Transit.tripInfo(pack,x.trip)?.trip[2]).split('.')[0]===dir).slice(0,3);
          rows.push({...n,route:rid,dir,headsign:titleCase(p[0]?.headsign||pack?.headsign[dir]||S.routeById[rid]?.long||''),times:p});
        }
      }
    }
    return rows.sort((a,b)=>(Number(b.times.length>0)-Number(a.times.length>0))||a.d-b.d||((a.times[0]?.at||Infinity)-(b.times[0]?.at||Infinity))).slice(0,limit);
  }
  function lineRows(rows){return rows.map(r=>{
    const first=r.times[0],hasAlert=freshSource('alerts')&&currentAlerts().some(a=>!a.routes?.length||a.routes.includes(r.route));
    return `<button class="line-row" data-stop="${esc(r.id)}">${badge(r.route)}<span class="line-content"><b>${esc(r.headsign.replace(/^To /i,''))}</b><small>${esc(r.s.name)} · ${walkText(r.d*1.25/1.2)}</small><span class="line-later">${r.times.slice(1).map(p=>esc(clock(p.at))+(p.sched?' sched.':'')).join(' · ')||esc(S.routeById[r.route]?.long||'The Hop streetcar')}${hasAlert?' · Service alert':''}</span></span><span class="line-arrival"><strong ${first?`data-at="${first.at}"`:''}>${first?esc(fmtIn(first.at-Date.now()/1000)):'—'}</strong><small class="${first&&!first.sched?'signal-live':''}">${first?(first.sched?'Scheduled':'Live'):(E.nearLoading?'Loading':'No times')}</small></span></button>`;
  }).join('');}
  function loadNearby(){
    if(!S.ready)return;
    const ll=position(),rids=[...new Set(around(ll).flatMap(x=>S.stopRoutes[x.id]||[]))],key=rids.sort().join('|');
    if(key===E.nearKey)return;E.nearKey=key;E.nearLoading=true;
    loadTtFor(rids).then(()=>{E.nearLoading=false;renderHome();}).catch(()=>{E.nearKey='';E.nearLoading=false;renderHome();});
  }
  function renderHome(){
    if(!$('nearby-lines'))return;
    $('nearby-location').textContent=S.mePos?'Around your location':'Around Downtown Milwaukee';
    if(!S.ready){$('nearby-lines').innerHTML='<div class="arrival-skeleton"></div><div class="arrival-skeleton"></div><div class="arrival-skeleton"></div>';return;}
    const rows=nearbyLines(position());
    $('nearby-lines').innerHTML=lineRows(rows)||`<div class="quiet-state">${E.filter==='saved'?'Save a route or stop to see it here.':'No stops within a kilometre. Choose a different starting point or search the map.'}</div>`;
    wireStopChoices($('nearby-lines'));renderJourneys();
  }
  function mapBoard(){
    const show=S.screen==='map'&&!S.selStop&&!S.selVeh&&!S.isoRoute;
    $('nearby-panel').hidden=!show;if(!show||!S.ready)return;
    const ll=S.map?[S.map.getCenter().lat,S.map.getCenter().lng]:position();
    // Stops on the map remain useful without downloading the entire network.
    const points=around(ll,1000).filter(n=>S.view!=='hop'||hopStop(n.id)),seen=new Set(),items=points.filter(n=>{const name=n.s.name;if(seen.has(name))return false;seen.add(name);return true;}).slice(0,5);
    $('nearby-panel').innerHTML='<div class="panel-grip"></div><div class="panel-heading"><b>Near this map</b><span>Choose a stop</span></div>'+items.map(n=>{
      const times=departures(n.id,undefined,undefined,2);
      return `<button class="map-stop-row" data-stop="${esc(n.id)}"><span class="stop-mark">${icon(hopStop(n.id)?'i-tram':'i-stop')}</span><span><b>${esc(n.s.name)}</b><small>${times.length?times.map(p=>esc(p.route)+' · '+esc(fmtIn(p.at-Date.now()/1000))+(p.sched?' sched.':' live')).join(' / '):esc((S.stopRoutes[n.id]||[]).join(' · ')||'The Hop')}</small></span><small>${Math.round(n.d)} m</small></button>`;
    }).join('');
    if(!items.length)$('nearby-panel').innerHTML+='<p class="board-note">Move the map closer to a transit route.</p>';
    wireStopChoices($('nearby-panel'));
  }
  function openPlanner(which='to',endpoint){
    if(endpoint){E[which]=endpoint;$('plan-'+which).value=endpoint.name;E.results=[];$('plan-results').replaceChildren();$('plan-status').textContent='Choose Find a trip to check departures.';}
    switchTab('plan');$('plan-'+which).focus();picker(which);
  }
  function choose(which,item){
    E[which]=item;$('plan-'+which).value=item.name;$('picker-'+which).hidden=true;
    E.results=[];$('plan-results').replaceChildren();$('plan-status').textContent=E.from&&E.to?'Ready when you are.':'';
    if(which==='from'&&!E.to){$('plan-to').focus();picker('to');}
  }
  function picker(which){
    const el=$('picker-'+which),q=$('plan-'+which).value.trim().toLowerCase();
    if(!S.ready){el.innerHTML='<p class="board-note">Loading stops…</p>';el.hidden=false;return;}
    const places=featured().filter(x=>!q||x.name.toLowerCase().includes(q)||x.detail.toLowerCase().includes(q));
    const matches=Object.entries(S.stops).filter(([id,s])=>q&&(id.toLowerCase()===q||s.name.toLowerCase().includes(q)||id.toLowerCase().includes(q))).sort((a,b)=>(a[0].toLowerCase()===q?-1:0)-(b[0].toLowerCase()===q?-1:0)||distance(position(),[a[1].lat,a[1].lon])-distance(position(),[b[1].lat,b[1].lon])).slice(0,8).map(([id])=>({...stopEndpoint(id),detail:(hopStop(id)?'The Hop':'MCTS')+' · Stop '+id}));
    const options=[...places,...matches].slice(0,10);
    el.innerHTML=options.map((p,i)=>`<button type="button" class="place-option" data-choice="${i}">${icon(p.kind==='stop'?'i-stop':'i-pin')}<span><b>${esc(p.name)}</b><small>${esc(p.detail||'')}</small></span></button>`).join('')||'<p class="board-note">No matches. Try a street intersection or stop number.</p>';
    el.hidden=false;el.querySelectorAll('[data-choice]').forEach(b=>b.onclick=()=>choose(which,options[+b.dataset.choice]));
  }
  async function runPlan(){
    if(E.busy)return;
    if(!E.from||!E.to){$('plan-status').textContent='Choose a starting point and destination from the suggestions.';picker(!E.from?'from':'to');return;}
    if(E.from.kind==='stop'&&E.to.kind==='stop'&&E.from.stop===E.to.stop){$('plan-status').textContent='You selected the same stop. Choose a different destination.';return;}
    E.busy=true;$('plan-submit').disabled=true;$('plan-submit').textContent='Finding your way…';$('plan-status').textContent='Checking current departures and published schedules…';
    const from=JSON.stringify(E.from),to=JSON.stringify(E.to);
    try{
      await loadTtFor(S.routes.map(r=>r.id));
      // Yield once so the loading state paints before a network-wide search.
      await new Promise(resolve=>setTimeout(resolve,0));
      if(from!==JSON.stringify(E.from)||to!==JSON.stringify(E.to))return;
      E.results=Journey.plan({packs:S.tt,calendar:S.static.calendar,stops:S.stops,hop:S.static.hop,live:navigator.onLine?S.live:null,from:E.from,to:E.to});
      renderPlan();
    }catch(e){$('plan-status').textContent='Some schedules could not load. Check your connection and try again.';console.warn('Trip planning unavailable',e);}
    finally{E.busy=false;$('plan-submit').disabled=false;$('plan-submit').textContent='Find a trip';}
  }
  function renderPlan(){
    const now=Date.now()/1000,open=new Set([...$('plan-results').querySelectorAll('details[open]')].map(d=>d.dataset.option));
    $('plan-status').textContent=E.results.length?`${E.results.length} options · leave now · Central time`:'No matching journey in the next four hours. Try another nearby stop or check the agency for more options.';
    $('plan-results').innerHTML=E.results.map((result,i)=>{
      const total=Math.ceil((result.arrive-now)/60),walks=result.walkStart+result.walkEnd+result.legs.reduce((n,l)=>n+(l.transferWalk||0),0);
      return `<details class="journey-card" data-option="${i}" ${open.has(String(i))?'open':''}><summary><div class="journey-top"><span>${i===0?'Earliest arrival':result.transfers?'One transfer':'Direct trip'}</span><b>${total} <small>min</small></b></div><div class="journey-routes">${result.legs.map(l=>badge(l.route)).join(icon('i-chev'))}<span>${esc(clock(result.arrive))}<small>arrive</small></span></div><div class="journey-caption">${result.transfers?'1 transfer':'No transfers'}${walks?' · ~'+Math.ceil(walks/60)+' min walking':''} · ${result.legs[0].live?'Live boarding estimate':'Scheduled boarding'}</div></summary><div class="journey-details">${result.walkStart?`<div class="journey-walk">${icon('i-nav')}<span>Walk about ${Math.ceil(result.walkStart/60)} min to ${esc(stopName(result.legs[0].board))}</span></div>`:''}${result.legs.map((l,n)=>`${n?`<div class="journey-transfer">${Math.floor((l.depart-result.legs[n-1].arrive)/60)} min connection${l.transferWalk?' · Walk ~'+Math.ceil(l.transferWalk/60)+' min to '+esc(stopName(l.board)):' at this stop'}</div>`:''}<div class="journey-leg">${badge(l.route)}<div><b>${esc(titleCase(l.headsign).replace(/^To /i,''))}</b><p>Board ${esc(stopName(l.board))} <span>Stop ${esc(l.board)}</span></p><strong>${esc(clock(l.depart))} · ${l.live?'Live prediction':'Scheduled'}</strong><p>Get off at ${esc(stopName(l.alight))} <span>Stop ${esc(l.alight)}</span></p><small>${esc(clock(l.arrive))}${l.arrivalLive?' · Live prediction':' · Estimated arrival'}${l.stopCount?' · '+l.stopCount+' stops':''}</small><button class="text-action" data-leg="${i}:${n}">View boarding stop</button></div></div>`).join('')}${result.walkEnd?`<div class="journey-walk">${icon('i-nav')}<span>Walk about ${Math.ceil(result.walkEnd/60)} min to your destination</span></div>`:''}<p class="journey-note">Walking times are approximate, based on distance. Allow extra time at crossings. Check service alerts before you leave.</p><button class="save-journey" data-save-journey="${i}">${icon('i-star')}${isSaved()?'Journey saved':'Save this journey'}</button></div></details>`;
    }).join('');
    $('plan-results').querySelectorAll('[data-leg]').forEach(b=>b.onclick=()=>{const [i,n]=b.dataset.leg.split(':').map(Number);selectStop(E.results[i].legs[n].board);});
    $('plan-results').querySelectorAll('[data-save-journey]').forEach(b=>b.onclick=saveJourney);
  }
  const journeyKey=()=>JSON.stringify([E.from,E.to]);
  const isSaved=()=>E.saved.some(j=>JSON.stringify([j.from,j.to])===journeyKey());
  function saveJourney(){
    if(isSaved()){toast('This journey is already saved.');return;}
    E.saved.unshift({id:Date.now().toString(36)+Math.random().toString(36).slice(2,6),from:E.from,to:E.to});E.saved=E.saved.slice(0,20);
    store.set('hop_journeys',E.saved);renderPlan();renderJourneys();toast('Journey saved on this device.');
  }
  function renderJourneys(){
    const el=$('personal-journeys');if(!el)return;
    el.innerHTML=E.saved.map(j=>`<div class="saved-journey"><button data-journey="${esc(j.id)}">${icon('i-nav')}<span><b>${esc(j.to.name)}</b><small>From ${esc(j.from.name)}</small></span>${icon('i-chev')}</button><button class="remove-journey" data-remove="${esc(j.id)}" aria-label="Remove journey to ${esc(j.to.name)}">Remove</button></div>`).join('')||'<p class="quiet-state">Plan a trip and save it for next time. Your journeys stay on this device.</p>';
    el.querySelectorAll('[data-journey]').forEach(b=>b.onclick=()=>{const j=E.saved.find(x=>x.id===b.dataset.journey);E.from=j.from;E.to=j.to;$('plan-from').value=j.from.name;$('plan-to').value=j.to.name;switchTab('plan');runPlan();});
    el.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{E.saved=E.saved.filter(j=>j.id!==b.dataset.remove);store.set('hop_journeys',E.saved);renderJourneys();});
  }
  function decorateStop(sid){
    const bar=document.createElement('div');bar.className='stop-plan-actions';bar.innerHTML='<button id="plan-from-stop">From here</button><button id="plan-to-stop">To here</button>';
    $('pin-stop').after(bar);$('plan-from-stop').onclick=()=>openPlanner('from',stopEndpoint(sid));$('plan-to-stop').onclick=()=>openPlanner('to',stopEndpoint(sid));
  }
  function routeDetails(rid){
    sheet(rid==='HOP'?'The Hop':'Route '+rid,rid==='HOP'?'Milwaukee streetcar':titleCase(S.routeById[rid]?.long||''),'i-'+(rid==='HOP'?'tram':'bus'));
    const pack=S.tt[rid],saved=S.pinnedRoutes.includes(rid);
    const dirs=rid==='HOP'?(S.static.hop?.routes||[]).map(r=>({id:String(r.id),name:r.name})):Object.entries(pack?.headsign||{}).map(([id,name])=>({id,name:titleCase(name).replace(/^To /i,'')}));
    if(!dirs.some(d=>d.id===String(S.routeDir)))S.routeDir=dirs[0]?.id;
    let ids=[];
    if(rid==='HOP')ids=(S.static.hop?.stops||[]).filter(s=>String(s.route)===String(S.routeDir)).map(s=>'H'+s.id);
    else if(pack){
      const votes={};for(const t of pack.trips)votes[t[2]]=(votes[t[2]]||0)+1;
      const pattern=Object.keys(pack.stops).filter(k=>k.split('.')[0]===String(S.routeDir)).sort((a,b)=>(votes[b]||0)-(votes[a]||0))[0];ids=pack.stops[pattern]||[];
    }
    $('sh-stops').innerHTML=`<button class="board-action" id="pin-route">${icon('i-star')}${saved?'Unsave route':'Save route'}</button><label class="direction-label">Direction<select id="route-direction" aria-label="Route direction">${dirs.map(d=>`<option value="${esc(d.id)}" ${d.id===String(S.routeDir)?'selected':''}>${esc(d.name)}</option>`).join('')}</select></label><p class="board-note">Stops in travel order on the main pattern. Some trips branch or end earlier; use a stop board for its exact destination.</p><div class="route-stop-list">${ids.map((id,i)=>`<button class="ordered-stop" data-stop="${esc(id)}"><span class="route-node"></span><span><b>${esc(stopName(id))}</b><small>Stop ${esc(id)}${i===0?' · Start':i===ids.length-1?' · End':''}</small></span>${icon('i-chev')}</button>`).join('')}</div>`;
    $('pin-route').onclick=()=>{S.pinnedRoutes=saved?S.pinnedRoutes.filter(r=>r!==rid):[...S.pinnedRoutes,rid];store.set('hop_pinned_routes',S.pinnedRoutes);routeDetails(rid);renderPinned();renderHome();drawRouteLines();};
    $('route-direction').onchange=e=>{S.routeDir=e.target.value;routeDetails(rid);drawRouteLines();};wireStopChoices($('sh-stops'));drawRouteLines();
  }
  function wire(){
    $('where-to').onclick=()=>openPlanner();$('home-locate').onclick=locate;
    document.querySelectorAll('[data-near-filter]').forEach(b=>b.onclick=()=>{E.filter=b.dataset.nearFilter;document.querySelectorAll('[data-near-filter]').forEach(x=>x.setAttribute('aria-pressed',x===b));renderHome();});
    $('plan-from').value=E.from.name;
    for(const which of ['from','to']){
      const field=$('plan-'+which);field.onfocus=()=>picker(which);field.oninput=()=>{E[which]=null;E.results=[];$('plan-results').replaceChildren();picker(which);};
      field.onkeydown=e=>{const options=[...$('picker-'+which).querySelectorAll('button')];if(e.key==='Enter'&&!$('picker-'+which).hidden){e.preventDefault();options[0]?.click();}if(e.key==='Escape')$('picker-'+which).hidden=true;if(e.key==='ArrowDown'){e.preventDefault();options[0]?.focus();}};
      $('picker-'+which).onkeydown=e=>{const options=[...$('picker-'+which).querySelectorAll('button')],index=options.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();options[(index+(e.key==='ArrowDown'?1:-1)+options.length)%options.length]?.focus();}if(e.key==='Escape'){$('picker-'+which).hidden=true;field.focus();}};
    }
    $('trip-form').onsubmit=e=>{e.preventDefault();$('picker-from').hidden=$('picker-to').hidden=true;runPlan();};
    $('plan-swap').onclick=()=>{[E.from,E.to]=[E.to,E.from];$('plan-from').value=E.from?.name||'';$('plan-to').value=E.to?.name||'';E.results=[];$('plan-results').replaceChildren();$('plan-status').textContent='Choose Find a trip to check the return journey.';};
    $('planner-location').onclick=()=>{E.locating=true;locate();};
    document.addEventListener('click',e=>{if(!e.target.closest('.endpoint-wrap')){$('picker-from').hidden=true;$('picker-to').hidden=true;}});
    renderHome();renderJourneys();
  }
  function located(){
    loadNearby();renderHome();if(E.locating&&S.mePos){E.locating=false;choose('from',{kind:'place',name:'Current location',lat:S.mePos[0],lon:S.mePos[1]});}
  }
  function onRefresh(){if(S.screen==='plan'&&E.results.length&&!E.busy)runPlan();}
  document.addEventListener('DOMContentLoaded',wire);
  return {color,renderHome,mapBoard,loadNearby,decorateStop,routeDetails,located,openPlanner,onRefresh};
})();
