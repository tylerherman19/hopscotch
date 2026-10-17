const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const root=process.cwd();
async function app({failSchedule=false,failLive=false,map=false}={}) {
  const html=fs.readFileSync('index.html','utf8').replace(/<script[^>]*src=[^>]*><\/script>/g,'');
  const dom=new JSDOM(html,{url:'https://example.org/hopscotch/#home',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  const errors=[];w.addEventListener('error',e=>errors.push(e.error));w.console.error=(...e)=>errors.push(e);w.console.warn=()=>{};
  w.matchMedia=()=>({matches:false});w.AbortSignal=AbortSignal;
  const fixed=Date.parse('2026-10-16T21:45:00Z');
  w.Date.now=()=>fixed;
  const live={schema:2,ts:fixed/1000,sources:Object.fromEntries(['vehicles','trips','alerts','hop','hop_arrivals'].map(s=>[s,{ok:true,ts:fixed/1000}])),vehicles:[{id:'test',trip:'test',route:'14',lat:43.0387,lon:-87.9111}],hop:[],stops:{},hop_stops:{},alerts:[]};
  live.ts=fixed/1000;
  for(const source of Object.values(live.sources))source.ts=fixed/1000;
  for(const v of [...live.vehicles,...live.hop])v.ts=fixed/1000;
  w.fetch=async url=>{
    if(String(url).includes('live.json')){if(failLive)throw new Error('offline');return {ok:true,json:async()=>live};}
    if(failSchedule&&String(url).includes('tt-'))throw new Error('timetable unavailable');
    return {ok:true,json:async()=>JSON.parse(fs.readFileSync(root+'/'+url))};
  };
  if(map) { w.SVGSVGElement.prototype.createSVGRect=()=>({});w.eval(fs.readFileSync('vendor/leaflet/leaflet.js','utf8')); }
  w.eval(fs.readFileSync('transit.js','utf8'));
  w.eval(fs.readFileSync('app.js','utf8'));
  await new Promise(resolve=>setTimeout(resolve,120));
  return {w,dom,errors,live};
}
test('startup, saved trip direction, stop saving and schedule board work without WebGL',async()=>{
 const {w,dom,errors}=await app();
 try{
  const $=id=>w.document.getElementById(id);
  assert.equal($('saved').querySelectorAll('article').length,2);
  assert.ok($('feed-status').textContent.includes('buses'));
  $('saved').querySelector('[data-card="school"][data-dir="back"]').click();
  assert.ok($('saved').textContent.includes('To Downtown'));
  assert.equal($('saved').querySelector('[data-stop]').dataset.stop,'9642');
  $('saved').querySelector('[data-stop]').click();
  await new Promise(r=>setTimeout(r,40));
  assert.equal($('sh-sub').textContent,'MCTS · Stop 9642');
  assert.ok($('sheet').classList.contains('half'));
  $('pin-stop').click();assert.equal(JSON.parse(w.localStorage.getItem('hop_favorites'))[0],'9642');
  assert.ok($('favorites').textContent.includes('Wisconsin'));
  $('sheet-close').click();assert.equal($('sheet').hidden,true);
  assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
});
test('failed timetable does not block controls, live data or streetcar search',async()=>{
 const {w,dom,errors}=await app({failSchedule:true});
 try{
  assert.ok(w.document.getElementById('feed-status').textContent.includes('buses'));
  const search=w.document.getElementById('searchinput');search.value='Lakefront';search.dispatchEvent(new w.Event('input'));
  assert.ok(w.document.getElementById('searchresults').textContent.toLowerCase().includes('lakefront'));
  w.document.getElementById('btn-settings').click();assert.equal(w.document.getElementById('settings').hidden,false);
  assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
});
test('live outage still provides labeled scheduled departures',async()=>{
 const {w,dom,errors}=await app({failLive:true});
 try{
  assert.ok(w.document.getElementById('feed-status').textContent.includes('unavailable'));
  assert.ok(w.document.getElementById('saved').textContent.includes('Scheduled'));
  assert.ok(w.document.getElementById('updates').textContent.includes('Service alerts unavailable'));
  assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
});

test('raster map initializes, searches and selects routes without WebGL',async()=>{
 const {w,dom,errors}=await app({map:true});
 try {
  w.document.querySelector('[data-screen="map"]').click();
  assert.ok(w.document.querySelector('.leaflet-container'));
  const search=w.document.getElementById('searchinput');
  search.value='5';search.dispatchEvent(new w.Event('input'));
  assert.equal(w.document.querySelector('#searchresults button').dataset.stop,'5');
  search.value='14';search.dispatchEvent(new w.Event('input'));
  w.document.querySelector('#searchresults [data-r="14"]').click();
  await new Promise(r=>setTimeout(r,60));
  assert.equal(w.document.getElementById('sh-title').textContent,'Route 14');
  w.document.getElementById('pin-route').click();
  assert.deepEqual(JSON.parse(w.localStorage.getItem('hop_pinned_routes')),['14']);
  assert.ok(w.document.querySelectorAll('#sh-stops [data-stop]').length>50);
  assert.ok(w.document.querySelectorAll('.leaflet-overlay-pane path').length>0);
  assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
});
