import concurrent.futures
import http.client
import json
import io
import subprocess
import socketserver
import sys
import time
import wave
from unittest.mock import patch
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import quote

from server import Handler, Library, Server


class MusicServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / 'music'
        self.root.mkdir()
        (self.root / 'Artist - First.mp3').write_bytes(bytes(range(256)) * 8)
        (self.root / 'Second.wav').write_bytes(b'RIFF' + b'0' * 100)
        self.library = Library(self.root, self.base / 'catalog.sqlite3', 1)
        self.server = Server(('127.0.0.1', 0), Handler)
        self.server.library = self.library
        self.server.verbose = False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def request(self, method, path, data=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        if isinstance(data, dict):
            data = json.dumps(data).encode()
        try:
            conn.request(method, path, data, headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            conn.close()

    def action(self, name, data):
        status, _, body = self.request('POST', '/api/' + name, data)
        self.assertEqual(status, 200, body)
        return json.loads(body)

    def first(self):
        return next(t for t in self.library.state()['tracks'] if t['path'].endswith('.mp3'))

    def test_localization_assets_are_json_and_traversal_is_rejected(self):
        status, headers, body = self.request('GET', '/client-session.js')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'text/javascript; charset=utf-8')
        self.assertIn(b'MusicClientSession', body)
        for path, mime in [('/layout.js','text/javascript'), ('/layout.css','text/css'), ('/visualization-presets.js','text/javascript'), ('/cd-view.js','text/javascript'), ('/cd-scene.mjs','text/javascript'),
                           ('/vendor/three-r180/three.module.min.js','text/javascript'),
                           ('/vendor/three-r180/three.core.min.js','text/javascript'),
                           ('/vendor/three-r180/manifest.json','application/json'),
                           ('/audio-analysis.js','text/javascript'), ('/effects-view.js','text/javascript'), ('/player-appearance.js','text/javascript'), ('/album-view.js','text/javascript'), ('/player-bridge.js','text/javascript'), ('/player-views.js','text/javascript'),
                           ('/shader-background.js','text/javascript'), ('/expanded-player.js','text/javascript'), ('/expanded-player.css','text/css')]:
            status, headers, body = self.request('GET', path)
            self.assertEqual(status, 200)
            self.assertEqual(headers['Content-Type'], mime + '; charset=utf-8')
            self.assertTrue(body)
        for language in ('en', 'ru', 'languages'):
            status, headers, body = self.request('GET', '/locales/' + language + '.json')
            self.assertEqual(status, 200)
            self.assertEqual(headers['Content-Type'], 'application/json; charset=utf-8')
            self.assertTrue(json.loads(body))
        for path in ('/locales/../config.example.json', '/locales/%2e%2e/config.example.json', '/locales/missing.json',
                     '/vendor/three-r180/package.json', '/vendor/three-r180/../package.json',
                     '/vendor/three-r180/%2e%2e/config.example.json', '/vendor/missing.js'):
            status, _, _ = self.request('GET', path)
            self.assertEqual(status, 404)

    def test_scan_preserves_ids_metadata_and_removes_missing(self):
        t = self.first()
        self.action('metadata', dict(id=t['id'], title='Changed', artist='A', album='B'))
        self.library.scan()
        self.assertEqual(self.library.track(t['id'])['title'], 'Changed')
        (self.root / t['path']).unlink()
        self.library.scan()
        self.assertEqual(len(self.library.state()['tracks']), 1)

    def test_range_stream_and_head(self):
        url = '/media/' + self.first()['id']
        status, headers, body = self.request('GET', url, headers={'Range':'bytes=10-19'})
        self.assertEqual((status,body), (206,bytes(range(10,20))))
        self.assertEqual(headers['Content-Range'], 'bytes 10-19/2048')
        status, headers, body = self.request('HEAD', url)
        self.assertEqual((status,headers['Content-Length'],body),(200,'2048',b''))
        status, _, body = self.request('GET',url,headers={'Range':'bytes=-3'})
        self.assertEqual((status,body),(206,bytes([253,254,255])))
        for invalid in ['bytes=99999-','bytes=20-10','bytes=0-1,3-4','bytes=-0','bad']:
            status, _, _ = self.request('GET',url,headers={'Range':invalid})
            self.assertEqual(status,416,invalid)

    def test_playlist_order_import_export_and_restart(self):
        ids = [t['id'] for t in self.library.state()['tracks']]
        p = self.action('playlist',{'name':'Evening'})['id']
        self.action('playlistTracks',{'id':p,'tracks':list(reversed(ids))})
        self.action('order',{'tracks':list(reversed(ids))})
        restored = Library(self.root,self.base / 'catalog.sqlite3')
        self.assertEqual(restored.state()['playlists'][0]['tracks'],list(reversed(ids)))
        self.assertEqual([t['id'] for t in restored.state()['tracks']],list(reversed(ids)))
        status, _, content = self.request('GET','/api/export/' + p)
        self.assertEqual(status,200)
        imported = self.action('import',{'name':'Imported','content':content.decode() + '\nmissing.mp3'})
        self.assertEqual(imported['matched'],2)
        self.assertEqual(imported['missing'],['missing.mp3'])
        self.action('deletePlaylist',{'id':p})
        self.assertTrue((self.root / self.first()['path']).exists())

    def test_move_preserves_playlist_and_rejects_collision(self):
        t = self.first()
        p = self.action('playlist',{'name':'P'})['id']
        self.action('playlistTracks',{'id':p,'tracks':[t['id']]})
        self.action('folder',{'path':'Jazz/Live'})
        self.action('move',{'folder':'Jazz/Live','tracks':[t['id']]})
        self.assertEqual(self.library.track(t['id'])['path'],'Jazz/Live/' + t['path'])
        self.assertEqual(self.library.state()['playlists'][0]['tracks'],[t['id']])
        (self.root / t['path']).write_bytes(b'collision')
        status, _, _ = self.request('POST','/api/move',{'folder':'','tracks':[t['id']]})
        self.assertEqual(status,400)
        self.assertTrue((self.root / 'Jazz/Live' / t['path']).exists())

    def test_upload_unicode_duplicate_and_limits(self):
        filename = '\u041c\u0443\u0437\u044b\u043a\u0430.mp3'
        headers = {'X-File-Path':quote(filename)}
        self.assertEqual(self.request('PUT','/api/upload',b'abc',headers)[0],201)
        self.assertEqual((self.root / filename).read_bytes(),b'abc')
        self.assertEqual(self.request('PUT','/api/upload',b'xyz',headers)[0],409)
        self.assertEqual((self.root / filename).read_bytes(),b'abc')
        # Oversized requests are rejected from headers, before sending a body.
        # Sending the rejected body anyway races the socket close on Windows.
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        conn.putrequest('PUT', '/api/upload')
        conn.putheader('Content-Length', str(1048576 + 1))
        conn.putheader('X-File-Path', quote(filename))
        conn.endheaders()
        response = conn.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        conn.close()
        self.assertEqual(self.request('PUT','/api/upload',b'code',{'X-File-Path':'bad.py'})[0],409)
        self.assertFalse(list(self.root.glob('.upload-*')))

    def test_path_boundaries_and_origin(self):
        for path in ['../outside.mp3','/outside.mp3','C:/outside.mp3','folder/../../bad.mp3','a\\b.mp3']:
            self.assertEqual(self.request('POST','/api/folder',{'path':path})[0],400)
        self.assertEqual(self.request('POST','/api/folder',{'path':'bad'}, {'Origin':'https://other.example'})[0],400)
        self.assertFalse((self.root / 'bad').exists())
        self.assertEqual(self.request('GET','/../server.py')[0],404)

    def test_parallel_clients_and_upload_race(self):
        url = '/media/' + self.first()['id']
        def read(_):
            status, _, content = self.request('GET',url,headers={'Range':'bytes=0-63'})
            return status,len(content)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(read,range(24))),[(206,64)] * 24)
            results = list(pool.map(lambda _: self.request('PUT','/api/upload',b'music',{'X-File-Path':'race.mp3'})[0], range(4)))
        self.assertEqual(sorted(results),[201,409,409,409])
        self.assertEqual(self.library.streams,0)

    def test_settings_and_static_assets(self):
        self.action('settings',{'title':'My server','defaultVolume':.25})
        self.assertEqual(self.library.state()['settings']['defaultVolume'],.25)
        for path in ['/','/app.js','/style.css','/api/stats']:
            status, headers, body = self.request('GET',path)
            self.assertEqual(status,200,path)
            self.assertTrue(body)
            self.assertEqual(int(headers['Content-Length']),len(body))

    def test_deleted_track_cascades_playlist(self):
        t = self.first()
        p = self.action('playlist',{'name':'P'})['id']
        self.action('playlistTracks',{'id':p,'tracks':[t['id']]})
        (self.root / t['path']).unlink()
        self.action('scan',{})
        self.assertEqual(self.library.state()['playlists'][0]['tracks'],[])

    def test_ambiguous_import_does_not_choose_random_file(self):
        self.action('folder',{'path':'other'})
        (self.root / 'other' / 'Second.wav').write_bytes(b'test')
        self.library.scan()
        result = self.action('import',{'name':'P','content':'Second.wav\nunknown/Second.wav\nother/Second.wav'})
        self.assertEqual(result['matched'],2)
        self.assertEqual(result['missing'],['unknown/Second.wav'])


    def test_existing_nested_audio_matches_uploaded_bytes_and_has_stable_mime(self):
        # Real PCM audio, not an arbitrary byte fixture with an audio extension.
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(8000)
            wav.writeframes(b'\0\0' * 800)
        content = buffer.getvalue()
        folder = self.root / 'Nested \u041f\u0430\u043f\u043a\u0430'
        folder.mkdir()
        source = folder / 'Track \u041c\u0443\u0437\u044b\u043a\u0430 #1.WAV'
        source.write_bytes(content)
        self.library.scan()
        track = next(t for t in self.library.state()['tracks'] if t['path'].endswith('.WAV'))
        with patch('mimetypes.guess_type', return_value=('application/x-broken-registry', None)):
            status, headers, body = self.request('GET', '/media/' + track['id'])
        self.assertEqual((status, body), (200, content))
        self.assertEqual(headers['Content-Type'], 'audio/wav')
        with wave.open(io.BytesIO(body), 'rb') as wav:
            self.assertEqual(wav.getnframes(), 800)
        self.assertEqual(self.request('PUT', '/api/upload', content, {'X-File-Path':'copy.wav'})[0], 201)
        copy = next(t for t in self.library.state()['tracks'] if t['path'] == 'copy.wav')
        self.assertEqual(self.request('GET', '/media/' + copy['id'])[2], body)
        info = json.loads(self.request('GET', '/api/media-info/' + track['id'])[2])
        self.assertEqual((info['mime'], info['container']), ('audio/wav', 'WAV'))

    def test_all_audio_mime_types_are_independent_of_os_registry(self):
        from http_api import MEDIA_TYPES
        for extension, mime in MEDIA_TYPES.items():
            path = self.root / ('sample' + extension.upper())
            path.write_bytes(b'example')
        self.library.scan()
        for t in self.library.state()['tracks']:
            status, headers, _ = self.request('HEAD', '/media/' + t['id'])
            self.assertEqual(status, 200)
            self.assertEqual(headers['Content-Type'], MEDIA_TYPES[Path(t['path']).suffix.lower()])

    def test_read_permissions_are_reported_as_http_error(self):
        url = '/media/' + self.first()['id']
        with patch('pathlib.Path.open', side_effect=PermissionError('denied')):
            status, _, body = self.request('GET', url)
        self.assertEqual(status, 403)
        self.assertIn('error', json.loads(body))

    def test_playback_status_queue_and_heartbeat_expiry(self):
        track = self.first()
        p = self.action('playlist', {'name':'Terminal Mix'})['id']
        report = dict(clientId='browser-1', seq=1, state='playing', trackId=track['id'],
                      playlistId=p, queueName='Mix', queue=[track['id']], position=12.5,
                      duration=100, name='Test browser')
        self.action('playback', report)
        status = json.loads(self.request('GET', '/api/status')[2])
        client = status['clients'][0]
        self.assertEqual(client['playlistName'], 'Terminal Mix')
        self.assertEqual(client['track']['id'], track['id'])
        self.assertEqual((client['state'], client['position'], client['queueCount']), ('playing', 12.5, 1))
        self.assertTrue(client['connected'])
        heartbeat = {k: v for k, v in report.items() if k != 'queue'}
        self.action('playback', dict(heartbeat, seq=2))
        self.assertEqual(self.library.status()['clients'][0]['queueCount'], 1)
        reconnect = self.action('playback', dict(heartbeat, clientId='new-browser'))
        self.assertTrue(reconnect['needsQueue'])
        # Old requests arriving late cannot overwrite a newer player state.
        self.action('playback', dict(report, seq=3, state='paused'))
        self.action('playback', dict(report, seq=2, state='playing'))
        self.assertEqual(self.library.status()['clients'][0]['state'], 'paused')
        self.library.clients.pop('new-browser')
        seen = self.library.clients['browser-1']['lastSeen']
        with patch('library.time.time', return_value=seen + 46):
            self.assertFalse(self.library.status()['clients'][0]['connected'])
        with patch('library.time.time', return_value=seen + 301):
            self.assertEqual(self.library.status()['clients'], [])
        self.assertEqual(self.request('POST', '/api/playback', dict(report, state='invalid'))[0], 400)
        self.assertEqual(self.request('POST', '/api/playback', dict(report, queue=[{}]))[0], 400)

    def test_tui_once_uses_running_server_without_access_to_music_storage(self):
        result = subprocess.run([sys.executable, 'tui.py', '--url',
            f'http://127.0.0.1:{self.server.server_port}', '--json'],
            capture_output=True, encoding='utf-8', timeout=10,
            env={**__import__('os').environ, 'PYTHONIOENCODING':'utf-8'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['tracks'], 2)



    def test_cancelled_audio_stream_does_not_send_second_response_or_log_traceback(self):
        original_write = socketserver._SocketWriter.write
        original_finish = Handler.finish
        audio_body = (self.root / self.first()['path']).read_bytes()
        url = '/media/' + self.first()['id']
        # Include a generic I/O failure to ensure an HTTP response is never
        # appended to an already-started audio body, regardless of error type.
        for exception in (ConnectionAbortedError, ConnectionResetError, BrokenPipeError,
                          TimeoutError, OSError):
            with self.subTest(exception=exception.__name__):
                writes, failed = [], []
                finished = threading.Event()

                def write(writer, data):
                    writes.append(bytes(data))
                    if data == audio_body or failed:
                        failed.append(True)
                        raise exception('simulated cancelled stream')
                    return original_write(writer, data)

                def finish(handler):
                    try:
                        original_finish(handler)
                    finally:
                        finished.set()

                with patch('socketserver._SocketWriter.write', new=write), \
                     patch.object(Handler, 'finish', new=finish), \
                     patch.object(self.server, 'handle_error') as errors:
                    with self.assertRaises(http.client.IncompleteRead):
                        self.request('GET', url)
                    self.assertTrue(finished.wait(5), 'Request did not terminate')
                    errors.assert_not_called()
                self.assertEqual(sum(w.startswith(b'HTTP/') for w in writes), 1)
                self.assertEqual(self.library.streams, 0)
        # Cancelling one connection must not affect subsequent playback.
        self.assertEqual(self.request('GET', url)[2], audio_body)

    def test_disconnect_during_headers_and_json_closes_only_that_connection(self):
        original_write = socketserver._SocketWriter.write
        original_finish = Handler.finish
        for method, url, fail_headers in [('HEAD', '/media/' + self.first()['id'], True),
                                          ('GET', '/api/state', False)]:
            with self.subTest(method=method, url=url):
                finished = threading.Event()
                failed = []

                def write(writer, data):
                    if failed or (bytes(data).startswith(b'HTTP/') == fail_headers):
                        failed.append(True)
                        raise ConnectionAbortedError('simulated disconnected client')
                    return original_write(writer, data)

                def finish(handler):
                    try:
                        original_finish(handler)
                    finally:
                        finished.set()

                with patch('socketserver._SocketWriter.write', new=write), \
                     patch.object(Handler, 'finish', new=finish), \
                     patch.object(self.server, 'handle_error') as errors:
                    with self.assertRaises((http.client.RemoteDisconnected, http.client.IncompleteRead)):
                        self.request(method, url)
                    self.assertTrue(finished.wait(5))
                    errors.assert_not_called()
        self.assertEqual(self.request('GET', '/api/state')[0], 200)



    def test_response_tracking_resets_on_persistent_connections(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            for url, expected in [('/media/' + self.first()['id'], 200),
                                  ('/media/missing', 404), ('/api/state', 200)]:
                conn.request('GET', url)
                response = conn.getresponse()
                self.assertEqual(response.status, expected)
                self.assertTrue(response.read())
        finally:
            conn.close()



    def test_cover_cache_and_modular_client_assets(self):
        import hashlib
        image = b'\xff\xd8\xff\xd9'
        identifier = hashlib.sha256(image).hexdigest()
        (self.library.reader.cache / (identifier + '.jpg')).write_bytes(image)
        status, headers, body = self.request('GET','/covers/' + identifier + '.jpg')
        self.assertEqual((status,headers['Content-Type'],body),(200,'image/jpeg',image))
        self.assertEqual(self.request('GET','/covers/../server.py')[0],404)
        for name in ['operations','health','devices','audio-wave','visualizer','catalog','collection','queue','core','settings','library','views','player','app']:
            status, headers, body = self.request('GET','/' + name + '.js')
            self.assertEqual(status,200)
            self.assertEqual(headers['Content-Type'],'text/javascript; charset=utf-8')
            self.assertTrue(body)

    def test_duplicate_queue_entries_report_correct_current_occurrence(self):
        t = self.first()['id']
        self.action('playback',dict(clientId='duplicates',seq=1,state='playing',trackId=t,
            queue=[t,t],queueEntryIds=['entry1','entry2'],queueEntryId='entry2'))
        client = self.library.status()['clients'][0]
        self.assertEqual(client['queueIndex'],1)
        self.assertEqual([t['entryId'] for t in client['queue']],['entry1','entry2'])
        self.assertEqual(self.request('POST','/api/playback',dict(clientId='bad',queue=[t],queueEntryIds=[]))[0],400)



    def test_history_api_favorites_and_media_requests_do_not_count_as_listening(self):
        t = self.first()['id']
        self.request('GET','/media/' + t)
        self.request('HEAD','/media/' + t)
        status, _, body = self.request('GET','/api/history')
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['total'],0)
        self.action('favorite',{'id':t,'value':True})
        self.assertTrue(next(row for row in self.library.state()['tracks'] if row['id']==t)['favorite'])
        report = dict(id='audition',trackId=t,deviceId='device',deviceName='PC',seq=1,
                      listened=31,position=50,duration=120,ended=False)
        self.action('listen',report)
        self.action('listen',report)
        status, _, body = self.request('GET','/api/history?device=device&limit=1')
        self.assertEqual(status,200)
        history=json.loads(body)
        self.assertEqual(history['total'],1)
        self.assertEqual(history['items'][0]['position'],50)
        self.assertEqual(self.request('GET','/api/history?limit=0')[0],400)
        for name in ['listen-session','history']:
            self.assertEqual(self.request('GET','/' + name + '.js')[0],200)


    def test_control_http_is_addressed_and_confirmed(self):
        for name in ['pc','phone']:
            self.action('playback',dict(clientId=name,seq=1,state='paused',name=name,controlVersion=1,volume=.4))
        from tui import send_command
        sent=send_command(f'http://127.0.0.1:{self.server.server_port}','pc','volume',.2)
        self.assertEqual(sent['state'],'pending')
        self.assertIsNone(self.action('control-poll',dict(clientId='phone'))['command'])
        cmd=self.action('control-poll',dict(clientId='pc'))['command']
        self.assertEqual((cmd['action'],cmd['value']),('volume',.2))
        self.action('control-ack',dict(clientId='pc',id=cmd['id'],ok=True))
        self.assertEqual(self.action('control-result',dict(id=cmd['id']))['state'],'done')
        status=self.library.status()['clients'][0]
        self.assertEqual((status['volume'],status['controlVersion']),(.4,1))


    def test_health_http_report_and_validation(self):
        (self.root/'Second.wav').unlink()
        sent=self.action('health-start',{'mode':'quick'})
        self.library.health.thread.join(3)
        status,_,body=self.request('GET','/api/health?category=missing&limit=50')
        report=json.loads(body)
        self.assertEqual((status,report['state'],report['counts']['missing']),(200,'done',1))
        self.assertEqual(report['items'][0]['path'],'Second.wav')
        self.assertEqual(self.request('GET','/api/health?category=invalid')[0],400)
        self.assertEqual(self.request('GET','/api/health?limit=10000')[0],400)
        self.assertEqual(self.request('GET','/api/health?jobId=old')[0],400)
        self.assertEqual(self.request('POST','/api/health-cancel',{'jobId':'old'})[0],400)
        self.assertEqual(self.action('health-cancel',{'jobId':sent['jobId']})['state'],'done')


    def test_undo_http_metadata_journal_and_conflicts(self):
        track=self.first()
        edited=self.action('metadata',{'id':track['id'],'title':'Manual undo test'})
        self.assertTrue(edited['operationId'])
        status,_,body=self.request('GET','/api/operations?offset=0&limit=30')
        history=json.loads(body)
        self.assertEqual((status,history['items'][0]['id']),(200,edited['operationId']))
        self.action('undo',{'id':edited['operationId']})
        self.assertEqual(self.library.track(track['id'])['title'],track['title'])
        self.assertEqual(self.action('undo',{'id':edited['operationId']})['state'],'undone')
        self.assertEqual(self.request('GET','/api/operations?limit=1000')[0],400)
        self.assertEqual(self.request('POST','/api/undo',{'id':'missing'})[0],400)
        self.assertEqual(self.request('POST','/api/operation-recover',{'id':'missing'})[0],400)


if __name__ == '__main__':
    unittest.main()
