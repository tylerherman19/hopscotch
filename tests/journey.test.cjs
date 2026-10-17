const {test}=require('node:test');
const assert=require('node:assert/strict');
const J=require('../journey.js');
const T=require('../transit.js');
const now=Date.parse('2026-10-17T17:00:00Z')/1000,day=T.dayKey(now),sec=now-T.serviceOrigin(day);
const stop=id=>({kind:'stop',stop:id,name:id});
const stops={A:{lat:43,lon:-87.9},B:{lat:43.005,lon:-87.9},C:{lat:43.01,lon:-87.9},D:{lat:43.015,lon:-87.9}};
const pack=(id,ids,times)=>({services:['S'],headsign:{0:'Destination'},stops:{'0.0':ids},trips:[[id,0,'0.0',[sec+times[0],...times.slice(1).map((t,i)=>t-times[i])]]]});
const base=extra=>({packs:{14:pack('one',['A','B','C'],[120,420,720])},calendar:{[day]:['S']},stops,live:null,from:stop('A'),to:stop('C'),now,...extra});
const live=extra=>({schema:2,ts:now,sources:{trips:{ok:true,ts:now}},stops:{},...extra});
test('direct journey respects boarding order, duration and exact stops',()=>{
 const r=J.plan(base())[0];assert.equal(r.legs[0].board,'A');assert.equal(r.legs[0].alight,'C');assert.equal(r.arrive,now+720);assert.equal(r.duration,720);assert.equal(r.transfers,0);
 assert.deepEqual(J.plan(base({from:stop('C'),to:stop('A')})),[]);
});
test('one-transfer journey enforces two minutes to change buses',()=>{
 const f=base({packs:{14:pack('one',['A','B'],[120,420]),30:pack('two',['B','D'],[600,900])},to:stop('D')});
 const r=J.plan(f)[0];assert.equal(r.transfers,1);assert.equal(r.legs[1].depart-r.legs[0].arrive,180);
 f.packs[30]=pack('two',['B','D'],[500,900]);assert.deepEqual(J.plan(f),[]);
});
test('cancellations and skipped destination suppress route options',()=>{
 assert.deepEqual(J.plan(base({live:live({canceled:['one|'+day]})})),[]);
 assert.deepEqual(J.plan(base({live:live({skipped:{C:['one|'+day]}})})),[]);
});
test('live boarding propagates a delay but labels unreported arrival as estimated',()=>{
 const r=J.plan(base({live:live({stops:{A:[['14',240,now+240,'one',day]]}})}))[0];
 assert.equal(r.depart,now+240);assert.equal(r.arrive,now+840);assert.equal(r.legs[0].live,true);assert.equal(r.legs[0].arrivalLive,false);
});
test('stale predictions cannot make a scheduled trip appear live',()=>{
 const l=live({sources:{trips:{ok:true,ts:now-181}},stops:{A:[['14',240,now+240,'one',day]]}});
 const r=J.plan(base({live:l}))[0];assert.equal(r.depart,now+120);assert.equal(r.legs[0].live,false);
});
test('walking access cannot board a bus before the rider can reach it',()=>{
 const f=base({from:{kind:'place',lat:43,lon:-87.905}});
 assert.deepEqual(J.plan(f),[]);
 assert.ok(J.access(f.from,stops).some(x=>x.walk>120));
});
test('clustered platforms do not hide other walkable boarding and destination stops',()=>{
 const nearby={...stops};
 for(let i=0;i<10;i++){nearby['H'+i]={lat:43.0001,lon:-87.9};nearby['Hend'+i]={lat:43.0101,lon:-87.9};}
 const r=J.plan(base({stops:nearby,from:{kind:'place',lat:43.0001,lon:-87.9},to:{kind:'place',lat:43.0101,lon:-87.9}}))[0];
 assert.ok(r);assert.equal(r.legs[0].board,'A');assert.equal(r.legs[0].alight,'C');assert.equal(r.transfers,0);
});
test('no calendar coverage and unknown stops never invent a journey',()=>{
 assert.deepEqual(J.plan(base({calendar:{}})),[]);assert.deepEqual(J.plan(base({from:stop('missing')})),[]);
});
test('overnight journeys use the previous service day',()=>{
 const n=Date.parse('2026-10-18T05:15:00Z')/1000;
 const p={...pack('night',['A','B'],[0,300]),trips:[['night',0,'0.0',[25*3600,300]]]};
 const r=J.plan(base({packs:{14:p},to:stop('B'),now:n}))[0];assert.equal(r.depart,Date.parse('2026-10-18T06:00:00Z')/1000);
});
test('streetcars require matching real vehicles at both stops',()=>{
 const hop={routes:[{id:9,name:'F-Line'}],stops:[{id:1,route:9},{id:2,route:9}]};
 const l=live({sources:{hop_arrivals:{ok:true,ts:now}},hop_stops:{1:[[120,now+120,false,3]],2:[[600,now+600,false,3]]}});
 const f=base({packs:{},hop,stops:{H1:stops.A,H2:stops.B},from:stop('H1'),to:stop('H2'),live:l});
 const r=J.plan(f)[0];assert.equal(r.legs[0].route,'HOP');assert.equal(r.legs[0].vehicle,3);
 l.hop_stops[2][0][3]=4;assert.deepEqual(J.plan(f),[]);
});

test('nearby stop transfers include walking time and a two-minute connection buffer',()=>{
 const f=base({stops:{...stops,X:{lat:43.005,lon:-87.8995}},packs:{14:pack('one',['A','B'],[120,420]),30:pack('two',['X','D'],[630,1000])},to:stop('D')});
 const r=J.plan(f)[0];assert.equal(r.transfers,1);assert.ok(r.legs[1].transferWalk>0);assert.equal(r.legs[0].alight,'B');assert.equal(r.legs[1].board,'X');
 f.packs[30]=pack('two',['X','D'],[550,1000]);assert.deepEqual(J.plan(f),[]);
});

test('different alighting stops on the same bus do not duplicate a journey option',()=>{
 const r=J.plan(base({to:{kind:'place',lat:43.0075,lon:-87.9}}));
 assert.equal(r.length,1);assert.equal(r[0].legs[0].alight,'B');
});
