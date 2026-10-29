function renderNav() {
  updateHomeLayout();
  document.querySelectorAll('.nav').forEach(el => el.classList.toggle('active', view === el.dataset.view && !playlistId));
  $('playlists').innerHTML = state.playlists.map(p => `<button class="playlist-button ${p.id === playlistId ? 'active' : ''}" data-playlist="${p.id}"><span class="button-icon" aria-hidden="true">☷</span> &nbsp; ${escapeHTML(p.name)} <small>(${p.tracks.length})</small></button>`).join('');
  const p = state.playlists.find(p => p.id === playlistId);
  const titles = {favorites:'Ваше избранное', history:'История прослушивания', library:'Ваша медиатека', folders:'Всё по папкам', operations:'Журнал операций',health:'Состояние коллекции', stats:'Музыка в цифрах', settings:'Ваше пространство'};
  $('pageTitle').textContent = p ? p.name : titles[view];
  $('crumb').textContent = p ? 'Плейлист' : {favorites:'Избранное',history:'История',library:'Медиатека',folders:'Папки',operations:'Журнал операций',health:'Состояние коллекции',stats:'Статистика',settings:'Настройки'}[view];
  $('pageDescription').textContent = p ? 'Соберите настроение в одну последовательность.' : {favorites:'Любимая музыка в одном месте. Для всех устройств сервера.',history:'То, что вы слушали. Сохранённые позиции и устройства.',library:'Любимые записи. Свой порядок. Всегда под рукой.',folders:'Ваша коллекция в привычном порядке.',operations:'История изменений и безопасная отмена действий.',health:'Доступность файлов, дубликаты и результаты фоновой проверки.',stats:'Коллекция и работа сервера в реальном времени.',settings:'Настройте музыкальный сервер под себя.'}[view];
  $('libraryList').disabled = !!p;
  const scope = !p && homeMode === 'table' ? tableScopeInfo() : null;
  if (!p && view === 'library' && homeMode === 'collection') { $('pageTitle').textContent = 'Ваша коллекция'; $('crumb').textContent = 'Коллекция'; $('pageDescription').textContent = 'Альбомы, исполнители и любимая музыка. Всё из вашего хранилища.'; }
  if (scope && view === 'library') { $('pageTitle').textContent = scope.title; $('crumb').textContent = scope.kind === 'album' ? 'Альбом' : 'Исполнитель'; }
  $('collectionTitle').textContent = p ? p.name : scope ? scope.title : ({all:'Все треки',favorites:'Избранное',recent:'Недавно прослушанное',frequent:'Часто включаемое',added:'Недавно добавленное'}[$('libraryList').value] || 'Все треки');
  for (const id of ['exportButton','renamePlaylist','deletePlaylist','removeButton']) $(id).hidden = !p;
}
function showView(next, id = null) {
  view = next; playlistId = id; tableScope = null; selected.clear(); limit = 150;
  if (next === 'favorites') { $('collectionSearch').value = ''; $('libraryList').value = 'favorites'; $('folderFilter').value = '*'; $('search').value = ''; }
  else if (next === 'library') { $('libraryList').value = 'all'; if (!id) { collectionRoute = {page:'overview'}; $('collectionSearch').value = ''; } }
  updateHomeLayout();
  renderNav(); renderTracks();
  if (view === 'history') loadHistory(true).catch(e => toast(e.message));
  if (view === 'operations') loadOperations().catch(e => toast(e.message));
  if (view === 'health') loadHealth().catch(e => toast(e.message));
  if (view === 'stats') updateStats().catch(e => toast(e.message));
}
function renderTracks() {
  visible = filteredTracks();
  $('resultCount').textContent = visible.length + ' записей';
  const manual = canReorderTracks();
  $('orderHint').textContent = tableScope ? 'Для свободной перестановки откройте всю медиатеку. Здесь порядок задаётся данными альбома.' : manual ? '⠿ Перетащите строку или используйте стрелки для изменения порядка' : 'Для ручного порядка выберите «Все треки» или «Избранное» и «Свой порядок»';
  $('tracks').innerHTML = visible.slice(0, limit).map((t, i) => `<tr data-id="${t.id}" draggable="${manual}" class="${t.id === currentId ? 'playing' : ''}">
  <td class="check-cell"><input type="checkbox" data-select="${t.id}" aria-label="Выбрать ${escapeHTML(t.title)}" ${selected.has(t.id) ? 'checked' : ''}></td>
  <td class="number-cell"><span class="drag-handle" title="Перетащить">${t.id === currentId && !audio.paused ? '♫' : i + 1}</span></td>
  <td><div class="track-info"><div class="mini-cover">${coverHTML(t)}</div><button class="icon favorite-button" data-favorite="${t.id}" aria-label="${t.favorite ? 'Убрать из избранного' : 'В избранное'}" aria-pressed="${!!t.favorite}" ${favoriteBusy.has(t.id) ? 'disabled' : ''}>${t.favorite ? '♥' : '♡'}</button><div class="track-copy"><button class="track-name" data-play="${t.id}" title="${escapeHTML(t.path)}">${escapeHTML(t.title)}</button><span class="track-artist">${escapeHTML(t.artist || 'Неизвестный исполнитель')}</span></div></div></td>
  <td class="album-cell">${escapeHTML(t.album || '—')}${t.metadata_error ? '<span class="metadata-warning" title="' + escapeHTML(t.metadata_error) + '"> ⚠</span>' : ''}</td><td class="folder-cell">${escapeHTML(folderOf(t) || 'Корневая')}</td><td class="size-cell">${clock(t.duration || 0)}<small class="technical-size">${bytes(t.size)}</small></td>
  <td><div class="row-actions"><button class="icon" data-enqueue-next="${t.id}" title="Воспроизвести следующим">↳</button><button class="icon" data-enqueue-end="${t.id}" title="В конец очереди">＋</button><button class="icon" data-up="${t.id}" title="Выше" ${!manual || i === 0 ? 'disabled' : ''}>↑</button><button class="icon" data-down="${t.id}" title="Ниже" ${!manual || i === visible.length - 1 ? 'disabled' : ''}>↓</button><button class="icon" data-edit="${t.id}" title="Редактировать">⋯</button></div></td></tr>`).join('');
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('h2').textContent = state.tracks.length ? 'Здесь пока нет треков' : 'Здесь начинается ваша коллекция';
  $('empty').querySelector('p').textContent = state.tracks.length ? 'Измените фильтры или добавьте записи в этот плейлист.' : 'Загрузите аудиофайлы или добавьте их в папку сервера. MP3, FLAC, OGG, WAV, M4A и другие форматы.';
  $('loadMore').hidden = visible.length <= limit;
  renderSelection();
  renderCollection();
}
function renderSelection() {
  $('selectionBar').hidden = !selected.size;
  $('selectionCount').textContent = `Выбрано: ${selected.size}`;
  $('selectAll').checked = !!visible.length && visible.every(t => selected.has(t.id));
  $('selectAll').indeterminate = visible.some(t => selected.has(t.id)) && !$('selectAll').checked;
  $('addButton').disabled = !state.playlists.length;
}
function renderFolders() {
  $('folderGrid').innerHTML = state.folders.map((folder, i) => `<button class="folder-card" data-folder-index="${i}"><span>▱</span><b>${escapeHTML(folder || 'Корневая папка')}</b><small>${state.tracks.filter(t => !folder || folderOf(t) === folder || folderOf(t).startsWith(folder + '/')).length} треков</small></button>`).join('');
}
