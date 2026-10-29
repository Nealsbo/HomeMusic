/* Client-side catalog grouping. Album identity includes album artist and release year. */
(function(root) {
  'use strict';
  const norm = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase('ru');
  const collator = new Intl.Collator('ru',{numeric:true,sensitivity:'base'});
  const compare = (a,b) => collator.compare(String(a || ''),String(b || ''));
  const folder = track => track.path.includes('/') ? track.path.slice(0,track.path.lastIndexOf('/')) : '';
  const disc = track => Number(track.disc_number) > 0 ? Number(track.disc_number) : 1;
  const orderTracks = (a,b) => disc(a) - disc(b) ||
    ((Number(a.track_number) > 0 ? Number(a.track_number) : Infinity) -
     (Number(b.track_number) > 0 ? Number(b.track_number) : Infinity)) || compare(a.path,b.path) || compare(a.id,b.id);
  class MusicCatalog {
    constructor(tracks = []) {
      this.albums = new Map(); this.artists = new Map(); this.trackAlbums = new Map();
      for (const track of tracks) {
        const album = String(track.album || '').trim(), artist = String(track.album_artist || track.artist || '').trim();
        // Untagged albums are kept within their source folder instead of merging
        // unrelated files from the whole storage into one fabricated album.
        const key = JSON.stringify([norm(artist),norm(album),norm(track.year),album ? '' : folder(track)]);
        if (!this.albums.has(key)) this.albums.set(key,{key,title:album || 'Без альбома',artist:artist || 'Неизвестный исполнитель',
          artistName:artist,year:String(track.year || '').trim(),folder:album ? '' : folder(track),tracks:[],cover_id:''});
        const release = this.albums.get(key);
        release.tracks.push(track); if (!release.cover_id && track.cover_id) release.cover_id = track.cover_id;
        this.trackAlbums.set(track.id,key);
        const names = new Map();
        for (const value of [String(track.artist || '').trim(),artist]) if (value) names.set(norm(value),value);
        if (!names.size) names.set('','Неизвестный исполнитель');
        for (const [artistKey,name] of names) {
          if (!this.artists.has(artistKey)) this.artists.set(artistKey,{key:artistKey,name,tracks:[],albumKeys:new Set(),cover_id:''});
          const person = this.artists.get(artistKey);
          person.tracks.push(track); person.albumKeys.add(key); if (!person.cover_id && track.cover_id) person.cover_id = track.cover_id;
        }
      }
      for (const album of this.albums.values()) {
        album.tracks.sort(orderTracks);
        album.searchText = norm([album.title,album.artist,album.year,album.folder,...new Set(album.tracks.map(t => t.artist || ''))].join(' '));
        album.duration = album.tracks.reduce((sum,t) => sum + (Number(t.duration) || 0),0);
        album.discs = new Set(album.tracks.map(disc)).size;
        album.added = album.tracks.reduce((value,t) => Math.max(value,Number(t.added) || 0),0);
      }
      for (const artist of this.artists.values()) artist.tracks.sort((a,b) => {
        const left = this.albums.get(this.trackAlbums.get(a.id)), right = this.albums.get(this.trackAlbums.get(b.id));
        return compare(right.year,left.year) || compare(left.title,right.title) || compare(left.key,right.key) || orderTracks(a,b);
      });
    }
    albumList(query = '') {
      const search = norm(query);
      return [...this.albums.values()].filter(a => !search || a.searchText.includes(search))
        .sort((a,b) => compare(a.artist,b.artist) || compare(a.title,b.title) || compare(a.year,b.year) || compare(a.key,b.key));
    }
    artistList(query = '') {
      const search = norm(query);
      return [...this.artists.values()].filter(a => !search || norm(a.name).includes(search)).sort((a,b) => compare(a.name,b.name));
    }
    artistAlbums(key) {
      const artist = this.artists.get(key);
      return artist ? [...artist.albumKeys].map(id => this.albums.get(id)).sort((a,b) => compare(b.year,a.year) || compare(a.title,b.title)) : [];
    }
  }
  MusicCatalog.normalize = norm;
  MusicCatalog.compare = compare;
  MusicCatalog.orderTracks = orderTracks;
  MusicCatalog.disc = disc;
  root.MusicCatalog = MusicCatalog;
  if (typeof module !== 'undefined' && module.exports) module.exports = MusicCatalog;
})(globalThis);
