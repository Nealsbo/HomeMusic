async function refresh() {
  state = await api('state'); trackMap = new Map(state.tracks.map(t => [t.id, t]));
  const previousCatalog = catalog; catalog = new MusicCatalog(state.tracks); reconcileCatalogNavigation(previousCatalog);
  selected = new Set([...selected].filter(id => trackMap.has(id)));
  if (playlistId && !state.playlists.some(p => p.id === playlistId)) playlistId = null;
  const oldEntry = queueModel.currentEntryId;
  queueModel.prune(trackMap); syncQueue();
  if (oldEntry && oldEntry !== queueModel.currentEntryId) {
    if (queueModel.current) await loadCurrent(!audio.paused);
    else stopPlayback();
  }
  renderFolderOptions();
  options($('addPlaylist'), state.playlists.map(p => [p.id, p.name]));
  $('libraryCount').textContent = state.tracks.length;
  $('trackCount').textContent = state.tracks.length;
  $('folderCount').textContent = state.folders.length;
  $('sizeCount').textContent = bytes(state.tracks.reduce((n,t) => n + t.size, 0));
  $('deviceName').value = deviceName;
  $('storagePath').value = state.storage;
  $('operationRecoveryNotice').hidden = !state.operationRecovery;
  $('serverTitle').value = state.settings.title || tr("Quiet Wave");
  $('defaultVolume').value = state.settings.defaultVolume ?? .75;
  renderLibraryMessages();
  renderNav(); renderTracks(); renderFolders(); renderQueue(); updateNowPlaying();
  document.querySelector('.connection').lastChild.textContent = (' ' + tr("Connected"));
}
function renderFolderOptions() {
  const folders = state.folders.map(folder => [folder, folder || tr('Root folder')]);
  options($('folderFilter'), [['*', tr('All folders')], ...folders], '*');
  for (const id of ['moveFolder', 'uploadFolder']) options($(id), folders);
}
function renderLibraryMessages() {
  $('brandName').textContent = state.settings.title || tr('Quiet Wave');
  document.title = (state.settings.title || tr('Quiet Wave')) + ' · ' + tr('Music');
  const metadata = state.metadata;
  $('indexStatus').textContent = !metadata ? '' : !metadata.tags ? tr("Install ffprobe to read tags; its path can be set in the server startup options.") : metadata.pending ? tr('Reading tags and covers: {count} files remaining. You can already listen to music.', {count:metadata.pending}) : tr("Tags and covers updated") + (!metadata.covers ? (' · ' + tr("Cover images require ffmpeg.")) : '.');
  $('uploadLimit').textContent = tr('Upload limit per file: {size} MB. Files are transferred without transcoding.', {size:state.maxUploadMB});
}
function filteredTracks() {
  const p = state.playlists.find(p => p.id === playlistId);
  let tracks = p ? p.tracks.map(id => trackMap.get(id)).filter(Boolean) : tableScope ? [...tableScopeInfo().tracks] : [...state.tracks];
  const list = playlistId ? 'all' : $('libraryList').value;
  if (list === 'favorites') tracks = tracks.filter(t => t.favorite);
  if (list === 'recent' || list === 'frequent') tracks = tracks.filter(t => t.play_count > 0);
  const search = $('search').value.toLocaleLowerCase().trim(), folder = $('folderFilter').value;
  tracks = tracks.filter(t => (!search || [t.title,t.artist,t.album,t.album_artist,t.genre,t.year,t.path].join(' ').toLocaleLowerCase().includes(search)) && (folder === '*' || folder === '' || folderOf(t) === folder || folderOf(t).startsWith(folder + '/')));
  const sort = $('sort').value;
  if (sort !== 'manual') tracks.sort((a,b) => ['size','modified','duration','track_number','disc_number'].includes(sort) ? (sort.endsWith('_number') ? a[sort] - b[sort] : b[sort] - a[sort]) : String(a[sort] || '').localeCompare(b[sort], MusicI18n.locale, {numeric:true}));
  if (sort === 'manual') {
    if (list === 'recent') tracks.sort((a,b) => b.last_played - a.last_played);
    if (list === 'frequent') tracks.sort((a,b) => b.play_count - a.play_count || b.last_played - a.last_played);
    if (list === 'added') tracks.sort((a,b) => b.added - a.added);
  }
  return tracks;
}
function canReorderTracks() { return !tableScope && $('sort').value === 'manual' && (playlistId || ['all','favorites'].includes($('libraryList').value)); }
async function reorder(from, to) {
  if (!canReorderTracks() || from === to) return;
  const full = playlistId ? [...state.playlists.find(p => p.id === playlistId).tracks] : state.tracks.map(t => t.id);
  const subset = visible.map(t => t.id), before = subset.indexOf(from), after = subset.indexOf(to);
  if (before < 0 || after < 0) return;
  subset.splice(before, 1); subset.splice(after, 0, from);
  const allowed = new Set(subset); let index = 0;
  const order = full.map(id => allowed.has(id) ? subset[index++] : id);
  await api(playlistId ? 'playlistTracks' : 'order', {id:playlistId, tracks:order});
  await refresh();
}
async function updateStats() {
  const s = await api('stats');
  $('statsGrid').innerHTML = [[s.tracks,tr("Tracks in library")],[s.playlists,tr("Your playlists")],[bytes(s.libraryBytes),tr("Collection size")],[s.streams,tr("Active streams")]].map(([n,label]) => `<div class="stat-card"><b>${n}</b><span>${escapeHTML(label)}</span></div>`).join('');
  $('serverStats').innerHTML = [[tr("Uptime"),`${Math.floor(s.uptime / 3600)} ${tr("h")} ${Math.floor(s.uptime % 3600 / 60)} ${tr("min")}`],[tr("Free disk space"),bytes(s.diskFree)],[tr("Audio transferred"),bytes(s.bytesSent)],[tr("Read requests"),s.requests]].map(([a,b]) => `<dt>${escapeHTML(a)}</dt><dd>${escapeHTML(b)}</dd>`).join('');
}
function uploadFile(file, folder) {
  return new Promise((resolve,reject) => {
    const xhr = new XMLHttpRequest(); xhr.open('PUT','/api/upload');
    xhr.setRequestHeader('X-File-Path', encodeURIComponent((folder ? folder + '/' : '') + file.name));
    xhr.upload.onprogress = e => { if (e.lengthComputable) $('uploadProgress').textContent = `${file.name} · ${Math.round(e.loaded / e.total * 100)}%`; };
    xhr.onload = () => { let result; try { result = JSON.parse(xhr.responseText); } catch { result = {}; } if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(Error(MusicI18n.message(result.error || 'Upload error'))); };
    xhr.onerror = () => reject(Error(tr("Connection interrupted"))); xhr.send(file);
  });
}
async function upload(files) {
  if (uploading) return;
  uploading = true; $('chooseFiles').disabled = true; const folder = $('uploadFolder').value;
  let success = 0; const failures = [];
  try {
    for (const file of files) {
      try {
        if (file.size > state.maxUploadMB * 1048576) throw Error(tr("File size limit exceeded"));
        await uploadFile(file, folder); success++;
      } catch(e) { failures.push(`${file.name}: ${e.message}`); }
    }
    $('uploadProgress').textContent = tr('Uploaded: {count} of {total}.', {count:success,total:files.length}) + (failures.length ? '\n' + failures.join('\n') : (' ' + tr("You can add more files.")));
    await refresh(); toast(tr('Files uploaded: {count}', {count:success}));
  } finally { uploading = false; $('chooseFiles').disabled = false; $('fileInput').value = ''; }
}
