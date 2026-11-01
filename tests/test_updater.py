"""Update boundaries, archive validation, HTTP authorization, and real restarts."""
import hashlib
from contextlib import closing
import http.client
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
import zipfile

from http_api import Handler, Server
import updater


def archive_bytes(number='0.2.0', extra=None, **overrides):
    files = {name: b'# source\n' for name in ('main.py', 'server.py', 'http_api.py', 'updater.py')}
    files.update({'VERSION': number.encode(), 'web/index.html': b'<html></html>'})
    files.update(extra or {})
    manifest = dict(protocol=1, version=number, python='3.10',
                    files={name: hashlib.sha256(content).hexdigest() for name, content in files.items()})
    manifest.update(overrides)
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w') as package:
        for name, content in files.items():
            package.writestr(name, content)
        package.writestr('update-manifest.json', json.dumps(manifest))
    return result.getvalue()


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'VERSION').write_text('0.1.0')
        self.shutdown = threading.Event()
        self.manager = updater.UpdateManager(self.root, self.root, self.root / 'music.sqlite3',
                                             'Nealsbo/HomeMusic', self.shutdown.set)

    def tearDown(self):
        self.manager.stop.set()
        self.temp.cleanup()

    def stage(self, content, number='0.2.0'):
        return updater.stage_archive(io.BytesIO(content), self.root / 'stage', number)

    def test_valid_archive_is_staged_without_touching_configuration_or_music(self):
        (self.root / 'config.json').write_text('private settings')
        (self.root / 'song.wav').write_bytes(b'music')
        manifest = self.stage(archive_bytes())
        self.assertEqual(manifest['version'], '0.2.0')
        self.assertEqual((self.root / 'stage/VERSION').read_text(), '0.2.0')
        self.assertEqual((self.root / 'config.json').read_text(), 'private settings')
        self.assertEqual((self.root / 'song.wav').read_bytes(), b'music')

    def test_traversal_and_user_data_paths_are_rejected_before_writing(self):
        for name in ('../outside.py', '/outside.py', 'web/../../x.py', 'web\\x.py',
                     'web/x:stream', 'config.json', 'data/library.sqlite3', 'web/x.', 'web/x ', 'web/CON.txt'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.stage(archive_bytes(extra={name: b'bad'}))
            self.assertFalse((self.root / 'stage').exists())

    def test_case_insensitive_duplicate_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.stage(archive_bytes(extra={'web/INDEX.html': b'collision'}))

    def test_symlink_entry_is_rejected(self):
        content = io.BytesIO(archive_bytes())
        with zipfile.ZipFile(content, 'a') as package:
            link = zipfile.ZipInfo('web/link')
            link.create_system = 3
            link.external_attr = 0o120777 << 16
            package.writestr(link, 'outside')
        with self.assertRaisesRegex(ValueError, 'regular'):
            self.stage(content.getvalue())

    def test_checksums_protocol_version_and_python_are_enforced(self):
        for changes in ({'files': {}}, {'protocol': 2}, {'version': '9.9.9'}, {'python': '99.0'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.stage(archive_bytes(**changes))
        manifest = json.loads(zipfile.ZipFile(io.BytesIO(archive_bytes())).read('update-manifest.json'))
        manifest['files']['main.py'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.stage(archive_bytes(files=manifest['files']))

    def test_archive_size_is_bounded(self):
        with patch.object(updater, 'MAX_ARCHIVE', 5), self.assertRaisesRegex(ValueError, 'large'):
            self.stage(archive_bytes())

    def test_invalid_versions_are_rejected(self):
        for value in ('latest', '../0.2.0', '0.2.0-beta', None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                updater.version(value)

    def test_owner_key_is_persistent_and_not_in_public_status(self):
        other = updater.UpdateManager(self.root, self.root, self.root / 'music.sqlite3',
                                      'Nealsbo/HomeMusic', self.shutdown.set)
        self.assertEqual(other.key, self.manager.key)
        self.assertTrue(self.manager.authorized('Bearer ' + other.key))
        self.assertFalse(self.manager.authorized('Bearer invalid'))
        self.assertNotIn(other.key, json.dumps(self.manager.status()))

    def test_untrusted_urls_and_redirects_are_rejected(self):
        for url in ('http://github.com/x', 'https://evil.test/x', 'https://github.com.evil.test/x',
                    'https://name@github.com/x'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                updater.HTTPSOnlyRedirects.validate(url)
        with self.assertRaises(ValueError):
            updater.HTTPSOnlyRedirects().redirect_request(None, None, 302, '', {}, 'http://127.0.0.1/')

    def release(self, number='0.2.0'):
        return {'tag_name': 'v' + number, 'body': 'Release notes', 'assets': [{
            'name': updater.ASSET, 'digest': 'sha256:' + 'a' * 64,
            'browser_download_url': 'https://github.com/Nealsbo/HomeMusic/releases/download/v' + number + '/' + updater.ASSET}]}

    def test_release_comparison_uses_numeric_versions_and_requires_asset(self):
        with patch.object(updater.HTTPSOnlyRedirects, 'open', return_value=io.BytesIO(json.dumps(self.release('0.10.0')).encode())):
            self.manager._check()
        self.assertEqual(self.manager.status()['phase'], 'available')
        self.assertEqual(self.manager.release['version'], '0.10.0')
        broken = self.release()
        broken['assets'] = []
        with patch.object(updater.HTTPSOnlyRedirects, 'open', return_value=io.BytesIO(json.dumps(broken).encode())), self.assertRaises(ValueError):
            self.manager._check()
        self.assertIsNone(self.manager.release)

    def test_current_release_cannot_be_reinstalled(self):
        with patch.object(updater.HTTPSOnlyRedirects, 'open', return_value=io.BytesIO(json.dumps(self.release('0.1.0')).encode())):
            self.manager._check()
        self.assertEqual(self.manager.status()['phase'], 'current')
        with self.assertRaises(ValueError):
            self.manager.start('install')

    def test_install_only_requests_shutdown_after_verified_staging(self):
        content = archive_bytes()
        self.manager.release = dict(version='0.2.0', url='https://github.com/test', digest=hashlib.sha256(content).hexdigest())
        with patch.object(updater.HTTPSOnlyRedirects, 'open', return_value=io.BytesIO(content)):
            self.manager._install()
        self.assertTrue(self.shutdown.is_set())
        self.assertEqual(updater.read_json(self.manager.home / 'request.json')['database'], str(self.root / 'music.sqlite3'))
        self.assertFalse((self.manager.home / 'current.json').exists())

    def test_corrupt_download_never_stops_server(self):
        self.manager.release = dict(version='0.2.0', url='https://github.com/test', digest='a' * 64)
        with patch.object(updater.HTTPSOnlyRedirects, 'open', return_value=io.BytesIO(b'broken')):
            self.manager._run('install')
        self.assertFalse(self.shutdown.is_set())
        self.assertEqual(self.manager.status()['phase'], 'error')
        self.assertFalse((self.manager.home / 'request.json').exists())

    def test_operations_are_serialized(self):
        self.manager.busy = True
        with self.assertRaisesRegex(ValueError, 'already running'):
            self.manager.start('check')

    def test_no_release_is_an_informational_state(self):
        with patch.object(updater.HTTPSOnlyRedirects, 'open', side_effect=HTTPError('url', 404, 'Not found', {}, None)):
            self.manager._check()
        self.assertEqual(self.manager.status()['phase'], 'no_release')
        self.assertIsNotNone(self.manager.status()['checkedAt'])

    def test_missing_backup_cannot_replace_existing_database(self):
        database = self.root / 'existing.sqlite3'
        database.write_bytes(b'original bytes')
        with self.assertRaises(sqlite3.OperationalError):
            updater.database_copy(self.root / 'missing-backup.sqlite3', database)
        self.assertEqual(database.read_bytes(), b'original bytes')
        self.assertFalse((self.root / 'missing-backup.sqlite3').exists())

    def test_process_lock_refuses_a_second_owner(self):
        with updater.process_lock(self.root / 'process.lock'):
            with self.assertRaises(SystemExit):
                with updater.process_lock(self.root / 'process.lock'):
                    self.fail('A second owner acquired the process lock')

    def test_interrupted_pending_transaction_is_recovered_before_starting(self):
        database = self.root / 'music.sqlite3'
        backup = self.root / 'backup.sqlite3'
        with closing(sqlite3.connect(database)) as db, db:
            db.execute('CREATE TABLE example(value TEXT)')
            db.execute("INSERT INTO example VALUES ('old')")
        updater.database_copy(database, backup)
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("UPDATE example SET value='new'")
        updater.write_json(self.manager.home / 'transaction.json', dict(
            version='0.2.0', database=str(database), backup=str(backup), previous=None))
        updater.write_json(self.manager.home / 'current.json', {'version':'0.2.0'})
        with patch.object(updater.subprocess, 'Popen') as popen:
            popen.return_value.wait.return_value = 0
            self.assertEqual(updater._supervise_locked(self.root, []), 0)
            self.assertEqual(popen.call_args.args[0][1], str(self.root / 'main.py'))
        with closing(sqlite3.connect(database)) as db:
            self.assertEqual(db.execute('SELECT value FROM example').fetchone()[0], 'old')
        self.assertFalse((self.manager.home / 'transaction.json').exists())

    def test_database_backup_includes_wal_and_rollback_restores_database(self):
        database = self.root / 'music.sqlite3'
        backup = self.root / 'backup.sqlite3'
        with closing(sqlite3.connect(database)) as db, db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('CREATE TABLE example(value TEXT)')
            db.execute("INSERT INTO example VALUES ('old')")
            db.commit()
            updater.database_copy(database, backup)
            db.execute("UPDATE example SET value='new'")
        updater.write_json(self.manager.home / 'current.json', {'version': '0.2.0'})
        updater.rollback(self.root, dict(version='0.2.0', database=str(database), backup=str(backup), previous=None))
        with closing(sqlite3.connect(database)) as db:
            self.assertEqual(db.execute('SELECT value FROM example').fetchone()[0], 'old')
        self.assertFalse((self.manager.home / 'current.json').exists())

    def test_http_requires_key_and_rejects_cross_origin_install(self):
        class FakeLibrary:
            lock = threading.RLock()
            requests = 0
        server = Server(('127.0.0.1', 0), Handler)
        server.library, server.verbose, server.updates = FakeLibrary(), False, self.manager
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with patch.object(self.manager, 'start', return_value={'phase': 'checking'}) as start:
                for headers, expected in [({}, 403),
                        ({'Authorization': 'Bearer ' + self.manager.key, 'Origin': 'https://evil.test'}, 400),
                        ({'Authorization': 'Bearer ' + self.manager.key}, 200)]:
                    connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
                    connection.request('POST', '/api/updates/check', '{}', headers)
                    response = connection.getresponse()
                    self.assertEqual(response.status, expected, response.read())
                    connection.close()
                start.assert_called_once_with('check')
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


# A tiny application fixture exercises actual subprocess exit, HTTP readiness and
# database rollback without changing user files or contacting GitHub.
CHILD = r'''
import json, os, sqlite3, sys, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
root = Path(os.environ['HOMEMUSIC_ROOT'])
home = root / '.updates'
number = (Path(__file__).parent / 'VERSION').read_text().strip()
database = root / 'library.sqlite3'
with sqlite3.connect(database) as db:
    db.execute('CREATE TABLE IF NOT EXISTS example(value TEXT)')
    if not db.execute('SELECT * FROM example').fetchone():
        db.execute("INSERT INTO example VALUES ('original')")
    if number != '0.1.0':
        db.execute("UPDATE example SET value='changed'")
if (Path(__file__).parent / 'fail').exists():
    sys.exit(2)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps({'instance':os.environ['HOMEMUSIC_INSTANCE']}).encode())
    def log_message(self, *args): pass
server = HTTPServer(('127.0.0.1', 0), Handler)
server.timeout = .1
ready = {'instance':os.environ['HOMEMUSIC_INSTANCE'], 'host':'127.0.0.1', 'port':server.server_port, 'pid':os.getpid()}
temporary = home / 'ready.tmp'
temporary.write_text(json.dumps(ready))
temporary.replace(home / 'ready.json')
while not (home / 'stop').exists():
    server.handle_request()
    if (home / 'trigger').exists():
        (home / 'trigger').unlink()
        (home / 'request.json').write_text(json.dumps({'version':'0.2.0','database':str(database)}))
        server.server_close()
        sys.exit(75)
server.server_close()
'''


class SupervisorTests(unittest.TestCase):
    def wait_for(self, predicate, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = predicate()
            if result:
                return result
            time.sleep(.05)
        self.fail('Timed out waiting for the update subprocess')

    def run_update(self, fail=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / '.updates'
            target = home / 'versions/0.2.0'
            target.mkdir(parents=True)
            for code, number in ((root, '0.1.0'), (target, '0.2.0')):
                (code / 'main.py').write_text(CHILD)
                (code / 'VERSION').write_text(number)
            if fail:
                (target / 'fail').touch()
            script = 'import updater,sys; from pathlib import Path; sys.exit(updater.supervise(Path(sys.argv[1]), []))'
            with (root / 'log').open('w') as log:
                parent = subprocess.Popen([sys.executable, '-c', script, str(root)], stdout=log, stderr=log)
                try:
                    self.wait_for(lambda: (home / 'ready.json').exists())
                    (home / 'trigger').touch()
                    result = self.wait_for(lambda: updater.read_json(home / 'result.json'))
                    self.assertEqual(result['outcome'], 'rolled_back' if fail else 'installed')
                    if fail:
                        self.wait_for(lambda: (home / 'ready.json').exists())
                    with closing(sqlite3.connect(root / 'library.sqlite3')) as db:
                        self.assertEqual(db.execute('SELECT value FROM example').fetchone()[0],
                                         'original' if fail else 'changed')
                    selected = updater.read_json(home / 'current.json')
                    self.assertEqual(selected, None if fail else {'version': '0.2.0'})
                    self.assertFalse((home / 'transaction.json').exists())
                finally:
                    (home / 'stop').touch()
                    try:
                        parent.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        ready = updater.read_json(home / 'ready.json')
                        if ready:
                            try:
                                os.kill(ready['pid'], 15)
                            except OSError:
                                pass
                        parent.terminate()
                        parent.wait(timeout=5)

    def test_successful_release_is_selected_after_real_http_health_check(self):
        self.run_update()

    def test_failed_startup_restores_database_and_restarts_previous_version(self):
        self.run_update(fail=True)

    def test_real_application_downloads_installs_and_serves_new_version(self):
        project = Path(__file__).resolve().parents[1]
        network_fixture = '''
if __name__ == '__main__':
    import updater
    def fixture_open(url):
        root = Path(os.environ.get('HOMEMUSIC_ROOT', Path(__file__).parent))
        return (root / ('network.json' if url.endswith('/latest') else 'network.zip')).open('rb')
    updater.HTTPSOnlyRedirects.open = fixture_open
'''
        # Replace only the network transport in private copies of the real app.
        # Manifest checks, HTTP authorization, shutdown and supervisor are real.
        def package(number):
            files = {path.name: path.read_bytes() for path in project.glob('*.py')}
            files['main.py'] = files['main.py'].replace(b"if __name__ == '__main__':", network_fixture.encode() + b"\nif __name__ == '__main__':")
            files['VERSION'] = number.encode()
            files.update({path.relative_to(project).as_posix(): path.read_bytes()
                          for path in (project / 'web').rglob('*') if path.is_file()})
            return archive_bytes(number, extra=files)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'app'
            updater.stage_archive(io.BytesIO(package('0.1.0')), root, '0.1.0')
            update = package('0.2.0')
            (root / 'network.zip').write_bytes(update)
            (root / 'network.json').write_text(json.dumps({'tag_name':'v0.2.0', 'body':'New release', 'assets':[{
                'name':updater.ASSET, 'digest':'sha256:' + hashlib.sha256(update).hexdigest(),
                'browser_download_url':'https://github.com/Nealsbo/HomeMusic/releases/download/v0.2.0/' + updater.ASSET}]}))
            config = dict(listen=False, port=0, music_dir='./music', database='./data/library.sqlite3', updates_auto_check=False)
            (root / 'config.json').write_text(json.dumps(config))
            home = root / '.updates'
            def request(path, method='GET', key='', expected=200):
                ready = updater.read_json(home / 'ready.json')
                connection = http.client.HTTPConnection('127.0.0.1', ready['port'], timeout=3)
                try:
                    connection.request(method, path, '{}' if method == 'POST' else None,
                                       {'Authorization':'Bearer ' + key})
                    response = connection.getresponse()
                    content = json.loads(response.read())
                    self.assertEqual(response.status, expected, content)
                    return content
                finally:
                    connection.close()
            with (Path(directory) / 'log').open('w') as log:
                parent = subprocess.Popen([sys.executable, str(root / 'main.py')], cwd=root, stdout=log, stderr=log)
                try:
                    self.wait_for(lambda: (home / 'ready.json').exists())
                    key = (home / 'owner-key').read_text()
                    request('/api/updates/check', 'POST', key)
                    self.wait_for(lambda: request('/api/updates')['phase'] == 'available')
                    request('/api/updates/install', 'POST', key)
                    self.wait_for(lambda: updater.read_json(home / 'result.json'))
                    self.assertEqual(request('/api/updates')['current'], '0.2.0')
                    self.assertEqual(request('/api/state')['tracks'], [])
                    self.assertEqual(json.loads((root / 'config.json').read_text()), config)
                    self.assertEqual((home / 'owner-key').read_text(), key)
                    self.assertEqual((root / 'VERSION').read_text(), '0.1.0')
                    previous_instance = updater.read_json(home / 'ready.json')['instance']
                    request('/api/server/restart', 'POST', key, expected=202)
                    self.wait_for(lambda: (ready if (ready := updater.read_json(home / 'ready.json')) and
                                          ready['instance'] != previous_instance else None))
                    self.assertEqual(request('/api/updates')['current'], '0.2.0')
                    self.assertEqual(updater.read_json(home / 'current.json'), {'version':'0.2.0'})
                finally:
                    ready = updater.read_json(home / 'ready.json')
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
