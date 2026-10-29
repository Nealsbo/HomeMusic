/* Favorites, listening outbox and paginated history. Audio samples are counted locally. */
let listeningSession = null;
let flushListenPromise = null;
const listenPending = new Map();
const PENDING_PREFIX = 'music-listen:';

function collectPendingListens() {
  const oldest = Date.now() - 86400000;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PENDING_PREFIX)) continue;
      let saved;
      try { saved = JSON.parse(localStorage.getItem(key)); } catch { localStorage.removeItem(key); continue; }
      if (!saved?.body?.id || !Number.isFinite(saved.queuedAt) || saved.queuedAt < oldest) { localStorage.removeItem(key); continue; }
      const old = listenPending.get(saved.body.id);
      if (!old || old.body.seq < saved.body.seq) listenPending.set(saved.body.id,saved);
    }
  } catch {} // Storage may be unavailable; current-page delivery still works.
  const ordered = [...listenPending.values()].sort((a,b) => b.queuedAt - a.queuedAt);
  for (const event of ordered.slice(100)) {
    listenPending.delete(event.body.id);
    try { localStorage.removeItem(PENDING_PREFIX + event.body.id); } catch {}
  }
  for (const [id,event] of listenPending) if (event.queuedAt < oldest) listenPending.delete(id);
}
function queueListen(body) {
  if (!body) return;
  const event = {body,queuedAt:Date.now()};
  listenPending.set(body.id,event);
  try { localStorage.setItem(PENDING_PREFIX + body.id,JSON.stringify(event)); } catch {}
}
function acknowledgeListen(body) {
  const current = listenPending.get(body.id);
  if (current && current.body.seq <= body.seq) listenPending.delete(body.id);
  try {
    const saved = JSON.parse(localStorage.getItem(PENDING_PREFIX + body.id));
    if (saved && saved.body.seq <= body.seq) localStorage.removeItem(PENDING_PREFIX + body.id);
  } catch {}
}
function sampleListening(playing = !audio.paused && !audio.seeking, seek = false) {
  if (listeningSession) listeningSession.sample(audio.currentTime,playing,seek);
}
function beginListening() {
  if (!currentId) return;
  listeningSession = new ListeningSession(currentId);
  listeningSession.sample(audio.currentTime,false,true);
}
function reportListening(ended = false) {
  if (!listeningSession) return;
  sampleListening(!audio.paused && !audio.seeking && !ended);
  const latestDevice = stored('device',{});
  if (latestDevice.id === deviceId && typeof latestDevice.name === 'string') deviceName = latestDevice.name;
  const duration = Number.isFinite(audio.duration) ? audio.duration : (trackMap.get(listeningSession.trackId)?.duration || 0);
  queueListen(listeningSession.payload(deviceId,deviceName,duration,ended));
}
function finishListening(ended = false) {
  reportListening(ended);
  listeningSession = null;
  flushListens();
}
async function flushListens() {
  if (flushListenPromise) return flushListenPromise;
  collectPendingListens();
  const pending = [...listenPending.values()].sort((a,b) => a.queuedAt - b.queuedAt).slice(0,8);
  if (!pending.length) return;
  flushListenPromise = (async () => {
    let changed = false;
    for (const event of pending) {
      try {
        const result = await api('listen',event.body);
        acknowledgeListen(event.body);
        changed ||= !!result.newlyQualified;
      } catch (error) {
        if (error.status >= 400 && error.status < 500) acknowledgeListen(event.body);
        else break;
      }
    }
    if (changed && !document.querySelector('dialog[open]')) {
      await refresh().catch(() => {});
      if (view === 'history') await loadHistory(true).catch(() => {});
    }
  })();
  try { await flushListenPromise; } finally { flushListenPromise = null; }
}
async function toggleFavorite(id) {
  const track = trackMap.get(id);
  if (!track || favoriteBusy.has(id)) return;
  const value = !track.favorite;
  favoriteBusy.add(id); renderTracks(); updateNowPlaying();
  try {
    await api('favorite',{id,value});
    const latest = trackMap.get(id); if (latest) { latest.favorite = value; latest.favorite_at = value ? Date.now() / 1000 : 0; }
  } finally { favoriteBusy.delete(id); renderTracks(); updateNowPlaying(); }
}
async function loadHistory(reset = true) {
  const request = ++historyRequest;
  const device = $('historyDevice').value;
  const params = new URLSearchParams({limit:'50'});
  if (device) params.set('device',device);
  const cursor = reset ? null : historyCursor;
  if (!reset && !cursor) return;
  if (cursor) { params.set('beforeStarted',String(cursor.started)); params.set('beforeId',cursor.id); }
  $('historyMore').disabled = true;
  try {
    const response = await api('history?' + params);
    if (request !== historyRequest) return;
    const devices = response.devices.map(d => [d.id,d.name]);
    if (device && !devices.some(d => d[0] === device)) devices.push([device,'Выбранное устройство (нет записей)']);
    options($('historyDevice'),[['','Все устройства'],...devices]);
    const entries = reset ? response.items : [...historyItems,...response.items];
    historyItems = [...new Map(entries.map(item => [item.id,item])).values()];
    historyCursor = response.nextCursor; historyTotal = response.total;
    renderHistory();
  } finally { if (request === historyRequest) $('historyMore').disabled = false; }
}
function renderHistory() {
  $('historyCount').textContent = `${historyTotal} прослушиваний · показано ${historyItems.length}`;
  $('historyMore').hidden = !historyCursor;
  $('historyEntries').innerHTML = historyItems.map(event => {
    const available = event.trackId && trackMap.has(event.trackId);
    const resume = available && !event.ended && event.position > 3 && (!event.duration || event.position < event.duration - 3);
    const date = new Date(event.started * 1000).toLocaleString('ru-RU');
    return `<article class="history-entry"><div class="mini-cover">${coverHTML(event)}</div><div class="history-track"><button class="track-name" data-history-play="${escapeHTML(event.id)}" ${available ? '' : 'disabled'}>${escapeHTML(event.title)}</button><span class="track-artist">${escapeHTML(event.artist || 'Неизвестный исполнитель')}</span><small>${escapeHTML(date)} · ${escapeHTML(event.deviceName)} · прослушано ${clock(event.listened)}${available ? '' : ' · файл удалён'}</small></div>${resume ? `<button class="secondary" data-history-resume="${escapeHTML(event.id)}">Продолжить с ${clock(event.position)}</button>` : ''}</article>`;
  }).join('') || '<div class="empty"><h2>Здесь появится ваша история</h2><p>Послушайте трек достаточно долго или выберите другое устройство.</p></div>';
}
$('favoriteCurrent').onclick = handle(() => toggleFavorite(currentId));
$('historyDevice').onchange = handle(() => loadHistory(true));
$('refreshHistory').onclick = handle(() => loadHistory(true));
$('historyMore').onclick = handle(() => loadHistory(false));
$('historyEntries').onclick = handle(async event => {
  const button = event.target.closest('button'); if (!button) return;
  const item = historyItems.find(h => h.id === (button.dataset.historyPlay || button.dataset.historyResume));
  if (item?.trackId && trackMap.has(item.trackId)) await playTrack(item.trackId,[item.trackId],button.dataset.historyResume ? item.position : 0);
});
setInterval(() => { reportListening(); flushListens(); },5000);
window.addEventListener('pagehide',() => {
  reportListening();
  if (navigator.sendBeacon) for (const event of [...listenPending.values()].slice(0,8)) {
    try { navigator.sendBeacon('/api/listen',new Blob([JSON.stringify(event.body)],{type:'application/json'})); } catch {}
  }
});
window.addEventListener('online',() => flushListens());
window.addEventListener('storage',event => {
  if (event.key === 'device') { const saved = stored('device',{}); if (saved.id === deviceId) deviceName = saved.name || deviceName; }
});
