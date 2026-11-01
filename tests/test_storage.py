"""Multiple sources preserve catalog identity and isolate file operations."""
import http.client
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from library import Library
from server import Handler, Server
from storage import directory_sources


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.primary, self.extra = self.base / 'primary', self.base / 'extra'
        self.primary.mkdir()
        self.extra.mkdir()
        (self.primary / 'same.mp3').write_bytes(b'primary')
        (self.extra / 'same.mp3').write_bytes(b'extra')
        self.config = [dict(id='archive', name='Archive', type='directory', path=str(self.extra))]
        self.library = self.open()

    def open(self, sources=None):
        library = Library(self.primary, self.base / 'library.sqlite3', ffprobe=False, ffmpeg=False,
                          music_sources=self.config if sources is None else sources)
        self.addCleanup(library.close)
        return library

    def test_identical_names_and_legacy_identity(self):
        tracks = {t['path']: t for t in self.library.state()['tracks']}
        self.assertEqual(set(tracks), {'same.mp3', '@sources/archive/same.mp3'})
        self.assertNotEqual(tracks['same.mp3']['id'], tracks['@sources/archive/same.mp3']['id'])
        legacy = self.open([])
        self.assertEqual(legacy.track(tracks['same.mp3']['id'])['path'], 'same.mp3')
        self.assertEqual(len(legacy.state()['tracks']), 2)  # Unconfigured source is retained.
        reopened = self.open()
        self.assertEqual({t['path']: t['id'] for t in reopened.state()['tracks']},
                         {p: t['id'] for p, t in tracks.items()})

    def test_disconnect_reconnect_preserves_playlists_favorites_and_metadata_worker(self):
        track = next(t for t in self.library.state()['tracks'] if t['path'].startswith('@sources/'))
        with self.library.connect() as db:
            db.execute("INSERT INTO playlists VALUES('p','Keep')")
            db.execute("INSERT INTO items VALUES('p',?,0)", (track['id'],))
            db.execute('INSERT INTO favorites VALUES(?,0)', (track['id'],))
        away = self.base / 'unplugged'
        self.extra.rename(away)
        self.library.scan()
        state = self.library.state()
        self.assertFalse(state['sources'][1]['available'])
        self.assertIn('@sources/archive', state['folders'])
        self.assertEqual(state['playlists'][0]['tracks'], [track['id']])
        self.library.index_pending()
        with self.assertRaises(FileNotFoundError):
            self.library.path('@sources/archive/new/subfolder')
        self.assertFalse(self.extra.exists())
        away.rename(self.extra)
        self.library.scan()
        self.assertEqual(self.library.track(track['id'])['path'], track['path'])
        with self.library.connect() as db:
            self.assertEqual(db.execute('SELECT track FROM favorites').fetchone()[0], track['id'])

    def test_partial_scan_failure_does_not_prune_source(self):
        def partial(source):
            yield source.root, []
            raise PermissionError('Disconnected during scan')
        with patch('storage.DirectorySource.directories', partial):
            self.library.scan()
        self.assertEqual(len(self.library.state()['tracks']), 2)

    def test_completed_scan_prunes_only_missing_files_in_its_source(self):
        (self.extra / 'same.mp3').unlink()
        self.library.scan()
        self.assertEqual([t['path'] for t in self.library.state()['tracks']], ['same.mp3'])

    def test_source_validation_and_containment(self):
        for items in ([self.config[0], self.config[0]], [dict(id='../escape', path=str(self.extra))],
                      [dict(id='nested', path=str(self.primary / 'nested'))],
                      [dict(id='network', type='smb', path='smb://server/music')], {}):
            with self.subTest(items=items), self.assertRaises(ValueError):
                directory_sources(self.primary, items)
        for path in ('@sources/archive/../escape', '@sources/archive/C:/escape',
                     '@sources/archive/..\\escape', '/absolute', '@sources'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.library.path(path)
        with self.assertRaises(FileNotFoundError):
            self.library.path('@sources/unknown/file.mp3')

    def test_cross_source_move_and_undo_preserve_track_id(self):
        (self.extra / 'Destination').mkdir()
        track = next(t for t in self.library.state()['tracks'] if t['path'] == 'same.mp3')
        result = self.library.action('move', dict(tracks=[track['id']], folder='@sources/archive/Destination'))
        self.assertEqual(self.library.track(track['id'])['path'], '@sources/archive/Destination/same.mp3')
        self.library.action('undo', dict(id=result['operationId']))
        self.assertEqual(self.library.track(track['id'])['path'], 'same.mp3')
        self.assertEqual((self.primary / 'same.mp3').read_bytes(), b'primary')

    def test_cross_filesystem_move_is_rejected_before_recording_or_touching_files(self):
        original = Path.stat
        def stat(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path == self.extra:
                fields = list(info)
                fields[2] = info.st_dev + 1
                return os.stat_result(fields)
            return info
        track = next(t for t in self.library.state()['tracks'] if t['path'] == 'same.mp3')
        with patch.object(Path, 'stat', stat), self.assertRaisesRegex(ValueError, 'between filesystems'):
            self.library.action('move', dict(tracks=[track['id']], folder='@sources/archive'))
        self.assertEqual((self.primary / 'same.mp3').read_bytes(), b'primary')
        with self.library.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM operations').fetchone()[0], 0)

    def test_http_stream_upload_and_theme_files(self):
        server = Server(('127.0.0.1', 0), Handler)
        server.library, server.verbose = self.library, False
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def stop():
            server.shutdown()
            server.server_close()
            thread.join()
        self.addCleanup(stop)
        def request(method, path, data=None, headers=None):
            conn = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
            try:
                conn.request(method, path, data, headers or {})
                response = conn.getresponse()
                return response.status, response.read()
            finally:
                conn.close()
        track = next(t for t in self.library.state()['tracks'] if t['path'].startswith('@sources/'))
        self.assertEqual(request('GET', '/media/' + track['id']), (200, b'extra'))
        code, body = request('PUT', '/api/upload', b'uploaded', {'X-File-Path':'@sources/archive/new.mp3'})
        self.assertEqual(code, 201, body)
        self.assertEqual((self.extra / 'new.mp3').read_bytes(), b'uploaded')
        for name in ('forest', 'midnight', 'sand'):
            code, css = request('GET', '/themes/' + name + '.css')
            self.assertEqual(code, 200)
            self.assertIn(b'--bg:', css)
        self.assertEqual(request('GET', '/themes/unknown.css')[0], 404)


if __name__ == '__main__':
    unittest.main()
