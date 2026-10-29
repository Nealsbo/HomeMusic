async function reportPlayback() {
  const signature = queueModel.order.join(',');
  const body = {clientId, deviceId, controlVersion:1, volume:audio.volume, seq: ++reportSeq, name: deviceName,
    state: playbackState, trackId: currentId, queueEntryId: queueModel.currentEntryId, playlistId: queuePlaylistId, queueName,
    position: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : 0, error: playbackError};
  if (reportedQueue !== signature) { body.queue = queue; body.queueEntryIds = queueModel.order; }
  try { const result = await api('playback', body); reportedQueue = signature; if (result.needsQueue) { reportedQueue = null; return reportPlayback(); } } catch {} // Playback works even if monitoring is unavailable.
}
async function diagnosePlayback(id, code = 4, generation = playbackGeneration) {
  if (id !== currentId || generation !== playbackGeneration) return;
  let message;
  try {
    const response = await fetch('/media/' + id, {method:'HEAD'});
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      message = `HTTP ${response.status}: ${result.error || 'Файл недоступен на сервере'}`;
    } else {
      const info = await api('media-info/' + id);
      const reasons = {1:'Воспроизведение прервано',2:'Ошибка сети при передаче аудио',3:'Ошибка декодирования аудио',4:'Браузер не поддерживает содержимое этого файла'};
      message = `${reasons[code] || reasons[4]}. ${info.path} · ${info.mime} · ${info.container} · ${bytes(info.size)}. ` +
        (info.size === 0 ? 'Файл пуст.' : 'Проверьте файл во внешнем плеере. Расширение не гарантирует поддержку кодека браузером.');
    }
  } catch (error) { message = 'Не удалось проверить доступность файла: ' + error.message; }
  if (id !== currentId || generation !== playbackGeneration) return;
  playbackState = 'error'; playbackError = message;
  $('playbackError').textContent = message; $('playbackError').hidden = false;
  toast(message); reportPlayback();
}
function syncQueue() {
  queue = queueModel.ordered.map(entry => entry.trackId);
  currentId = queueModel.current?.trackId || null;
}
function persistPlayer() {
  store('player', {queueModel:queueModel.snapshot(), queue,currentId,position:audio.currentTime,
    shuffled,repeating,queuePlaylistId,queueName});
}
function coverHTML(track) {
  return /^[a-f0-9]{64}$/.test(track?.cover_id || '') ? `<img src="/covers/${track.cover_id}.jpg" alt="" loading="lazy">` : '♫';
}
function updateNowPlaying() {
  const t = trackMap.get(currentId);
  $('nowTitle').textContent = t?.title || 'Выберите музыку';
  $('nowArtist').textContent = t ? t.artist || 'Неизвестный исполнитель' : 'Ваша коллекция ждёт';
  $('nowCover').innerHTML = coverHTML(t);
  $('favoriteCurrent').disabled = !t || favoriteBusy.has(currentId);
  $('favoriteCurrent').textContent = t?.favorite ? '♥' : '♡';
  $('favoriteCurrent').classList.toggle('enabled',!!t?.favorite);
  $('favoriteCurrent').setAttribute('aria-pressed',String(!!t?.favorite));
  $('favoriteCurrent').title = t?.favorite ? 'Убрать из избранного' : 'В избранное';
  $('favoriteCurrent').setAttribute('aria-label',$('favoriteCurrent').title);
  if (t && 'mediaSession' in navigator && 'MediaMetadata' in window) navigator.mediaSession.metadata = new MediaMetadata({title:t.title,artist:t.artist,album:t.album,
    artwork:t.cover_id ? [{src:location.origin + '/covers/' + t.cover_id + '.jpg',type:'image/jpeg'}] : []});
}
function renderQueue() {
  const ordered = queueModel.ordered;
  $('queueCount').textContent = `${ordered.length} треков · ${queueName}`;
  $('queueList').innerHTML = ordered.slice(0,queueLimit).map((entry,i) => {
    const t = trackMap.get(entry.trackId);
    return t ? `<div class="queue-row ${entry.id === queueModel.currentEntryId ? 'active' : ''}" draggable="true" data-entry="${entry.id}">
      <button class="queue-item" data-queue="${entry.id}">${i + 1}. ${escapeHTML(t.title)}<small>${escapeHTML(t.artist || 'Неизвестный исполнитель')}</small></button>
      <div class="queue-actions"><button class="icon" data-queue-up="${entry.id}" title="Выше" ${i === 0 ? 'disabled' : ''}>↑</button><button class="icon" data-queue-down="${entry.id}" title="Ниже" ${i === ordered.length - 1 ? 'disabled' : ''}>↓</button><button class="icon" data-queue-remove="${entry.id}" title="Убрать из очереди">×</button></div></div>` : '';
  }).join('') || '<p class="muted">Выберите трек или добавьте музыку в очередь.</p>';
  $('queueMore').hidden = ordered.length <= queueLimit;
  $('clearQueue').disabled = !ordered.length;
  $('saveQueue').disabled = !ordered.length;
}
function queueChanged() {
  syncQueue(); renderQueue(); renderTracks(); persistPlayer(); reportPlayback();
}
function stopPlayback() {
  finishListening();
  playbackGeneration++;
  syncQueue(); audio.pause(); audio.removeAttribute('src'); audio.load();
  playbackState = 'idle'; playbackError = ''; $('playbackError').hidden = true;
  $('elapsed').textContent = '0:00'; $('duration').textContent = '0:00'; $('seek').value = 0;
  updateNowPlaying(); queueChanged();
}
async function loadCurrent(autoplay = true, resumePosition = 0) {
  finishListening();
  syncQueue(); const t = trackMap.get(currentId); if (!t) return;
  const id = currentId, generation = ++playbackGeneration;
  playbackState = autoplay ? 'buffering' : 'paused'; playbackError = ''; $('playbackError').hidden = true;
  if (Number.isFinite(resumePosition) && resumePosition > 0) audio.addEventListener('loadedmetadata',() => {
    if (generation === playbackGeneration && Number.isFinite(audio.duration)) audio.currentTime = Math.min(resumePosition,Math.max(0,audio.duration - .1));
  },{once:true});
  audio.src = '/media/' + id; audio.load(); beginListening();
  updateNowPlaying(); renderTracks(); renderQueue(); persistPlayer(); reportPlayback();
  if (!autoplay) return;
  try { await audio.play(); } catch(e) {
    if (generation !== playbackGeneration) return;
    if (e.name === 'NotAllowedError') { playbackState = 'paused'; toast('Браузер ожидает нажатия ▶ для начала воспроизведения.'); reportPlayback(); }
    else if (e.name !== 'AbortError') await diagnosePlayback(id, audio.error?.code || 4, generation);
  }
}
async function playTrack(id, newQueue, resumePosition = 0, contextName = null) {
  if (!trackMap.has(id)) return;
  if (newQueue) {
    queueModel.setShuffle(shuffled);
    const valid = newQueue.filter(t => trackMap.has(t));
    queueModel.replace(valid, Math.max(0,valid.indexOf(id)));
    queuePlaylistId = playlistId;
    queueName = contextName || state.playlists.find(p => p.id === playlistId)?.name || (view === 'history' ? 'История' : {favorites:'Избранное',recent:'Недавно прослушанное',frequent:'Часто включаемое',added:'Недавно добавленное'}[$('libraryList').value]) || ($('folderFilter').value === '*' || !$('folderFilter').value ? 'Медиатека' : $('folderFilter').value);
  } else {
    const entry = queueModel.ordered.find(e => e.trackId === id);
    if (entry) queueModel.select(entry.id);
    else { const [added] = queueModel.add([id]); queueModel.select(added.id); }
  }
  return loadCurrent(true,resumePosition);
}
async function step(direction, ended = false) {
  if (!queueModel.order.length) return;
  if (direction < 0 && audio.currentTime > 3) { audio.currentTime = 0; return; }
  queueModel.setShuffle(shuffled);
  const entry = direction < 0 ? queueModel.previous() : queueModel.next(repeating);
  if (!entry) { if (!ended && direction > 0) toast('Конец очереди'); return; }
  return loadCurrent();
}
function enqueue(ids, next = false) {
  queueModel.add(ids.filter(id => trackMap.has(id)),next);
  queueChanged(); toast(next ? 'Добавлено следующим' : 'Добавлено в конец очереди');
}
async function removeQueueEntry(id) {
  const wasPlaying = !audio.paused;
  const result = queueModel.remove(id);
  if (result.wasCurrent) {
    if (result.current) await loadCurrent(wasPlaying); else stopPlayback();
  }
  queueChanged();
}

function playVisibleMusic() {
  const context = !$('collectionView').hidden ? collectionRouteInfo() : null;
  const tracks = context ? context.tracks : visible;
  return tracks.length ? playTrack(tracks[0].id,tracks.map(t => t.id),0,context?.title || null) : toast('Добавьте музыку в коллекцию');
}
$('playAll').onclick = handle(() => playVisibleMusic());
$('togglePlay').onclick = handle(async () => {
  if (!currentId) {
    if (queueModel.order.length) { queueModel.next(); await loadCurrent(); }
    else await playVisibleMusic();
  } else if (audio.paused) await audio.play(); else audio.pause();
});
$('previous').onclick = handle(() => step(-1)); $('next').onclick = handle(() => step(1));
$('shuffle').onclick = () => { shuffled = !shuffled; queueModel.setShuffle(shuffled); syncQueue(); renderQueue(); reportPlayback(); $('shuffle').classList.toggle('enabled',shuffled); $('shuffle').setAttribute('aria-pressed',shuffled); persistPlayer(); };
$('repeat').onclick = () => { repeating = !repeating; $('repeat').classList.toggle('enabled',repeating); $('repeat').setAttribute('aria-pressed',repeating); persistPlayer(); };
$('queueButton').onclick = () => { renderQueue(); $('queueDialog').showModal(); };
$('queueList').onclick = handle(async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.queue) { queueModel.select(b.dataset.queue); return loadCurrent(); }
  if (b.dataset.queueRemove) return removeQueueEntry(b.dataset.queueRemove);
  const id = b.dataset.queueUp || b.dataset.queueDown;
  if (id) { const index = queueModel.order.indexOf(id), target = queueModel.order[index + (b.dataset.queueUp ? -1 : 1)]; if (target) { queueModel.move(id,target); queueChanged(); } }
});
$('queueList').ondragstart = e => { const row = e.target.closest('[data-entry]'); if (!row) return; queueDragId = row.dataset.entry; e.dataTransfer.setData('text/plain',queueDragId); e.dataTransfer.effectAllowed = 'move'; };
$('queueList').ondragover = e => { if (queueDragId && e.target.closest('[data-entry]')) e.preventDefault(); };
$('queueList').ondrop = e => { e.preventDefault(); const row = e.target.closest('[data-entry]'); if (row && queueDragId) { queueModel.move(queueDragId,row.dataset.entry); queueChanged(); } queueDragId = null; };
$('queueList').ondragend = () => { queueDragId = null; };
$('queueMore').onclick = () => { queueLimit += 150; renderQueue(); };
$('clearQueue').onclick = () => { queueModel.clear(); stopPlayback(); };
$('saveQueue').onclick = handle(async () => {
  const name = prompt('Название плейлиста для текущей очереди'); if (!name?.trim()) return;
  const p = await api('playlist',{name});
  await api('playlistTracks',{id:p.id,tracks:[...new Set(queue)]});
  await refresh(); toast('Очередь сохранена в плейлист. Повторяющиеся треки включены один раз.');
});
$('seek').oninput = () => { if (Number.isFinite(audio.duration)) { sampleListening(false); audio.currentTime = Number($('seek').value) / 100 * audio.duration; sampleListening(!audio.paused,true); } };
$('volume').oninput = () => { audio.volume = Number($('volume').value); $('volumeValue').textContent = Math.round(audio.volume * 100) + '%'; store('volume',audio.volume); };
let lastPersist = 0;
audio.ontimeupdate = () => { sampleListening(); $('elapsed').textContent = clock(audio.currentTime); $('duration').textContent = clock(audio.duration); $('seek').value = audio.duration ? audio.currentTime / audio.duration * 100 : 0; if (Date.now() - lastPersist > 5000) { persistPlayer(); lastPersist = Date.now(); } };
audio.onloadedmetadata = () => { $('duration').textContent = clock(audio.duration); };
audio.onplay = () => { playbackState = 'playing'; playbackError = ''; $('playbackError').hidden = true; $('togglePlay').textContent = 'Ⅱ'; renderTracks(); reportPlayback(); };
audio.onpause = () => { reportListening(!!audio.ended); flushListens(); if (playbackState !== 'error') playbackState = audio.ended ? 'ended' : 'paused'; $('togglePlay').textContent = '▶'; renderTracks(); persistPlayer(); reportPlayback(); };
audio.onended = handle(async () => { reportListening(true); flushListens(); playbackState = 'ended'; reportPlayback(); await step(1,true); });
audio.onerror = () => { reportListening(); flushListens(); if (currentId) diagnosePlayback(currentId, audio.error?.code || 4); };
audio.onwaiting = () => { sampleListening(false); if (currentId && !audio.paused) { playbackState = 'buffering'; reportPlayback(); } };
audio.onplaying = () => { if (!listeningSession) beginListening(); sampleListening(true); playbackState = 'playing'; reportPlayback(); };
audio.onseeking = () => sampleListening(false,true);
audio.onseeked = () => { sampleListening(!audio.paused,true); reportListening(); flushListens(); reportPlayback(); };
setInterval(reportPlayback, 10000);
window.addEventListener('pagehide',persistPlayer);
if ('mediaSession' in navigator) {
  for (const [action,fn] of Object.entries({play:() => audio.play().catch(e => toast(e.message)),pause:() => audio.pause(),previoustrack:() => step(-1),nexttrack:() => step(1)})) {
    try { navigator.mediaSession.setActionHandler(action,fn); } catch {}
  }
}
