const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(id) {
    this.id = id; this._value = id === 'sort' ? 'manual' : id === 'libraryList' ? 'all' : ''; this.options = id === 'sort' ? [{value:'manual'}] : [];
    this.hidden = false; this.checked = false; this.dataset = {}; this.children = {}; this.textContent = '';
    this.attributes = {}; this.listeners = {};
    this.classList = {toggle(){},add(){},remove(){}};
  }
  set innerHTML(html) {
    this.html = html;
    if (['folderFilter','moveFolder','uploadFolder','addPlaylist','historyDevice','deviceTarget'].includes(this.id)) {
      this.options = [...html.matchAll(/<option value="([^"]*)">/g)].map(m => ({value:m[1]}));
      this._value = this.options[0]?.value ?? '';
    }
  }
  get innerHTML() { return this.html || ''; }
  get value() { return this._value; }
  set value(value) { this._value = String(value); }
  querySelector(selector) { return this.children[selector] ??= new Element(selector); }
  setAttribute(name,value) { this.attributes[name] = value; }
  addEventListener(name,fn,options = {}) { (this.listeners[name] ||= []).push({fn,once:options.once}); }
  emit(name) { this['on' + name]?.(); const list = this.listeners[name] || []; this.listeners[name] = list.filter(e => !e.once); list.forEach(e => e.fn()); }
  removeAttribute(name) { if (name === 'src') this.src = undefined; }
  load() { if (this.id === 'audio') { this.currentTime = 0; this.paused = true; } }
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
async function client({headStatus = 200, savedPlayer = null, listenFailures = 0, initialStorage = {}, controlTransport = null, healthTransport = null, operationTransport = null} = {}) {
  let data = fixture(); const elements = new Map(); const calls = [];
  const get = id => { if (!elements.has(id)) elements.set(id,new Element(id)); return elements.get(id); };
  const audio = get('audio'); Object.assign(audio,{paused:true,currentTime:0,duration:120,volume:.75});
  audio.play = async () => { audio.paused = false; audio.onplay?.(); };
  audio.pause = () => { audio.paused = true; audio.onpause?.(); };
  let now = 0;
  const local = new Map(Object.entries(initialStorage));
  if (savedPlayer) local.set('player',JSON.stringify(savedPlayer));
  const connection = {lastChild:{textContent:''}};
  const sandbox = {
    document:{documentElement:{dataset:{},style:{}},getElementById:get,querySelectorAll:() => [],querySelector:s => s === '.connection' ? connection : null,hidden:false},
    navigator:{},window:{addEventListener(){}},
    localStorage:{getItem:k => local.get(k),setItem:(k,v) => local.set(k,v),removeItem:k => local.delete(k),get length() { return local.size; },key:i => [...local.keys()][i]},
    TextEncoder, URLSearchParams, performance:{now:() => now},
    setInterval:() => 1,setTimeout:() => 1,clearTimeout(){},console,
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
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync('web/i18n.js','utf8'),context);
  await sandbox.MusicI18n.initialize();
  for (const [,src] of fs.readFileSync('web/index.html','utf8').matchAll(/data-app-src="\/([^"]+)"/g)) vm.runInContext(fs.readFileSync('web/' + src,'utf8'),context);
  await new Promise(resolve => setImmediate(resolve));
  const run = expression => vm.runInContext(expression,context);
  return {get,audio,run,calls,local,advanceTime:ms => { now += ms; },data:() => data};
}

test('initial library includes nested folders and selects the first playlist destination',async () => {
  const c = await client();
  assert.equal(c.get('folderFilter').value,'*');
  assert.equal(c.get('addPlaylist').value,'p');
  assert.equal(c.run('visible.length'),3);
  assert.equal(c.get('nowTitle').textContent,'Choose music');
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
  await second.get('settingsForm').onsubmit({preventDefault(){}});
  assert.equal(JSON.parse(second.local.get('device')).name,'Kitchen');
  assert.equal(second.calls.find(r => r.action === 'device').body.name,'Kitchen');
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
