const {test} = require('node:test');
const assert = require('node:assert/strict');
const Catalog = require('../web/catalog.js');
const track = (id,values={}) => ({id,path:id + '.mp3',title:id,artist:'Band',album:'Album',year:'2000',track_number:0,disc_number:0,...values});

test('same title by different album artists or in different years remains separate', () => {
  const catalog = new Catalog([track('a'),track('b',{artist:'Other'}),track('c',{year:'2001'})]);
  assert.equal(catalog.albums.size,3);
});

test('compilation tracks and different disc folders group by album artist', () => {
  const catalog = new Catalog([
    track('b',{path:'Disc2/01.mp3',artist:'Singer B',album_artist:'Various',disc_number:2,track_number:1}),
    track('a',{path:'Disc1/01.mp3',artist:'Singer A',album_artist:'Various',disc_number:1,track_number:1})
  ]);
  assert.equal(catalog.albums.size,1);
  const album = catalog.albumList()[0];
  assert.deepEqual(album.tracks.map(t => t.id),['a','b']);
  assert.equal(album.discs,2);
  assert.equal(catalog.artists.get('various').tracks.length,2);
  assert.equal(catalog.artists.get('singer a').tracks.length,1);
  assert.equal(catalog.albumList('Singer A').length,1);
  assert.equal(catalog.artistAlbums('singer a')[0].key,album.key);
});

test('disc and track numbers take priority over filenames; missing numbers sort last', () => {
  const source = [track('missing',{path:'00.mp3'}),track('two',{path:'a.mp3',track_number:2}),
    track('disc2',{disc_number:2,track_number:1}),track('one',{path:'z.mp3',track_number:1})];
  const catalog = new Catalog(source);
  assert.deepEqual(catalog.albumList()[0].tracks.map(t => t.id),['one','two','missing','disc2']);
  assert.deepEqual(source.map(t => t.id),['missing','two','disc2','one']);
});

test('untagged albums stay separated by storage folder and unknown artist is navigable', () => {
  const catalog = new Catalog([track('a',{album:'',artist:'',path:'One/a.mp3'}),track('b',{album:'',artist:'',path:'Two/b.mp3'})]);
  assert.equal(catalog.albums.size,2);
  assert.equal(catalog.artists.get('').name,'Неизвестный исполнитель');
  assert.equal(catalog.artists.get('').tracks.length,2);
});

test('normalized case and whitespace group the same album without duplicating artist membership', () => {
  const catalog = new Catalog([track('a',{artist:'Band',album_artist:'band',album:' Album '}),track('b',{artist:' BAND ',album:'album'})]);
  assert.equal(catalog.albums.size,1);
  assert.equal(catalog.artists.size,1);
  assert.equal(catalog.artists.get('band').tracks.length,2);
});

test('search is case insensitive and sorting uses numeric album names', () => {
  const catalog = new Catalog([track('a',{album:'Album 10',artist:'Артист'}),track('b',{album:'Album 2',artist:'Артист'})]);
  assert.deepEqual(catalog.albumList('АРТИСТ').map(a => a.title),['Album 2','Album 10']);
  assert.equal(catalog.artistList('арТиСт').length,1);
  assert.equal(catalog.albumList('missing').length,0);
});

test('cover, total duration and newest addition are derived from grouped tracks', () => {
  const catalog = new Catalog([track('a',{duration:20,added:5}),track('b',{duration:30,added:10,cover_id:'a'.repeat(64)})]);
  const album = catalog.albumList()[0];
  assert.equal(album.duration,50);
  assert.equal(album.added,10);
  assert.equal(album.cover_id,'a'.repeat(64));
});

test('large untagged collections do not spread arrays into function arguments', () => {
  const catalog = new Catalog(Array.from({length:20000},(_,i) => track('t' + i,{album:'',artist:'',added:i})));
  assert.equal(catalog.albumList()[0].tracks.length,20000);
  assert.equal(catalog.albumList()[0].added,19999);
});
test('artist playback keeps same-titled releases grouped when album artists differ', () => {
  const catalog = new Catalog([
    track('g2one',{artist:'Singer',album_artist:'Group 2',track_number:1}),
    track('g1two',{artist:'Singer',album_artist:'Group 1',track_number:2}),
    track('g1one',{artist:'Singer',album_artist:'Group 1',track_number:1})
  ]);
  assert.deepEqual(catalog.artists.get('singer').tracks.map(t => t.id),['g1one','g1two','g2one']);
});
