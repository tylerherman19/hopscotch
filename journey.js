/* Stop-to-stop journeys from published trips and fresh agency predictions. */
(function(root){
  'use strict';
  const T=typeof module!=='undefined'&&module.exports?require('./transit.js'):root.Transit;
  function meters(a,b){const r=Math.PI/180;return Math.hypot((b.lon-a.lon)*r*Math.cos((a.lat+b.lat)*r/2),(b.lat-a.lat)*r)*6371000;}
  function access(endpoint,stops){
    if(endpoint.kind==='stop')return stops[endpoint.stop]?[{id:endpoint.stop,walk:0}]:[];
    if(!Number.isFinite(endpoint.lat)||!Number.isFinite(endpoint.lon))return [];
    // Several lines can share one platform. Keep every walkable stop so those
    // duplicate platforms cannot crowd a useful bus stop out of the search.
    return Object.entries(stops).map(([id,s])=>({id,distance:meters(endpoint,s)})).filter(x=>x.distance<=650).sort((a,b)=>a.distance-b.distance).map(x=>({id:x.id,walk:Math.ceil(x.distance*1.25/1.2)}));
  }
  function plan({packs,calendar,stops,live,hop,from,to,now=Date.now()/1000,limit=5}){
    const origins=access(from,stops),destinations=new Map(access(to,stops).map(x=>[x.id,x.walk]));
    if(!origins.length||!destinations.size)return [];
    const originMap=new Map(origins.map(x=>[x.id,x.walk]));
    const rt=live?.schema>=2&&T.fresh(T.sourceTime(live,'trips'),now),pred=new Map();
    if(rt)for(const [sid,rows] of Object.entries(live.stops||{}))for(const p of rows){
      const key=String(p[3])+'|'+(p[4]||T.dayKey(p[2]));
      if(!pred.has(key))pred.set(key,new Map());pred.get(key).set(sid,p[2]);
    }
    const canceled=new Set(rt?live.canceled||[]:[]);
    const blocked=(sid,key)=>rt&&((live.skipped?.[sid]||[]).includes(key)||(live.passed?.[sid]||[]).includes(key));
    const runs=[],today=T.dayKey(now),end=now+4*3600;
    for(const offset of [-1,0,1]){
      const day=T.shiftDay(today,offset),svcs=new Set(calendar[day]||[]),origin=T.serviceOrigin(day);
      if(!svcs.size)continue;
      for(const [route,pack] of Object.entries(packs))for(const trip of pack.trips){
        if(!svcs.has(pack.services[trip[1]]))continue;
        const key=String(trip[0])+'|'+day;if(canceled.has(key))continue;
        const ids=pack.stops[trip[2]]||[],times=[],isLive=[],updates=pred.get(key);
        let cumulative=origin,delay=0;
        for(let i=0;i<ids.length;i++){
          cumulative+=trip[3][i];const reported=updates?.get(ids[i]);
          if(reported!=null)delay=reported-cumulative;
          times.push(cumulative+delay);isLive.push(reported!=null);
        }
        if(times.at(-1)<now||times[0]>end)continue;
        runs.push({route,trip:String(trip[0]),day,key,ids,times,isLive,headsign:pack.trip_headsign?.[String(trip[0])]||pack.headsign[String(trip[2]).split('.')[0]]||''});
      }
    }
    const firstByStop=new Map(),out=[];
    const leg=(r,i,j)=>({route:r.route,trip:r.trip,day:r.day,board:r.ids[i],alight:r.ids[j],depart:r.times[i],arrive:r.times[j],live:r.isLive[i],arrivalLive:r.isLive[j],headsign:r.headsign,stopCount:j-i});
    const add=(legs,walkStart,walkEnd)=>{
      const arrive=legs.at(-1).arrive+walkEnd;
      if(arrive>end||arrive<=now)return;
      out.push({legs,walkStart,walkEnd,depart:legs[0].depart,arrive,duration:arrive-now,transfers:legs.length-1});
    };
    for(const r of runs){
      for(let i=0;i<r.ids.length-1;i++){
        const walk=originMap.get(r.ids[i]);
        if(walk==null||r.times[i]<now+walk+30||blocked(r.ids[i],r.key))continue;
        for(let j=i+1;j<r.ids.length;j++){
          if(r.times[j]<r.times[i]||blocked(r.ids[j],r.key))continue;
          const ride=leg(r,i,j),walkEnd=destinations.get(r.ids[j]);
          if(walkEnd!=null)add([ride],walk,walkEnd);
          const previous=firstByStop.get(r.ids[j])||[];
          previous.push({ride,walk});previous.sort((a,b)=>a.ride.arrive-b.ride.arrive);
          // Keep different arriving routes so a useful transfer is not lost.
          const seen=new Set();firstByStop.set(r.ids[j],previous.filter(x=>{if(seen.has(x.ride.route))return false;seen.add(x.ride.route);return true;}).slice(0,3));
        }
        // The first reachable boarding occurrence is best for this trip.
        break;
      }
    }
    const transferCache=new Map();
    function transferOptions(sid){
      if(transferCache.has(sid))return transferCache.get(sid);
      const options=[];
      for(const [id,firsts] of firstByStop){
        if(!stops[id]||!stops[sid])continue;
        const distance=meters(stops[id],stops[sid]);if(distance>180)continue;
        const walk=id===sid?0:Math.ceil(distance*1.25/1.2);
        for(const first of firsts)options.push({...first,transferWalk:walk});
      }
      transferCache.set(sid,options);return options;
    }
    for(const r of runs)for(let j=1;j<r.ids.length;j++){
      const walkEnd=destinations.get(r.ids[j]);if(walkEnd==null||blocked(r.ids[j],r.key))continue;
      for(let i=0;i<j;i++){
        if(blocked(r.ids[i],r.key)||r.times[j]<r.times[i])continue;
        for(const first of transferOptions(r.ids[i])){
          if(first.ride.route===r.route||first.ride.arrive+first.transferWalk+120>r.times[i])continue;
          add([first.ride,{...leg(r,i,j),transferWalk:first.transferWalk}],first.walk,walkEnd);
        }
      }
    }
    // A streetcar journey requires both stops to report the same real vehicle.
    if(live?.schema>=2&&T.fresh(T.sourceTime(live,'hop_arrivals'),now)){
      for(const a of origins.filter(x=>x.id.startsWith('H')))for(const [dest,walkEnd] of destinations){
        if(dest===a.id||!dest.startsWith('H'))continue;
        const boardStop=hop?.stops.find(s=>'H'+s.id===a.id),alightStop=hop?.stops.find(s=>'H'+s.id===dest);
        if(!boardStop||!alightStop||boardStop.route!==alightStop.route)continue;
        const boardRows=live.hop_stops?.[a.id.slice(1)]||[],alightRows=live.hop_stops?.[dest.slice(1)]||[];
        for(const b of boardRows){
          if(b[2]!==false||b[3]==null||b[1]<now+a.walk+30)continue;
          const arrival=alightRows.find(p=>p[2]===false&&p[3]===b[3]&&p[1]>b[1]&&p[1]<b[1]+5400);
          if(arrival)add([{route:'HOP',trip:null,vehicle:b[3],board:a.id,alight:dest,depart:b[1],arrive:arrival[1],live:true,arrivalLive:true,headsign:hop.routes.find(r=>r.id===boardStop.route)?.name||'The Hop',stopCount:null}],a.walk,walkEnd);
        }
      }
    }
    const seen=new Set();
    return out.sort((a,b)=>a.arrive-b.arrive||a.transfers-b.transfers||a.depart-b.depart).filter(x=>{
      const key=x.legs.map(l=>l.route+':'+(l.trip||l.vehicle)+':'+(l.day||'')).join('|');
      if(seen.has(key))return false;seen.add(key);return true;
    }).slice(0,limit);
  }
  const api={meters,access,plan};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.Journey=api;
})(typeof window!=='undefined'?window:globalThis);
