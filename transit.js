/* Pure transit rules shared by the browser and regression tests. */
(function (root) {
  "use strict";
  const MAX_AGE = 180;
  const dateFormat = new Intl.DateTimeFormat("en-CA", {timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit"});
  function dayKey(epoch) { return dateFormat.format(new Date(epoch * 1000)).replace(/-/g, ""); }
  function shiftDay(key, offset) {
    const d = new Date(Date.UTC(+key.slice(0,4), +key.slice(4,6)-1, +key.slice(6,8)+offset));
    return d.toISOString().slice(0,10).replace(/-/g, "");
  }
  // GTFS service-day origin is local noon minus 12 elapsed hours, including DST days.
  function serviceOrigin(key) {
    const noonUTC = Date.UTC(+key.slice(0,4), +key.slice(4,6)-1, +key.slice(6,8), 12) / 1000;
    const hour = +new Intl.DateTimeFormat("en-US", {timeZone:"America/Chicago", hour:"numeric", hourCycle:"h23"}).format(new Date(noonUTC * 1000));
    return noonUTC + (12-hour) * 3600 - 43200;
  }
  function fresh(ts, now = Date.now()/1000) { return Number.isFinite(ts) && now-ts >= -60 && now-ts <= MAX_AGE; }
  function sourceTime(live, source) {
    if (!live) return 0;
    if (live.sources && source in live.sources) return live.sources[source]?.ok ? +live.sources[source].ts : 0;
    return +live.ts || 0;
  }
  function tripInfo(pack, id) {
    const t = pack?.trips.find(t => String(t[0]) === String(id));
    if (!t) return null;
    return {trip:t, stops:pack.stops[t[2]], headsign:pack.trip_headsign?.[String(t[0])] || pack.headsign[String(t[2]).split('.')[0]] || ""};
  }
  function reaches(pack, id, board, alight) {
    if (!alight) return true;
    const p = tripInfo(pack, id)?.stops;
    if (!p) return false;
    const i = p.indexOf(String(board));
    return i >= 0 && p.indexOf(String(alight), i+1) > i;
  }
  function scheduled(pack, rid, sid, calendar, now, alight) {
    if (!pack) return [];
    const out = [], today = dayKey(now);
    for (const offset of [-1,0,1]) {
      const key = shiftDay(today, offset), origin = serviceOrigin(key), active = new Set(calendar[key] || []);
      for (const t of pack.trips) {
        if (!active.has(pack.services[t[1]])) continue;
        const pat = pack.stops[t[2]] || [], idx = pat.indexOf(String(sid));
        if (idx < 0 || (alight && pat.indexOf(String(alight),idx+1) <= idx)) continue;
        const at = origin + t[3].slice(0,idx+1).reduce((a,b)=>a+b,0);
        if (at < now || at > now+4*3600) continue;
        out.push({route:rid, at, trip:String(t[0]), day:key, sched:true, headsign:pack.trip_headsign?.[String(t[0])] || pack.headsign[String(t[2]).split('.')[0]] || ""});
      }
    }
    return out;
  }
  function departures({packs, calendar, live, sid, routes, alight, now = Date.now()/1000, limit = 8}) {
    sid = String(sid);
    const wanted = new Set(routes || Object.keys(packs)), out = [];
    const valid = fresh(sourceTime(live,'trips'),now);
    // Schema 2 no longer mixes schedule rows into the prediction feed. Legacy
    // snapshots are ambiguous and must be treated as schedule-only.
    const predictions = valid && live.schema >= 2 ? live.stops?.[sid] || [] : [];
    for (const p of predictions) {
      const rid = String(p[0]);
      if (!wanted.has(rid) || p[2] < now-15 || p[2] > now+4*3600 || !reaches(packs[rid],p[3],sid,alight)) continue;
      out.push({route:rid, at:p[2], trip:String(p[3]), day:p[4] || dayKey(p[2]), sched:false, headsign:tripInfo(packs[rid],p[3])?.headsign || ""});
    }
    for (const rid of wanted) for (const p of scheduled(packs[rid],rid,sid,calendar,now,alight)) {
      const key = p.trip+'|'+p.day;
      if (out.some(x=>x.trip===p.trip && x.day===p.day)) continue;
      if (valid && (live.canceled || []).includes(key)) continue;
      if (valid && (live.skipped?.[sid] || []).includes(key)) continue;
      // A trip that already passed this stop must not reappear at its old schedule.
      if (valid && (live.passed?.[sid] || []).includes(key)) continue;
      out.push(p);
    }
    return out.sort((a,b)=>a.at-b.at || a.route.localeCompare(b.route)).slice(0,limit);
  }
  const api = {MAX_AGE,dayKey,shiftDay,serviceOrigin,fresh,sourceTime,tripInfo,reaches,scheduled,departures};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Transit = api;
})(typeof window !== 'undefined' ? window : globalThis);
