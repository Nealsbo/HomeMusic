function renderNav() {
  updateHomeLayout();
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', view === el.dataset.view && !playlistId));
  $('playlists').innerHTML = state.playlists.map(p => `<button class="playlist-button ${p.id === playlistId ? 'active' : ''}" data-playlist="${p.id}"><span class="button-icon" aria-hidden="true">☷</span> &nbsp; ${escapeHTML(p.name)} <small>(${p.tracks.length})</small></button>`).join('');
  const p = state.playlists.find(p => p.id === playlistId);
  const titles = {favorites:tr("Your favorites"), history:tr("Listening history"), library:tr("Your library"), folders:tr("Music by folder"), operations:tr("Operation log"),health:tr("Collection health"), stats:tr("Music in numbers"), settings:tr("Your space")};
  $('pageTitle').textContent = p ? p.name : titles[view];
  $('crumb').textContent = p ? tr("Playlist") : {favorites:tr("Favorites"),history:tr("History"),library:tr("Library"),folders:tr("Folders"),operations:tr("Operation log"),health:tr("Collection health"),stats:tr("Statistics"),settings:tr("Settings")}[view];
  $('pageDescription').textContent = p ? tr("Put your mood into a sequence.") : {favorites:tr("Your favorite music in one place. Shared across server devices."),history:tr("What you listened to. Saved positions and devices."),library:tr("Favorite records. Your order. Always within reach."),folders:tr("Your collection, in a familiar order."),operations:tr("Change history and safe undo."),health:tr("File availability, duplicates, and background check results."),stats:tr("Your collection and server activity in real time."),settings:tr("Make the music server your own.")}[view];
  $('libraryList').disabled = !!p;
  if (['stats','health','operations'].includes(view)) $('serverNavigation').open = true;
  const scope = !p && homeMode === 'table' ? tableScopeInfo() : null;
  if (!p && view === 'library' && homeMode === 'collection') { $('pageTitle').textContent = tr("Your collection"); $('crumb').textContent = tr("Collection"); $('pageDescription').textContent = tr("Albums, artists, and favorite music. All from your storage."); }
  if (scope && view === 'library') { $('pageTitle').textContent = scope.title; $('crumb').textContent = scope.kind === 'album' ? tr("Album") : tr("Artist"); }
  $('collectionTitle').textContent = p ? p.name : scope ? scope.title : ({all:tr("All tracks"),favorites:tr("Favorites"),recent:tr("Recently played"),frequent:tr("Frequently played"),added:tr("Recently added")}[$('libraryList').value] || tr("All tracks"));
  for (const id of ['exportButton','renamePlaylist','deletePlaylist','removeButton']) $(id).hidden = !p;
}
function showView(next, id = null) {
  view = next; playlistId = id; tableScope = null; selected.clear(); limit = 150;
  if (next === 'favorites') { $('collectionSearch').value = ''; $('libraryList').value = 'favorites'; $('folderFilter').value = '*'; $('search').value = ''; }
  else if (next === 'library') { $('libraryList').value = 'all'; if (!id) { collectionRoute = {page:'overview'}; $('collectionSearch').value = ''; } }
  updateHomeLayout();
  renderNav(); renderTracks();
  globalThis.appLayout?.onNavigate();
  if (view === 'history') loadHistory(true).catch(e => toast(e.message));
  if (view === 'operations') loadOperations().catch(e => toast(e.message));
  if (view === 'health') loadHealth().catch(e => toast(e.message));
  if (view === 'stats') updateStats().catch(e => toast(e.message));
}
function renderTracks() {
  globalThis.appLayout?.refreshFilters();
  visible = filteredTracks();
  $('resultCount').textContent = tr('{count} entries', {count:visible.length});
  const manual = canReorderTracks();
  $('orderHint').textContent = tableScope ? tr("Open the full library to reorder freely. This view follows the album track order.") : manual ? ('⠿ ' + tr("Drag a row or use the arrows to change the order")) : tr("For manual ordering, select “All tracks” or “Favorites” and “Custom order”");
  $('tracks').innerHTML = visible.slice(0, limit).map((t, i) => `<tr data-id="${t.id}" draggable="${manual}" class="${t.id === currentId ? 'playing' : ''}">
  <td class="check-cell"><input type="checkbox" data-select="${t.id}" aria-label="${escapeHTML(tr("Select"))} ${escapeHTML(t.title)}" ${selected.has(t.id) ? 'checked' : ''}></td>
  <td class="number-cell"><span class="drag-handle" title="${escapeHTML(tr("Drag"))}">${t.id === currentId && !audio.paused ? '♫' : i + 1}</span></td>
  <td><div class="track-info"><div class="mini-cover">${coverHTML(t)}</div><button class="icon favorite-button" data-favorite="${t.id}" aria-label="${escapeHTML(t.favorite ? tr("Remove from favorites") : tr("Add to favorites"))}" aria-pressed="${!!t.favorite}" ${favoriteBusy.has(t.id) ? 'disabled' : ''}>${t.favorite ? '♥' : '♡'}</button><div class="track-copy"><button class="track-name" data-play="${t.id}" title="${escapeHTML(t.path)}">${escapeHTML(t.title)}</button><span class="track-artist">${escapeHTML(t.artist || tr("Unknown artist"))}</span></div></div></td>
  <td class="album-cell">${escapeHTML(t.album || '—')}${t.metadata_error ? '<span class="metadata-warning" title="' + escapeHTML(MusicI18n.message(t.metadata_error)) + '"> ⚠</span>' : ''}</td><td class="folder-cell">${escapeHTML(folderLabel(folderOf(t)))}</td><td class="size-cell">${clock(t.duration || 0)}<small class="technical-size">${bytes(t.size)}</small></td>
  <td><div class="row-actions"><button class="icon" data-track-actions="${t.id}" aria-haspopup="dialog" aria-controls="trackActionsDialog" aria-label="${escapeHTML(tr('Actions for {title}',{title:t.title}))}">⋯</button></div></td></tr>`).join('');
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('h2').textContent = state.tracks.length ? tr("No tracks here yet") : tr("Your collection starts here");
  $('empty').querySelector('p').textContent = state.tracks.length ? tr("Change the filters or add tracks to this playlist.") : tr("Upload audio files or add them to the server folder. MP3, FLAC, OGG, WAV, M4A, and other formats.");
  $('loadMore').hidden = visible.length <= limit;
  renderSelection();
  renderCollection();
}
function renderSelection() {
  $('selectionBar').hidden = !selected.size;
  $('selectionCount').textContent = tr('Selected: {count}', {count:selected.size});
  $('selectAll').checked = !!visible.length && visible.every(t => selected.has(t.id));
  $('selectAll').indeterminate = visible.some(t => selected.has(t.id)) && !$('selectAll').checked;
  $('addButton').disabled = !state.playlists.length;
}
function renderFolders() {
  $('folderGrid').innerHTML = state.folders.map((folder, i) => `<button class="folder-card" data-folder-index="${i}"><span>▱</span><b>${escapeHTML(folderLabel(folder))}</b><small>${state.tracks.filter(t => !folder || folderOf(t) === folder || folderOf(t).startsWith(folder + '/')).length} ${escapeHTML(tr("tracks"))}</small></button>`).join('');
}
