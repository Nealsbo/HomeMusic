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

FIELD_LABELS = dict(title='Название', artist='Исполнитель', album='Альбом', album_artist='Исполнитель альбома',
                    genre='Жанр', year='Год', track_number='Номер трека', disc_number='Номер диска')


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
        raise ValueError('Путь не является обычным файлом: ' + str(path))
    return dict(size=info.st_size, mtime=info.st_mtime_ns, device=info.st_dev, inode=info.st_ino)


class OperationHistory:
    def __init__(self, library):
        self.library = library

    def mark_interrupted(self):
        with self.library.connect() as db:
            db.execute("UPDATE operations SET state='recovery',error='Сервер завершился во время перемещения. Восстановите состояние перед попыткой.' WHERE state IN ('pending','undoing')")

    def has_recovery(self, db=None):
        if db is None:
            with self.library.connect() as connection:
                return self.has_recovery(connection)
        return bool(db.execute("SELECT 1 FROM operations WHERE state IN ('pending','undoing','recovery') LIMIT 1").fetchone())

    def ensure_ready(self, db):
        if self.has_recovery(db):
            raise ValueError('Сначала восстановите незавершённое перемещение в журнале операций')

    @staticmethod
    def playlist(db, key):
        row = db.execute('SELECT id,name FROM playlists WHERE id=?', (key,)).fetchone()
        return None if row is None else dict(row, tracks=[r[0] for r in db.execute('SELECT track FROM items WHERE playlist=? ORDER BY position', (key,))])

    def record(self, db, kind, resource, label, before, after, state='done'):
        if before == after:
            return None
        encoded = [json.dumps(value, ensure_ascii=False) for value in (before, after)]
        if sum(len(value.encode()) for value in encoded) > 8 * 1024 * 1024:
            raise ValueError('Операция слишком велика для журнала; уменьшите количество выбранных треков')
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
        if row['kind'] == 'metadata':
            for key in EDIT_FIELDS:
                if before.get(key) != after.get(key) or (key in before) != (key in after):
                    details.append(f"{FIELD_LABELS[key]}: {before.get(key, 'из тегов')} → {after.get(key, 'из тегов')}")
        elif row['kind'] == 'playlist':
            details = [f"Плейлист: {before['name'] if before else 'не существовал'} → {after['name'] if after else 'удалён'}",
                       f"Треков: {len(before['tracks']) if before else 0} → {len(after['tracks']) if after else 0}"]
            if before and after and before['tracks'] != after['tracks']:
                added = set(after['tracks']) - set(before['tracks'])
                removed = set(before['tracks']) - set(after['tracks'])
                details.append(f'Добавлено: {len(added)}; убрано: {len(removed)}')
                if not added and not removed:
                    details.append('Изменён порядок треков')
        elif row['kind'] == 'move':
            details = [a['path'] + ' → ' + b['path'] for a, b in zip(before[:5], after[:5])]
            if len(before) > 5:
                details.append(f'Всего файлов: {len(before)}')
        return dict(id=row['id'], kind=row['kind'], label=row['label'], created=row['created'],
                    state=row['state'], undone=row['undone'], error=row['error'], details=details,
                    canUndo=row['state'] == 'done', canRecover=row['state'] == 'recovery')

    def page(self, offset=0, limit=30):
        offset, limit = int(offset), int(limit)
        if offset < 0 or not 1 <= limit <= 100:
            raise ValueError('Некорректная страница журнала')
        with self.library.lock, self.library.connect() as db:
            self.prune(db)
            rows = db.execute('SELECT * FROM operations ORDER BY created DESC,id DESC LIMIT ? OFFSET ?', (limit, offset)).fetchall()
            return dict(items=[self.describe(r) for r in rows], offset=offset, limit=limit,
                        total=db.execute('SELECT COUNT(*) FROM operations').fetchone()[0], recovery=self.has_recovery(db))

    def metadata(self, db, key, overrides):
        row = db.execute('SELECT * FROM tracks WHERE id=?', (key,)).fetchone()
        if row is None:
            raise ValueError('Трек больше не находится в каталоге')
        values = {**fallback(row['path']), **json.loads(row['source_tags']), **overrides}
        db.execute('UPDATE tracks SET ' + ','.join(k + '=?' for k in EDIT_FIELDS) + ',overrides=? WHERE id=?',
                   [values[k] for k in EDIT_FIELDS] + [json.dumps(overrides, ensure_ascii=False), key])

    def undo(self, data):
        with self.library.lock, self.library.connect() as db:
            self.prune(db)
            row = db.execute('SELECT * FROM operations WHERE id=?', (data.get('id'),)).fetchone()
            if row is None:
                raise ValueError('Операция не найдена или срок хранения истёк')
            if row['state'] == 'undone':
                return dict(ok=True, id=row['id'], state='undone')
            if row['state'] != 'done':
                raise ValueError('Эту операцию сейчас нельзя отменить')
            before, after = (json.loads(row[k]) for k in ('before_json', 'after_json'))
            if row['kind'] == 'metadata':
                current = db.execute('SELECT overrides FROM tracks WHERE id=?', (row['resource'],)).fetchone()
                if current is None or json.loads(current[0]) != after:
                    raise ValueError('Метаданные изменились позже или трек удалён; сначала отмените более поздние правки')
                self.metadata(db, row['resource'], before)
            elif row['kind'] == 'playlist':
                if self.playlist(db, row['resource']) != after:
                    raise ValueError('Плейлист изменился позже; сначала отмените более поздние изменения')
                if before:
                    valid = {r[0] for r in db.execute('SELECT id FROM tracks')}
                    if any(key not in valid for key in before['tracks']):
                        raise ValueError('В старом плейлисте есть удалённые треки; восстановление отменено')
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
                raise ValueError('Отмена этой операции не поддерживается')
            db.execute("UPDATE operations SET state='undone',undone=?,error='' WHERE id=?", (time.time(), row['id']))
            return dict(ok=True, id=row['id'], state='undone')

    def move(self, db, data):
        self.ensure_ready(db)
        destination = self.library.path(data['folder'], True)
        if not destination.is_dir():
            raise ValueError('Нужна папка назначения')
        before, after, targets = [], [], set()
        for key in dict.fromkeys(data['tracks']):
            row = db.execute('SELECT id,path FROM tracks WHERE id=?', (key,)).fetchone()
            if row is None:
                raise ValueError('Трек не найден')
            source = self.library.path(row['path'], True)
            target = destination / source.name
            if source == target:
                continue
            if target in targets:
                raise ValueError('Одинаковые имена файлов в выбранных треках')
            targets.add(target)
            info = fingerprint(source)
            before.append(dict(id=key, path=row['path'], fingerprint=info))
            after.append(dict(id=key, path=target.relative_to(self.library.root).as_posix(), fingerprint=info))
        if not before:
            return dict(ok=True, operationId=None)
        # Preflight before committing an intent or touching any file.
        self.validate_moves(db, before, after)
        key = self.record(db, 'move', '', f"Перемещение файлов: {len(before)} → {data['folder'] or 'корневая папка'}", before, after, 'pending')
        self.execute_moves(db, before, after, key)
        return dict(ok=True, operationId=key)

    def validate_moves(self, db, before, after):
        for source, target in zip(before, after):
            row = db.execute('SELECT path FROM tracks WHERE id=?', (source['id'],)).fetchone()
            if row is None or row['path'] != source['path']:
                raise ValueError('Расположение трека изменилось позже: ' + source['path'])
            path = self.library.path(source['path'], True)
            destination = self.library.path(target['path'])
            if fingerprint(path) != source['fingerprint']:
                raise ValueError('Файл изменён или заменён: ' + source['path'])
            if os.path.lexists(destination):
                raise ValueError('Путь уже занят: ' + target['path'])
            if not destination.parent.is_dir():
                raise ValueError('Папка назначения отсутствует: ' + str(destination.parent))

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
                    raise ValueError('Файл изменился во время перемещения: ' + new['path'])
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
                        raise ValueError('Файл изменён')
                    move_no_replace(source, target)
                except Exception as rollback_error:
                    failures.append(str(rollback_error))
            state = 'recovery' if failures else 'done' if undo else 'failed'
            message = str(error) + ('; требуется восстановление: ' + '; '.join(failures) if failures else '')
            db.execute('UPDATE operations SET state=?,error=? WHERE id=?', (state, message[:2000], key))
            self.prune(db)
            db.commit()
            raise ValueError(message) from error

    def recover(self, data):
        with self.library.lock, self.library.connect() as db:
            row = db.execute("SELECT * FROM operations WHERE id=? AND state='recovery' AND kind='move'", (data.get('id'),)).fetchone()
            if row is None:
                raise ValueError('Незавершённое перемещение не найдено')
            original, final = (json.loads(row[k]) for k in ('before_json', 'after_json'))
            before, after = (final, original) if row['phase'] == 'undo' else (original, final)
            rollback = []
            # Validate the entire batch before restoring any moved part.
            for old, new in zip(before, after):
                current = db.execute('SELECT path FROM tracks WHERE id=?', (old['id'],)).fetchone()
                if current is None or current['path'] != old['path']:
                    raise ValueError('Запись каталога изменилась; требуется ручная проверка: ' + old['path'])
                a, b = self.library.path(old['path']), self.library.path(new['path'])
                if os.path.lexists(a) and not os.path.lexists(b) and fingerprint(a) == old['fingerprint']:
                    continue
                if not os.path.lexists(a) and os.path.lexists(b) and fingerprint(b) == old['fingerprint'] and a.parent.is_dir():
                    rollback.append((b, a))
                else:
                    raise ValueError('Состояние неоднозначно; проверьте оба пути: ' + old['path'] + ' / ' + new['path'])
            for source, target in rollback:
                move_no_replace(source, target)
            # The interrupted SQL transaction was rolled back; restore its intended pre-state.
            for item in before:
                if not db.execute('SELECT 1 FROM tracks WHERE id=?', (item['id'],)).fetchone():
                    raise ValueError('Запись каталога удалена; требуется ручная проверка')
                db.execute('UPDATE tracks SET path=? WHERE id=?', (item['path'], item['id']))
            state = 'done' if row['phase'] == 'undo' else 'failed'
            db.execute('UPDATE operations SET state=?,error=? WHERE id=?', (state, 'Восстановлено состояние до прерванной попытки', row['id']))
            return dict(ok=True, id=row['id'], state=state)
