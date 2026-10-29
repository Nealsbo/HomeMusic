const {test} = require('node:test');
const assert = require('node:assert/strict');
const {AudioWave} = require('../web/audio-wave.js');
function fixture({resumeFails=false, unsupported=false}={}) {
  const audio={paused:false,ended:false,src:'/media/a',currentTime:42};
  const links=new Set(), timers=new Map(); let now=0, next=0, hidden=false, reduced=false, contexts=0, sources=0, analyses=0, status, drawing;
  const analyser={fftSize:0,getByteFrequencyData:b => { analyses++; b.fill(220); },getByteTimeDomainData:b => b.fill(170)};
  const context={state:'suspended',destination:{},resume:async () => { if(resumeFails) throw Error('blocked'); context.state='running'; },
    createAnalyser:() => analyser,createMediaElementSource:a => { assert.equal(a,audio); sources++; return source; }};
  const source={connect:node => links.add(node),disconnect:node => { assert.equal(node,analyser); links.delete(node); }};
  const wave=new AudioWave(audio,{
    now:() => now,
    createContext:() => { contexts++; return unsupported ? null : context; }, hidden:() => hidden,reduced:() => reduced,
    schedule:(fn,delay) => { const id=++next; timers.set(id,{fn,delay}); return id; },cancel:id => timers.delete(id),
    draw:(levels,active) => drawing={levels:[...levels],active},status:s => status=s
  });
  return {audio,wave,context,analyser,links,timers,hidden:v => hidden=v,reduced:v => reduced=v,
    get status(){return status;},get drawing(){return drawing;},get contexts(){return contexts;},get sources(){return sources;},get analyses(){return analyses;},
    frame(){ const [id,t]=timers.entries().next().value; timers.delete(id); now+=t.delay; t.fn(); }};
}
async function playing(f,mode='eco') { f.wave.setMode(mode); await f.wave.unlock(); f.wave.media('playing'); }

test('disabled visualizer does not create an audio context or change playback',async () => {
  const f=fixture(); await f.wave.unlock(); f.wave.media('playing');
  assert.equal(f.contexts,0); assert.equal(f.timers.size,0); assert.equal(f.audio.currentTime,42);
});
test('wave is measured from audio samples and frame rate is bounded',async () => {
  const f=fixture(); await playing(f);
  assert.equal(f.sources,1); assert.ok(f.links.has(f.context.destination)); assert.ok(f.links.has(f.analyser));
  assert.ok(f.drawing.levels.every(l => l>0)); assert.equal(f.timers.size,1);
  assert.equal([...f.timers.values()][0].delay,1000/12);
  f.wave.setMode('smooth'); assert.equal(f.timers.size,1); assert.equal([...f.timers.values()][0].delay,1000/30);
  f.wave.setMode('high'); assert.equal(f.timers.size,1); assert.equal([...f.timers.values()][0].delay,1000/60);
  f.analyser.getByteFrequencyData=b=>b.fill(0); f.analyser.getByteTimeDomainData=b=>b.fill(128);
  for(let i=0;i<120;i++) f.frame();
  assert.ok(f.drawing.levels.every(l=>l<.001));
});
test('turning off detaches only analysis; audible path and position survive repeated toggles',async () => {
  const f=fixture(); await playing(f);
  for(let i=0;i<8;i++) {
    f.wave.setMode('off'); assert.equal(f.timers.size,0); assert.equal(f.links.has(f.analyser),false);
    assert.ok(f.links.has(f.context.destination)); assert.ok(f.drawing.levels.every(l=>l===0));
    f.wave.setMode('eco'); await f.wave.unlock();
  }
  assert.equal(f.sources,1); assert.equal(f.contexts,1); assert.equal(f.audio.src,'/media/a'); assert.equal(f.audio.currentTime,42); assert.equal(f.audio.paused,false);
});
test('pause, buffering, seek and track changes reset wave without duplicate loops',async () => {
  const f=fixture(); await playing(f);
  f.audio.paused=true; f.wave.media('pause'); assert.equal(f.timers.size,0);
  f.audio.paused=false; f.wave.media('playing'); assert.equal(f.timers.size,1);
  for(const event of ['waiting','seeking','loadstart','emptied','error','ended']) {
    f.wave.media(event); assert.equal(f.timers.size,0); assert.ok(f.drawing.levels.every(l=>l===0));
    f.wave.media('playing'); assert.equal(f.timers.size,1);
  }
});
test('hidden panels/tabs and reduced motion stop analysis while audio remains connected',async () => {
  const f=fixture(); await playing(f);
  for(const setting of [f.hidden,f.reduced]) {
    setting(true); f.wave.sync(); assert.equal(f.timers.size,0); assert.ok(f.links.has(f.context.destination));
    const n=f.analyses; f.wave.sync(); assert.equal(f.analyses,n);
    setting(false); f.wave.sync(); assert.equal(f.timers.size,1);
  }
});
test('system reduced motion does not initialize Web Audio',async () => {
  const f=fixture(); f.reduced(true); f.wave.setMode('eco'); await f.wave.unlock();
  assert.equal(f.contexts,0); assert.equal(f.status,'reduced');
});
test('unsupported or rejected audio context leaves native audio untouched',async () => {
  for(const options of [{unsupported:true},{resumeFails:true}]) {
    const f=fixture(options); await playing(f); assert.equal(f.sources,0); assert.equal(f.timers.size,0);
    assert.equal(f.status,'unavailable'); assert.equal(f.audio.paused,false); assert.equal(f.audio.currentTime,42);
  }
});
test('analysis failures preserve direct sound and cancel drawing',async () => {
  const f=fixture(); await playing(f);
  f.analyser.getByteFrequencyData=()=>{throw Error('failed');}; f.frame();
  assert.equal(f.status,'unavailable'); assert.equal(f.timers.size,0); assert.ok(f.links.has(f.context.destination));
});
test('suspended attached graph resumes even when animation has been turned off',async () => {
  const f=fixture(); await playing(f); f.wave.setMode('off'); f.context.state='suspended';
  await f.wave.unlock(); assert.equal(f.context.state,'running'); assert.equal(f.sources,1); assert.equal(f.timers.size,0);
});
test('switching off during context resume does not reroute native audio',async () => {
  const f=fixture(); let resume;
  f.context.resume=()=>new Promise(resolve=>{resume=()=>{f.context.state='running';resolve();};});
  f.wave.setMode('eco'); const pending=f.wave.unlock(); f.wave.setMode('off'); resume(); await pending;
  assert.equal(f.sources,0); assert.equal(f.timers.size,0);
});


test('60 fps smooths abrupt attacks and releases instead of snapping to samples',async () => {
  const f=fixture();
  f.analyser.getByteFrequencyData=b=>b.fill(0);
  await playing(f,'high');
  f.analyser.getByteFrequencyData=b=>b.fill(255);
  f.frame();
  const first=f.drawing.levels[0];
  assert.ok(first>0 && first<.25);
  f.frame(); assert.ok(f.drawing.levels[0]>first);
  for(let i=0;i<60;i++)f.frame();
  const peak=f.drawing.levels[0];
  f.analyser.getByteFrequencyData=b=>b.fill(0);
  f.frame();
  assert.ok(f.drawing.levels[0]<peak && f.drawing.levels[0]>peak*.9);
});

test('smoothing follows elapsed time consistently at 12, 30 and 60 fps',async () => {
  const readings=[];
  for(const [mode,fps] of [['eco',12],['smooth',30],['high',60]]) {
    const f=fixture(); f.analyser.getByteFrequencyData=b=>b.fill(0);
    await playing(f,mode);
    f.analyser.getByteFrequencyData=b=>b.fill(220);
    for(let i=0;i<fps/2;i++)f.frame();
    const attack=f.drawing.levels[0];
    f.analyser.getByteFrequencyData=b=>b.fill(0);
    for(let i=0;i<fps/2;i++)f.frame();
    readings.push({attack,release:f.drawing.levels[0]});
  }
  for(const sample of readings.slice(1)) {
    assert.ok(Math.abs(sample.attack-readings[0].attack)<.00001);
    assert.ok(Math.abs(sample.release-readings[0].release)<.00001);
  }
});


test('smoothing strength can be tuned live, disabled, or safely reset by invalid values',async () => {
  const f=fixture(); await playing(f,'high');
  async function attack(strength) {
    f.wave.smoothing=strength;
    f.wave.media('playing');
    return f.drawing.levels[0];
  }
  const normal=await attack(1), gentle=await attack(2), instant=await attack(0);
  assert.ok(gentle>0 && gentle<normal && normal<instant);
  assert.equal(await attack(NaN),normal);
  assert.equal(await attack(-1),instant);
});
