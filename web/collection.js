function reconcileCatalogNavigation(previous) {
  function remap(kind,key) {
    const current = kind === 'album' ? catalog.albums : catalog.artists;
    if (current.has(key)) return key;
    const old = (kind === 'album' ? previous.albums : previous.artists).get(key);
    if (!old) return key;
    const candidates = new Set(old.tracks.filter(t => trackMap.has(t.id)).map(t => kind === 'album' ? catalog.trackAlbums.get(t.id) :
      MusicCatalog.normalize(trackMap.get(t.id).artist || trackMap.get(t.id).album_artist || '')));
    return candidates.size === 1 && current.has([...candidates][0]) ? [...candidates][0] : key;
  }
  if (['album','artist','artist-albums'].includes(collectionRoute.page)) collectionRoute.key = remap(collectionRoute.page === 'album' ? 'album' : 'artist',collectionRoute.key);
  if (tableScope) tableScope.key = remap(tableScope.kind,tableScope.key);
}
/* Two home layouts share the existing audio element, queue and library state. */
function tableScopeInfo() {
  if (!tableScope) return null;
  const entity = tableScope.kind === 'album' ? catalog.albums.get(tableScope.key) : catalog.artists.get(tableScope.key);
  return entity ? {kind:tableScope.kind,entity,title:tableScope.kind === 'album' ? entity.title : entity.name,tracks:entity.tracks} :
    {kind:tableScope.kind,title:'Запись больше не найдена',tracks:[]};
}
function updateHomeLayout() {
  const home = view === 'library' || view === 'favorites';
  const collection = home && !playlistId && homeMode === 'collection';
  $('librarySummary').hidden = !home;
  $('wavePanel').hidden = !home;
  audioWave.sync();
  $('libraryView').hidden = !home || collection;
  $('collectionView').hidden = !collection;
  for (const name of ['folders','stats','settings','history','health','operations']) $(name + 'View').hidden = view !== name;
  const effective = home && playlistId ? 'table' : homeMode;
  $('tableMode').setAttribute('aria-pressed',String(effective === 'table'));
  $('collectionMode').setAttribute('aria-pressed',String(effective === 'collection'));
  $('homeModeSetting').value = homeMode;
  const scope = !playlistId && !collection ? tableScopeInfo() : null;
  $('tableScopeBar').hidden = !scope;
  $('tableScopeName').textContent = scope ? `${scope.kind === 'album' ? 'Альбом' : 'Исполнитель'}: ${scope.title}` : '';
}
function setHomeMode(mode, navigate = true) {
  homeMode = mode === 'collection' ? 'collection' : 'table';
  store('homeMode',homeMode);
  if (navigate && (!['library','favorites'].includes(view) || playlistId)) {
    showView('library');
    return;
  }
  renderNav(); renderTracks();
}
function openCollectionPage(page, key = '') {
  const pages = ['overview','albums','artists','artist-albums','album','artist','favorites','recent','frequent','added','tracks'];
  if (!pages.includes(page)) return;
  collectionRoute = {page,key}; collectionLimit = 48;
  view = page === 'favorites' ? 'favorites' : 'library'; playlistId = null;
  homeMode = 'collection'; store('homeMode',homeMode);
  renderNav(); renderTracks();
  $('collectionView').scrollIntoView?.({block:'start'});
  $('collectionContent').focus?.({preventScroll:true});
}
function collectionRouteInfo(full = false, override = null) {
  const route = override || (view === 'favorites' ? {page:'favorites'} : collectionRoute);
  const names = {overview:'Коллекция',tracks:'Все треки',favorites:'Избранное',recent:'Недавно прослушанное',frequent:'Часто включаемое',added:'Недавно добавленное'};
  let tracks = [...state.tracks], title = names[route.page] || 'Коллекция', entity = null;
  if (route.page === 'album') { entity = catalog.albums.get(route.key); tracks = entity?.tracks || []; title = entity?.title || 'Альбом не найден'; }
  if (route.page === 'artist' || route.page === 'artist-albums') { entity = catalog.artists.get(route.key); tracks = entity?.tracks || []; title = entity?.name || 'Исполнитель не найден'; }
  if (route.page === 'favorites') tracks = tracks.filter(t => t.favorite);
  if (route.page === 'recent' || route.page === 'frequent') tracks = tracks.filter(t => t.play_count > 0);
  if (route.page === 'recent') tracks.sort((a,b) => b.last_played - a.last_played);
  if (route.page === 'frequent') tracks.sort((a,b) => b.play_count - a.play_count || b.last_played - a.last_played);
  if (route.page === 'added') tracks.sort((a,b) => b.added - a.added);
  const query = MusicCatalog.normalize($('collectionSearch').value);
  if (!full && query) tracks = tracks.filter(t => MusicCatalog.normalize([t.title,t.artist,t.album,t.album_artist,t.genre,t.year,t.path].join(' ')).includes(query));
  return {...route,title,entity,tracks};
}
function albumCard(album) {
  return `<button class="music-card album-card" data-album="${escapeHTML(album.key)}" title="${escapeHTML(album.title + ' · ' + album.artist)}"><span class="album-art">${coverHTML(album)}</span><strong>${escapeHTML(album.title)}</strong><span>${escapeHTML(album.artist)}</span><small>${escapeHTML(album.year || album.folder || 'Без года')} · треков: ${album.tracks.length}</small></button>`;
}
function artistCard(artist) {
  const art = artist.cover_id ? coverHTML(artist) : escapeHTML(Array.from(artist.name)[0]?.toLocaleUpperCase('ru') || '?');
  return `<button class="music-card artist-card" data-artist="${escapeHTML(artist.key)}"><span class="artist-art">${art}</span><strong>${escapeHTML(artist.name)}</strong><small>Альбомов: ${artist.albumKeys.size} · треков: ${artist.tracks.length}</small></button>`;
}
function collectionTrackRows(tracks, {album = false, compact = false, showDiscs = false} = {}) {
  let disc = null;
  return tracks.map((track,index) => {
    const separator = showDiscs && MusicCatalog.disc(track) !== disc ? `<div class="disc-separator">Диск ${MusicCatalog.disc(track)}</div>` : '';
    disc = MusicCatalog.disc(track);
    return separator + `<div class="collection-track ${track.id === currentId ? 'playing' : ''}"><span class="collection-track-number">${album && track.track_number ? track.track_number : index + 1}</span><div class="mini-cover">${coverHTML(track)}</div><button class="collection-track-title" data-cplay="${escapeHTML(track.id)}"><b>${escapeHTML(track.title)}</b><small>${escapeHTML(track.artist || 'Неизвестный исполнитель')}${!compact && track.album ? ' · ' + escapeHTML(track.album) : ''}</small></button><span class="collection-duration">${clock(track.duration || 0)}</span><button class="icon favorite-button" data-cfavorite="${escapeHTML(track.id)}" aria-label="${track.favorite ? 'Убрать из избранного' : 'В избранное'}" aria-pressed="${!!track.favorite}" ${favoriteBusy.has(track.id) ? 'disabled' : ''}>${track.favorite ? '♥' : '♡'}</button><button class="icon" data-cnext="${escapeHTML(track.id)}" title="Следующим">↳</button><button class="icon" data-cappend="${escapeHTML(track.id)}" title="В конец очереди">＋</button></div>`;
  }).join('');
}
function collectionShelf(title, page, tracks) {
  return `<section class="collection-shelf"><div class="shelf-heading"><h2>${title}</h2><button class="text-button" data-collection-page="${page}">Все <span class="button-icon" aria-hidden="true">→</span></button></div><div class="collection-track-list" data-shelf="${page}">${tracks.length ? collectionTrackRows(tracks.slice(0,6),{compact:true}) : '<p class="shelf-empty">Пока нет записей</p>'}</div></section>`;
}
function emptyCollection(message = 'Добавьте аудиофайлы, чтобы увидеть альбомы и исполнителей.') {
  return `<div class="empty collection-empty"><div>♫</div><h2>${state.tracks.length ? 'Ничего не найдено' : 'Ваша коллекция начинается здесь'}</h2><p>${escapeHTML(message)}</p>${state.tracks.length ? '' : '<button class="secondary" data-collection-upload>Загрузить музыку</button>'}</div>`;
}
function renderCollection() {
  if ($('collectionView').hidden) return;
  const info = collectionRouteInfo(), query = $('collectionSearch').value.trim();
  $('collectionSearch').placeholder = info.page === 'albums' || info.page === 'artist-albums' ? 'Альбом, исполнитель, год…' : info.page === 'artists' ? 'Имя исполнителя…' : 'Название, исполнитель, альбом…';
  $('collectionContent').setAttribute('aria-label',info.title);
  const protectedAlbums = state.tracks.filter(t => !t.album && t.metadata_overrides?.includes('album')).length;
  $('collectionIndexStatus').textContent = $('indexStatus').textContent + (protectedAlbums ? ` · У ${protectedAlbums} треков поле альбома защищено. Применить теги можно через «Вернуть данные из тегов» в таблице.` : '');
  document.querySelectorAll('.collection-tab').forEach(button => {
    button.classList.toggle('active',button.dataset.collectionPage === ({album:'albums',artist:'artists','artist-albums':'artists'}[info.page] || info.page));
    button.setAttribute('aria-pressed',String(button.dataset.collectionPage === ({album:'albums',artist:'artists','artist-albums':'artists'}[info.page] || info.page)));
  });
  $('collectionMore').hidden = true;
  let html = '';
  if (info.page === 'overview') {
    if (!state.tracks.length) html = emptyCollection();
    else if (query) {
      const albums = catalog.albumList(query), artists = catalog.artistList(query);
      html = `<div class="shelf-heading"><h2>Результаты поиска</h2><button class="text-button" data-collection-page="tracks">Все найденные треки <span class="button-icon" aria-hidden="true">→</span></button></div>`;
      if (albums.length) html += `<section class="collection-shelf"><h2>Альбомы</h2><div class="music-grid">${albums.slice(0,8).map(albumCard).join('')}</div></section>`;
      if (artists.length) html += `<section class="collection-shelf"><h2>Исполнители</h2><div class="music-grid">${artists.slice(0,8).map(artistCard).join('')}</div></section>`;
      html += info.tracks.length ? `<div class="collection-track-list">${collectionTrackRows(info.tracks.slice(0,12))}</div>` : '';
      if (!albums.length && !artists.length && !info.tracks.length) html += emptyCollection('Попробуйте другое название, исполнителя или альбом.');
    } else {
      const added = catalog.albumList().sort((a,b) => b.added - a.added || MusicCatalog.compare(a.title,b.title));
      const recent = state.tracks.filter(t => t.play_count > 0).sort((a,b) => b.last_played - a.last_played);
      const frequent = state.tracks.filter(t => t.play_count > 0).sort((a,b) => b.play_count - a.play_count || b.last_played - a.last_played);
      const favorites = state.tracks.filter(t => t.favorite);
      html = `<section class="collection-shelf"><div class="shelf-heading"><h2>Недавно добавленные альбомы</h2><button class="text-button" data-collection-page="albums">Все альбомы <span class="button-icon" aria-hidden="true">→</span></button></div><div class="music-grid">${added.slice(0,8).map(albumCard).join('')}</div></section>`;
      html += `<div class="collection-columns">${collectionShelf('Недавно прослушанное','recent',recent)}${collectionShelf('Избранное','favorites',favorites)}</div>`;
      html += collectionShelf('Часто включаемое','frequent',frequent);
      html += `<div class="collection-bottom-links"><button class="secondary" data-collection-page="tracks">Все треки</button><button class="secondary" data-collection-page="added">Недавно добавленные треки</button><button class="text-button" data-collection-history>Полная история прослушивания <span class="button-icon" aria-hidden="true">→</span></button></div>`;
    }
  } else if (info.page === 'albums' || info.page === 'artists' || info.page === 'artist-albums') {
    const albumsPage = info.page !== 'artists';
    const items = info.page === 'artist-albums' ? catalog.artistAlbums(info.key).filter(a => !query || a.searchText.includes(MusicCatalog.normalize(query))) : albumsPage ? catalog.albumList(query) : catalog.artistList(query);
    html = (info.page === 'artist-albums' ? `<button class="text-button" data-artist="${escapeHTML(info.key)}"><span class="button-icon" aria-hidden="true">←</span> К исполнителю</button>` : '') + `<div class="shelf-heading"><h2>${info.page === 'artist-albums' ? 'Альбомы: ' + escapeHTML(info.title) : albumsPage ? 'Альбомы' : 'Исполнители'}</h2><span class="muted">Найдено: ${items.length}</span></div><div class="music-grid">${items.slice(0,collectionLimit).map(albumsPage ? albumCard : artistCard).join('')}</div>`;
    if (!items.length) html += emptyCollection();
    $('collectionMore').hidden = items.length <= collectionLimit;
  } else {
    if ((info.page === 'album' || info.page === 'artist') && !info.entity) {
      html = `<button class="text-button" data-collection-page="${info.page === 'album' ? 'albums' : 'artists'}"><span class="button-icon" aria-hidden="true">←</span> Назад</button>` + emptyCollection('Данные могли измениться после сканирования. Откройте список заново.');
    } else {
      if (info.page === 'album' || info.page === 'artist') {
        const entity = info.entity, album = info.page === 'album';
        const art = entity.cover_id ? coverHTML(entity) : album ? '♫' : escapeHTML(Array.from(entity.name)[0]?.toLocaleUpperCase('ru') || '?');
        const description = album ? [entity.artist,entity.year,`треков: ${entity.tracks.length}`,clock(entity.duration),entity.discs > 1 ? `дисков: ${entity.discs}` : ''].filter(Boolean).join(' · ') : `Альбомов: ${entity.albumKeys.size} · треков: ${entity.tracks.length}`;
        html = `<button class="text-button" data-collection-page="${album ? 'albums' : 'artists'}"><span class="button-icon" aria-hidden="true">←</span> ${album ? 'К альбомам' : 'К исполнителям'}</button><div class="release-detail"><div class="release-art ${album ? '' : 'round'}">${art}</div><div class="release-info"><div class="eyebrow">${album ? 'АЛЬБОМ' : 'ИСПОЛНИТЕЛЬ'}</div><h2>${escapeHTML(info.title)}</h2><p>${escapeHTML(description)}</p>${album ? `<button class="text-button release-artist-link" data-artist="${escapeHTML(MusicCatalog.normalize(entity.artistName))}">${escapeHTML(entity.artist)}</button>` : ''}<div class="release-actions"><button class="primary" data-collection-play-all><span class="button-icon" aria-hidden="true">▶</span> ${album ? 'Слушать альбом' : 'Слушать исполнителя'}</button><button class="secondary" data-collection-append-all><span class="button-icon" aria-hidden="true">＋</span> В очередь</button><button class="text-button" data-collection-table>Открыть в таблице <span class="button-icon" aria-hidden="true">→</span></button></div></div></div>`;
        if (!album) {
          const albums = catalog.artistAlbums(entity.key);
          html += `<section class="collection-shelf"><h2>Альбомы</h2><div class="music-grid">${albums.slice(0,12).map(albumCard).join('')}</div>${albums.length > 12 ? '<button class="text-button" data-collection-artist-albums>Показать все альбомы исполнителя <span class="button-icon" aria-hidden="true">→</span></button>' : ''}</section>`;
        }
      } else html = `<div class="shelf-heading"><h2>${escapeHTML(info.title)}</h2><span class="muted">Треков: ${info.tracks.length}</span></div><div class="release-actions"><button class="primary" data-collection-play-all ${info.tracks.length ? '' : 'disabled'}><span class="button-icon" aria-hidden="true">▶</span> Слушать всё</button><button class="secondary" data-collection-append-all ${info.tracks.length ? '' : 'disabled'}><span class="button-icon" aria-hidden="true">＋</span> В очередь</button></div>`;
      const multipleDiscs = info.page === 'album' && info.entity.discs > 1;
      html += info.tracks.length ? `<div class="collection-track-list">${collectionTrackRows(info.tracks.slice(0,collectionLimit),{album:info.page === 'album',showDiscs:multipleDiscs})}</div>` : emptyCollection('В этом разделе пока нет треков или они не соответствуют поиску.');
      $('collectionMore').hidden = info.tracks.length <= collectionLimit;
    }
  }
  $('collectionContent').innerHTML = html;
}
function openCollectionInTable() {
  const info = collectionRouteInfo(true);
  if (!info.entity || !['album','artist'].includes(info.page)) return;
  tableScope = {kind:info.page,key:info.key}; selected.clear(); limit = 150;
  $('search').value = ''; $('folderFilter').value = '*'; $('sort').value = 'manual';
  setHomeMode('table');
}
$('tableMode').onclick = () => setHomeMode('table');
$('collectionMode').onclick = () => setHomeMode('collection');
$('homeModeSetting').onchange = event => setHomeMode(event.target.value,false);
$('clearTableScope').onclick = () => { tableScope = null; renderNav(); renderTracks(); };
$('collectionSearch').oninput = () => { collectionLimit = 48; renderCollection(); };
$('collectionMore').onclick = () => { collectionLimit += 48; renderCollection(); };
$('collectionView').onclick = handle(async event => {
  const button = event.target.closest('button'); if (!button) return;
  const d = button.dataset;
  if (d.collectionPage !== undefined) return openCollectionPage(d.collectionPage);
  if (d.album !== undefined) return openCollectionPage('album',d.album);
  if (d.artist !== undefined) return openCollectionPage('artist',d.artist);
  if (d.collectionUpload !== undefined) return $('uploadButton').click();
  if (d.collectionHistory !== undefined) return showView('history');
  if (d.collectionTable !== undefined) return openCollectionInTable();
  if (d.cfavorite) return toggleFavorite(d.cfavorite);
  if (d.cnext) return enqueue([d.cnext],true);
  if (d.cappend) return enqueue([d.cappend]);
  const full = d.collectionPlayAll !== undefined || d.collectionAppendAll !== undefined;
  const shelf = button.closest?.('[data-shelf]')?.dataset.shelf;
  const context = collectionRouteInfo(full,shelf ? {page:shelf} : null);
  if (d.collectionArtistAlbums !== undefined && context.page === 'artist') return openCollectionPage('artist-albums',context.key);
  if (d.collectionAppendAll !== undefined) {
    if (!queueModel.order.length) { queueName = context.title; queuePlaylistId = null; }
    return enqueue(context.tracks.map(t => t.id));
  }
  if (d.cplay || d.collectionPlayAll !== undefined) {
    const tracks = context.tracks;
    const id = d.cplay || tracks[0]?.id;
    if (id && tracks.some(t => t.id === id)) return playTrack(id,tracks.map(t => t.id),0,context.title);
  }
});
