"""Persistent, conflict-checked undo and recoverable no-overwrite file moves."""
import ctypes
import errno
import json
import os
import stat
import sys
import time
import uuid
from media_metadata import EDIT_FIELDS, fallback

FIELD_LABELS = dict(title='Title', artist='Artist', album='Album', album_artist='Album artist',
                    genre='Genre', year='Year', track_number='Track number', disc_number='Disc number')


def move_no_replace(source, target):
    """Atomic no-replace rename on Windows/Linux; safe hard-link fallback."""
    if os.name == 'nt':
        os.rename(source, target)
        return
    if sys.platform.startswith('linux'):
        libc = ctypes.CDLL(None, use_errno=True)
        rename = getattr(libc, 'renameat2', None)
        if rename:
            rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
            rename.restype = ctypes.c_int
            if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1) == 0:
                return
            code = ctypes.get_errno()
            if code not in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP):
                raise OSError(code, os.strerror(code), str(target))
    os.link(source, target)  # Fails if target exists, even if created after preflight.
    try:
        os.unlink(source)
    except Exception:
        if os.path.samefile(source, target):
            os.unlink(target)
        raise


def fingerprint(path):
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError('Path is not a regular file: ' + str(path))
    return dict(size=info.st_size, mtime=info.st_mtime_ns, device=info.st_dev, inode=info.st_ino)


class OperationHistory:
    def __init__(self, library):
        self.library = library

    def mark_interrupted(self):
        with self.library.connect() as db:
            db.execute("UPDATE operations SET state='recovery',error='The server stopped during a move. Restore the state before retrying.' WHERE state IN ('pending','undoing')")

    def has_recovery(self, db=None):
        if db is None:
            with self.library.connect() as connection:
                return self.has_recovery(connection)
        return bool(db.execute("SELECT 1 FROM operations WHERE state IN ('pending','undoing','recovery') LIMIT 1").fetchone())

    def ensure_ready(self, db):
        if self.has_recovery(db):
            raise ValueError('First recover the unfinished move in the operation log')

    @staticmethod
    def playlist(db, key):
        row = db.execute('SELECT id,name FROM playlists WHERE id=?', (key,)).fetchone()
        return None if row is None else dict(row, tracks=[r[0] for r in db.execute('SELECT track FROM items WHERE playlist=? ORDER BY position', (key,))])

    def record(self, db, kind, resource, label, before, after, state='done'):
        if before == after:
            return None
        encoded = [json.dumps(value, ensure_ascii=False) for value in (before, after)]
        if sum(len(value.encode()) for value in encoded) > 8 * 1024 * 1024:
            raise ValueError('Operation is too large for the log; select fewer tracks')
        key = uuid.uuid4().hex
        db.execute('INSERT INTO operations(id,kind,resource,label,before_json,after_json,created,state,phase) VALUES(?,?,?,?,?,?,?,?,?)',
                   (key, kind, resource, label[:400], *encoded, time.time(), state, 'forward' if kind == 'move' else ''))
        self.prune(db)
        return key

    def prune(self, db):
        rows = db.execute("SELECT id,created,LENGTH(CAST(before_json AS BLOB))+LENGTH(CAST(after_json AS BLOB)) AS bytes FROM operations WHERE state IN ('done','undone','failed') ORDER BY created,id").fetchall()
        total, count = sum(r['bytes'] for r in rows), len(rows)
        for row in rows:
            if row['created'] >= time.time() - 30 * 86400 and count <= 500 and total <= 16 * 1024 * 1024:
                break
            db.execute('DELETE FROM operations WHERE id=?', (row['id'],))
            total -= row['bytes']; count -= 1
    def describe(self, row):
        before, after = (json.loads(row[k]) for k in ('before_json', 'after_json'))
        details = []
        messages = []
        label_message = None
        def message(key, **params):
            return dict(key=key, params=params)
        if row['kind'] == 'metadata':
            label_message = message('Metadata: {title}', title=row['label'].partition(': ')[2] or row['label'])
            for key in EDIT_FIELDS:
                if before.get(key) != after.get(key) or (key in before) != (key in after):
                    details.append(f"{FIELD_LABELS[key]}: {before.get(key, 'from tags')} → {after.get(key, 'from tags')}")
                    messages.append(message('{field}: {before} → {after}', field=message(FIELD_LABELS[key]),
                                            before=before[key] if key in before else message('from tags'),
                                            after=after[key] if key in after else message('from tags')))
        elif row['kind'] == 'playlist':
            label_message = message('Playlist: {name}', name=(after or before)['name'])
            messages = [message('Playlist: {before} → {after}',
                                before=before['name'] if before else message('did not exist'),
                                after=after['name'] if after else message('deleted')),
                        message('Tracks: {before} → {after}', before=len(before['tracks']) if before else 0,
                                after=len(after['tracks']) if after else 0)]
            details = [f"Playlist: {before['name'] if before else 'did not exist'} → {after['name'] if after else 'deleted'}",
                       f"Tracks: {len(before['tracks']) if before else 0} → {len(after['tracks']) if after else 0}"]
            if before and after and before['tracks'] != after['tracks']:
                added = set(after['tracks']) - set(before['tracks'])
                removed = set(before['tracks']) - set(after['tracks'])
                details.append(f'Added: {len(added)}; removed: {len(removed)}')
                messages.append(message('Added: {added}; removed: {removed}', added=len(added), removed=len(removed)))
                if not added and not removed:
                    details.append('Track order changed')
                    messages.append(message('Track order changed'))
        elif row['kind'] == 'move':
            label_message = message('File move: {count}', count=len(before))
            details = [a['path'] + ' → ' + b['path'] for a, b in zip(before[:5], after[:5])]
            messages = [message('{source} → {target}', source=a['path'], target=b['path']) for a, b in zip(before[:5], after[:5])]
            if len(before) > 5:
                details.append(f'Total files: {len(before)}')
                messages.append(message('Total files: {count}', count=len(before)))
        return dict(id=row['id'], kind=row['kind'], label=row['label'], created=row['created'],
                    state=row['state'], undone=row['undone'], error=row['error'], details=details,
                    labelMessage=label_message, detailMessages=messages,
                    canUndo=row['state'] == 'done', canRecover=row['state'] == 'recovery')

    def page(self, offset=0, limit=30):
        offset, limit = int(offset), int(limit)
        if offset < 0 or not 1 <= limit <= 100:
            raise ValueError('Invalid operation log page')
        with self.library.lock, self.library.connect() as db:
            self.prune(db)
            rows = db.execute('SELECT * FROM operations ORDER BY created DESC,id DESC LIMIT ? OFFSET ?', (limit, offset)).fetchall()
            return dict(items=[self.describe(r) for r in rows], offset=offset, limit=limit,
                        total=db.execute('SELECT COUNT(*) FROM operations').fetchone()[0], recovery=self.has_recovery(db))

    def metadata(self, db, key, overrides):
        row = db.execute('SELECT * FROM tracks WHERE id=?', (key,)).fetchone()
        if row is None:
            raise ValueError('Track is no longer in the catalog')
        values = {**fallback(row['path']), **json.loads(row['source_tags']), **overrides}
        db.execute('UPDATE tracks SET ' + ','.join(k + '=?' for k in EDIT_FIELDS) + ',overrides=? WHERE id=?',
                   [values[k] for k in EDIT_FIELDS] + [json.dumps(overrides, ensure_ascii=False), key])

    def undo(self, data):
        with self.library.lock, self.library.connect() as db:
            self.prune(db)
            row = db.execute('SELECT * FROM operations WHERE id=?', (data.get('id'),)).fetchone()
            if row is None:
                raise ValueError('Operation not found or retention period expired')
            if row['state'] == 'undone':
                return dict(ok=True, id=row['id'], state='undone')
            if row['state'] != 'done':
                raise ValueError('This operation cannot be undone right now')
            before, after = (json.loads(row[k]) for k in ('before_json', 'after_json'))
            if row['kind'] == 'metadata':
                current = db.execute('SELECT overrides FROM tracks WHERE id=?', (row['resource'],)).fetchone()
                if current is None or json.loads(current[0]) != after:
                    raise ValueError('Metadata was changed later or the track was deleted; undo later edits first')
                self.metadata(db, row['resource'], before)
            elif row['kind'] == 'playlist':
                if self.playlist(db, row['resource']) != after:
                    raise ValueError('The playlist was changed later; undo later changes first')
                if before:
                    valid = {r[0] for r in db.execute('SELECT id FROM tracks')}
                    if any(key not in valid for key in before['tracks']):
                        raise ValueError('The old playlist contains deleted tracks; restoration cancelled')
                    db.execute('INSERT INTO playlists VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name', (before['id'], before['name']))
                    db.execute('DELETE FROM items WHERE playlist=?', (before['id'],))
                    db.executemany('INSERT INTO items VALUES(?,?,?)', [(before['id'], key, i) for i, key in enumerate(before['tracks'])])
                else:
                    db.execute('DELETE FROM playlists WHERE id=?', (row['resource'],))
            elif row['kind'] == 'move':
                self.ensure_ready(db)
                self.execute_moves(db, after, before, row['id'], undo=True)
                return dict(ok=True, id=row['id'], state='undone')
            else:
                raise ValueError('Undo is not supported for this operation')
            db.execute("UPDATE operations SET state='undone',undone=?,error='' WHERE id=?", (time.time(), row['id']))
            return dict(ok=True, id=row['id'], state='undone')

    def move(self, db, data):
        self.ensure_ready(db)
        destination = self.library.path(data['folder'], True)
        if not destination.is_dir():
            raise ValueError('A destination folder is required')
        before, after, targets = [], [], set()
        for key in dict.fromkeys(data['tracks']):
            row = db.execute('SELECT id,path FROM tracks WHERE id=?', (key,)).fetchone()
            if row is None:
                raise ValueError('Track not found')
            source = self.library.path(row['path'], True)
            target = destination / source.name
            if source == target:
                continue
            if target in targets:
                raise ValueError('Selected tracks have duplicate file names')
            targets.add(target)
            info = fingerprint(source)
            before.append(dict(id=key, path=row['path'], fingerprint=info))
            after.append(dict(id=key, path=target.relative_to(self.library.root).as_posix(), fingerprint=info))
        if not before:
            return dict(ok=True, operationId=None)
        # Preflight before committing an intent or touching any file.
        self.validate_moves(db, before, after)
        key = self.record(db, 'move', '', f"File move: {len(before)} → {data['folder'] or 'root folder'}", before, after, 'pending')
        self.execute_moves(db, before, after, key)
        return dict(ok=True, operationId=key)

    def validate_moves(self, db, before, after):
        for source, target in zip(before, after):
            row = db.execute('SELECT path FROM tracks WHERE id=?', (source['id'],)).fetchone()
            if row is None or row['path'] != source['path']:
                raise ValueError('Track location was changed later: ' + source['path'])
            path = self.library.path(source['path'], True)
            destination = self.library.path(target['path'])
            if fingerprint(path) != source['fingerprint']:
                raise ValueError('File changed or was replaced: ' + source['path'])
            if os.path.lexists(destination):
                raise ValueError('Path is already occupied: ' + target['path'])
            if not destination.parent.is_dir():
                raise ValueError('Destination folder is missing: ' + str(destination.parent))

    def execute_moves(self, db, before, after, key, undo=False):
        self.validate_moves(db, before, after)
        db.execute('UPDATE operations SET state=?,phase=?,error=? WHERE id=?', ('undoing' if undo else 'pending', 'undo' if undo else 'forward', '', key))
        db.commit()  # Write-ahead intent survives a process crash during file operations.
        completed = []
        try:
            for old, new in zip(before, after):
                source = self.library.path(old['path'], True)
                target = self.library.path(new['path'])
                move_no_replace(source, target)
                completed.append((old, new))
                if fingerprint(target) != old['fingerprint']:
                    raise ValueError('File changed during the move: ' + new['path'])
                db.execute('UPDATE tracks SET path=? WHERE id=?', (new['path'], old['id']))
            db.execute('UPDATE operations SET state=?,undone=?,error=? WHERE id=?', ('undone' if undo else 'done', time.time() if undo else None, '', key))
            self.prune(db)
            db.commit()
        except Exception as error:
            db.rollback()
            failures = []
            for old, new in reversed(completed):
                try:
                    source, target = self.library.path(new['path'], True), self.library.path(old['path'])
                    if fingerprint(source) != old['fingerprint']:
                        raise ValueError('File changed')
                    move_no_replace(source, target)
                except Exception as rollback_error:
                    failures.append(str(rollback_error))
            state = 'recovery' if failures else 'done' if undo else 'failed'
            message = str(error) + ('; recovery required: ' + '; '.join(failures) if failures else '')
            db.execute('UPDATE operations SET state=?,error=? WHERE id=?', (state, message[:2000], key))
            self.prune(db)
            db.commit()
            raise ValueError(message) from error

    def recover(self, data):
        with self.library.lock, self.library.connect() as db:
            row = db.execute("SELECT * FROM operations WHERE id=? AND state='recovery' AND kind='move'", (data.get('id'),)).fetchone()
            if row is None:
                raise ValueError('Unfinished move not found')
            original, final = (json.loads(row[k]) for k in ('before_json', 'after_json'))
            before, after = (final, original) if row['phase'] == 'undo' else (original, final)
            rollback = []
            # Validate the entire batch before restoring any moved part.
            for old, new in zip(before, after):
                current = db.execute('SELECT path FROM tracks WHERE id=?', (old['id'],)).fetchone()
                if current is None or current['path'] != old['path']:
                    raise ValueError('Catalog entry changed; manual review required: ' + old['path'])
                a, b = self.library.path(old['path']), self.library.path(new['path'])
                if os.path.lexists(a) and not os.path.lexists(b) and fingerprint(a) == old['fingerprint']:
                    continue
                if not os.path.lexists(a) and os.path.lexists(b) and fingerprint(b) == old['fingerprint'] and a.parent.is_dir():
                    rollback.append((b, a))
                else:
                    raise ValueError('Ambiguous state; check both paths: ' + old['path'] + ' / ' + new['path'])
            for source, target in rollback:
                move_no_replace(source, target)
            # The interrupted SQL transaction was rolled back; restore its intended pre-state.
            for item in before:
                if not db.execute('SELECT 1 FROM tracks WHERE id=?', (item['id'],)).fetchone():
                    raise ValueError('Catalog entry deleted; manual review required')
                db.execute('UPDATE tracks SET path=? WHERE id=?', (item['path'], item['id']))
            state = 'done' if row['phase'] == 'undo' else 'failed'
            db.execute('UPDATE operations SET state=?,error=? WHERE id=?', (state, 'State restored to before the interrupted attempt', row['id']))
            return dict(ok=True, id=row['id'], state=state)
