const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const T=require('../transit.js');
const now=Date.parse('2026-10-16T21:00:00Z')/1000, day='20261016';
const origin=T.serviceOrigin(day),sec=now-origin;
const pack={services:['weekday'],headsign:{0:'East',1:'West'},stops:{'0.0':['A','B','C'],'1.0':['C','B','A']},trips:[['1',0,'0.0',[sec+60,60,60]],['2',0,'0.0',[sec+90,60,60]],['3',0,'1.0',[sec+120,60,60]]]};
const fixture=(extra={})=>({packs:{14:pack},calendar:{[day]:['weekday']},live:{schema:2,ts:now,sources:{trips:{ok:true,ts:now}},stops:{}},sid:'A',now,...extra});
test('live prediction replaces only the same trip, retaining close distinct trips',()=>{
 const f=fixture();f.live.stops.A=[['14',180,now+180,'1',day]];
 const rows=T.departures(f);assert.equal(rows.length,3);assert.equal(rows.filter(p=>p.trip==='1').length,1);assert.equal(rows.find(p=>p.trip==='1').sched,false);assert.equal(rows[0].trip,'2');
});
test('destination eligibility rejects the opposite direction and short turns',()=>{
 const rows=T.departures(fixture({alight:'C'}));assert.deepEqual(rows.map(p=>p.trip),['1','2']);
 assert.equal(T.reaches(pack,'3','A','C'),false);assert.equal(T.reaches(pack,'unknown','A','C'),false);
});
test('stale and failed sources do not supply live predictions',()=>{
 for(const source of [{ok:true,ts:now-181},{ok:false,ts:now}]){
  const f=fixture();f.live.sources.trips=source;f.live.stops.A=[['14',60,now+60,'1',day]];
  assert.ok(T.departures(f).every(p=>p.sched));
 }
});
test('legacy snapshots never promote mixed scheduled rows to live',()=>{
 const f=fixture();delete f.live.schema;f.live.stops.A=[['14',60,now+60,'1']];assert.ok(T.departures(f).every(p=>p.sched));
});
test('canceled, skipped, and already passed stops do not reappear from timetable',()=>{
 for(const kind of ['canceled','skipped','passed']){
  const f=fixture();f.live[kind]=kind==='canceled'?['1|'+day]:{A:['1|'+day]};assert.ok(!T.departures(f).some(p=>p.trip==='1'));
 }
});
test('calendar expiration never guesses a service by month or weekday',()=>{
 assert.deepEqual(T.departures(fixture({calendar:{}})),[]);
});
test('after midnight includes previous service day times beyond 24:00',()=>{
 const n=Date.parse('2026-10-17T05:30:00Z')/1000;
 const p={...pack,trips:[['night',0,'0.0',[25*3600,60,60]]]};
 const r=T.departures(fixture({packs:{14:p},now:n,live:null}));assert.equal(r[0].at,Date.parse('2026-10-17T06:00:00Z')/1000);
});
test('tomorrow morning departures are considered late at night',()=>{
 const n=Date.parse('2026-10-17T04:55:00Z')/1000;
 const p={...pack,trips:[['tomorrow',0,'0.0',[60,60,60]]]};
 const r=T.departures(fixture({packs:{14:p},calendar:{'20261017':['weekday']},now:n,live:null}));assert.equal(r[0].at,Date.parse('2026-10-17T05:01:00Z')/1000);
});
test('GTFS service origin uses noon minus 12h across daylight saving transitions',()=>{
 assert.equal(T.serviceOrigin('20260308'),Date.parse('2026-03-08T05:00:00Z')/1000);
 assert.equal(T.serviceOrigin('20261101'),Date.parse('2026-11-01T06:00:00Z')/1000);
 assert.equal(T.dayKey(Date.parse('2026-10-17T04:59:00Z')/1000),'20261016');
});
test('all configured commutes have board then alight in each listed route',()=>{
 const st=JSON.parse(fs.readFileSync('data/static.json'));
 for(const trip of JSON.parse(fs.readFileSync('data/hotroutes.json')).routes){
  const leg=trip.legs.find(l=>l.kind==='bus');
  for(const rid of leg.routes){const p=JSON.parse(fs.readFileSync('data/tt-'+st.tindex[rid]+'.json'))[rid];assert.ok(Object.values(p.stops).some(stops=>stops.indexOf(leg.board)>=0&&stops.indexOf(leg.alight)>stops.indexOf(leg.board)),trip.id+' '+rid);}
 }
});
