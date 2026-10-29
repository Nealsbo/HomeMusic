"""On-demand collection audits. Read files in one worker; never change the catalog."""
from collections import defaultdict
import copy
import hashlib
import stat
import threading
import time
import unicodedata
import uuid

CATEGORIES = ('missing', 'problems', 'metadata', 'exact', 'similar')


class CheckCancelled(Exception):
    pass


class FileChanged(Exception):
    pass


def normalized(value):
    return ' '.join(unicodedata.normalize('NFKC', value or '').casefold().split())


def signature(info):
    return (info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_dev, info.st_ino)


class CollectionHealth:
    def __init__(self, library):
        self.library = library
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.thread = None
        self.state = dict(jobId=None, state='idle', phase='idle', mode='quick', started=None,
                          finished=None, total=0, checked=0, hashTotal=0, hashed=0, bytesRead=0,
                          error='', exactGroups=0, similarGroups=0)
        self.results = {key: [] for key in CATEGORIES}

    def start(self, data):
        mode = data.get('mode', 'quick')
        if mode not in ('quick', 'duplicates'):
            raise ValueError('Неизвестный режим проверки')
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise ValueError('Проверка уже выполняется')
            self.stop = threading.Event()
            self.results = {key: [] for key in CATEGORIES}
            self.state = dict(jobId=uuid.uuid4().hex, state='running', phase='catalog', mode=mode,
                              started=time.time(), finished=None, total=0, checked=0, hashTotal=0,
                              hashed=0, bytesRead=0, error='', exactGroups=0, similarGroups=0)
            self.thread = threading.Thread(target=self._run, args=(mode,), name='collection-check', daemon=True)
            self.thread.start()
            return self.report()

    def cancel(self, data):
        with self.lock:
            if data.get('jobId') != self.state['jobId'] or not self.state['jobId']:
                raise ValueError('Отчёт изменился; обновите страницу проверки')
            if self.state['state'] == 'running':
                self.stop.set()
                self.state['phase'] = 'cancelling'
            return self.report()

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=3)

    def report(self, category='missing', offset=0, limit=50, job_id=None):
        if category not in CATEGORIES:
            raise ValueError('Неизвестный раздел отчёта')
        offset, limit = int(offset), int(limit)
        if offset < 0 or not 1 <= limit <= 100:
            raise ValueError('Некорректная страница отчёта')
        with self.lock:
            if job_id and job_id != self.state['jobId']:
                raise ValueError('Отчёт изменился; обновите страницу проверки')
            items = self.results[category]
            return dict(**self.state, counts={key: len(value) for key, value in self.results.items()},
                        category=category, offset=offset, limit=limit, categoryTotal=len(items),
                        items=copy.deepcopy(items[offset:offset + limit]))

    def update(self, **values):
        with self.lock:
            self.state.update(values)

    def issue(self, category, track, reason, code):
        with self.lock:
            self.results[category].append(dict(id=track['id'], path=track['path'], title=track['title'],
                                               artist=track['artist'], reason=reason, code=code))

    def _hash(self, path, expected):
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            while True:
                if self.stop.is_set():
                    raise CheckCancelled()
                block = stream.read(256 * 1024)
                if not block:
                    break
                digest.update(block)
                with self.lock:
                    self.state['bytesRead'] += len(block)
                # Yield between chunks on small computers and allow prompt cancellation.
                if self.stop.wait(.002):
                    raise CheckCancelled()
        if signature(path.stat()) != expected:
            raise FileChanged()
        return digest.hexdigest()

    def _groups(self, rows, digests, exact):
        groups = defaultdict(list)
        for track in rows:
            if exact:
                if track['id'] not in digests:
                    continue
                key = digests[track['id']]
            else:
                title = normalized(track['title'])
                if not title:
                    continue
                key = (normalized(track['artist']), title)
            groups[key].append(track)
        results, count = [], 0
        for key, members in groups.items():
            if len(members) < 2:
                continue
            # Fully verified byte copies are already listed as exact duplicates.
            if not exact and all(t['id'] in digests for t in members) and len({digests[t['id']] for t in members}) == 1:
                continue
            count += 1
            group = key if exact else hashlib.sha256(repr(key).encode()).hexdigest()
            for track in members:
                results.append(dict(id=track['id'], path=track['path'], title=track['title'], artist=track['artist'],
                                    size=track['actualSize'], group=group, groupNumber=count, groupSize=len(members)))
        return results, count

    def _run(self, mode):
        try:
            with self.library.lock, self.library.connect() as db:
                tracks = [dict(r) for r in db.execute('''SELECT id,path,title,artist,size,file_mtime_ns,metadata_error
                    FROM tracks ORDER BY path''')]
            self.update(total=len(tracks), phase='availability')
            readable = []
            for track in tracks:
                if self.stop.is_set():
                    break
                try:
                    path = self.library.path(track['path'])
                    info = path.stat()
                    if not stat.S_ISREG(info.st_mode):
                        self.issue('problems', track, 'Путь не является обычным файлом', 'not_file')
                    elif info.st_size == 0:
                        self.issue('problems', track, 'Файл пуст', 'empty')
                    else:
                        with path.open('rb') as stream:
                            if not stream.read(1):
                                raise FileChanged()
                        track['actualSize'] = info.st_size
                        track['signature'] = signature(info)
                        readable.append(track)
                        if info.st_size != track['size'] or info.st_mtime_ns != track['file_mtime_ns']:
                            self.issue('problems', track, 'Файл изменился после индексации; обновите индекс медиатеки', 'index_outdated')
                    error = track.get('metadata_error')
                    if error and not error.startswith('ffprobe не найден:'):
                        self.issue('metadata', track, error, 'metadata')
                except FileNotFoundError:
                    self.issue('missing', track, 'Файл отсутствует по пути из каталога', 'missing')
                except FileChanged:
                    self.issue('problems', track, 'Файл изменился во время проверки; повторите проверку', 'changed')
                except (OSError, ValueError) as error:
                    self.issue('problems', track, 'Файл недоступен: ' + str(error), 'unreadable')
                with self.lock:
                    self.state['checked'] += 1
                if self.stop.wait(.001):
                    break
            digests = {}
            if mode == 'duplicates' and not self.stop.is_set():
                sizes = defaultdict(list)
                for track in readable:
                    sizes[track['actualSize']].append(track)
                candidates = [t for members in sizes.values() if len(members) > 1 for t in members]
                self.update(hashTotal=len(candidates), phase='hashing')
                for track in candidates:
                    if self.stop.is_set():
                        break
                    try:
                        path = self.library.path(track['path'], True)
                        if signature(path.stat()) != track['signature']:
                            raise FileChanged()
                        digests[track['id']] = self._hash(path, track['signature'])
                    except CheckCancelled:
                        break
                    except FileChanged:
                        self.issue('problems', track, 'Файл изменился во время чтения; совпадение не подтверждено', 'changed')
                    except (OSError, ValueError) as error:
                        self.issue('problems', track, 'Не удалось прочитать файл целиком: ' + str(error), 'hash_error')
                    with self.lock:
                        self.state['hashed'] += 1
                # Files changed after their own hash must not appear as confirmed copies.
                for track in readable:
                    if track['id'] not in digests:
                        continue
                    try:
                        if signature(self.library.path(track['path'], True).stat()) != track['signature']:
                            raise FileChanged()
                    except (OSError, ValueError, FileChanged):
                        digests.pop(track['id'], None)
                        self.issue('problems', track, 'Файл изменился или исчез до завершения проверки', 'changed')
            exact, exact_count = self._groups(readable, digests, True)
            similar, similar_count = self._groups(readable, digests, False)
            with self.lock:
                self.results['exact'], self.results['similar'] = exact, similar
                self.state.update(exactGroups=exact_count, similarGroups=similar_count,
                                  state='cancelled' if self.stop.is_set() else 'done', phase='finished', finished=time.time())
        except Exception as error:
            self.update(state='failed', phase='finished', finished=time.time(), error=str(error)[:600])
