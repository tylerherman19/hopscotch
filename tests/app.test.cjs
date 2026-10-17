const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {JSDOM}=require('jsdom');
const root=process.cwd();
async function app({failSchedule=false,failLive=false,map=false,staleRaw=false}={}) {
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
  let apiCalls=0;
  w.fetch=async url=>{
    if(String(url).includes('/git/ref/heads/data')){if(failLive)throw new Error('offline');apiCalls++;return {ok:true,json:async()=>({object:{sha:'a'.repeat(40)}})};}
    if(String(url).includes('/'+ 'a'.repeat(40) +'/live.json'))return {ok:true,json:async()=>live};
    if(String(url).includes('live.json')){if(failLive)throw new Error('offline');const raw=JSON.parse(JSON.stringify(live));if(staleRaw){raw.ts-=600;for(const source of Object.values(raw.sources))source.ts-=600;}return {ok:true,json:async()=>raw};}
    if(failSchedule&&String(url).includes('tt-'))throw new Error('timetable unavailable');
    return {ok:true,json:async()=>JSON.parse(fs.readFileSync(root+'/'+url))};
  };
  if(map) { w.SVGSVGElement.prototype.createSVGRect=()=>({});w.eval(fs.readFileSync('vendor/leaflet/leaflet.js','utf8')); }
  w.eval(fs.readFileSync('transit.js','utf8'));
  w.eval(fs.readFileSync('journey.js','utf8'));
  w.eval(fs.readFileSync('app.js','utf8')+'\n'+fs.readFileSync('experience.js','utf8'));
  await new Promise(resolve=>setTimeout(resolve,120));
  return {w,dom,errors,live,apiCalls:()=>apiCalls};
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

test('stale branch cache recovers by commit and never replaces newer data with older snapshots',async()=>{
 const {w,dom,errors,apiCalls}=await app({staleRaw:true});
 try {
  assert.ok(w.document.getElementById('feed-status').classList.contains('live'));
  assert.equal(apiCalls(),1);
  w.document.getElementById('btn-refresh').click();
  await new Promise(r=>setTimeout(r,60));
  assert.equal(apiCalls(),1);
  assert.ok(w.document.getElementById('feed-status').classList.contains('live'));
  assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
});

test('nearby boards show directional lines and streetcar filtering',async()=>{
 const {w,dom,errors}=await app();
 try {
  assert.ok(w.document.querySelectorAll('#nearby-lines .line-row').length>=4);
  w.document.querySelector('[data-near-filter="hop"]').click();
  const badges=[...w.document.querySelectorAll('#nearby-lines .line-badge')];
  assert.ok(badges.length>0);assert.ok(badges.every(b=>b.textContent==='H'));
  assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
});

test('trip planner finds a real stop-to-stop journey, saves it locally and opens its board',async()=>{
 const {w,dom,errors}=await app();
 try {
  const $=id=>w.document.getElementById(id);
  $('where-to').click();assert.ok($('screen-plan').classList.contains('on'));
  assert.equal($('picker-to').hidden,false,'Where to keeps destination suggestions open');
  const choice=$('picker-to').querySelector('button');choice.focus();
  choice.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal($('picker-to').hidden,true,'Escape closes suggestions and returns focus');
  assert.equal(w.document.activeElement,$('plan-to'));
  for(const [field,value] of [['from','5'],['to','9643']]){
   const input=$('plan-'+field);input.value=value;input.dispatchEvent(new w.Event('input'));
   const options=[...$('picker-'+field).querySelectorAll('button')];
   const option=options.find(b=>b.textContent.includes('Stop '+value));assert.ok(option);option.click();
  }
  $('trip-form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  await new Promise(r=>setTimeout(r,200));
  assert.ok($('plan-results').querySelectorAll('.journey-card').length>0,$('plan-status').textContent);
  $('plan-results').querySelector('[data-save-journey]').click();
  const saved=JSON.parse(w.localStorage.getItem('hop_journeys'));assert.equal(saved[0].from.stop,'5');assert.equal(saved[0].to.stop,'9643');
  assert.ok($('personal-journeys').textContent.includes('Wisconsin'));
  $('plan-results').querySelector('[data-leg]').click();await new Promise(r=>setTimeout(r,30));
  assert.equal($('sh-sub').textContent,'MCTS · Stop 5');assert.ok($('plan-from-stop'));assert.ok($('plan-to-stop'));
  $('plan-to-stop').click();assert.ok($('screen-plan').classList.contains('on'));assert.equal($('plan-results').children.length,0);
  assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
});

test('route direction changes the ordered stop list',async()=>{
 const {w,dom,errors}=await app();
 try {
  const input=w.document.getElementById('searchinput');input.value='14';input.dispatchEvent(new w.Event('input'));
  w.document.querySelector('#searchresults [data-r="14"]').click();await new Promise(r=>setTimeout(r,50));
  const select=w.document.getElementById('route-direction');assert.equal(select.options.length,2);
  const first=w.document.querySelector('.ordered-stop').dataset.stop;
  select.value=select.options[1].value;select.dispatchEvent(new w.Event('change'));
  assert.notEqual(w.document.querySelector('.ordered-stop').dataset.stop,first);
  assert.deepEqual(errors,[]);
 }finally{dom.window.close();}
});
