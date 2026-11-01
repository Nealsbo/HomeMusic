"""HTTP API, uploads and byte-range audio streaming."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit, parse_qs

from library import FORMATS

WEB = Path(__file__).parent / 'web'
# Do not use the Windows registry for MIME types: installed applications can
# register audio extensions as application/octet-stream or unrelated types.
MEDIA_TYPES = {
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.aac': 'audio/aac', '.webm': 'audio/webm', '.aiff': 'audio/aiff',
}
CONNECTION_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def handle_one_request(self):
        # A persistent connection can carry several responses; reset per request.
        self._response_started = False
        try:
            super().handle_one_request()
        except CONNECTION_ERRORS:
            # Changing tracks cancels the previous download, especially on Windows.
            self.close_connection = True

    def end_headers(self):
        # Even a partially written header cannot be replaced with another response.
        self._response_started = True
        super().end_headers()

    @property
    def library(self):
        return self.server.library

    def log_message(self, fmt, *args):
        if self.server.verbose:
            super().log_message(fmt, *args)

    def setup(self):
        super().setup()
        self.connection.settimeout(60)

    def reply(self, status, body, content_type='application/json; charset=utf-8', head=False):
        if self._response_started:
            self.close_connection = True
            return
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        try:
            with self.library.lock:
                self.library.requests += 1
            path = unquote(urlsplit(self.path).path)
            if path == '/api/state':
                return self.reply(200, self.library.state(), head=head)
            if path == '/api/history':
                query = parse_qs(urlsplit(self.path).query)
                try:
                    result = self.library.listening.history(device=query.get('device',[''])[0],
                        limit=query.get('limit',[50])[0], before_started=query.get('beforeStarted',[None])[0],
                        before_id=query.get('beforeId',[''])[0])
                except (ValueError, TypeError) as error:
                    return self.reply(400, {'error': str(error)}, head=head)
                return self.reply(200, result, head=head)
            if path == '/api/operations':
                query = parse_qs(urlsplit(self.path).query)
                try:
                    result = self.library.operations.page(query.get('offset',[0])[0], query.get('limit',[30])[0])
                except (ValueError, TypeError) as error:
                    return self.reply(400, {'error': str(error)}, head=head)
                return self.reply(200, result, head=head)
            if path == '/api/health':
                query = parse_qs(urlsplit(self.path).query)
                try:
                    result = self.library.health.report(category=query.get('category',['missing'])[0],
                        offset=query.get('offset',[0])[0], limit=query.get('limit',[50])[0],
                        job_id=query.get('jobId',[None])[0])
                except (ValueError, TypeError) as error:
                    return self.reply(400, {'error': str(error)}, head=head)
                return self.reply(200, result, head=head)
            if path == '/api/status':
                return self.reply(200, self.library.status(), head=head)
            if path.startswith('/api/media-info/'):
                identifier = path.split('/')[-1]
                track = self.library.track(identifier)
                source = self.library.path(track['path'], True)
                with source.open('rb') as stream:
                    signature = stream.read(16)
                container = ('FLAC' if signature.startswith(b'fLaC') else
                             'Ogg' if signature.startswith(b'OggS') else
                             'WAV' if signature.startswith(b'RIFF') and signature[8:12] == b'WAVE' else
                             'MP4/M4A' if signature[4:8] == b'ftyp' else
                             'MP3/ID3' if signature.startswith(b'ID3') or signature[:1] == b'\xff' else
                             'AIFF' if signature.startswith(b'FORM') else
                             'WebM' if signature.startswith(b'\x1aE\xdf\xa3') else 'unknown')
                return self.reply(200, dict(path=track['path'], size=source.stat().st_size,
                    mime=MEDIA_TYPES.get(source.suffix.lower(), 'application/octet-stream'),
                    container=container), head=head)
            if path == '/api/stats':
                state = self.library.state()
                disk = shutil.disk_usage(self.library.root)
                return self.reply(200, dict(tracks=len(state['tracks']), playlists=len(state['playlists']),
                    libraryBytes=sum(t['size'] for t in state['tracks']), diskFree=disk.free,
                    uptime=int(time.time() - self.library.started), streams=self.library.streams,
                    requests=self.library.requests, bytesSent=self.library.bytes_sent), head=head)
            if path.startswith('/covers/'):
                name = path.removeprefix('/covers/')
                if not re.fullmatch(r'[a-f0-9]{64}\.jpg', name):
                    return self.reply(404, {'error': 'Cover not found'}, head=head)
                return self.send_file(self.library.reader.cache / name, head)
            if path.startswith('/media/'):
                track = self.library.track(path.split('/')[-1])
                return self.send_file(self.library.path(track['path'], True), head, streaming=True)
            if path.startswith('/api/export/'):
                identifier = path.split('/')[-1]
                with self.library.connect() as db:
                    rows = db.execute('SELECT t.* FROM items i JOIN tracks t ON t.id=i.track WHERE i.playlist=? ORDER BY i.position', (identifier,))
                    lines = ['#EXTM3U']
                    for row in rows:
                        lines.extend([f"#EXTINF:-1,{row['artist']} - {row['title']}", row['path']])
                return self.reply(200, ('\n'.join(lines) + '\n').encode('utf-8'), 'audio/x-mpegurl', head)
            assets = {'/': 'index.html', '/style.css': 'style.css', '/layout.css': 'layout.css', '/expanded-player.css': 'expanded-player.css', '/cd-scene.mjs': 'cd-scene.mjs',
                      **{f'/{name}.js': f'{name}.js' for name in ('layout','visualization-presets','cd-view','audio-analysis','effects-view','player-appearance','album-view','player-bridge','player-views','expanded-player','client-session','i18n','bootstrap','operations','health','devices','audio-wave','visualizer','queue','listen-session','catalog','core','settings','library','views','collection','player','history','app')},
                      **{f'/vendor/three-r180/{name}': f'vendor/three-r180/{name}' for name in ('three.module.min.js','three.core.min.js','LICENSE','manifest.json')}}
            if re.fullmatch(r'/locales/[a-zA-Z0-9_-]+\.json', path):
                return self.send_file(WEB / path.lstrip('/'), head)
            if path not in assets:
                return self.reply(404, {'error': 'Not found'}, head=head)
            return self.send_file(WEB / assets[path], head)
        except CONNECTION_ERRORS:
            raise  # Handled at the request boundary, including HEAD and JSON writes.
        except (ValueError, FileNotFoundError) as e:
            self.reply(404, {'error': str(e)}, head=head)
        except PermissionError:
            self.reply(403, {'error': 'The server process has no permission to read this file'}, head=head)
        except OSError as e:
            self.reply(409, {'error': str(e)}, head=head)

    def send_file(self, path, head=False, streaming=False):
        with path.open('rb') as source:
            size = os.fstat(source.fileno()).st_size
            start, end, status = 0, size - 1, 200
            range_header = self.headers.get('Range') if streaming else None
            if range_header:
                match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header)
                if not match or not any(match.groups()):
                    return self.range_error(size)
                left, right = match.groups()
                if left:
                    start = int(left)
                    end = min(int(right), size - 1) if right else size - 1
                else:
                    start = max(0, size - int(right))
                if start > end or start >= size:
                    return self.range_error(size)
                status = 206
            self.send_response(status)
            types = {'.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
                     '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg'}
            self.send_header('Content-Type', types.get(path.suffix.lower()) or
                             MEDIA_TYPES.get(path.suffix.lower(), 'application/octet-stream'))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Content-Length', str(max(0, end - start + 1)))
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('X-Content-Type-Options', 'nosniff')
            if status == 206:
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.end_headers()
            if head:
                return
            source.seek(start)
            remaining = end - start + 1
            if streaming:
                with self.library.lock:
                    self.library.streams += 1
            try:
                while remaining > 0:
                    block = source.read(min(65536, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)
                    if streaming:
                        with self.library.lock:
                            self.library.bytes_sent += len(block)
            finally:
                if streaming:
                    with self.library.lock:
                        self.library.streams -= 1

    def range_error(self, size):
        self.send_response(416)
        self.send_header('Content-Range', f'bytes */{size}')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def check_origin(self):
        origin = self.headers.get('Origin')
        if origin and urlsplit(origin).netloc != self.headers.get('Host'):
            raise ValueError('Cross-site request rejected')

    def do_POST(self):
        try:
            self.check_origin()
            length = int(self.headers.get('Content-Length', '0'))
            limit = (8 if urlsplit(self.path).path == '/api/control-ack' else 2) * 1024 * 1024
            if length <= 0 or length > limit:
                self.close_connection = True
                return self.reply(413, {'error': 'Request is too large'})
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('Expected a JSON object')
            path = urlsplit(self.path).path
            if not path.startswith('/api/'):
                raise ValueError('Unknown endpoint')
            result = self.library.action(path.removeprefix('/api/'), data)
            self.reply(200, result)
        except (ValueError, KeyError, TypeError, sqlite3.IntegrityError) as e:
            self.reply(400, {'error': str(e)})
        except OSError as e:
            self.reply(409, {'error': str(e)})

    def do_PUT(self):
        temporary = None
        try:
            self.check_origin()
            if urlsplit(self.path).path != '/api/upload':
                raise ValueError('Unknown endpoint')
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > self.library.max_upload_mb * 1024 * 1024:
                self.close_connection = True
                return self.reply(413, {'error': f'File limit: {self.library.max_upload_mb} MB'})
            relative = unquote(self.headers.get('X-File-Path', ''))
            target = self.library.path(relative)
            if target.suffix.lower() not in FORMATS:
                raise ValueError('Unsupported audio format')
            if not target.parent.is_dir():
                raise ValueError('Folder not found')
            temporary = target.parent / ('.upload-' + uuid.uuid4().hex)
            with temporary.open('xb') as output:
                remaining = length
                while remaining:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        raise ValueError('Upload interrupted')
                    output.write(chunk)
                    remaining -= len(chunk)
            with self.library.lock:
                # Exclusive creation prevents concurrent clients overwriting each other.
                with target.open('xb') as output, temporary.open('rb') as source:
                    try:
                        shutil.copyfileobj(source, output, 65536)
                    except Exception:
                        output.close()
                        target.unlink(missing_ok=True)
                        raise
                self.library.scan()
            self.reply(201, {'ok': True})
        except (ValueError, OSError) as e:
            self.close_connection = True
            self.reply(409, {'error': str(e)})
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)


