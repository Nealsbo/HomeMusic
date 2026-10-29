"""Versioned, transactional catalog migrations. Never discard legacy values."""
import json
from pathlib import Path
import sqlite3
import time

SCHEMA_VERSION = 3


def migrate(db, filename):
    version = db.execute('PRAGMA user_version').fetchone()[0]
    if version > SCHEMA_VERSION:
        raise RuntimeError(f'Catalog version {version} is newer than supported {SCHEMA_VERSION}')
    if version == SCHEMA_VERSION:
        return
    populated = any(db.execute(f'SELECT 1 FROM {table} LIMIT 1').fetchone()
                    for table in ('tracks', 'playlists', 'settings'))
    if populated:
        backup = Path(str(filename) + f'.pre-v{version + 1}.bak')
        try:
            with backup.open('xb'):
                pass
        except FileExistsError:
            pass
        else:
            try:
                destination = sqlite3.connect(backup)
                try:
                    db.backup(destination)
                finally:
                    destination.close()
            except Exception:
                backup.unlink(missing_ok=True)
                raise
    with db:
        db.execute('BEGIN IMMEDIATE')
        if version < 1:
            columns = {
                'album_artist': "TEXT NOT NULL DEFAULT ''", 'genre': "TEXT NOT NULL DEFAULT ''",
                'year': "TEXT NOT NULL DEFAULT ''", 'track_number': 'INTEGER NOT NULL DEFAULT 0',
                'disc_number': 'INTEGER NOT NULL DEFAULT 0', 'duration': 'REAL NOT NULL DEFAULT 0',
                'codec': "TEXT NOT NULL DEFAULT ''", 'bitrate': 'INTEGER NOT NULL DEFAULT 0',
                'sample_rate': 'INTEGER NOT NULL DEFAULT 0', 'channels': 'INTEGER NOT NULL DEFAULT 0',
                'cover_id': "TEXT NOT NULL DEFAULT ''", 'metadata_error': "TEXT NOT NULL DEFAULT ''",
                'metadata_key': "TEXT NOT NULL DEFAULT ''", 'file_mtime_ns': 'INTEGER NOT NULL DEFAULT 0',
                'overrides': "TEXT NOT NULL DEFAULT '{}'", 'source_tags': "TEXT NOT NULL DEFAULT '{}'",
                'added': 'REAL NOT NULL DEFAULT 0',
            }
            for name, kind in columns.items():
                db.execute(f'ALTER TABLE tracks ADD COLUMN {name} {kind}')
            for row in db.execute('SELECT id,title,artist,album FROM tracks').fetchall():
                # The old catalog did not record provenance. Protect even intentionally
                # blank edits; users can explicitly restore the imported tags in the UI.
                values = dict(title=row['title'], artist=row['artist'], album=row['album'])
                db.execute('UPDATE tracks SET overrides=?,added=? WHERE id=?',
                           (json.dumps(values, ensure_ascii=False), time.time(), row['id']))
            db.execute('CREATE INDEX tracks_album ON tracks(album_artist,album,disc_number,track_number)')
            db.execute('CREATE INDEX tracks_metadata ON tracks(metadata_key,position)')
        if version < 2:
            db.execute('CREATE TABLE devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, updated REAL NOT NULL)')
            db.execute('''CREATE TABLE favorites(track TEXT PRIMARY KEY, added REAL NOT NULL,
                FOREIGN KEY(track) REFERENCES tracks(id) ON DELETE CASCADE)''')
            db.execute('''CREATE TABLE listens(
                id TEXT PRIMARY KEY, track TEXT, title TEXT NOT NULL, artist TEXT NOT NULL, album TEXT NOT NULL,
                device TEXT NOT NULL, started REAL NOT NULL, last_seen REAL NOT NULL,
                listened REAL NOT NULL DEFAULT 0, position REAL NOT NULL DEFAULT 0,
                duration REAL NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
                qualified INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(track) REFERENCES tracks(id) ON DELETE SET NULL,
                FOREIGN KEY(device) REFERENCES devices(id))''')
            db.execute('CREATE INDEX listens_recent ON listens(qualified,started DESC,id DESC)')
            db.execute('CREATE INDEX listens_device ON listens(device,qualified,started DESC,id DESC)')
            db.execute('CREATE INDEX listens_track ON listens(track,qualified)')
        if version < 3:
            db.execute('''CREATE TABLE IF NOT EXISTS operations(
                id TEXT PRIMARY KEY,kind TEXT NOT NULL,resource TEXT NOT NULL,label TEXT NOT NULL,
                before_json TEXT NOT NULL,after_json TEXT NOT NULL,created REAL NOT NULL,
                state TEXT NOT NULL DEFAULT 'done',undone REAL,phase TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '')''')
            db.execute('CREATE INDEX IF NOT EXISTS operations_recent ON operations(created DESC,id DESC)')
        db.execute(f'PRAGMA user_version={SCHEMA_VERSION}')
