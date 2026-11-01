"""Restart authorization and real launcher/configuration lifecycle."""
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from http_api import Handler, Server
from library import Library
from updater import UpdateManager, read_json


class RestartAPITests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'VERSION').write_text('0.1.0')
        self.library = Library(self.root / 'music', self.root / 'catalog.sqlite3', ffprobe=False, ffmpeg=False)
        self.addCleanup(self.library.close)
        self.shutdown = threading.Event()
        self.manager = UpdateManager(self.root, self.root, self.library.database,
                                     'Nealsbo/HomeMusic', self.shutdown.set)
        self.server = Server(('127.0.0.1', 0), Handler)
        self.server.library, self.server.verbose, self.server.updates = self.library, False, self.manager
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method='POST', path='/api/server/restart', key=None, origin=None):
        headers = {}
        if key is not None:
            headers['Authorization'] = 'Bearer ' + key
        if origin is not None:
            headers['Origin'] = origin
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=3)
        try:
            conn.request(method, path, '{}' if method == 'POST' else None, headers)
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_owner_key_and_same_origin_are_required_before_restart_intent(self):
        with patch.dict(os.environ, HOMEMUSIC_RESTART='1', HOMEMUSIC_INSTANCE='first'):
            for key in (None, 'wrong'):
                self.assertEqual(self.request(key=key)[0], 403)
            self.assertEqual(self.request(key=self.manager.key, origin='http://other.invalid')[0], 400)
        self.assertFalse((self.manager.home / 'restart.json').exists())
        self.assertFalse(self.manager.busy)

    def test_unmanaged_and_old_bootstrap_are_reported_without_stopping(self):
        with patch.dict(os.environ, HOMEMUSIC_RESTART='0'):
            self.assertFalse(self.request('GET', '/api/server')[1]['restartSupported'])
            self.assertEqual(self.request(key=self.manager.key)[0], 400)
        del self.server.updates
        self.assertEqual(self.request(key='anything')[0], 409)
        self.assertFalse((self.manager.home / 'restart.json').exists())

    def test_active_update_blocks_restart(self):
        self.manager.busy = True
        with patch.dict(os.environ, HOMEMUSIC_RESTART='1', HOMEMUSIC_INSTANCE='first'):
            self.assertEqual(self.request(key=self.manager.key)[0], 400)
        self.assertFalse((self.manager.home / 'restart.json').exists())

    def test_restart_reply_is_delivered_and_intent_is_bound_to_current_instance(self):
        with patch.dict(os.environ, HOMEMUSIC_RESTART='1', HOMEMUSIC_INSTANCE='first'):
            status, result = self.request(key=self.manager.key)
        self.assertEqual(status, 202)
        self.assertEqual(result, dict(accepted=True, instance='first'))
        self.assertEqual(read_json(self.manager.home / 'restart.json'), {'instance':'first'})
        self.assertFalse((self.manager.home / 'request.json').exists())
        self.assertTrue(self.manager.busy)
        with self.assertRaises(ValueError):
            with patch.dict(os.environ, HOMEMUSIC_RESTART='1', HOMEMUSIC_INSTANCE='first'):
                self.manager.request_restart()


class RestartProcessTests(unittest.TestCase):
    def wait_for(self, predicate, timeout=15):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                result = predicate()
                if result:
                    return result
            except (OSError, ValueError):
                pass
            time.sleep(.05)
        self.fail('Timed out waiting for restarted server')

    def test_http_and_tui_restart_reload_config_without_changing_catalog_or_version(self):
        project = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for source in project.glob('*.py'):
                shutil.copy2(source, root / source.name)
            shutil.copy2(project / 'VERSION', root / 'VERSION')
            shutil.copytree(project / 'web', root / 'web')
            (root / 'music').mkdir()
            (root / 'music/song.mp3').write_bytes(b'music')
            with socket.socket() as probe:
                probe.bind(('127.0.0.1', 0))
                port = probe.getsockname()[1]
            config = dict(music_dir='./music', database='./data/library.sqlite3', port=port,
                          listen=False, ffprobe=False, ffmpeg=False, updates_auto_check=False)
            (root / 'config.json').write_text(json.dumps(config))
            home = root / '.updates'
            def request(path, key=None):
                conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
                try:
                    conn.request('POST' if key else 'GET', path, '{}' if key else None,
                                 {'Authorization':'Bearer ' + key} if key else {})
                    response = conn.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    conn.close()
            with (root / 'server.log').open('w') as log:
                parent = subprocess.Popen([sys.executable, str(root / 'main.py')], cwd=root, stdout=log, stderr=log)
                try:
                    first = self.wait_for(lambda: read_json(home / 'ready.json'))
                    original_track = request('/api/state')[1]['tracks'][0]
                    key = (home / 'owner-key').read_text()
                    (root / 'archive').mkdir()
                    (root / 'archive/song.mp3').write_bytes(b'other music')
                    config['music_sources'] = [dict(id='archive', name='Archive', path='./archive')]
                    (root / 'config.json').write_text(json.dumps(config))
                    status, result = request('/api/server/restart', key)
                    self.assertEqual(status, 202)
                    second = self.wait_for(lambda: (r if (r := read_json(home / 'ready.json')) and
                                                   r['instance'] != first['instance'] else None))
                    self.assertNotEqual(first['pid'], second['pid'])
                    self.assertIsNone(parent.poll())
                    state = request('/api/state')[1]
                    self.assertEqual(len(state['tracks']), 2)
                    self.assertIn(original_track['id'], [t['id'] for t in state['tracks']])
                    self.assertFalse((home / 'current.json').exists())
                    self.assertFalse((home / 'transaction.json').exists())
                    self.assertFalse(list(home.glob('database-*.sqlite3')))
                    cli = subprocess.run([sys.executable, str(root / 'tui.py'), '--restart',
                                          '--url', f'http://127.0.0.1:{port}', '--owner-key-file',
                                          str(home / 'owner-key'), '--wait', '15'],
                                         cwd=root, capture_output=True, text=True, timeout=25)
                    self.assertEqual(cli.returncode, 0, cli.stderr)
                    self.assertIn('Server restarted.', cli.stdout)
                    third = read_json(home / 'ready.json')
                    self.assertNotEqual(second['instance'], third['instance'])
                    self.assertEqual((home / 'owner-key').read_text(), key)
                    self.assertEqual(json.loads((root / 'config.json').read_text()), config)
                finally:
                    ready = read_json(home / 'ready.json')
                    if ready:
                        try:
                            os.kill(ready['pid'], 15)
                        except OSError:
                            pass
                    try:
                        parent.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        parent.terminate()
                        parent.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
