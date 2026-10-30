const openUpload = () => { $('uploadDialog').showModal(); };
$('uploadButton').onclick = openUpload; $('emptyUpload').onclick = openUpload;
$('chooseFiles').onclick = () => $('fileInput').click();
$('fileInput').onchange = handle(e => upload([...e.target.files]));
$('chooseFiles').ondragover = e => { e.preventDefault(); };
$('chooseFiles').ondrop = handle(e => { e.preventDefault(); return upload([...e.dataTransfer.files]); });
document.querySelectorAll('.nav').forEach(el => el.onclick = () => showView(el.dataset.view));
$('playlists').onclick = e => { const b = e.target.closest('[data-playlist]'); if (b) { $('search').value = ''; $('folderFilter').value = '*'; $('sort').value = 'manual'; showView('library', b.dataset.playlist); } };
$('newPlaylist').onclick = handle(async () => { const name = prompt(tr("New playlist name")); if (!name?.trim()) return; const p = await api('playlist',{name}); await refresh(); showView('library',p.id); });
$('renamePlaylist').onclick = handle(async () => { const name = prompt(tr("Playlist name"),state.playlists.find(p => p.id === playlistId).name); if (!name?.trim()) return; await api('playlist',{id:playlistId,name}); await refresh(); });
$('deletePlaylist').onclick = handle(async () => { if (!confirm(tr("Delete this playlist? Audio files will be kept."))) return; await api('deletePlaylist',{id:playlistId}); playlistId = null; await refresh(); });
$('importButton').onclick = () => $('m3uInput').click();
$('m3uInput').onchange = handle(async e => { const file = e.target.files[0]; if (!file) return; if (file.size > 1048576) throw Error(tr("Maximum M3U size: 1 MB")); const result = await api('import',{name:file.name.replace(/\.m3u8?$/i,''), content:await file.text()}); await refresh(); showView('library',result.id); toast(tr('Added: {count}. Not found or ambiguous: {missing}.', {count:result.matched,missing:result.missing.length})); if (result.missing.length) { $('queueList').innerHTML = ('<p class="muted">' + escapeHTML(tr("These entries were not found in storage. Upload the corresponding audio files and import again.")) + '</p>') + result.missing.map(line => `<p>${escapeHTML(line)}</p>`).join(''); $('queueDialog').showModal(); } e.target.value = ''; });
$('exportButton').onclick = async () => { try { const response = await fetch('/api/export/' + playlistId); if (!response.ok) throw Error(tr("Could not export")); const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = state.playlists.find(p => p.id === playlistId).name + '.m3u8'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); } catch(e) { toast(e.message); } };
$('libraryList').onchange = () => { selected.clear(); limit = 150; view = $('libraryList').value === 'favorites' ? 'favorites' : 'library'; renderNav(); renderTracks(); };
$('search').oninput = () => { limit = 150; renderTracks(); };
$('sort').onchange = () => { limit = 150; renderTracks(); };
$('folderFilter').onchange = () => { selected.clear(); limit = 150; renderTracks(); };
$('loadMore').onclick = () => { limit += 150; renderTracks(); };
$('selectAll').onchange = e => { visible.forEach(t => e.target.checked ? selected.add(t.id) : selected.delete(t.id)); renderTracks(); };
$('tracks').onchange = e => { if (e.target.dataset.select) { e.target.checked ? selected.add(e.target.dataset.select) : selected.delete(e.target.dataset.select); renderSelection(); } };
$('tracks').onclick = handle(async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.favorite) return toggleFavorite(b.dataset.favorite);
  if (b.dataset.enqueueNext) return enqueue([b.dataset.enqueueNext],true);
  if (b.dataset.enqueueEnd) return enqueue([b.dataset.enqueueEnd]);
  if (b.dataset.play) return playTrack(b.dataset.play,visible.map(t => t.id));
  const id = b.dataset.up || b.dataset.down;
  if (id) { const i = visible.findIndex(t => t.id === id), target = visible[i + (b.dataset.up ? -1 : 1)]; if (target) await reorder(id,target.id); }
  if (b.dataset.edit) { const t = trackMap.get(b.dataset.edit); editingTrackSnapshot = {...t}; $('editProvenance').textContent = t.metadata_overrides?.length ? (tr("Protected fields:") + " ") + t.metadata_overrides.join(', ') + ('. ' + tr("You can restore values from tags.")) : tr("Data was read from the file; manual edits will be preserved during scans."); for (const [key,value] of Object.entries({editId:t.id,editTitle:t.title,editArtist:t.artist,editAlbum:t.album,editAlbumArtist:t.album_artist || '',editGenre:t.genre || '',editYear:t.year || '',editTrackNumber:t.track_number || 0,editDiscNumber:t.disc_number || 0})) $(key).value = value; $('editTechnical').textContent = `${clock(t.duration || 0)} · ${t.codec || tr("unknown format")} · ${Math.round((t.bitrate || 0) / 1000)} ${tr("kbps ·")} ${t.sample_rate || 0} ${tr("Hz")}` + (t.metadata_error ? ' · ' + MusicI18n.message(t.metadata_error) : ''); $('editDialog').showModal(); }
});
$('tracks').ondragstart = e => { const row = e.target.closest('tr'); if (!row || !canReorderTracks() || e.target.closest('input,button')) { e.preventDefault(); return; } dragId = row.dataset.id; e.dataTransfer.setData('text/plain',dragId); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); };
$('tracks').ondragover = e => { const row = e.target.closest('tr'); if (row && dragId) { e.preventDefault(); document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target')); row.classList.add('drop-target'); } };
$('tracks').ondrop = handle(async e => { e.preventDefault(); const row = e.target.closest('tr'); if (row && dragId) await reorder(dragId,row.dataset.id); dragId = null; });
$('tracks').ondragend = () => { dragId = null; document.querySelectorAll('.dragging,.drop-target').forEach(el => el.classList.remove('dragging','drop-target')); };
$('moveButton').onclick = handle(async () => { await api('move',{tracks:[...selected],folder:$('moveFolder').value}); selected.clear(); await refresh(); toast(tr("Files moved")); });
$('addButton').onclick = handle(async () => { const p = state.playlists.find(p => p.id === $('addPlaylist').value); if (!p) return; await api('playlistTracks',{id:p.id,tracks:[...new Set([...p.tracks,...selected])]}); selected.clear(); await refresh(); toast(tr("Added to playlist")); });
$('removeButton').onclick = handle(async () => { const p = state.playlists.find(p => p.id === playlistId); await api('playlistTracks',{id:p.id,tracks:p.tracks.filter(id => !selected.has(id))}); selected.clear(); await refresh(); });
$('newFolder').onclick = handle(async () => { const path = prompt(tr("New folder path, for example Jazz/Live")); if (!path?.trim()) return; await api('folder',{path:path.trim()}); await refresh(); });
$('folderGrid').onclick = e => { const b = e.target.closest('[data-folder-index]'); if (b) { setHomeMode('table',false); $('folderFilter').value = state.folders[Number(b.dataset.folderIndex)]; $('search').value = ''; showView('library'); } };
$('scanButton').onclick = handle(async () => { $('scanButton').disabled = true; try { await api('scan',{}); await refresh(); toast(tr("Library updated")); } finally { $('scanButton').disabled = false; } });
$('refresh').onclick = handle(async () => { if (view === 'operations') { await loadOperations(); toast(tr("Operation log updated")); return; } if (view === 'health') { await loadHealth(); toast(tr("Report updated")); return; } await api('scan', {}); await refresh(); if (view === 'stats') await updateStats(); if (view === 'history') await loadHistory(true); toast(tr("Data updated")); });
$('editForm').onsubmit = handle(async e => {
  e.preventDefault();
  const data = {id:$('editId').value};
  const fields = {title:'editTitle',artist:'editArtist',album:'editAlbum',album_artist:'editAlbumArtist',genre:'editGenre',year:'editYear',track_number:'editTrackNumber',disc_number:'editDiscNumber'};
  for (const [field,id] of Object.entries(fields)) {
    const value = field.endsWith('_number') ? Number($(id).value) : $(id).value;
    const before = editingTrackSnapshot?.[field] ?? (field.endsWith('_number') ? 0 : '');
    if (value !== before) data[field] = value;
  }
  await api('metadata',data); $('editDialog').close(); await refresh();
});
$('resetMetadata').onclick = handle(async () => {
  if (!confirm(tr("Restore all fields from file tags? Manual values will be replaced."))) return;
  await api('metadata',{id:$('editId').value,reset:true}); $('editDialog').close(); await refresh();
});
$('enqueueSelectedNext').onclick = () => enqueue(visible.filter(t => selected.has(t.id)).map(t => t.id),true);
$('enqueueSelectedEnd').onclick = () => enqueue(visible.filter(t => selected.has(t.id)).map(t => t.id));
$('cancelEdit').onclick = () => $('editDialog').close();
setInterval(() => { if (state.metadata?.pending && !dragId && !queueDragId && view !== 'settings' && !document.hidden && !document.querySelector('dialog[open]')) refresh().catch(() => {}); },3000);
setInterval(() => { if (view === 'stats' && !document.hidden) updateStats().catch(() => {}); },15000);
window.addEventListener('focus',() => { if (!document.querySelector('dialog[open]') && view !== 'settings') refresh().then(() => view === 'history' ? loadHistory(true) : undefined).catch(() => {}); });
(async () => {
  try {
    await refresh();
    audio.volume = Math.min(1,Math.max(0,Number(stored('volume',state.settings.defaultVolume ?? .75)))); $('volume').value = audio.volume; $('volumeValue').textContent = Math.round(audio.volume * 100) + '%';
    const saved = stored('player',{});
    if (!queueModel.restore(saved.queueModel,trackMap)) {
      const legacy = Array.isArray(saved.queue) ? saved.queue.filter(id => trackMap.has(id)) : [];
      queueModel.replace(legacy,Math.max(0,legacy.indexOf(saved.currentId)));
      if (!trackMap.has(saved.currentId)) queueModel.currentEntryId = null;
      queueModel.setShuffle(!!saved.shuffled);
    }
    syncQueue();
    shuffled = saved.queueModel?.version === 2 ? queueModel.shuffled : !!saved.shuffled; repeating = !!saved.repeating; queuePlaylistId = saved.queuePlaylistId || null; queueName = saved.queueName || tr("Library");
    for (const [id,value] of [['shuffle',shuffled],['repeat',repeating]]) { $(id).classList.toggle('enabled',value); $(id).setAttribute('aria-pressed',value); }
    if (currentId) {
      playbackState = 'paused'; audio.src = '/media/' + currentId; updateNowPlaying();
      const restoredEntryId = queueModel.currentEntryId;
      audio.addEventListener('loadedmetadata',() => { if (restoredEntryId === queueModel.currentEntryId && Number.isFinite(saved.position) && saved.position < audio.duration) audio.currentTime = saved.position; },{once:true});
    }
    renderTracks(); renderQueue(); reportPlayback(); flushListens();
  } catch(e) { toast((tr("Could not connect:") + " ") + e.message); document.querySelector('.connection').lastChild.textContent = (' ' + tr("Disconnected")); }
})();
