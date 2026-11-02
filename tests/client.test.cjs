const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {audioGraph,drawingContext} = require('./audio-fixture.cjs');

class Element {
  constructor(id) {
    this.id = id; this._value = id === 'sort' ? 'manual' : id === 'libraryList' ? 'all' : ''; this.options = id === 'sort' ? [{value:'manual'}] : [];
    this.hidden = false; this.checked = false; this.dataset = {}; this.children = {}; this.textContent = '';
    this.attributes = {}; this.listeners = {};
    const classes = new Set();
    this.classList = {toggle(name,force) { const add = force ?? !classes.has(name); add ? classes.add(name) : classes.delete(name); return add; },
      add:name => classes.add(name),remove:name => classes.delete(name),contains:name => classes.has(name)};
    this.nodes = []; this.parentNode = null;
    this.style = {setProperty(key,value) { this[key] = value; }};
  }
  set innerHTML(html) {
    this.html = html;
    if (['folderFilter','moveFolder','uploadFolder','newFolderParent','addPlaylist','historyDevice','deviceTarget'].includes(this.id)) {
      this.options = [...html.matchAll(/<option value="([^"]*)">/g)].map(m => ({value:m[1]}));
      this._value = this.options[0]?.value ?? '';
    }
  }
  get innerHTML() { return this.html || ''; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  querySelector(selector) { return this.children[selector] ??= new Element(selector); }
  setAttribute(name,value) { this.attributes[name] = value; }
  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) node.parentNode.nodes = node.parentNode.nodes.filter(other => other !== node);
      node.parentNode = this; this.nodes.push(node);
    }
  }
  replaceChildren(...nodes) { for (const node of this.nodes) node.parentNode = null; this.nodes = []; this.html = ''; this.textContent = ''; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.nodes = this.parentNode.nodes.filter(node => node !== this); this.parentNode = null; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  addEventListener(name,fn,options = {}) { (this.listeners[name] ||= []).push({fn,once:options.once}); }
  emit(name) { this['on' + name]?.(); const list = this.listeners[name] || []; this.listeners[name] = list.filter(e => !e.once); list.forEach(e => e.fn()); }
  removeAttribute(name) { if (name === 'src') this.src = undefined; }
  load() { this.loadCalls = (this.loadCalls || 0) + 1; if (this.id === 'audio') { this.currentTime = 0; this.paused = true; } }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const fixture = () => ({
  tracks:[
    {id:'a',title:'Alpha',artist:'Zed',album:'Night',path:'Alpha.mp3',size:100,modified:1},
    {id:'b',title:'Beta',artist:'Alex',album:'Day',path:'Jazz/Beta.mp3',size:300,modified:3},
    {id:'c',title:'Gamma',artist:'Alex',album:'Night',path:'Jazz/Gamma.mp3',size:200,modified:2}
  ],
  playlists:[{id:'p',name:'Mix',tracks:['c','a','b']}],folders:['','Jazz'],settings:{},storage:'/music',maxUploadMB:512
});
async function client({headStatus = 200, savedPlayer = null, listenFailures = 0, initialStorage = {}, initialSessionStorage = {}, controlTransport = null, healthTransport = null, operationTransport = null, reducedMotion = false, audioContextFactory = null, drawing = null, narrowPlayer = false} = {}) {
  let data = fixture(); const elements = new Map(); const calls = [];
  let document;
  const get = id => { if (!elements.has(id)) elements.set(id,new Element(id)); const element = elements.get(id); element.ownerDocument = document; return element; };
  const audio = get('audio'); Object.assign(audio,{paused:true,currentTime:0,duration:120,volume:.75});
  audio.play = async () => { audio.paused = false; audio.emit('play'); };
  audio.pause = () => { audio.paused = true; audio.emit('pause'); };
  let now = 0;
  const local = new Map(Object.entries(initialStorage));
  // Audio-analysis scenarios keep the optional wave visible unless explicitly collapsed.
  if (drawing && !local.has('libraryWaveOpen')) local.set('libraryWaveOpen','true');
  const session = new Map(Object.entries(initialSessionStorage));
  if (savedPlayer) local.set('player',JSON.stringify(savedPlayer));
  const connection = {lastChild:{textContent:''}};
  const documentListeners = new Map();
  const createdElements = [];
  const timers = {timeouts:0,intervals:0};
  const timeoutTasks = new Map();
  const motionListeners = new Set();
  const motionPreference = {matches:reducedMotion,addEventListener(name,fn) { motionListeners.add(fn); },removeEventListener(name,fn) { motionListeners.delete(fn); }};
  const viewportListeners = new Set();
  const playerViewport = {matches:narrowPlayer,addEventListener(name,fn) { viewportListeners.add(fn); },removeEventListener(name,fn) { viewportListeners.delete(fn); }};
  const sandbox = {
    document:{documentElement:{dataset:{},style:{},classList:get('documentElement').classList},getElementById:get,querySelectorAll:() => [],querySelector:s => s === '.connection' ? connection : null,hidden:false,
      createElement(tag) { const element = new Element(''); element.tagName = tag.toUpperCase(); element.ownerDocument = document; if (tag === 'canvas' && drawing) element.getContext = () => drawing; createdElements.push(element); return element; },
      addEventListener(name,fn) { if (!documentListeners.has(name)) documentListeners.set(name,[]); documentListeners.get(name).push(fn); },
      removeEventListener(name,fn) { documentListeners.set(name,(documentListeners.get(name) || []).filter(listener => listener !== fn)); },
      dispatchEvent(event) { for (const fn of documentListeners.get(event.type) || []) fn(event); }},
    navigator:{},window:{addEventListener(){},matchMedia:query => query === '(max-width: 960px)' ? playerViewport : motionPreference,AudioContext:audioContextFactory},
    localStorage:{getItem:k => local.get(k),setItem:(k,v) => local.set(k,v),removeItem:k => local.delete(k),get length() { return local.size; },key:i => [...local.keys()][i]},
    sessionStorage:{getItem:k => session.get(k),setItem:(k,v) => session.set(k,v)},
    TextEncoder, URLSearchParams, Event, performance:{now:() => now},
    setInterval:() => ++timers.intervals,
    setTimeout:(fn,delay) => { const id = ++timers.timeouts; timeoutTasks.set(id,{fn,delay}); return id; },
    clearTimeout:id => timeoutTasks.delete(id),console:{...console},
    getComputedStyle:() => ({color:({forest:'#24754b',midnight:'#74b9e8',sand:'#9b5634'})[document.documentElement.dataset.theme] || '#24754b'}),
    fetch:async (url,options = {}) => {
      if (url.startsWith('/locales/')) return {ok:true,json:async () => JSON.parse(fs.readFileSync('web' + url,'utf8'))};
      const action = url.replace('/api/',''); const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({action,body});
      if (operationTransport && (action.startsWith('operations?') || ['undo','operation-recover','metadata'].includes(action))) return {ok:true,json:async () => operationTransport(action,body)};
      if (healthTransport && action.startsWith('health')) return {ok:true,json:async () => healthTransport(action,body)};
      if (controlTransport && (action.startsWith('control') || action === 'status')) return {ok:true,json:async () => controlTransport(action,body)};
      if (url.startsWith('/media/')) return {ok:headStatus === 200, status:headStatus, json:async () => ({error:'File not found'})};
      if (action.startsWith('media-info/')) return {ok:true,json:async () => ({path:'Jazz/test.flac',mime:'audio/flac',container:'FLAC',size:200})};
      let result = {ok:true};
      if (action === 'listen' && listenFailures-- > 0) throw new Error('offline');
      if (action === 'favorite') { data.tracks.find(t => t.id === body.id).favorite = body.value; result.favorite = body.value; }
      if (action === 'device') result.name = body.name;
      if (action === 'settings') Object.assign(data.settings,body);
      if (action.startsWith('history?')) return {ok:true,json:async () => ({items:data.historyEvents || [],devices:[{id:'phone',name:'Phone'}],total:(data.historyEvents || []).length,nextCursor:null})};
      if (action === 'playlist') { const id = 'p' + data.playlists.length; data.playlists.push({id,name:body.name,tracks:[]}); result = {id}; }
      if (action === 'order') data.tracks = body.tracks.map(id => data.tracks.find(t => t.id === id));
      if (action === 'playlistTracks') data.playlists.find(p => p.id === body.id).tracks = body.tracks;
      return {ok:true,json:async () => JSON.parse(JSON.stringify(action === 'state' ? data : result))};
    }
  };
  document = sandbox.document;
  get('compactPlayerHome').append(get('compactPlayer'));
  get('sidebarHome').append(get('appSidebar'));
  if (drawing) { get('audioWave').getContext = () => drawing; get('audioWave').width = 720; get('audioWave').height = 192; }
  get('expandedAppearancePanel').hidden = true;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('web/i18n.js','utf8'),context);
  await sandbox.MusicI18n.initialize();
  for (const [,src] of fs.readFileSync('web/index.html','utf8').matchAll(/data-app-src="\/([^"]+)"/g)) {
    vm.runInContext(fs.readFileSync('web/' + src,'utf8'),context);
    if (src === 'client-session.js') await sandbox.browserSession.ready;
  }
  await new Promise(resolve => setImmediate(resolve));
  const run = expression => vm.runInContext(expression,context);
  return {get,audio,run,calls,local,session,timers,createdElements,timeoutTasks,
    setNarrowPlayer(value) { playerViewport.matches = value; for (const listener of viewportListeners) listener({matches:value}); },
    setReducedMotion(value) { motionPreference.matches = value; for (const listener of motionListeners) listener({matches:value}); },
    advanceTime:ms => { now += ms; },data:() => data};
}

test('initial library includes nested folders and selects the first playlist destination',async () => {
  const c = await client();
  assert.equal(c.get('folderFilter').value,'*');
  assert.equal(c.get('addPlaylist').value,'p');
  assert.equal(c.run('visible.length'),3);
  assert.equal(c.get('nowTitle').textContent,'Choose music');
});

test('queue backdrop closes only for gestures starting and ending outside and preserves playback', async () => {
  const c = await client(); await c.run("playTrack('a',['a','b'])");
  const source = c.audio.src, queue = c.run('JSON.stringify(queueModel.snapshot())');
  const dialog = c.get('queueDialog');
  dialog.getBoundingClientRect = () => ({left:100,top:100,right:400,bottom:500});
  c.get('queueButton').onclick();
  const outside = {target:dialog,pointerId:1,clientX:40,clientY:200};
  const inside = {target:dialog,pointerId:1,clientX:200,clientY:200};
  dialog.onpointerdown(inside); dialog.onpointerup(outside); assert.equal(dialog.open,true);
  dialog.onpointerdown(outside); dialog.onpointerup(inside); assert.equal(dialog.open,true);
  dialog.onpointerdown(outside); dialog.onpointercancel(); dialog.onpointerup(outside); assert.equal(dialog.open,true);
  dialog.onpointerdown(outside); dialog.onpointerup(outside); assert.equal(dialog.open,false);
  assert.equal(c.audio.src,source); assert.equal(c.audio.paused,false);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),queue);
});

test('navigation drawer and queue shortcut preserve the existing playback and DOM controls', async () => {
  const c = await client(); await c.run("playTrack('a',['a','b'])");
  c.audio.currentTime = 41; await new Promise(resolve => setImmediate(resolve));
  const source = c.audio.src, loads = c.audio.loadCalls, listening = c.run('listeningSession');
  const queue = c.run('JSON.stringify(queueModel.snapshot())'), sidebar = c.get('appSidebar');
  const requests = c.calls.length;
  c.get('navigationToggle').onclick();
  assert.equal(c.get('navigationDialog').open,true); assert.equal(sidebar.parentNode,c.get('sidebarSlot'));
  c.get('appMain').scrollTop = 250;
  c.run("showView('settings')");
  assert.equal(c.get('appMain').scrollTop,0);
  assert.equal(c.get('navigationDialog').open,false); assert.equal(sidebar.parentNode,c.get('sidebarHome'));
  c.run("showView('library'); appLayout.openNavigation()");
  c.get('navigationDialog').onclose(); assert.equal(c.get('navigationDialog').open,true);
  c.get('closeNavigation').onclick();
  assert.equal(sidebar.parentNode,c.get('sidebarHome')); assert.equal(c.get('navigationToggle').attributes['aria-expanded'],'false');
  c.get('queueShortcut').onclick(); assert.equal(c.get('queueDialog').open,true);
  assert.equal(c.audio.src,source); assert.equal(c.audio.loadCalls,loads); assert.equal(c.audio.currentTime,41);
  assert.equal(c.audio.paused,false); assert.equal(c.run('listeningSession'),listening);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),queue); assert.equal(c.calls.length,requests);
});

test('collapsed wave starts no audio analysis and collapsing an active wave preserves audible routing', async () => {
  const graph = audioGraph(null);
  const c = await client({drawing:drawingContext(),initialStorage:{libraryWaveOpen:'false',waveMode:'"eco"'},audioContextFactory:function() { return graph.createContext(); }});
  await c.run("playTrack('a',['a','b'])"); c.audio.emit('playing');
  assert.equal(graph.counts.contexts,0); assert.equal(c.run('audioWave.timer'),null);
  c.get('libraryWave').open = true; c.get('libraryWave').ontoggle();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(graph.counts.sources,1); assert.notEqual(c.run('audioWave.timer'),null);
  c.get('libraryWave').open = false; c.get('libraryWave').ontoggle();
  assert.equal(c.run('audioWave.timer'),null); assert.ok(graph.links.has(graph.context.destination));
  assert.equal(graph.links.has(graph.analyser),false); assert.equal(graph.counts.badDisconnects,0);
  assert.equal(c.local.get('libraryWaveOpen'),'false'); assert.equal(c.audio.paused,false);
});

test('table and collection searches follow the selected view and collapsed filters expose active criteria', async () => {
  const c = await client();
  assert.equal(c.get('tableSearchBox').hidden,false); assert.equal(c.get('collectionSearchBox').hidden,true);
  c.get('folderFilter').value = 'Jazz'; c.get('sort').value = 'title'; c.run('renderTracks()');
  assert.equal(c.get('activeFilters').hidden,false); assert.equal(c.get('activeFilters').textContent,'2');
  c.run("setHomeMode('collection')");
  assert.equal(c.get('tableSearchBox').hidden,true); assert.equal(c.get('collectionSearchBox').hidden,false);
  c.run("showView('settings')");
  assert.equal(c.get('collectionSearchBox').hidden,true); assert.equal(c.get('libraryWave').hidden,true);
  assert.equal(c.run('document.documentElement.dataset.home'),'false');
  c.run("showView('library'); setHomeMode('table')");
  assert.equal(c.get('tableSearchBox').hidden,false); assert.equal(c.get('libraryWave').hidden,false);
});

test('search, exact folder filters and numeric/title sorting',async () => {
  const c = await client();
  c.get('folderFilter').value = 'Jazz'; c.get('sort').value = 'size';
  assert.equal(c.run('filteredTracks().map(t => t.id).join()'),'b,c');
  c.get('search').value = 'night';
  assert.equal(c.run('filteredTracks().map(t => t.id).join()'),'c');
  c.get('search').value = ''; c.get('folderFilter').value = '*'; c.get('sort').value = 'title';
  assert.equal(c.run('filteredTracks().map(t => t.id).join()'),'a,b,c');
});

test('reordering a filtered subset preserves the slots of hidden tracks',async () => {
  const c = await client();
  c.get('folderFilter').value = 'Jazz'; c.run('renderTracks()');
  await c.run("reorder('c','b')");
  assert.equal(c.data().tracks.map(t => t.id).join(),'a,c,b');
  assert.equal(c.get('folderFilter').value,'Jazz');
});

test('playlist reorder stays independent from library order',async () => {
  const c = await client(); c.run("showView('library','p')");
  await c.run("reorder('b','c')");
  assert.equal(c.data().playlists[0].tracks.join(),'b,c,a');
  assert.equal(c.data().tracks.map(t => t.id).join(),'a,b,c');
});

test('playback queues are independent between clients and stop at the end',async () => {
  const c = await client(), other = await client();
  await c.run("playTrack('a',['a','b'])");
  assert.equal(c.audio.src,'/media/a');
  assert.equal(c.get('nowTitle').textContent,'Alpha');
  assert.equal(other.run('currentId'),null);
  await c.run('step(1)'); assert.equal(c.audio.src,'/media/b');
  await c.run('step(1,true)'); assert.equal(c.audio.src,'/media/b');
  c.run('repeating = true'); await c.run('step(1,true)'); assert.equal(c.audio.src,'/media/a');
  assert.deepEqual(JSON.parse(c.local.get('player')).queue,['a','b']);
});

test('select all includes filtered records beyond the render limit',async () => {
  const c = await client();
  c.run('limit = 1; renderTracks()');
  c.get('selectAll').onchange({target:{checked:true}});
  assert.equal(c.run('selected.size'),3);
  assert.equal(c.get('selectionCount').textContent,'Selected: 3');
});


test('root folder includes nested files even when root itself is empty', async () => {
  const c = await client();
  c.data().tracks = c.data().tracks.filter(t => t.path.includes('/'));
  await c.run('refresh()');
  c.get('folderFilter').value = '';
  assert.equal(c.run('filteredTracks().length'),2);
});

test('themes are device-local and invalid stored values fall back safely', async () => {
  const c = await client();
  c.run("applyTheme('midnight')");
  assert.equal(c.run('document.documentElement.dataset.theme'),'midnight');
  assert.equal(c.run('document.documentElement.style.colorScheme'),'dark');
  assert.equal(JSON.parse(c.local.get('theme')),'midnight');
  c.run("applyTheme('invalid')");
  assert.equal(c.run('document.documentElement.dataset.theme'),'forest');
});

test('TUI reports track and original playlist even after switching views', async () => {
  const c = await client();
  c.run("showView('library','p')");
  await c.run("playTrack('c',['c','a','b'])");
  c.run("showView('folders')");
  await c.run('reportPlayback()');
  const reports = c.calls.filter(r => r.action === 'playback');
  const last = reports.at(-1).body;
  assert.equal(last.trackId,'c');
  assert.equal(last.playlistId,'p');
  assert.equal(last.queueName,'Mix');
  assert.equal(last.state,'playing');
});

test('missing media is diagnosed as HTTP failure, not a codec error', async () => {
  const c = await client({headStatus:404});
  await c.run("playTrack('a',['a'])");
  await c.run("diagnosePlayback('a',4)");
  assert.match(c.get('playbackError').textContent,/HTTP 404/);
  assert.equal(c.get('playbackError').hidden,false);
  assert.equal(c.run('playbackState'),'error');
});

test('decoder error includes actual path and MIME for troubleshooting', async () => {
  const c = await client();
  await c.run("playTrack('a',['a'])");
  await c.run("diagnosePlayback('a',3)");
  assert.match(c.get('playbackError').textContent,/decoding/);
  assert.match(c.get('playbackError').textContent,/audio\/flac/);
});
const { test: extraTest } = require('node:test');
extraTest('browser autoplay permission is not reported as a codec failure', async () => {
  const c = await client();
  c.audio.play = async () => { throw Object.assign(new Error('blocked'), {name:'NotAllowedError'}); };
  await c.run("playTrack('a',['a'])");
  assert.equal(c.run('playbackState'), 'paused');
  assert.equal(c.get('playbackError').hidden, true);
  assert.equal(c.calls.some(r => r.action.startsWith('/media/')), false);
});


test('legacy saved player upgrades to occurrence queue without autoplay',async () => {
  const c = await client({savedPlayer:{queue:['a','b','c'],currentId:'b',position:20,shuffled:false}});
  assert.equal(c.run('currentId'),'b');
  assert.equal(c.audio.paused,true);
  assert.equal(c.run('queueModel.ordered.length'),3);
  assert.equal(c.run('new Set(queueModel.order).size'),3);
});

test('play-next supports duplicate occurrences without changing saved playlist',async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b'])");
  const original = JSON.stringify(c.data().playlists);
  c.run("enqueue(['a'],true)");
  assert.equal(c.run('queue.join()'),'a,a,b');
  const first = c.run('queueModel.currentEntryId');
  await c.run('step(1)');
  assert.equal(c.run('currentId'),'a');
  assert.notEqual(c.run('queueModel.currentEntryId'),first);
  assert.equal(JSON.stringify(c.data().playlists),original);
  const report = c.calls.filter(call => call.action === 'playback').at(-1).body;
  assert.equal(report.queueEntryId,c.run('queueModel.currentEntryId'));
});

test('remove current while paused loads next without starting audio; clear stops it',async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b'])");
  c.audio.pause();
  await c.run('removeQueueEntry(queueModel.currentEntryId)');
  assert.equal(c.run('currentId'),'b');
  assert.equal(c.audio.paused,true);
  c.get('clearQueue').onclick();
  assert.equal(c.run('currentId'),null);
  assert.equal(c.run('queue.length'),0);
  assert.equal(c.run('playbackState'),'idle');
});

test('queue saves as a new playlist without changing the active queue',async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b','a'])");
  c.run("globalThis.prompt = () => 'Saved queue'");
  await c.get('saveQueue').onclick();
  assert.equal(c.data().playlists.at(-1).name,'Saved queue');
  assert.deepEqual(c.data().playlists.at(-1).tracks,['a','b']);
  assert.equal(c.run('queue.join()'),'a,b,a');
});


test('favorites toggle is shared state and works from table and now-playing without restarting audio',async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b'])");
  const source = c.audio.src;
  await c.run("toggleFavorite('a')");
  assert.equal(c.run("trackMap.get('a').favorite"),true);
  assert.equal(c.get('favoriteCurrent').textContent,'♥');
  c.run("showView('favorites')");
  assert.equal(c.run('visible.map(t => t.id).join()'),'a');
  assert.equal(c.audio.src,source);
  await c.run("toggleFavorite('a')");
  assert.equal(c.run('visible.length'),0);
});

test('recent, frequent and added lists use their proper ranking and disable manual reorder',async () => {
  const c = await client();
  Object.assign(c.data().tracks[0],{play_count:2,last_played:10,added:30});
  Object.assign(c.data().tracks[1],{play_count:1,last_played:20,added:10});
  Object.assign(c.data().tracks[2],{play_count:0,last_played:0,added:20});
  await c.run('refresh()');
  c.get('libraryList').value='recent';
  assert.equal(c.run('filteredTracks().map(t => t.id).join()'),'b,a');
  c.get('libraryList').value='frequent';
  assert.equal(c.run('filteredTracks().map(t => t.id).join()'),'a,b');
  c.get('libraryList').value='added';
  assert.equal(c.run('filteredTracks().map(t => t.id).join()'),'a,c,b');
  assert.equal(c.run('canReorderTracks()'),false);
});

test('audio preloading does not emit listening reports; actual time and pause do',async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b'])");
  assert.equal(c.calls.filter(r => r.action === 'listen').length,0);
  c.audio.onplaying();
  c.advanceTime(30000); c.audio.currentTime=30; c.audio.ontimeupdate();
  c.audio.pause(); await c.run('flushListens()');
  const report = c.calls.filter(r => r.action === 'listen').at(-1).body;
  assert.equal(report.trackId,'a');
  assert.equal(report.listened,30);
  c.advanceTime(30000); c.audio.ontimeupdate(); c.run('reportListening()'); await c.run('flushListens()');
  assert.equal(c.calls.filter(r => r.action === 'listen').length,1);
});

test('offline outbox retries the same event and acknowledges it once',async () => {
  const c = await client({listenFailures:1});
  c.run("queueListen({id:'event',trackId:'a',deviceId:'device',deviceName:'PC',seq:1,listened:31,position:31,duration:100})");
  await c.run('flushListens()');
  assert.equal(c.run('listenPending.size'),1);
  assert.ok(c.local.has('music-listen:event'));
  await c.run('flushListens()');
  assert.equal(c.run('listenPending.size'),0);
  assert.equal(c.local.has('music-listen:event'),false);
  const sent = c.calls.filter(r => r.action === 'listen');
  assert.equal(sent.length,2);
  assert.equal(sent[0].body.id,sent[1].body.id);
  assert.equal(sent[0].body.seq,sent[1].body.seq);
});

test('outbox from a previous page is recovered without creating a new listening event',async () => {
  const body = {id:'recovered',trackId:'a',deviceId:'device',deviceName:'PC',seq:4,listened:31,position:50,duration:100};
  const c = await client({initialStorage:{'music-listen:recovered':JSON.stringify({body,queuedAt:Date.now()})}});
  await c.run('flushListens()');
  assert.equal(c.calls.find(r => r.action === 'listen').body.id,'recovered');
  assert.equal(c.local.has('music-listen:recovered'),false);
});

test('history resume restores position and device filter is sent to server',async () => {
  const c = await client();
  c.data().historyEvents = [{id:'event',trackId:'a',deviceId:'phone',deviceName:'Phone',title:'Alpha',artist:'Zed',started:1,listened:31,position:45,duration:120,ended:false}];
  c.get('historyDevice').value='phone';
  await c.run('loadHistory(true)');
  assert.match(c.calls.at(-1).action,/device=phone/);
  assert.match(c.get('historyEntries').innerHTML,/Resume from 0:45/);
  await c.get('historyEntries').onclick({target:{closest:() => ({dataset:{historyResume:'event'}})}});
  c.audio.emit('loadedmetadata');
  assert.equal(c.audio.currentTime,45);
  assert.equal(c.audio.src,'/media/a');
});

test('device identity survives page reload and its name is editable',async () => {
  const first = await client();
  const stored = first.local.get('device');
  const second = await client({initialStorage:{device:stored}});
  assert.equal(second.run('deviceId'),first.run('deviceId'));
  second.get('deviceName').value='Kitchen';
  await second.get('deviceSettingsForm').onsubmit({preventDefault(){}});
  assert.equal(JSON.parse(second.local.get('device')).name,'Kitchen');
  assert.equal(second.calls.find(r => r.action === 'device').body.name,'Kitchen');
});

test('device and server forms save independently and preserve the other draft and current audio', async () => {
  const c = await client(); await c.run("playTrack('a',['a','b'])"); c.audio.currentTime = 41;
  await new Promise(resolve => setImmediate(resolve));
  const source = c.audio.src, loads = c.audio.loadCalls, queue = c.run('JSON.stringify(queueModel.snapshot())');
  c.get('deviceName').value = 'Unsaved device draft';
  c.get('serverTitle').value = 'Home stereo'; c.get('defaultVolume').value = '.25';
  const first = c.calls.length;
  await c.get('settingsForm').onsubmit({preventDefault(){}});
  assert.equal(c.calls.slice(first).some(call => call.action === 'device'),false);
  assert.equal(c.get('deviceName').value,'Unsaved device draft');
  assert.equal(c.run('state.settings.title'),'Home stereo');
  assert.equal(c.audio.volume,.75);
  c.get('serverTitle').value = 'Unsaved server draft';
  const second = c.calls.length;
  await c.get('deviceSettingsForm').onsubmit({preventDefault(){}});
  assert.equal(c.calls.slice(second).some(call => call.action === 'settings'),false);
  assert.equal(c.get('serverTitle').value,'Unsaved server draft');
  assert.equal(JSON.parse(c.local.get('device')).name,'Unsaved device draft');
  assert.equal(c.get('saveDeviceSettings').disabled,false); assert.equal(c.get('saveServerSettings').disabled,false);
  assert.equal(c.audio.src,source); assert.equal(c.audio.loadCalls,loads); assert.equal(c.audio.currentTime,41);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),queue);
});

test('track action sheet reuses queue commands without replacing the playing entry', async () => {
  const c = await client(); await c.run("playTrack('a',['a','b'])"); c.audio.currentTime = 41;
  const entry = c.run('queueModel.currentEntryId'), source = c.audio.src;
  const trigger = c.get('trackMenuTrigger'); trigger.dataset.trackActions = 'b';
  await c.get('tracks').onclick({target:{closest:() => trigger}});
  assert.equal(c.get('trackActionsDialog').open,true); assert.equal(c.get('trackActionsTitle').textContent,'Beta');
  const button = c.get('trackActionNext');
  await c.get('trackActionsList').onclick({target:{closest:() => button}});
  assert.equal(c.get('trackActionsDialog').open,false);
  assert.equal(c.run('queue.join()'),'a,b,b'); assert.equal(c.run('queueModel.currentEntryId'),entry);
  assert.equal(c.audio.src,source); assert.equal(c.audio.currentTime,41); assert.equal(c.audio.paused,false);
});

test('track actions respect reorder eligibility and keyboard dismissal restores focus', async () => {
  const c = await client(), origin = c.get('trackMenuTrigger');
  c.run("appLayout.openTrackActions('a',document.getElementById('trackMenuTrigger'))");
  assert.equal(c.get('trackActionUp').disabled,true); assert.equal(c.get('trackActionDown').disabled,false);
  c.get('trackActionsDialog').onkeydown({key:'End',preventDefault(){}});
  assert.equal(c.run('document.activeElement.id'),'trackActionEdit');
  c.get('trackActionsDialog').oncancel({preventDefault(){}});
  assert.equal(c.get('trackActionsDialog').open,false); assert.equal(c.run('document.activeElement.id'),origin.id);
  c.get('sort').value = 'title'; c.run("renderTracks(); appLayout.openTrackActions('b',document.getElementById('trackMenuTrigger'))");
  assert.equal(c.get('trackActionUp').disabled,true); assert.equal(c.get('trackActionDown').disabled,true);
  c.get('closeTrackActions').onclick(); assert.equal(c.get('trackActionsDialog').open,false);
  c.run("appLayout.openTrackActions('b',document.getElementById('trackMenuTrigger')); showView('settings')");
  c.get('trackActionsDialog').onclose(); assert.equal(c.run('document.activeElement.id'),'pageTitle');
});

test('track information action opens the existing editor after dismissing the action sheet', async () => {
  const c = await client(); await c.run("playTrack('a',['a','b'])"); c.audio.currentTime = 41;
  c.run("appLayout.openTrackActions('a',document.getElementById('pageTitle'))");
  await c.get('trackActionsList').onclick({target:{closest:() => c.get('trackActionEdit')}});
  assert.equal(c.get('trackActionsDialog').open,false); assert.equal(c.get('editDialog').open,true);
  assert.equal(c.get('editTitle').value,'Alpha'); assert.equal(c.get('editId').value,'a');
  assert.equal(c.audio.currentTime,41); assert.equal(c.audio.src,'/media/a'); assert.equal(c.audio.paused,false);
});


test('home layouts switch during playback without altering source, position, queue or listening session',async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b','a'])");
  c.audio.currentTime=37;
  const source=c.audio.src, queue=c.run('JSON.stringify(queueModel.snapshot())'), entry=c.run('queueModel.currentEntryId');
  const listen=c.run('listeningSession.id'), generation=c.run('playbackGeneration');
  c.run("setHomeMode('collection')");
  assert.equal(c.get('collectionView').hidden,false);
  assert.equal(c.get('libraryView').hidden,true);
  assert.equal(c.get('collectionMode').attributes['aria-pressed'],'true');
  c.run("setHomeMode('table')");
  assert.equal(c.audio.src,source);
  assert.equal(c.audio.currentTime,37);
  assert.equal(c.audio.paused,false);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),queue);
  assert.equal(c.run('queueModel.currentEntryId'),entry);
  assert.equal(c.run('listeningSession.id'),listen);
  assert.equal(c.run('playbackGeneration'),generation);
  assert.equal(c.get('libraryView').hidden,false);
});

test('home preference restores locally and changing it in settings keeps settings open',async () => {
  const c=await client({initialStorage:{homeMode:JSON.stringify('collection')}});
  assert.equal(c.get('collectionView').hidden,false);
  assert.equal(c.run('homeMode'),'collection');
  c.run("showView('settings')");
  c.get('homeModeSetting').onchange({target:{value:'table'}});
  assert.equal(c.get('settingsView').hidden,false);
  assert.equal(c.run('view'),'settings');
  assert.equal(JSON.parse(c.local.get('homeMode')),'table');
});

test('album detail plays in disc/track order and appends without replacing existing playback',async () => {
  const c=await client();
  c.data().tracks.forEach((t,i) => Object.assign(t,{album:'Release',album_artist:'Various',year:'2001',disc_number:i===0 ? 2 : 1,track_number:i===1 ? 2 : 1}));
  await c.run('refresh()');
  c.run("openCollectionPage('album',catalog.albumList()[0].key)");
  assert.match(c.get('collectionContent').innerHTML,/Disc 2/);
  const button={dataset:{collectionPlayAll:''}};
  await c.get('collectionView').onclick({target:{closest:() => button}});
  assert.equal(c.run('queue.join()'),'c,b,a');
  assert.equal(c.run('queueName'),'Release');
  assert.equal(c.audio.src,'/media/c');
  const entry=c.run('queueModel.currentEntryId');
  await c.get('collectionView').onclick({target:{closest:() => ({dataset:{collectionAppendAll:''}})}});
  assert.equal(c.run('queue.join()'),'c,b,a,c,b,a');
  assert.equal(c.run('queueModel.currentEntryId'),entry);
  assert.equal(c.audio.src,'/media/c');
});

test('overview shelves play their own list instead of the whole collection',async () => {
  const c=await client();
  Object.assign(c.data().tracks[1],{play_count:2,last_played:10});
  await c.run('refresh()'); c.run("setHomeMode('collection')");
  const button={dataset:{cplay:'b'},closest:() => ({dataset:{shelf:'recent'}})};
  await c.get('collectionView').onclick({target:{closest:() => button}});
  assert.equal(c.run('queue.join()'),'b');
  assert.match(c.run('queueName'),/Recently/);
});

test('album can open in scoped table; clearing scope and folder navigation restore file management',async () => {
  const c=await client();
  c.run("openCollectionPage('album',catalog.trackAlbums.get('b'))");
  c.run('openCollectionInTable()');
  assert.equal(c.run('homeMode'),'table');
  assert.equal(c.run('visible.map(t => t.id).join()'),'b');
  assert.equal(c.get('tableScopeBar').hidden,false);
  assert.equal(c.run('canReorderTracks()'),false);
  c.get('clearTableScope').onclick();
  assert.equal(c.run('visible.length'),3);
  c.run("setHomeMode('collection'); showView('folders')");
  c.get('folderGrid').onclick({target:{closest:() => ({dataset:{folderIndex:'1'}})}});
  assert.equal(c.get('libraryView').hidden,false);
  assert.equal(c.get('folderFilter').value,'Jazz');
  assert.equal(c.run('visible.map(t => t.id).join()'),'b,c');
});

test('collection pagination and searches use all records without rendering them all',async () => {
  const c=await client();
  c.data().tracks=Array.from({length:100},(_,i) => ({id:'t'+i,path:'f'+i+'.mp3',title:'Track '+i,album:'Album '+i,artist:'Artist',added:i}));
  await c.run('refresh()'); c.run("openCollectionPage('albums')");
  assert.equal((c.get('collectionContent').innerHTML.match(/class="music-card album-card"/g)||[]).length,48);
  assert.equal(c.get('collectionMore').hidden,false);
  c.get('collectionMore').onclick();
  assert.equal((c.get('collectionContent').innerHTML.match(/class="music-card album-card"/g)||[]).length,96);
  c.get('collectionSearch').value='Album 99'; c.get('collectionSearch').oninput();
  assert.equal((c.get('collectionContent').innerHTML.match(/class="music-card album-card"/g)||[]).length,1);
  assert.equal(c.get('collectionMore').hidden,true);
});

test('metadata updates reconcile album navigation without restarting current playback',async () => {
  const c=await client();
  await c.run("playTrack('a',['a','b'])");
  c.run("openCollectionPage('album',catalog.trackAlbums.get('a'))");
  const before=c.run('collectionRoute.key');
  c.data().tracks[0].album='New imported album';
  await c.run('refresh()');
  assert.notEqual(c.run('collectionRoute.key'),before);
  assert.match(c.get('collectionContent').innerHTML,/New imported album/);
  assert.equal(c.audio.src,'/media/a');
  assert.equal(c.audio.paused,false);
});

test('unknown artist pages and untrusted metadata render safely',async () => {
  const c=await client();
  c.data().tracks[0].artist=''; c.data().tracks[0].album='<img src=x onerror=alert(1)>';
  await c.run('refresh()');
  c.run("openCollectionPage('artist','')");
  assert.match(c.get('collectionContent').innerHTML,/Unknown artist/);
  assert.match(c.get('collectionContent').innerHTML,/&lt;img/);
  assert.doesNotMatch(c.get('collectionContent').innerHTML,/<img src=x/);
});

test('playlists remain editable in the table without resetting preferred home layout',async () => {
  const c=await client(); c.run("setHomeMode('collection'); showView('library','p')");
  assert.equal(c.get('libraryView').hidden,false);
  assert.equal(c.get('tableMode').attributes['aria-pressed'],'true');
  assert.equal(c.run('homeMode'),'collection');
  c.run("showView('library')");
  assert.equal(c.get('collectionView').hidden,false);
});
test('artist compilation albums remain searchable and paginated by contributing artist',async () => {
  const c=await client();
  c.data().tracks=Array.from({length:60},(_,i) => ({id:'t'+i,path:'f'+i+'.mp3',title:'Track '+i,album:'Album '+i,artist:'Singer',album_artist:'Various'}));
  await c.run('refresh()'); c.get('collectionSearch').value='Singer';
  c.run("openCollectionPage('artist-albums','singer')");
  assert.equal((c.get('collectionContent').innerHTML.match(/class="music-card album-card"/g)||[]).length,48);
  assert.equal(c.get('collectionMore').hidden,false);
  c.get('collectionMore').onclick();
  assert.equal((c.get('collectionContent').innerHTML.match(/class="music-card album-card"/g)||[]).length,60);
});
test('font and icon size default to current minimum and restore independent browser preferences',async () => {
  const c=await client();
  assert.equal(c.run('document.documentElement.dataset.fontSize'),'small');
  assert.equal(c.run('document.documentElement.dataset.iconSize'),'small');
  c.get('fontSizeSetting').onchange({target:{value:'xlarge'}});
  c.get('iconSizeSetting').onchange({target:{value:'medium'}});
  const restored=await client({initialStorage:Object.fromEntries(c.local)});
  assert.equal(restored.get('fontSizeSetting').value,'xlarge');
  assert.equal(restored.get('iconSizeSetting').value,'medium');
  assert.equal(restored.run('document.documentElement.dataset.fontSize'),'xlarge');
  assert.equal(restored.run('document.documentElement.dataset.iconSize'),'medium');
});

test('all 16 font/icon combinations apply without touching playback, queue or server settings',async () => {
  const c=await client();
  await c.run("playTrack('a',['a','b','a'])");
  c.audio.currentTime=29;
  const before={source:c.audio.src,queue:c.run('JSON.stringify(queueModel.snapshot())'),listen:c.run('listeningSession.id'),generation:c.run('playbackGeneration')};
  for (const font of ['small','medium','large','xlarge']) for (const icon of ['small','medium','large','xlarge']) {
    c.get('fontSizeSetting').onchange({target:{value:font}});
    c.get('iconSizeSetting').onchange({target:{value:icon}});
    assert.equal(c.run('document.documentElement.dataset.fontSize'),font);
    assert.equal(c.run('document.documentElement.dataset.iconSize'),icon);
    assert.equal(JSON.parse(c.local.get('fontSize')),font);
    assert.equal(JSON.parse(c.local.get('iconSize')),icon);
    assert.equal(c.audio.src,before.source);
    assert.equal(c.audio.currentTime,29);
    assert.equal(c.audio.paused,false);
    assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),before.queue);
    assert.equal(c.run('listeningSession.id'),before.listen);
    assert.equal(c.run('playbackGeneration'),before.generation);
  }
  assert.equal(c.calls.filter(call => call.action === 'settings').length,0);
});

test('invalid size preferences fall back to minimum and remain separate from theme/home mode',async () => {
  const c=await client({initialStorage:{fontSize:JSON.stringify('invalid'),iconSize:JSON.stringify(200)}});
  assert.equal(c.get('fontSizeSetting').value,'small');
  assert.equal(c.get('iconSizeSetting').value,'small');
  c.run("applyInterfaceSize('font','large'); applyInterfaceSize('icon','xlarge'); applyTheme('midnight'); setHomeMode('collection')");
  assert.equal(c.run('document.documentElement.dataset.fontSize'),'large');
  assert.equal(c.run('document.documentElement.dataset.iconSize'),'xlarge');
});

test('wave preferences and quick toggle are local and preserve active playback',async () => {
  const c=await client(); await c.run("playTrack('a',['a','b'])"); c.audio.currentTime=37;
  const session=c.run('listeningSession.id'), queue=c.run('JSON.stringify(queueModel.snapshot())');
  c.get('waveModeSetting').onchange({target:{value:'high'}});
  assert.equal(c.get('waveToggle').attributes['aria-pressed'],'true');
  c.get('waveToggle').onclick(); assert.equal(c.get('waveModeSetting').value,'off');
  c.get('waveToggle').onclick(); assert.equal(c.get('waveModeSetting').value,'high');
  c.run("setHomeMode('collection'); showView('settings')"); assert.equal(c.get('wavePanel').hidden,true);
  c.run("showView('library')"); assert.equal(c.get('wavePanel').hidden,false);
  assert.equal(c.audio.currentTime,37); assert.equal(c.audio.src,'/media/a'); assert.equal(c.audio.paused,false);
  assert.equal(c.run('listeningSession.id'),session); assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),queue);
  const restored=await client({initialStorage:Object.fromEntries(c.local)});
  assert.equal(restored.get('waveModeSetting').value,'high');
  const independent=await client(); assert.equal(independent.get('waveModeSetting').value,'off');
});


test('remote controls address only the selected browser and require its acknowledgement',async () => {
  const commands=new Map();
  const transport=(action,body)=>{
    if(action==='control') { commands.set(body.id,{...body,state:'pending'}); return commands.get(body.id); }
    if(action==='control-poll') return {command:[...commands.values()].find(c=>c.target===body.clientId && c.state==='pending')};
    if(action==='control-ack') { const c=commands.get(body.id); c.state=body.ok?'done':'failed'; return c; }
    if(action==='control-result') return commands.get(body.id);
  };
  const controller=await client({controlTransport:transport}), target=await client({controlTransport:transport});
  await controller.run("playTrack('a',['a','b'])"); await target.run("playTrack('b',['b','c'])");
  const targetId=target.run('clientId');
  await controller.run(`sendDeviceCommand('pause',null,${JSON.stringify(targetId)})`);
  assert.equal(target.audio.paused,false); assert.match(controller.get('deviceCommandStatus').textContent,/Waiting/);
  await controller.run('pollPlayerCommands()'); assert.equal(controller.audio.paused,false);
  await target.run('pollPlayerCommands()'); assert.equal(target.audio.paused,true); assert.equal(controller.audio.paused,false);
  await controller.run('refreshCommandResult()'); assert.match(controller.get('deviceCommandStatus').textContent,/confirmed/);
});

test('redelivered next command after lost ack executes once',async () => {
  let acknowledgements=0;
  const c=await client({controlTransport:(action,body)=>{
    if(action==='control-poll')return {command:{id:'same-command',action:'next'}};
    if(action==='control-ack') { acknowledgements++; if(acknowledgements===1)throw Error('offline'); return {}; }
  }});
  await c.run("playTrack('a',['a','b','c'])");
  await c.run('pollPlayerCommands()'); assert.equal(c.run('currentId'),'b');
  await c.run('pollPlayerCommands()'); assert.equal(c.run('currentId'),'b'); assert.equal(acknowledgements,2);
});

test('five page reloads keep one player identity and increasing report sequence numbers', async () => {
  let local = {}, session = {}, id, previousSeq = 0;
  for (let reload = 0; reload < 6; reload++) {
    const c = await client({initialStorage:local,initialSessionStorage:session});
    await c.run('reportPlayback()');
    id ||= c.run('clientId');
    assert.equal(c.run('clientId'), id);
    const reports = c.calls.filter(call => call.action === 'playback');
    for (const report of reports) {
      assert.equal(report.body.clientId, id);
      assert.ok(report.body.seq > previousSeq);
      previousSeq = report.body.seq;
    }
    local = Object.fromEntries(c.local);
    session = Object.fromEntries(c.session);
  }
  const anotherTab = await client({initialStorage:local});
  assert.notEqual(anotherTab.run('clientId'), id);
});

test('lost next acknowledgement is retried after reload without advancing again', async () => {
  let acknowledgements = 0;
  const transport = action => {
    if (action === 'control-poll') return {command:{id:'reload-command',action:'next'}};
    if (action === 'control-ack') { if (++acknowledgements === 1) throw Error('offline'); return {}; }
  };
  const first = await client({controlTransport:transport});
  await first.run("playTrack('a',['a','b','c'])");
  await first.run('pollPlayerCommands()');
  assert.equal(first.run('currentId'), 'b');
  const second = await client({controlTransport:transport,
    initialStorage:Object.fromEntries(first.local),initialSessionStorage:Object.fromEntries(first.session)});
  assert.equal(second.run('clientId'), first.run('clientId'));
  await second.run('pollPlayerCommands()');
  assert.equal(second.run('currentId'), 'b');
  assert.equal(acknowledgements, 2);
});

test('transfer pause from the previous page cannot stop playback after a reload', async () => {
  const first = await client();
  await first.run("playTrack('a',['a','b'])");
  const snapshot = await first.run("executePlayerCommand({action:'export'})");
  const second = await client({initialStorage:Object.fromEntries(first.local),initialSessionStorage:Object.fromEntries(first.session)});
  await second.audio.play();
  await assert.rejects(second.run(`executePlayerCommand({action:'pause',value:{guard:${JSON.stringify(snapshot.snapshot.guard)}}})`), /source track changed/);
  assert.equal(second.audio.paused, false);
});

test('transfer snapshot preserves duplicate occurrences, shuffle history and position with local volume',async () => {
  const source=await client(), target=await client();
  await source.run("playTrack('a',['a','b','a'])"); await source.run('step(1)');
  source.run('shuffled=true; queueModel.setShuffle(true)');
  source.audio.currentTime=29;
  const result=await source.run("executePlayerCommand({action:'export'})");
  target.audio.readyState=1; target.audio.volume=.2;
  await target.run(`executePlayerCommand({action:'import',value:${JSON.stringify(result.snapshot)}})`);
  assert.equal(target.audio.currentTime,29); assert.equal(target.audio.paused,false); assert.equal(target.audio.volume,.2);
  assert.equal(target.run('JSON.stringify(queueModel.snapshot())'),source.run('JSON.stringify(queueModel.snapshot())'));
  assert.equal(source.audio.paused,false);
  await source.run(`executePlayerCommand({action:'pause',value:{guard:${JSON.stringify(result.snapshot.guard)}}})`);
  assert.equal(source.audio.paused,true);
});

test('failed transfer restores destination queue and leaves source playing',async () => {
  const source=await client(), target=await client();
  await source.run("playTrack('a',['a','a'])"); source.audio.currentTime=31;
  await target.run("playTrack('b',['b','c'])"); target.audio.currentTime=12; target.audio.readyState=1;
  const before=target.run('JSON.stringify(queueModel.snapshot())');
  const {snapshot}=await source.run("executePlayerCommand({action:'export'})");
  target.audio.play=async()=>{const e=Error('blocked');e.name='NotAllowedError';throw e;};
  await assert.rejects(target.run(`executePlayerCommand({action:'import',value:${JSON.stringify(snapshot)}})`),/The browser blocked/);
  assert.equal(target.run('JSON.stringify(queueModel.snapshot())'),before);
  assert.equal(target.audio.src,'/media/b'); assert.equal(source.audio.paused,false);
});

test('source changed during transfer refuses delayed pause; invalid snapshots preserve destination',async () => {
  const c=await client(); await c.run("playTrack('a',['a','b'])");
  const {snapshot}=await c.run("executePlayerCommand({action:'export'})");
  await c.run('step(1)');
  await assert.rejects(c.run(`executePlayerCommand({action:'pause',value:{guard:${JSON.stringify(snapshot.guard)}}})`),/track changed/);
  assert.equal(c.audio.paused,false); assert.equal(c.audio.src,'/media/b');
  snapshot.queueModel.entries[0].trackId='missing';
  await assert.rejects(c.run(`executePlayerCommand({action:'import',value:${JSON.stringify(snapshot)}})`),/Some queue tracks/);
  assert.equal(c.audio.src,'/media/b');
});

test('remote seek and volume preserve listening accounting and local queue',async () => {
  const c=await client(); await c.run("playTrack('a',['a','b'])");
  const queue=c.run('JSON.stringify(queueModel.snapshot())');
  await c.run("executePlayerCommand({action:'seek',value:30})");
  await c.run("executePlayerCommand({action:'volume',value:.25})");
  assert.equal(c.audio.currentTime,30); assert.equal(c.audio.volume,.25);
  assert.equal(JSON.parse(c.local.get('volume')),.25); assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),queue);
});


test('paused transfers load the selected track without autoplay',async () => {
  const source=await client(), target=await client();
  await source.run("playTrack('c',['a','c','c'])"); source.audio.currentTime=19; source.audio.pause();
  const {snapshot}=await source.run("executePlayerCommand({action:'export'})");
  target.audio.readyState=1;
  await target.run(`executePlayerCommand({action:'import',value:${JSON.stringify(snapshot)}})`);
  assert.equal(target.audio.paused,true); assert.equal(target.audio.currentTime,19); assert.equal(target.audio.src,'/media/c');
});


test('previous button and remote previous can go before a clicked middle track',async () => {
  const c=await client();await c.run("playTrack('b',['a','b','c'])");
  await c.get('next').onclick();assert.equal(c.run('currentId'),'c');
  await c.get('previous').onclick();assert.equal(c.run('currentId'),'b');
  await c.run("executePlayerCommand({action:'previous'})");assert.equal(c.run('currentId'),'a');
  await c.get('next').onclick();assert.equal(c.run('currentId'),'b');
});


function healthResponse(category='missing',offset=0) {
  return {jobId:'audit',state:'done',phase:'finished',mode:'quick',started:10,total:1,checked:1,hashTotal:0,hashed:0,bytesRead:0,
    counts:{missing:0,problems:0,metadata:0,exact:0,similar:0},exactGroups:0,similarGroups:0,
    category,offset,items:[],categoryTotal:0};
}

test('health checks and report navigation preserve playback and do not scan/delete the catalog',async () => {
  const c=await client({healthTransport:(action)=>{
    const query=new URLSearchParams(action.split('?')[1]||'');return healthResponse(query.get('category')||'missing',Number(query.get('offset')||0));
  }});
  await c.run("playTrack('b',['a','b','b'])");c.audio.currentTime=24;
  const before=c.run('JSON.stringify(queueModel.snapshot())');
  c.run("showView('health')");await c.run('loadHealth(0)');
  assert.equal(c.get('healthView').hidden,false);assert.equal(c.get('wavePanel').hidden,true);
  await c.get('healthQuick').onclick();await c.get('refresh').onclick();
  assert.equal(c.audio.src,'/media/b');assert.equal(c.audio.currentTime,24);assert.equal(c.audio.paused,false);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),before);
  assert.equal(c.calls.some(call=>['scan','delete','move'].includes(call.action)),false);
  assert.equal(c.calls.find(call=>call.action==='health-start').body.mode,'quick');
});

test('health rendering escapes file metadata and distinguishes quick mode from exact verification',async () => {
  const c=await client({healthTransport:action=>{
    const category=new URLSearchParams(action.split('?')[1]).get('category');
    const result=healthResponse(category);
    if(category==='problems') { result.items=[{id:'a',title:'<img onerror=bad>',artist:'<b>Artist</b>',path:'<evil>.mp3',reason:'<script>bad</script>'}];result.categoryTotal=1; }
    return result;
  }});
  c.get('healthCategory').value='problems';await c.run('loadHealth(0)');
  assert.match(c.get('healthResults').innerHTML,/&lt;img/);assert.doesNotMatch(c.get('healthResults').innerHTML,/<script>/);
  c.get('healthCategory').value='exact';await c.run('loadHealth(0)');
  assert.match(c.get('healthEmpty').textContent,/Find duplicates/);
});

test('health pages and cancellation use the current report identifier',async () => {
  let cancelled=null;
  const c=await client({healthTransport:(action,body)=>{
    if(action==='health-cancel')cancelled=body.jobId;
    const query=new URLSearchParams(action.split('?')[1]||'');
    const result=healthResponse(query.get('category')||'missing',Number(query.get('offset')||0));
    result.state='running';result.categoryTotal=105;
    result.items=Array.from({length:Math.min(50,105-result.offset)},(_,i)=>({id:'a',path:`file${result.offset+i}.mp3`,title:'Song',reason:'missing'}));
    return result;
  }});
  await c.run('loadHealth(0)');assert.equal(c.get('healthQuick').disabled,true);
  await c.get('healthNext').onclick();assert.equal(c.run('healthOffset'),50);assert.equal(c.get('healthPrevious').disabled,false);
  await c.get('healthNext').onclick();assert.equal(c.run('healthOffset'),100);assert.equal(c.get('healthNext').disabled,true);
  await c.get('healthCancel').onclick();assert.equal(cancelled,'audit');
});

test('a newer health request prevents stale response from replacing another category',async () => {
  let release;
  const c=await client({healthTransport:async action=>{
    const category=new URLSearchParams(action.split('?')[1]).get('category');
    if(category==='missing')await new Promise(resolve=>release=resolve);
    return healthResponse(category);
  }});
  const first=c.run('loadHealth(0)');
  c.get('healthCategory').value='similar';await c.run('loadHealth(0)');
  release();await first;
  assert.equal(c.run('healthReport.category'),'similar');
});


function operationPage(items=[],offset=0,total=items.length) { return {items,offset,total,recovery:false}; }

test('operation response exposes quick undo and undo keeps audio, queue and listening session',async () => {
  let undone=null;
  const c=await client({operationTransport:(action,body)=>{
    if(action==='metadata')return {ok:true,operationId:'edit-id'};
    if(action==='undo'){undone=body.id;return {ok:true,state:'undone'};}
    return operationPage();
  }});
  await c.run("playTrack('a',['a','b','a'])");c.audio.currentTime=23;
  const queue=c.run('JSON.stringify(queueModel.snapshot())'), session=c.run('listeningSession.id');
  await c.run("api('metadata',{id:'a',title:'Edit'})");
  assert.equal(c.get('undoNotice').hidden,false);
  await c.get('undoLast').onclick();
  assert.equal(undone,'edit-id');assert.equal(c.get('undoNotice').hidden,true);
  assert.equal(c.audio.src,'/media/a');assert.equal(c.audio.currentTime,23);assert.equal(c.audio.paused,false);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),queue);assert.equal(c.run('listeningSession.id'),session);
});

test('journal navigation renders untrusted values safely and does not scan files',async () => {
  const item={id:'operation',label:'<img src=x>',state:'done',created:1,canUndo:true,details:['<script>bad</script>'],error:''};
  const c=await client({operationTransport:()=>operationPage([item])});
  c.run("showView('operations')");await c.run('loadOperations(0)');
  assert.equal(c.get('operationsView').hidden,false);assert.equal(c.get('wavePanel').hidden,true);
  assert.match(c.get('operationsList').innerHTML,/&lt;img/);assert.doesNotMatch(c.get('operationsList').innerHTML,/<script>/);
  await c.get('refresh').onclick();assert.equal(c.calls.some(call=>call.action==='scan'),false);
});

test('undo conflicts keep quick action available and show the server reason',async () => {
  const c=await client({operationTransport:(action)=>{
    if(action==='undo')throw Error('The playlist was changed later');
    return operationPage();
  }});
  c.run("rememberOperation('old-operation')");await c.get('undoLast').onclick();
  assert.equal(c.get('undoNotice').hidden,false);assert.equal(c.get('undoLast').disabled,false);
  assert.equal(c.get('toast').textContent,'The playlist was changed later');
});

test('journal recovery targets a specific operation and refreshes catalog without scanning',async () => {
  let recovered;
  const c=await client({operationTransport:(action,body)=>{
    if(action==='operation-recover'){recovered=body.id;return {ok:true};}
    return operationPage();
  }});
  await c.run("recoverOperation('interrupted-operation')");
  assert.equal(recovered,'interrupted-operation');assert.equal(c.calls.some(call=>call.action==='scan'),false);
});

test('switching language preserves playback, queue, position, selection, and form edits', async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b','c'])");
  c.audio.currentTime = 42;
  c.get('serverTitle').value = 'Unsaved server title';
  c.get('deviceName').value = 'Unsaved device name';
  c.run("selected.add('b')");
  const snapshot = c.run('JSON.stringify(queueModel.snapshot())');
  const generation = c.run('playbackGeneration');
  await c.run("MusicI18n.setLanguage('ru')");
  const ru = JSON.parse(fs.readFileSync('web/locales/ru.json', 'utf8'));
  assert.equal(c.get('pageTitle').textContent, ru['Your library']);
  assert.equal(c.get('waveToggle').textContent, ru['Enable wave']);
  assert.equal(c.get('nowTitle').textContent, 'Alpha');
  assert.equal(c.get('serverTitle').value, 'Unsaved server title');
  assert.equal(c.get('deviceName').value, 'Unsaved device name');
  assert.equal(c.audio.paused, false);
  assert.equal(c.audio.currentTime, 42);
  assert.equal(c.run('playbackGeneration'), generation);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'), snapshot);
  assert.equal(c.run("selected.has('b')"), true);
  assert.equal(JSON.parse(c.local.get('language')), 'ru');
  await c.run("MusicI18n.setLanguage('en')");
  assert.equal(c.get('pageTitle').textContent, 'Your library');
  assert.equal(c.audio.currentTime, 42);
  const restored = await client({initialStorage:{language:c.local.get('language')}});
  assert.equal(restored.run('MusicI18n.language'), 'en');
});

test('saved Russian language is available before the first application render', async () => {
  const c = await client({initialStorage:{language:JSON.stringify('ru')}});
  const ru = JSON.parse(fs.readFileSync('web/locales/ru.json', 'utf8'));
  assert.equal(c.get('pageTitle').textContent, ru['Your library']);
  assert.equal(c.get('nowArtist').textContent, ru['Your collection is waiting']);
});

test('expanded player reuses controls and preserves audio, queue and listening across all modes', async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b','a'])");
  c.audio.currentTime = 37; c.audio.volume = .4;
  const original = c.get('compactPlayer'), toggle = c.get('togglePlay').onclick;
  const snapshot = c.run('JSON.stringify(queueModel.snapshot())');
  const listening = c.run('listeningSession');
  const source = c.audio.src, loads = c.audio.loadCalls, generation = c.run('playbackGeneration');
  const requests = c.calls.length, timers = {...c.timers};
  for (const mode of ['album','effects','cd','album']) {
    await c.get('expandPlayer').onclick();
    c.run(`expandedPlayer.setMode(${JSON.stringify(mode)})`);
    assert.equal(c.get('expandedPlayerDialog').open, true);
    assert.equal(original.parentNode, c.get('expandedPlayerControls'));
    assert.equal(c.get('expandedTrackTitle').textContent, 'Alpha');
    assert.equal(c.get('expandedTrackAlbum').textContent, 'Night');
    c.run('expandedPlayer.close(true)');
    assert.equal(original.parentNode, c.get('compactPlayerHome'));
  }
  assert.equal(c.audio.paused, false); assert.equal(c.audio.currentTime, 37); assert.equal(c.audio.volume, .4);
  assert.equal(c.audio.src, source); assert.equal(c.audio.loadCalls, loads);
  assert.equal(c.run('playbackGeneration'), generation);
  assert.equal(c.run('listeningSession'), listening);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'), snapshot);
  assert.equal(c.get('togglePlay').onclick, toggle);
  assert.equal(c.calls.length, requests);
  assert.deepEqual(c.timers, timers);
});

test('expanded controls, remote commands and queue dialog keep working on the same player', async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b','c'])");
  c.run('expandedPlayer.open()');
  await c.get('togglePlay').onclick(); assert.equal(c.audio.paused, true);
  await c.get('togglePlay').onclick(); assert.equal(c.audio.paused, false);
  await c.run("executePlayerCommand({action:'next'})");
  assert.equal(c.get('expandedTrackTitle').textContent, 'Beta');
  c.get('seek').value = 50; c.get('seek').oninput(); assert.equal(c.audio.currentTime, 60);
  c.get('volume').value = .25; c.get('volume').oninput(); assert.equal(c.audio.volume, .25);
  c.get('queueButton').onclick(); assert.equal(c.get('queueDialog').open, true);
  assert.equal(c.run('expandedPlayer.isOpen'), true);
  c.get('queueDialog').close();
  c.run('expandedPlayer.close(true)');
  assert.equal(c.run('currentId'), 'b'); assert.equal(c.audio.paused, false);
});

test('shared appearance panel hosts current view controls without changing the audible graph or player', async () => {
  const graph = audioGraph(null);
  const c = await client({drawing:drawingContext(),audioContextFactory:function() { return graph.createContext(); }});
  await c.run("playTrack('a',['a','b'])"); c.audio.emit('playing'); c.audio.currentTime = 41;
  c.run("expandedPlayer.open(); expandedPlayer.setMode('effects')");
  await new Promise(resolve => setImmediate(resolve));
  const controls = c.createdElements.find(element => element.className === 'effects-controls');
  assert.equal(controls.parentNode,c.get('expandedSceneSettings'));
  assert.equal(c.get('expandedSceneSettingsSection').hidden,false);
  const source = c.audio.src, loads = c.audio.loadCalls, queue = c.run('JSON.stringify(queueModel.snapshot())');
  const listening = c.run('listeningSession'), requests = c.calls.length;
  for (let i = 0; i < 3; i++) {
    c.get('expandedAppearanceToggle').onclick();
    assert.equal(c.run('document.activeElement'),controls.nodes[0].nodes[1]);
    c.get('closeExpandedAppearance').onclick();
    assert.equal(controls.parentNode,c.get('expandedSceneSettings'));
    assert.equal(graph.counts.sources,1); assert.ok(graph.links.has(graph.context.destination));
  }
  c.run('expandedPlayer.setSettingsOpen(true)'); c.get('expandedAppearancePanel').scrollTop = 200;
  c.run("expandedPlayer.setMode('cd')");
  const cdControls = c.createdElements.find(element => element.className === 'cd-controls');
  assert.equal(cdControls.parentNode,c.get('expandedSceneSettings')); assert.equal(controls.parentNode,null);
  assert.equal(c.get('expandedAppearancePanel').hidden,false);
  assert.equal(c.get('expandedAppearancePanel').scrollTop,0);
  assert.equal(c.get('expandedSceneSettingsTitle').textContent,'CD controls');
  c.run("expandedPlayer.setMode('album')");
  assert.equal(c.get('expandedSceneSettingsSection').hidden,true); assert.equal(cdControls.parentNode,null);
  assert.equal(c.get('expandedSceneSettings').nodes.length,0);
  c.run('expandedPlayer.close(true)');
  assert.equal(c.audio.src,source); assert.equal(c.audio.loadCalls,loads); assert.equal(c.audio.currentTime,41);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),queue); assert.equal(c.run('listeningSession'),listening);
  assert.equal(c.calls.length,requests); assert.equal(graph.counts.contexts,1); assert.equal(graph.counts.badDisconnects,0);
});

test('mobile appearance overlay leaves transport available and Escape closes the panel before the player', async () => {
  const c = await client({narrowPlayer:true});
  c.run('playerAppearance.set({animation:false}); expandedPlayer.open(); expandedPlayer.setSettingsOpen(true)');
  assert.equal(c.get('expandedSettingsBackdrop').hidden,false); assert.equal(c.get('expandedPlayerStage').inert,true);
  assert.notEqual(c.get('compactPlayer').inert,true);
  c.setNarrowPlayer(false);
  assert.equal(c.get('expandedPlayerStage').inert,false); assert.equal(c.get('expandedSettingsBackdrop').hidden,true);
  c.setNarrowPlayer(true);
  c.get('expandedPlayerDialog').oncancel({preventDefault(){}});
  assert.equal(c.run('expandedPlayer.isOpen'),true); assert.equal(c.get('expandedAppearancePanel').hidden,true);
  assert.equal(c.run('document.activeElement.id'),'expandedAppearanceToggle');
  c.get('expandedAppearanceToggle').onclick(); c.get('expandedSettingsBackdrop').onclick();
  assert.equal(c.get('expandedPlayerStage').inert,false);
  c.get('expandedPlayerDialog').oncancel({preventDefault(){}});
  assert.equal(c.run('expandedPlayer.isOpen'),false);
  assert.equal(c.get('expandedSettingsBackdrop').hidden,true);
});

test('expanded player keyboard navigation persists mode and restores focus after collapse', async () => {
  const c = await client();
  c.run('expandedPlayer.open()');
  assert.equal(c.run('document.activeElement.id'), 'collapsePlayer');
  let prevented = false;
  c.get('expandedPlayerTabs').onkeydown({key:'ArrowLeft',target:c.get('expandedTab-album'),preventDefault() { prevented = true; }});
  assert.equal(prevented, true); assert.equal(c.run('expandedPlayer.mode'), 'cd');
  assert.equal(c.run('document.activeElement.id'), 'expandedTab-cd');
  assert.equal(c.get('expandedTab-cd').attributes['aria-selected'], 'true');
  assert.equal(c.get('expandedTab-album').tabIndex, -1);
  c.get('expandedPlayerTabs').onkeydown({key:'Home',target:c.get('expandedTab-cd'),preventDefault(){}});
  assert.equal(c.run('expandedPlayer.mode'), 'album');
  c.get('expandedTab-effects').onclick();
  c.get('collapsePlayer').onclick();
  assert.equal(c.get('expandedPlayerDialog').open, true);
  c.get('expandedPlayerDialog').ontransitionend({target:c.get('expandedPlayerDialog'),propertyName:'transform'});
  assert.equal(c.get('expandedPlayerDialog').open, false);
  assert.equal(c.run('document.activeElement.id'), 'expandPlayer');
  assert.equal(c.get('expandPlayer').attributes['aria-expanded'], 'false');
  const restored = await client({initialStorage:Object.fromEntries(c.local)});
  assert.equal(restored.run('expandedPlayer.mode'), 'effects');
  assert.equal(restored.run('expandedPlayer.isOpen'), false);
  const invalid = await client({initialStorage:{expandedPlayerMode:JSON.stringify('missing')}});
  assert.equal(invalid.run('expandedPlayer.mode'), 'album');
});

test('reduced motion collapses immediately and ordinary clicks do not dismiss the player', async () => {
  const c = await client({reducedMotion:true});
  c.run('expandedPlayer.open()');
  assert.equal(c.get('expandedPlayerDialog').onclick, undefined);
  let prevented = false;
  c.get('expandedPlayerDialog').oncancel({preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  assert.equal(c.get('expandedPlayerDialog').open, false);
  assert.equal(c.get('compactPlayer').parentNode, c.get('compactPlayerHome'));
});

test('expanded view localizes live and preserves all existing themes', async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b'])");
  c.run("expandedPlayer.open(); expandedPlayer.setMode('effects')");
  const source = c.audio.src;
  for (const theme of ['forest','midnight','sand']) {
    c.run(`applyTheme(${JSON.stringify(theme)})`);
    await c.run("MusicI18n.setLanguage('ru')");
    const ru = JSON.parse(fs.readFileSync('web/locales/ru.json','utf8'));
    assert.equal(c.createdElements.filter(element => element.className === 'effects-enable')[0].nodes[1].textContent,ru['Enable visualization']);
    assert.equal(c.run('document.documentElement.dataset.theme'), theme);
    await c.run("MusicI18n.setLanguage('en')");
    assert.equal(c.createdElements.filter(element => element.className === 'effects-enable')[0].nodes[1].textContent,'Enable visualization');
  }
  assert.equal(c.audio.src, source); assert.equal(c.audio.paused, false);
  c.run('expandedPlayer.close(true)');
});

test('visual failures are isolated and view subscriptions stop after collapse', async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b'])");
  c.run(`globalThis.viewUpdates = 0; globalThis.viewDisposed = 0; console.error = () => {};
    playerViews.register('effects', () => ({mount(){},setActive(){},
      update(){ viewUpdates++; throw Error('Broken view'); },dispose(){ viewDisposed++; }}));
    expandedPlayer.open(); expandedPlayer.setMode('effects');`);
  assert.equal(c.get('expandedPlayerStage').textContent, 'This view is unavailable. Playback will continue.');
  assert.equal(c.audio.paused, false); assert.equal(c.run('viewDisposed'), 1);
  await c.run('playbackBridge.commands.next()');
  assert.equal(c.get('expandedTrackTitle').textContent, 'Beta');
  c.run("expandedPlayer.setMode('album'); expandedPlayer.close(true)");
  const title = c.get('expandedTrackTitle').textContent;
  await c.run('playbackBridge.commands.previous()');
  assert.equal(c.get('expandedTrackTitle').textContent, title);
  assert.equal(c.audio.paused, false);
  assert.equal(c.run('viewUpdates'), 1);
});

test('reopening during collapse and delayed native close events do not detach active controls', async () => {
  const c = await client();
  c.run('expandedPlayer.open(); expandedPlayer.close(); expandedPlayer.open()');
  c.get('expandedPlayerDialog').ontransitionend({target:c.get('expandedPlayerDialog'),propertyName:'transform'});
  assert.equal(c.run('expandedPlayer.isOpen'), true);
  c.run('expandedPlayer.close(true); expandedPlayer.open()');
  c.get('expandedPlayerDialog').onclose();
  assert.equal(c.run('expandedPlayer.isOpen'), true);
  assert.equal(c.get('compactPlayer').parentNode, c.get('expandedPlayerControls'));
  c.run('expandedPlayer.close(true)');
});

test('album artwork follows metadata and remote track changes without additional audio loads', async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b'])");
  c.audio.currentTime = 29;
  c.run('expandedPlayer.open()');
  assert.equal(c.createdElements.filter(element => element.tagName === 'IMG').length, 0);
  const source = c.audio.src, loads = c.audio.loadCalls, listening = c.run('listeningSession');
  c.data().tracks[0].cover_id = 'a'.repeat(64);
  c.data().tracks[1].cover_id = 'b'.repeat(64);
  await c.run('refresh()');
  const first = c.createdElements.find(element => element.tagName === 'IMG');
  assert.equal(first.src, '/covers/' + 'a'.repeat(64) + '.jpg');
  first.naturalWidth = 500; first.naturalHeight = 400; first.onload();
  for (let i = 0; i < 5; i++) c.audio.emit('timeupdate');
  assert.equal(c.createdElements.filter(element => element.tagName === 'IMG').length, 1);
  assert.equal(c.audio.src, source); assert.equal(c.audio.loadCalls, loads);
  assert.equal(c.audio.currentTime, 29); assert.equal(c.run('listeningSession'), listening);
  await c.run("MusicI18n.setLanguage('ru')");
  const ru = JSON.parse(fs.readFileSync('web/locales/ru.json','utf8'));
  assert.equal(first.alt, ru['Album artwork: {album}'].replace('{album}', 'Night'));
  assert.equal(c.createdElements.filter(element => element.tagName === 'IMG').length, 1);
  await c.run("executePlayerCommand({action:'next'})");
  const second = c.createdElements.filter(element => element.tagName === 'IMG')[1];
  assert.equal(second.src, '/covers/' + 'b'.repeat(64) + '.jpg');
  assert.equal(c.get('expandedTrackTitle').textContent, 'Beta');
  second.naturalWidth = 400; second.naturalHeight = 400; second.onload();
  assert.equal(c.audio.loadCalls, loads + 1);
  c.run('expandedPlayer.close(true)');
  assert.equal(first.src, undefined); assert.equal(second.src, undefined);
  assert.equal(c.audio.paused, false);
});

test('switching away from a loading cover discards its callbacks and preserves paused playback', async () => {
  const c = await client();
  c.data().tracks[0].cover_id = 'a'.repeat(64);
  await c.run('refresh()');
  await c.run("playTrack('a',['a','b'])");
  c.audio.pause(); c.audio.currentTime = 18;
  c.run('expandedPlayer.open()');
  const image = c.createdElements.find(element => element.tagName === 'IMG');
  const late = image.onload;
  c.run("expandedPlayer.setMode('effects')");
  late();
  assert.equal(image.parentNode, null);
  assert.equal(c.createdElements.find(element => element.className === 'effects-status').textContent,'Visualization is unavailable in this browser');
  c.run("expandedPlayer.setMode('album')");
  const retry = c.createdElements.filter(element => element.tagName === 'IMG')[1];
  retry.onerror();
  assert.equal(c.createdElements.filter(element => element.className === 'album-artwork-status').at(-1).textContent, 'Artwork unavailable');
  assert.equal(c.audio.paused, true); assert.equal(c.audio.currentTime, 18);
  c.run('expandedPlayer.close(true)');
});

test('appearance controls synchronize across both panels and preserve playback in all themes', async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b'])");
  c.audio.currentTime = 27;
  c.run('expandedPlayer.open()');
  c.get('expandedAppearanceToggle').onclick();
  assert.equal(c.get('expandedAppearancePanel').hidden, false);
  assert.equal(c.run('document.activeElement.id'), 'expandedBackgroundSetting');
  const source = c.audio.src, loads = c.audio.loadCalls, requests = c.calls.length;
  const queue = c.run('JSON.stringify(queueModel.snapshot())'), listening = c.run('listeningSession');
  for (const theme of ['forest','midnight','sand']) {
    c.run(`applyTheme(${JSON.stringify(theme)})`);
    for (const background of ['none','ambient','waves','texture']) {
      c.get('expandedBackgroundSetting').onchange({target:{value:background}});
      c.get('expandedIntensitySetting').oninput({target:{value:'70'}});
      assert.equal(c.get('playerBackgroundSetting').value, background);
      assert.equal(c.get('playerIntensityValue').textContent, '70%');
      assert.equal(c.get('playerIntensitySetting').disabled, background === 'none');
      assert.equal(c.get('expandedPlayerDialog').dataset.background, background);
      assert.equal(c.run('document.documentElement.dataset.theme'), theme);
    }
  }
  c.get('playerAnimationSetting').onchange({target:{checked:false}});
  assert.equal(c.get('expandedAnimationSetting').checked, false);
  assert.equal(c.get('expandedPlayerDialog').dataset.motion, 'off');
  assert.equal(c.audio.src, source); assert.equal(c.audio.loadCalls, loads); assert.equal(c.audio.currentTime, 27);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'), queue); assert.equal(c.run('listeningSession'), listening);
  assert.equal(c.calls.length, requests);
  c.get('collapsePlayer').onclick();
  assert.equal(c.get('expandedPlayerDialog').open, false);
  assert.equal(c.get('expandedAppearancePanel').hidden, true);
  const restored = await client({initialStorage:Object.fromEntries(c.local)});
  assert.equal(restored.get('playerBackgroundSetting').value, 'texture');
  assert.equal(restored.get('playerIntensitySetting').value, '70');
  assert.equal(restored.get('playerAnimationSetting').checked, false);
});

test('decorative motion only runs for visible active playback and responds live to reduced motion', async () => {
  const c = await client();
  await c.run("playTrack('a',['a','b'])");
  c.run("playerAppearance.set({background:'waves'}); expandedPlayer.open()");
  const dialog = c.get('expandedPlayerDialog');
  assert.equal(dialog.dataset.backgroundMotion, 'on');
  c.audio.pause(); assert.equal(dialog.dataset.backgroundMotion, 'off');
  await c.audio.play(); assert.equal(dialog.dataset.backgroundMotion, 'on');
  c.audio.emit('waiting'); assert.equal(dialog.dataset.backgroundMotion, 'off');
  c.audio.emit('playing'); assert.equal(dialog.dataset.backgroundMotion, 'on');
  c.run("document.hidden=true; document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(dialog.dataset.backgroundMotion, 'off');
  c.run("document.hidden=false; document.dispatchEvent(new Event('visibilitychange'))");
  assert.equal(dialog.dataset.backgroundMotion, 'on');
  c.setReducedMotion(true);
  assert.equal(dialog.dataset.motion, 'off'); assert.equal(dialog.dataset.backgroundMotion, 'off');
  assert.equal(c.get('expandedAnimationSetting').checked, true);
  assert.equal(c.get('expandedReducedMotionNote').hidden, false);
  c.setReducedMotion(false);
  assert.equal(dialog.dataset.backgroundMotion, 'on');
  c.run('playerAppearance.set({intensity:0})');
  assert.equal(dialog.dataset.backgroundVisible, 'false'); assert.equal(dialog.dataset.backgroundMotion, 'off');
  c.run('playerAppearance.set({intensity:100})');
  assert.equal(dialog.dataset.backgroundMotion, 'on');
  c.get('collapsePlayer').onclick(); assert.equal(dialog.dataset.backgroundMotion, 'off');
  c.run('playerAppearance.set({animation:false})');
  assert.equal(dialog.open, false);
  assert.equal(c.audio.paused, false);
});

test('appearance preferences remain local and independent of mode, theme and library wave', async () => {
  const first = await client();
  first.run("applyTheme('midnight'); setWaveMode('eco'); expandedPlayer.setMode('cd'); playerAppearance.set({background:'texture',intensity:95,animation:false})");
  await first.run("MusicI18n.setLanguage('ru')");
  assert.equal(first.run('expandedPlayer.mode'), 'cd');
  assert.equal(first.run('waveMode'), 'eco');
  assert.equal(first.run('document.documentElement.dataset.theme'), 'midnight');
  const second = await client();
  assert.equal(second.run('playerAppearance.get().background'), 'ambient');
  assert.equal(second.run('playerAppearance.get().animation'), true);
  const restored = await client({initialStorage:Object.fromEntries(first.local)});
  assert.equal(restored.run('expandedPlayer.mode'), 'cd');
  assert.equal(restored.run('playerAppearance.get().background'), 'texture');
  assert.equal(restored.run('playerAppearance.get().animation'), false);
  assert.equal(restored.run('waveMode'), 'eco');
});

test('library wave and expanded effects reuse one audible graph across repeated view changes', async () => {
  const graph = audioGraph(null), drawing = drawingContext();
  const c = await client({drawing,audioContextFactory:function() { return graph.createContext(); }});
  await c.run("playTrack('a',['a','b'])"); c.audio.emit('playing'); c.audio.currentTime = 41;
  c.run("setWaveMode('eco')"); await c.run('audioWave.unlock()');
  const source = c.audio.src, loads = c.audio.loadCalls, listening = c.run('listeningSession');
  const queue = c.run('JSON.stringify(queueModel.snapshot())'), requests = c.calls.length;
  assert.equal(graph.counts.sources, 1); assert.equal(graph.audio, c.audio);
  for (let i = 0; i < 4; i++) {
    c.run("expandedPlayer.open(); expandedPlayer.setMode('effects')");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal([...c.timeoutTasks.values()].filter(timer => timer.delay === 1000 / 30).length, 1);
    assert.equal(c.run('audioWave.timer'), null);
    assert.equal(graph.counts.sources, 1); assert.ok(graph.links.has(graph.context.destination));
    c.run("expandedPlayer.setMode('album')");
    assert.equal([...c.timeoutTasks.values()].filter(timer => timer.delay === 1000 / 30).length, 0);
    c.run('expandedPlayer.close(true)');
    assert.notEqual(c.run('audioWave.timer'), null);
    assert.equal(c.run('audioAnalysis.listeners.size'), 1);
  }
  assert.equal(graph.counts.contexts, 1); assert.equal(graph.counts.analysers, 1);
  assert.equal(graph.counts.badDisconnects, 0); assert.equal(graph.counts.closes, 0);
  assert.equal(c.audio.src, source); assert.equal(c.audio.loadCalls, loads); assert.equal(c.audio.currentTime, 41);
  assert.equal(c.run('listeningSession'), listening); assert.equal(c.run('JSON.stringify(queueModel.snapshot())'), queue);
  assert.equal(c.calls.length, requests);
});

test('effect controls persist locally and respect motion restrictions without altering background settings', async () => {
  const graph = audioGraph(null);
  const c = await client({drawing:drawingContext(),audioContextFactory:function() { return graph.createContext(); }});
  await c.run("playTrack('a',['a','b'])"); c.audio.emit('playing');
  c.run("expandedPlayer.open(); expandedPlayer.setMode('effects')");
  await new Promise(resolve => setImmediate(resolve));
  const preset = c.createdElements.find(element => element.className === 'effects-controls').nodes[0].nodes[1];
  const intensity = c.createdElements.find(element => element.className === 'effects-controls').nodes[1].nodes[1];
  const enabled = c.createdElements.find(element => element.className === 'effects-enable').nodes[0];
  preset.onchange({target:{value:'waveform'}}); intensity.oninput({target:{value:'85'}});
  assert.equal(JSON.parse(c.local.get('expandedPlayerEffects')).preset, 'waveform');
  assert.equal(c.run('playerAppearance.get().intensity'), 40);
  c.setReducedMotion(true);
  assert.equal([...c.timeoutTasks.values()].filter(timer => timer.delay === 1000 / 30).length, 0);
  assert.ok(graph.links.has(graph.context.destination)); assert.equal(graph.links.has(graph.analyser), false);
  c.setReducedMotion(false);
  assert.equal([...c.timeoutTasks.values()].filter(timer => timer.delay === 1000 / 30).length, 1);
  enabled.onchange({target:{checked:false}});
  assert.equal([...c.timeoutTasks.values()].filter(timer => timer.delay === 1000 / 30).length, 0);
  assert.equal(c.run('playerAppearance.get().animation'), true);
  c.run('expandedPlayer.close(true)');
  const restoredGraph = audioGraph(null);
  const restored = await client({initialStorage:Object.fromEntries(c.local),drawing:drawingContext(),audioContextFactory:function() { return restoredGraph.createContext(); }});
  restored.run('expandedPlayer.open()');
  const controls = restored.createdElements.find(element => element.className === 'effects-controls');
  assert.equal(controls.nodes[0].nodes[1].value, 'waveform');
  assert.equal(controls.nodes[1].nodes[1].value, '85');
  assert.equal(controls.nodes[2].nodes[0].checked, false);
  assert.equal(restoredGraph.counts.contexts, 0);
});

test('CD static fallback reuses album presentation without affecting playback', async () => {
  const graph = audioGraph(null);
  const c = await client({audioContextFactory:function() { return graph.createContext(); }});
  await c.run("playTrack('a',['a','b'])"); c.audio.emit('playing'); c.audio.currentTime = 33;
  const source = c.audio.src, loads = c.audio.loadCalls, listening = c.run('listeningSession');
  const queue = c.run('JSON.stringify(queueModel.snapshot())'), requests = c.calls.length;
  c.run("expandedPlayer.open(); expandedPlayer.setMode('cd')");
  assert.ok(c.createdElements.some(element => element.className === 'album-view'));
  assert.equal(c.createdElements.find(element => element.className === 'cd-status').textContent, '3D is unavailable. Showing static artwork.');
  c.run("expandedPlayer.setMode('album'); expandedPlayer.setMode('cd'); expandedPlayer.close(true)");
  assert.equal(c.audio.src, source); assert.equal(c.audio.loadCalls, loads); assert.equal(c.audio.currentTime, 33);
  assert.equal(c.run('listeningSession'), listening); assert.equal(c.run('JSON.stringify(queueModel.snapshot())'), queue);
  assert.equal(c.calls.length, requests, JSON.stringify(c.calls.slice(requests))); assert.equal(graph.counts.contexts, 0);
});

test('CD scene interactions and lifecycle preserve the existing audio and queue', async () => {
  const graph = audioGraph(null);
  const c = await client({audioContextFactory:function() { return graph.createContext(); }});
  c.run(`globalThis.cdStats = {imports:0,renders:0,disposed:0};
    playerViews.register('cd',context => new CDPlayerView({createFallback:context.artworkFactory,
      createContext:() => ({}),isWeakDevice:() => false,
      schedule:fn => { globalThis.cdFrame = fn; return 1; },cancel:() => { globalThis.cdFrame = null; },
      loadScene:async () => { cdStats.imports++; return {createCDScene:() => ({
        resize(){},setPalette(){},setArtwork(){},render(){cdStats.renders++;},dispose(){cdStats.disposed++;}
      })}; }}));`);
  await c.run("playTrack('a',['a','b'])"); c.audio.emit('playing'); c.audio.currentTime = 41;
  await new Promise(resolve => setImmediate(resolve));
  const source = c.audio.src, loads = c.audio.loadCalls, listening = c.run('listeningSession');
  const queue = c.run('JSON.stringify(queueModel.snapshot())'), requests = c.calls.length;
  c.run("expandedPlayer.setMode('cd')");
  assert.equal(c.run('cdStats.imports'), 0);
  for (let i = 0; i < 3; i++) {
    c.run('expandedPlayer.open()'); await new Promise(resolve => setImmediate(resolve));
    const controls = c.createdElements.filter(element => element.className === 'cd-controls').at(-1);
    controls.nodes[0].onclick(); controls.nodes[1].onclick(); controls.nodes[3].onclick();
    const canvas = c.createdElements.filter(element => element.className === 'cd-canvas').at(-1);
    const click = {pointerType:'mouse',pointerId:1,button:0,clientX:500,clientY:200,preventDefault(){}};
    canvas.onpointerdown(click); canvas.onpointerup(click);
    canvas.onkeydown({key:'ArrowRight',preventDefault(){}});
    c.advanceTime(34); c.run('cdFrame()');
    c.run("expandedPlayer.setMode('album'); expandedPlayer.setMode('cd')");
    await new Promise(resolve => setImmediate(resolve)); c.run('expandedPlayer.close(true)');
  }
  assert.ok(c.run('cdStats.renders') > 0);
  assert.equal(c.run('cdStats.disposed'), c.run('cdStats.imports'));
  assert.equal(c.audio.src, source); assert.equal(c.audio.loadCalls, loads); assert.equal(c.audio.currentTime, 41);
  assert.equal(c.audio.paused, false); assert.equal(c.run('listeningSession'), listening);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'), queue);
  assert.equal(c.calls.length, requests, JSON.stringify(c.calls.slice(requests))); assert.equal(graph.counts.contexts, 0);
});

test('analysis failure in effects leaves playback controls and the audible connection usable', async () => {
  const graph = audioGraph(null);
  const c = await client({drawing:drawingContext(),audioContextFactory:function() { return graph.createContext(); }});
  await c.run("playTrack('a',['a','b'])"); c.audio.emit('playing');
  c.run("expandedPlayer.open(); expandedPlayer.setMode('effects')");
  await new Promise(resolve => setImmediate(resolve));
  graph.analyser.getByteFrequencyData = () => { throw Error('read failed'); };
  const [id,timer] = [...c.timeoutTasks.entries()].find(([,timer]) => timer.delay === 1000 / 30);
  c.timeoutTasks.delete(id); timer.fn();
  assert.equal(c.createdElements.find(element => element.className === 'effects-status').textContent,'Visualization is unavailable in this browser');
  assert.equal(c.audio.paused, false); assert.ok(graph.links.has(graph.context.destination));
  await c.get('next').onclick(); assert.equal(c.run('currentId'), 'b'); assert.equal(c.audio.paused, false);
  assert.equal(graph.counts.sources, 1); assert.equal(graph.counts.badDisconnects, 0); assert.equal(graph.counts.closes, 0);
  c.run('expandedPlayer.close(true)');
});


test('named music sources label folders and status without changing playback', async () => {
  const c = await client(); await c.run("playTrack('a',['a','b'])");
  const source = c.audio.src, queue = c.run('JSON.stringify(queueModel.snapshot())');
  c.data().sources = [{id:'primary',primary:true,folder:'',name:'Primary storage',path:'/music',available:true},
    {id:'archive',folder:'@sources/archive',name:'Archive <disk>',path:'/archive',available:false}];
  c.data().folders.push('@sources/archive','@sources/archive/Jazz');
  await c.run('refresh()');
  assert.equal(c.run("folderLabel('@sources/archive/Jazz')"), 'Archive <disk>/Jazz');
  assert.match(c.get('folderFilter').innerHTML, /Archive &lt;disk&gt;/);
  assert.match(c.get('storageSources').innerHTML, /Unavailable/);
  assert.equal(c.audio.src, source);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'), queue);
  c.get('newFolderParent').value = '@sources/archive';
  c.get('newFolderName').value = 'New/Albums';
  await c.get('newFolderForm').onsubmit({preventDefault(){}});
  assert.equal(c.calls.findLast(call => call.action === 'folder').body.path, '@sources/archive/New/Albums');
});


test('all eight themes and new background palettes preserve playback and synchronize both settings panels', async () => {
  const c = await client(); await c.run("playTrack('a',['a','b'])"); c.audio.currentTime = 24;
  const source = c.audio.src, queue = c.run('JSON.stringify(queueModel.snapshot())'), session = c.run('listeningSession');
  for (const theme of ['forest','sand','latte','dawn','midnight','nord','mocha','dracula']) {
    c.run(`applyTheme('${theme}')`);
    assert.equal(c.run('document.documentElement.dataset.theme'),theme);
    assert.equal(c.run('document.documentElement.style.colorScheme'),['forest','sand','latte','dawn'].includes(theme) ? 'light' : 'dark');
  }
  c.run('expandedPlayer.open()');
  for (const background of ['aurora','gradient','stars','grid','northern-lights']) {
    c.get('expandedBackgroundSetting').onchange({target:{value:background}});
    assert.equal(c.get('playerBackgroundSetting').value,background);
    assert.equal(c.get('expandedPlayerDialog').dataset.backgroundMotion,'on');
  }
  c.get('playerPaletteSetting').onchange({target:{value:'custom'}});
  c.get('playerPrimaryColor').oninput({target:{value:'#123456'}});
  c.get('expandedSecondaryColor').oninput({target:{value:'#abcdef'}});
  assert.equal(c.get('expandedPrimaryColor').value,'#123456');
  assert.equal(c.get('playerSecondaryColor').value,'#abcdef');
  assert.equal(c.get('expandedPlayerDialog').style['--player-color-primary'],'#123456');
  c.get('expandedPaletteSetting').onchange({target:{value:'nord'}});
  assert.equal(c.get('playerCustomColors').hidden,true);
  assert.equal(c.get('expandedPlayerDialog').style['--player-color-primary'],'#88c0d0');
  assert.equal(c.run('document.documentElement.dataset.theme'),'dracula');
  c.audio.pause(); assert.equal(c.get('expandedPlayerDialog').dataset.backgroundMotion,'off');
  assert.equal(c.audio.src,source); assert.equal(c.audio.currentTime,24);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),queue); assert.equal(c.run('listeningSession'),session);
});

test('background speed synchronizes panels, scales durations and stops only background motion at zero', async () => {
  const c=await client(); await c.run("playTrack('a',['a','b']); playerAppearance.set({background:'northern-lights'}); expandedPlayer.open()");
  c.audio.currentTime=32;
  const source=c.audio.src, queue=c.run('JSON.stringify(queueModel.snapshot())'), session=c.run('listeningSession');
  assert.equal(c.get('playerBackgroundSpeedSetting').value,'20');
  c.get('expandedBackgroundSpeedSetting').oninput({target:{value:'100'}});
  assert.equal(c.get('playerBackgroundSpeedValue').textContent,'100%');
  assert.equal(c.get('expandedPlayerDialog').style['--player-background-duration-scale'],'0.2');
  c.get('playerBackgroundSpeedSetting').oninput({target:{value:'0'}});
  assert.equal(c.get('expandedBackgroundSpeedSetting').value,'0');
  assert.equal(c.get('expandedPlayerDialog').dataset.backgroundMotion,'off');
  assert.equal(c.get('expandedPlayerDialog').dataset.motion,'on');
  assert.equal(c.run('playerAppearance.get().motionEnabled'),true);
  c.get('expandedBackgroundSpeedSetting').oninput({target:{value:'20'}});
  assert.equal(c.get('expandedPlayerDialog').dataset.backgroundMotion,'on');
  assert.equal(c.get('expandedPlayerDialog').style['--player-background-duration-scale'],'1');
  assert.equal(c.audio.src,source); assert.equal(c.audio.currentTime,32); assert.equal(c.audio.paused,false);
  assert.equal(c.run('JSON.stringify(queueModel.snapshot())'),queue); assert.equal(c.run('listeningSession'),session);
});
