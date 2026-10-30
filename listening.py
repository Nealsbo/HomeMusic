"""Shared favorites and idempotent playback history, independent of audio downloads."""
import math
import re
import time

RETENTION_DAYS = 365
DRAFT_DAYS = 7
MAX_HISTORY = 50000
MAX_DRAFTS = 5000
ID = re.compile(r'[A-Za-z0-9_-]{1,80}')


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        raise ValueError('Invalid ID')
    return value


def seconds(value):
    result = float(value or 0)
    if not math.isfinite(result) or not 0 <= result <= 7 * 86400:
        raise ValueError('Invalid listening time')
    return result


class ListeningStore:
    def __init__(self, connect, lock):
        self.connect, self.lock = connect, lock
        self.last_cleanup = 0
        self.cleanup()

    def cleanup(self, db=None):
        now = time.time()
        if now - self.last_cleanup < 3600:
            return
        if db is None:
            with self.lock, self.connect() as connection:
                self.cleanup(connection)
            return
        db.execute('DELETE FROM listens WHERE qualified=1 AND started<?', (now - RETENTION_DAYS * 86400,))
        db.execute('DELETE FROM listens WHERE qualified=0 AND last_seen<?', (now - DRAFT_DAYS * 86400,))
        for qualified, maximum in ((1, MAX_HISTORY), (0, MAX_DRAFTS)):
            db.execute('''DELETE FROM listens WHERE id IN
                (SELECT id FROM listens WHERE qualified=? ORDER BY started DESC,id DESC LIMIT -1 OFFSET ?)''',
                       (qualified, maximum))
        db.execute('DELETE FROM devices WHERE NOT EXISTS(SELECT 1 FROM listens WHERE listens.device=devices.id)')
        self.last_cleanup = now

    def favorite(self, data):
        track = identifier(data.get('id'))
        value = data.get('value')
        if not isinstance(value, bool):
            raise ValueError('Specify true or false for favorites')
        with self.lock, self.connect() as db:
            if not db.execute('SELECT 1 FROM tracks WHERE id=?', (track,)).fetchone():
                raise ValueError('Track not found')
            if value:
                db.execute('INSERT OR IGNORE INTO favorites VALUES(?,?)', (track, time.time()))
            else:
                db.execute('DELETE FROM favorites WHERE track=?', (track,))
        return dict(ok=True, favorite=value)

    def device(self, data):
        device = identifier(data.get('id'))
        name = ''.join(c for c in str(data.get('name') or '')[:80] if ord(c) >= 32).strip()
        if not name:
            raise ValueError('Enter a device name')
        with self.lock, self.connect() as db:
            db.execute('INSERT INTO devices VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated=excluded.updated',
                       (device, name, time.time()))
        return dict(ok=True, name=name)

    def report(self, data):
        event, track, device = (identifier(data.get(key)) for key in ('id', 'trackId', 'deviceId'))
        seq = data.get('seq')
        if not isinstance(seq, int) or isinstance(seq, bool) or not 1 <= seq <= 2**53 - 1:
            raise ValueError('Invalid report sequence number')
        heard, position, duration = (seconds(data.get(key)) for key in ('listened', 'position', 'duration'))
        ended = data.get('ended', False)
        if not isinstance(ended, bool):
            raise ValueError('Invalid completion flag')
        name = str(data.get('deviceName') or 'Browser')[:80]
        name = ''.join(c for c in name if ord(c) >= 32).strip() or 'Browser'
        with self.lock, self.connect() as db:
            self.cleanup(db)
            old = db.execute('SELECT * FROM listens WHERE id=?', (event,)).fetchone()
            if old and (old['track'] != track or old['device'] != device):
                raise ValueError('Listening session ID is already in use')
            if old and seq <= old['seq']:
                return dict(ok=True, qualified=bool(old['qualified']))
            song = db.execute('SELECT title,artist,album,duration FROM tracks WHERE id=?', (track,)).fetchone()
            if song is None:
                raise ValueError('Track not found')
            now = time.time()
            started = now - heard
            if data.get('startedAt') is not None:
                declared = float(data['startedAt'])
                if not math.isfinite(declared) or declared < 0:
                    raise ValueError('Invalid listening start time')
                if now - RETENTION_DAYS * 86400 <= declared <= now + 300:
                    started = min(declared, now)
            db.execute('INSERT INTO devices VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated=excluded.updated',
                       (device, name, now))
            heard = max(heard, old['listened'] if old else 0)
            known_duration = song['duration'] or duration
            threshold = min(30, known_duration / 2) if known_duration > 0 else 30
            qualified = bool((old and old['qualified']) or heard >= threshold)
            if old:
                db.execute('UPDATE listens SET last_seen=?,listened=?,position=?,duration=?,seq=?,qualified=?,ended=? WHERE id=?',
                           (now, heard, position, known_duration, seq, qualified, bool(ended or old['ended']), event))
            else:
                db.execute('INSERT INTO listens VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                           (event, track, song['title'], song['artist'], song['album'], device,
                            started, now, heard, position, known_duration, seq, qualified, ended))
        return dict(ok=True, qualified=qualified, newlyQualified=qualified and not bool(old and old['qualified']))

    def decorate(self, db, tracks):
        self.cleanup(db)
        favorites = {r['track']: r['added'] for r in db.execute('SELECT * FROM favorites')}
        stats = {r['track']: dict(r) for r in db.execute('''SELECT track,COUNT(*) AS play_count,
            MAX(started) AS last_played,SUM(listened) AS listened_seconds
            FROM listens WHERE qualified=1 AND track IS NOT NULL GROUP BY track''')}
        for track in tracks:
            values = stats.get(track['id'], {})
            track.update(favorite=track['id'] in favorites, favorite_at=favorites.get(track['id'], 0),
                         play_count=values.get('play_count', 0), last_played=values.get('last_played', 0),
                         listened_seconds=values.get('listened_seconds', 0))
        return dict(retentionDays=RETENTION_DAYS, thresholdSeconds=30, thresholdFraction=.5)

    def history(self, device='', limit=50, before_started=None, before_id=''):
        if device:
            identifier(device)
        limit = int(limit)
        if not 1 <= limit <= 100:
            raise ValueError('Page size must be between 1 and 100')
        where, params = ['h.qualified=1'], []
        if device:
            where.append('h.device=?')
            params.append(device)
        if before_started is not None:
            value = float(before_started)
            if not math.isfinite(value) or value < 0:
                raise ValueError('Invalid page cursor')
            identifier(before_id)
            where.append('(h.started<? OR (h.started=? AND h.id<?))')
            params.extend([value, value, before_id])
        with self.lock, self.connect() as db:
            self.cleanup(db)
            rows = [dict(r) for r in db.execute('''SELECT h.id,h.track AS trackId,h.device AS deviceId,
                d.name AS deviceName,h.started,h.last_seen AS lastSeen,h.listened,h.position,h.duration,h.ended,
                COALESCE(t.title,h.title) AS title,COALESCE(t.artist,h.artist) AS artist,
                COALESCE(t.album,h.album) AS album,COALESCE(t.cover_id,'') AS cover_id
                FROM listens h JOIN devices d ON d.id=h.device LEFT JOIN tracks t ON t.id=h.track WHERE ''' +
                ' AND '.join(where) + ' ORDER BY h.started DESC,h.id DESC LIMIT ?', params + [limit + 1])]
            more = len(rows) > limit
            rows = rows[:limit]
            devices = [dict(r) for r in db.execute('''SELECT d.id,d.name FROM devices d
                WHERE EXISTS(SELECT 1 FROM listens h WHERE h.device=d.id AND h.qualified=1) ORDER BY d.name,d.id''')]
            count = db.execute('SELECT COUNT(*) FROM listens WHERE qualified=1' + (' AND device=?' if device else ''),
                               [device] if device else []).fetchone()[0]
        cursor = dict(started=rows[-1]['started'], id=rows[-1]['id']) if more and rows else None
        return dict(items=rows, devices=devices, total=count, nextCursor=cursor, retentionDays=RETENTION_DAYS)
