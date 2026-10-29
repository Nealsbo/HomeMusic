"""Music storage, catalog, playlists and playback presence."""
from __future__ import annotations

from contextlib import contextmanager
import json
import math
import os
import re
from pathlib import Path, PurePosixPath
import sqlite3
import threading
import time
import uuid
from urllib.parse import unquote

from collection_health import CollectionHealth
from operations import OperationHistory
from control import ControlStore
from listening import ListeningStore
from database import migrate, SCHEMA_VERSION
from media_metadata import MetadataReader, EDIT_FIELDS, TECH_FIELDS, fallback

FORMATS = {'.mp3', '.flac', '.ogg', '.opus', '.wav', '.m4a', '.aac', '.webm', '.aiff'}


def re_client_id(value):
    return re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value) is not None


class Library:
    def __init__(self, root, database, max_upload_mb=512, ffprobe=None, ffmpeg=None):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.database = str(Path(database).resolve())
        Path(self.database).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.started = time.time()
        self.streams = 0
        self.requests = 0
        self.bytes_sent = 0
        self.max_upload_mb = max_upload_mb
        self.clients = {}
        self.control = ControlStore(self)
        self.operations = OperationHistory(self)
        self.health = CollectionHealth(self)
        self.reader = MetadataReader(Path(self.database).parent / 'covers', ffprobe, ffmpeg)
        self._metadata_event = threading.Event()
        self._stop_metadata = threading.Event()
        self._metadata_thread = None
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS tracks (
                    id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL,
                    title TEXT NOT NULL, artist TEXT DEFAULT '', album TEXT DEFAULT '',
                    size INTEGER, modified REAL, position INTEGER DEFAULT 0);
                CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS items (
                    playlist TEXT, track TEXT, position INTEGER,
                    PRIMARY KEY(playlist,track),
                    FOREIGN KEY(playlist) REFERENCES playlists(id) ON DELETE CASCADE,
                    FOREIGN KEY(track) REFERENCES tracks(id) ON DELETE CASCADE);
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
            ''')
            migrate(db, self.database)
        self.listening = ListeningStore(self.connect,self.lock)
        self.operations.mark_interrupted()
        if not self.operations.has_recovery():
            self.scan()

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=30)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def path(self, relative='', must_exist=False):
        if (not isinstance(relative, str) or '\\' in relative or ':' in relative
                or any(ord(c) < 32 for c in relative)):
            raise ValueError('Недопустимый путь')
        parts = PurePosixPath(relative)
        if parts.is_absolute() or '..' in parts.parts:
            raise ValueError('Путь должен находиться в музыкальной директории')
        target = self.root.joinpath(*parts.parts)
        # Reject symlinks, including links to other locations within the library.
        cursor = self.root
        for part in parts.parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise ValueError('Символические ссылки не поддерживаются')
        if not target.resolve().is_relative_to(self.root):
            raise ValueError('Выход за музыкальную директорию')
        if must_exist and not target.exists():
            raise FileNotFoundError(relative)
        return target

    def scan(self):
        with self.lock, self.connect() as db:
            self.operations.ensure_ready(db)
            known = {r['path']: r for r in db.execute('SELECT * FROM tracks')}
            seen = set()
            position = db.execute('SELECT COALESCE(MAX(position),0) FROM tracks').fetchone()[0]
            def scan_error(error):
                raise error
            for directory, dirs, files in os.walk(self.root, followlinks=False, onerror=scan_error):
                dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
                for name in sorted(files):
                    p = Path(directory) / name
                    if p.suffix.lower() not in FORMATS or p.is_symlink():
                        continue
                    relative = p.relative_to(self.root).as_posix()
                    seen.add(relative)
                    try:
                        stat = p.stat()
                    except FileNotFoundError:
                        seen.discard(relative)
                        continue
                    if relative in known:
                        old = known[relative]
                        changed = old['size'] != stat.st_size or old['file_mtime_ns'] != stat.st_mtime_ns
                        missing_cover = old['cover_id'] and not (self.reader.cache / (old['cover_id'] + '.jpg')).is_file()
                        if changed or missing_cover or old['metadata_key'] != self.reader.key:
                            db.execute('UPDATE tracks SET size=?, modified=?, file_mtime_ns=?, metadata_key=? WHERE path=?',
                                       (stat.st_size, stat.st_mtime, stat.st_mtime_ns, '', relative))
                    else:
                        position += 1
                        initial = fallback(p)
                        db.execute('''INSERT INTO tracks
                            (id,path,title,artist,album,size,modified,position,file_mtime_ns,added)
                            VALUES(?,?,?,?,?,?,?,?,?,?)''',
                            (uuid.uuid4().hex, relative, initial['title'], initial['artist'], '',
                             stat.st_size, stat.st_mtime, position, stat.st_mtime_ns, time.time()))
            for path in known.keys() - seen:
                db.execute('DELETE FROM tracks WHERE path=?', (path,))
        self._metadata_event.set()

    def start_metadata_worker(self):
        if self._metadata_thread and self._metadata_thread.is_alive():
            return
        self._stop_metadata.clear()
        self._metadata_thread = threading.Thread(target=self._metadata_worker, name='music-metadata', daemon=True)
        self._metadata_thread.start()

    def close(self):
        self.health.close()
        self._stop_metadata.set()
        self._metadata_event.set()
        if self._metadata_thread:
            self._metadata_thread.join(timeout=55)

    def _metadata_worker(self):
        while not self._stop_metadata.is_set():
            self._metadata_event.clear()
            if not self.index_pending(limit=1):
                self._metadata_event.wait(timeout=2)

    def index_pending(self, limit=None):
        """Bounded worker operation; expensive probing runs outside the library lock."""
        completed = 0
        while not self._stop_metadata.is_set() and (limit is None or completed < limit):
            with self.lock, self.connect() as db:
                row = db.execute("SELECT * FROM tracks WHERE metadata_key='' ORDER BY position LIMIT 1").fetchone()
                if row is None:
                    return completed
                snapshot = dict(row)
            source = self.path(snapshot['path'])
            result = self.reader.read(source)
            with self.lock, self.connect() as db:
                latest = db.execute('SELECT * FROM tracks WHERE id=?', (snapshot['id'],)).fetchone()
                if latest is not None and (latest['path'], latest['file_mtime_ns'], latest['size']) == (
                        snapshot['path'], snapshot['file_mtime_ns'], snapshot['size']):
                    try:
                        stat = source.stat()
                    except OSError:
                        stat = None
                    if stat and (stat.st_mtime_ns, stat.st_size) != (snapshot['file_mtime_ns'], snapshot['size']):
                        db.execute('UPDATE tracks SET file_mtime_ns=?,modified=?,size=? WHERE id=?',
                                   (stat.st_mtime_ns,stat.st_mtime,stat.st_size,snapshot['id']))
                    else:
                        imported = {key: result[key] for key in (*EDIT_FIELDS, *TECH_FIELDS)}
                        values = {**imported, **json.loads(latest['overrides'])}
                        fields = (*EDIT_FIELDS, *TECH_FIELDS)
                        db.execute('UPDATE tracks SET ' + ','.join(key + '=?' for key in fields) +
                                   ',source_tags=?,metadata_error=?,metadata_key=? WHERE id=?',
                                   [values[key] for key in fields] + [json.dumps(imported, ensure_ascii=False),
                                    result['metadata_error'], self.reader.key, snapshot['id']])
            completed += 1
        return completed

    def state(self):
        with self.lock, self.connect() as db:
            tracks = []
            for row in db.execute('SELECT * FROM tracks ORDER BY position,path'):
                track = dict(row)
                track['metadata_overrides'] = list(json.loads(track.pop('overrides')))
                track.pop('source_tags')
                tracks.append(track)
            listening_policy = self.listening.decorate(db,tracks)
            pending = db.execute("SELECT COUNT(*) FROM tracks WHERE metadata_key=''").fetchone()[0]
            playlists = [dict(r) for r in db.execute('SELECT * FROM playlists ORDER BY name')]
            for playlist in playlists:
                playlist['tracks'] = [r[0] for r in db.execute(
                    'SELECT track FROM items WHERE playlist=? ORDER BY position', (playlist['id'],))]
            settings = {r['key']: json.loads(r['value']) for r in db.execute('SELECT * FROM settings')}
            folders = ['']
            for directory, dirs, _ in os.walk(self.root):
                dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
                if Path(directory) != self.root:
                    folders.append(Path(directory).relative_to(self.root).as_posix())
            return dict(tracks=tracks, playlists=playlists, folders=folders, settings=settings,
                        storage=str(self.root), maxUploadMB=self.max_upload_mb, schemaVersion=SCHEMA_VERSION,
                        metadata=dict(self.reader.capabilities(), pending=pending), listeningPolicy=listening_policy,
                        operationRecovery=self.operations.has_recovery(db))

    def track(self, identifier):
        with self.connect() as db:
            row = db.execute('SELECT * FROM tracks WHERE id=?', (identifier,)).fetchone()
            if row is None:
                raise FileNotFoundError('Трек не найден')
            return dict(row)

    def playback(self, data):
        """Ephemeral browser reports, not a server-side audio player."""
        identifier = data.get('clientId')
        if not isinstance(identifier, str) or not re_client_id(identifier):
            raise ValueError('Некорректный идентификатор плеера')
        playback_state = data.get('state', 'idle')
        if playback_state not in {'idle', 'playing', 'paused', 'buffering', 'ended', 'error'}:
            raise ValueError('Некорректное состояние плеера')
        def seconds(key):
            value = float(data.get(key) or 0)
            if not math.isfinite(value) or value < 0:
                raise ValueError('Некорректное время воспроизведения')
            return value
        position, duration = seconds('position'), seconds('duration')
        volume = float(data.get('volume', .75))
        if not math.isfinite(volume) or not 0 <= volume <= 1:
            raise ValueError('Некорректная громкость')
        seq = int(data.get('seq', 0))
        queue = data.get('queue')
        if queue is not None and (not isinstance(queue, list) or len(queue) > 20000 or
                                  any(not isinstance(t, str) or len(t) > 64 for t in queue)):
            raise ValueError('Некорректная очередь')
        entry_ids = data.get('queueEntryIds')
        if entry_ids is not None and (queue is None or not isinstance(entry_ids, list) or
                len(entry_ids) != len(queue) or any(not isinstance(t, str) or not re_client_id(t) for t in entry_ids)
                or len(set(entry_ids)) != len(entry_ids)):
            raise ValueError('Некорректные элементы очереди')
        with self.lock:
            now = time.time()
            self.clients = {k: v for k, v in self.clients.items() if now - v['lastSeen'] < 300}
            old = self.clients.get(identifier, {})
            if seq <= old.get('seq', -1):
                return {'ok': True}
            if not old and len(self.clients) >= 128:
                raise ValueError('Достигнут лимит отслеживаемых плееров')
            self.clients[identifier] = dict(
                clientId=identifier, seq=seq, volume=volume, controlVersion=1 if data.get('controlVersion') == 1 else 0,
                deviceId=str(data.get('deviceId') or '')[:80], name=str(data.get('name') or 'Браузер')[:100],
                state=playback_state, trackId=str(data.get('trackId') or '')[:64],
                queueEntryId=str(data.get('queueEntryId') or '')[:80],
                queueEntryIds=entry_ids if entry_ids is not None else ([] if queue is not None else old.get('queueEntryIds', [])),
                playlistId=str(data.get('playlistId') or '')[:64],
                queueName=str(data.get('queueName') or 'Очередь')[:160],
                queue=queue if queue is not None else old.get('queue', []),
                position=position, duration=duration, lastSeen=now,
                error=str(data.get('error') or '')[:1000])
        return {'ok': True, 'needsQueue': queue is None and not old}

    def status(self):
        with self.lock, self.connect() as db:
            now = time.time()
            self.clients = {k: v for k, v in self.clients.items() if now - v['lastSeen'] < 300}
            count, size = db.execute('SELECT COUNT(*), COALESCE(SUM(size),0) FROM tracks').fetchone()
            playlists = [dict(r) for r in db.execute('''SELECT p.id,p.name,COUNT(i.track) AS tracks
                FROM playlists p LEFT JOIN items i ON i.playlist=p.id GROUP BY p.id ORDER BY p.name''')]
            sessions = []
            for client in self.clients.values():
                item = {k: v for k, v in client.items() if k not in ('queue', 'queueEntryIds')}
                item['age'] = max(0, now - client['lastSeen'])
                item['connected'] = item['age'] < 45
                queue = client['queue']
                current = queue.index(client['trackId']) if client['trackId'] in queue else -1
                entry_ids = client.get('queueEntryIds', [])
                if client.get('queueEntryId') in entry_ids:
                    current = entry_ids.index(client['queueEntryId'])
                start = max(0, current - 3)
                preview = queue[start:start + 15]
                ids = list(dict.fromkeys([client['trackId'], *preview]))
                tracks = {r['id']: dict(r) for r in db.execute(
                    'SELECT id,title,artist,path FROM tracks WHERE id IN (' + ','.join('?' for _ in ids) + ')', ids)}
                item.update(track=tracks.get(client['trackId']), queueCount=len(queue),
                            queueIndex=current, queueStart=start,
                            queue=[tracks.get(t, dict(id=t, title='Удалённый трек', artist='')) for t in preview])
                for offset, track in enumerate(item['queue']):
                    item['queue'][offset] = {**track, 'entryId': entry_ids[start + offset] if entry_ids else ''}
                playlist = next((p for p in playlists if p['id'] == client['playlistId']), None)
                item['playlistName'] = playlist['name'] if playlist else client['queueName']
                sessions.append(item)
            return dict(server='online', storage=str(self.root), uptime=int(now - self.started),
                        tracks=count, libraryBytes=size, streams=self.streams,
                        bytesSent=self.bytes_sent, clients=sessions, playlists=playlists)

    def action(self, action, data):
        if action == 'undo':
            return self.operations.undo(data)
        if action == 'operation-recover':
            return self.operations.recover(data)
        if action == 'health-start':
            return self.health.start(data)
        if action == 'health-cancel':
            return self.health.cancel(data)
        control_actions = {'control':self.control.send, 'control-poll':self.control.poll,
                           'control-ack':self.control.ack, 'control-result':self.control.result}
        if action in control_actions:
            return control_actions[action](data)
        if action == 'device':
            return self.listening.device(data)
        if action == 'listen':
            return self.listening.report(data)
        if action == 'favorite':
            return self.listening.favorite(data)
        if action == 'playback':
            return self.playback(data)
        operation_id = None
        with self.lock, self.connect() as db:
            if action == 'scan':
                self.scan()
            elif action == 'folder':
                self.path(data['path']).mkdir(parents=True, exist_ok=True)
            elif action == 'move':
                return self.operations.move(db, data)
            elif action == 'playlist':
                name = str(data['name']).strip()[:160]
                if not name:
                    raise ValueError('Введите название плейлиста')
                identifier = data.get('id') or uuid.uuid4().hex
                before = self.operations.playlist(db, identifier)
                db.execute('INSERT INTO playlists VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name',
                           (identifier, name))
                operation_id = self.operations.record(db, 'playlist', identifier, 'Плейлист: ' + name, before, self.operations.playlist(db, identifier))
                return {'id': identifier, 'operationId': operation_id}
            elif action == 'deletePlaylist':
                before = self.operations.playlist(db, data['id'])
                db.execute('DELETE FROM playlists WHERE id=?', (data['id'],))
                operation_id = self.operations.record(db, 'playlist', data['id'], 'Удаление плейлиста: ' + (before['name'] if before else ''), before, None)
            elif action == 'playlistTracks':
                identifier = data['id']
                before = self.operations.playlist(db, identifier)
                if not db.execute('SELECT 1 FROM playlists WHERE id=?', (identifier,)).fetchone():
                    raise ValueError('Плейлист не найден')
                ids = list(dict.fromkeys(data['tracks']))
                valid = {r[0] for r in db.execute('SELECT id FROM tracks')}
                if any(t not in valid for t in ids):
                    raise ValueError('Один из треков был удалён. Обновите медиатеку.')
                db.execute('DELETE FROM items WHERE playlist=?', (identifier,))
                db.executemany('INSERT INTO items VALUES(?,?,?)',
                               [(identifier, t, i) for i, t in enumerate(ids)])
                operation_id = self.operations.record(db, 'playlist', identifier, 'Состав и порядок плейлиста: ' + before['name'], before, self.operations.playlist(db, identifier))
            elif action == 'order':
                db.executemany('UPDATE tracks SET position=? WHERE id=?',
                               [(i, t) for i, t in enumerate(dict.fromkeys(data['tracks']))])
            elif action == 'settings':
                for key in ('title', 'defaultVolume'):
                    if key in data:
                        value = data[key]
                        if key == 'title':
                            value = str(value).strip()[:80] or 'Тихая волна'
                        else:
                            value = max(0, min(1, float(value)))
                        db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)', (key, json.dumps(value)))
            elif action == 'metadata':
                row = db.execute('SELECT * FROM tracks WHERE id=?', (data['id'],)).fetchone()
                if row is None:
                    raise ValueError('Трек не найден')
                before = json.loads(row['overrides'])
                overrides = dict(before)
                if data.get('reset'):
                    overrides = {}
                else:
                    for key in EDIT_FIELDS:
                        if key in data:
                            overrides[key] = max(0, min(99999, int(data[key] or 0))) if key.endswith('_number') else str(data[key])[:300]
                imported = {**fallback(row['path']), **json.loads(row['source_tags'])}
                values = {**imported, **overrides}
                db.execute('UPDATE tracks SET ' + ','.join(key + '=?' for key in EDIT_FIELDS) +
                           ',overrides=? WHERE id=?', [values[key] for key in EDIT_FIELDS] +
                           [json.dumps(overrides, ensure_ascii=False), data['id']])
                operation_id = self.operations.record(db, 'metadata', data['id'], 'Метаданные: ' + row['title'], before, overrides)
            elif action == 'import':
                content = str(data['content']).lstrip('\ufeff')
                tracks = list(db.execute('SELECT id,path FROM tracks'))
                by_path = {r['path']: r['id'] for r in tracks}
                by_name = {}
                for r in tracks:
                    by_name.setdefault(PurePosixPath(r['path']).name, []).append(r['id'])
                matched, missing = [], []
                for line in content.splitlines():
                    line = unquote(line.strip()).replace('\\', '/')
                    if not line or line.startswith('#'):
                        continue
                    identifier = by_path.get(line.removeprefix('./'))
                    if not identifier:
                        candidates = by_name.get(line.rsplit('/', 1)[-1], [])
                        identifier = candidates[0] if len(candidates) == 1 else None
                    if identifier:
                        if identifier not in matched:
                            matched.append(identifier)
                    else:
                        missing.append(line)
                identifier = uuid.uuid4().hex
                db.execute('INSERT INTO playlists VALUES(?,?)', (identifier, str(data['name'])[:160]))
                db.executemany('INSERT INTO items VALUES(?,?,?)',
                               [(identifier, t, i) for i, t in enumerate(matched)])
                operation_id = self.operations.record(db, 'playlist', identifier, 'Импорт плейлиста: ' + str(data['name']), None, self.operations.playlist(db, identifier))
                return {'id': identifier, 'matched': len(matched), 'missing': missing, 'operationId': operation_id}
            else:
                raise ValueError('Неизвестная команда')
        return {'ok': True, 'operationId': operation_id}


