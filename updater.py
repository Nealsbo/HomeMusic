"""Release downloads and a small, stable update supervisor (stdlib only)."""
from __future__ import annotations

import hashlib
import hmac
from contextlib import contextmanager, closing
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
import zipfile

PROTOCOL = 1
ASSET = 'homemusic-update.zip'
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_FILES = 1500


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d+\.\d+\.\d+', value):
        raise ValueError('Expected a stable version such as 0.1.0')
    return tuple(map(int, value.split('.')))


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return default


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def current_code(root):
    selected = read_json(root / '.updates' / 'current.json')
    if not selected:
        return root
    value = selected['version']
    version(value)
    target = root / '.updates' / 'versions' / value
    if target.is_symlink() or not (target / 'main.py').is_file():
        raise ValueError('The selected application version is missing')
    return target


def safe_name(name):
    path = PurePosixPath(name)
    if (not isinstance(name, str) or not name or '\\' in name or ':' in name
            or any(ord(char) < 32 for char in name)
            or path.is_absolute() or '..' in path.parts or str(path) != name
            or any(part.endswith((' ', '.')) for part in path.parts)):
        raise ValueError('Unsafe release path')
    reserved = {'con', 'prn', 'aux', 'nul', *(f'com{i}' for i in range(1, 10)),
                *(f'lpt{i}' for i in range(1, 10))}
    if any(part.split('.')[0].casefold() in reserved for part in path.parts):
        raise ValueError('Reserved release path')
    # Releases contain code and shipped assets only. User data never belongs here.
    if not ((len(path.parts) == 1 and (name.endswith('.py') or name in {'VERSION', 'LICENSE', 'THIRD_PARTY_NOTICES.md'}))
            or (path.parts[0] == 'web' and len(path.parts) > 1)):
        raise ValueError('Unexpected release file')
    return path


def stage_archive(archive, destination, expected_version):
    """Validate every entry before creating an isolated version directory."""
    version(expected_version)
    if destination.exists():
        raise ValueError('This version is already staged; remove it locally before retrying')
    with zipfile.ZipFile(archive) as package:
        entries = package.infolist()
        if len(entries) > MAX_FILES or sum(item.file_size for item in entries) > MAX_ARCHIVE:
            raise ValueError('Release is too large')
        names = [entry.filename for entry in entries]
        if len({name.casefold() for name in names}) != len(names):
            raise ValueError('Duplicate release paths')
        for entry in entries:
            if entry.filename != 'update-manifest.json':
                safe_name(entry.filename)
            mode = entry.external_attr >> 16
            if entry.is_dir() or (mode & 0o170000) not in (0, 0o100000):
                raise ValueError('Release entries must be regular files')
        manifest = json.loads(package.read('update-manifest.json'))
        if manifest['protocol'] != PROTOCOL or manifest['version'] != expected_version:
            raise ValueError('Incompatible update manifest')
        required_python = manifest['python'].split('.')
        if len(required_python) != 2 or sys.version_info[:2] < tuple(map(int, required_python)):
            raise ValueError('This release requires a newer Python version')
        files = manifest['files']
        required = {'VERSION', 'main.py', 'server.py', 'http_api.py', 'updater.py', 'web/index.html'}
        if not isinstance(files, dict) or not required.issubset(files):
            raise ValueError('Incomplete release')
        if set(names) != set(files) | {'update-manifest.json'}:
            raise ValueError('Release files do not match the manifest')
        for name, digest in files.items():
            safe_name(name)
            if not isinstance(digest, str) or hashlib.sha256(package.read(name)).hexdigest() != digest:
                raise ValueError('Release checksum mismatch')
        if package.read('VERSION').decode().strip() != expected_version:
            raise ValueError('Release version mismatch')
        destination.mkdir(parents=True)
        # All names and checksums have been checked; never use extractall.
        for name in files:
            target = destination.joinpath(*PurePosixPath(name).parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(package.read(name))
        write_json(destination / 'update-manifest.json', manifest)
    return manifest


class HTTPSOnlyRedirects(HTTPRedirectHandler):
    """Validate redirects before following them; update sources are configured locally."""

    @staticmethod
    def validate(url):
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname not in {
                'api.github.com', 'github.com', 'release-assets.githubusercontent.com',
                'objects.githubusercontent.com'} or parsed.username or parsed.password:
            raise ValueError('Unexpected update URL')

    def redirect_request(self, request, fp, code, message, headers, url):
        self.validate(url)
        return super().redirect_request(request, fp, code, message, headers, url)

    @staticmethod
    def open(url):
        HTTPSOnlyRedirects.validate(url)
        return build_opener(HTTPSOnlyRedirects()).open(Request(url, headers={
            'Accept': 'application/vnd.github+json', 'User-Agent': 'HomeMusic-updater'}), timeout=20)


class UpdateManager:
    def __init__(self, root, code, database, repository, shutdown, managed=True, startup_timeout=90):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
            raise ValueError('Invalid update repository')
        self.root, self.code = Path(root).resolve(), Path(code).resolve()
        self.home = self.root / '.updates'
        self.home.mkdir(exist_ok=True)
        self.database = str(Path(database).resolve())
        if Path(self.database).is_relative_to(self.home):
            raise ValueError('The database must be outside the update directory')
        self.repository, self.shutdown, self.managed = repository, shutdown, managed
        if type(startup_timeout) is not int or not 10 <= startup_timeout <= 1800:
            raise ValueError('updates_startup_timeout must be between 10 and 1800 seconds')
        self.startup_timeout = startup_timeout
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.busy = False
        self.release = None
        self.state = {'current': (self.code / 'VERSION').read_text().strip(),
                      'repository': repository, 'phase': 'idle', 'checkedAt': None,
                      'latest': None, 'error': '', 'managed': managed,
                      'lastResult': read_json(self.home / 'result.json')}
        version(self.state['current'])
        token_path = self.home / 'owner-key'
        if not token_path.exists():
            descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w') as output:
                output.write(secrets.token_urlsafe(32))
        self.key = token_path.read_text().strip()
        if not self.key:
            raise ValueError('The update owner key is empty')

    def authorized(self, header):
        return hmac.compare_digest(header or '', 'Bearer ' + self.key)

    def status(self):
        with self.lock:
            return dict(self.state, lastResult=read_json(self.home / 'result.json'))

    def restart_status(self):
        with self.lock:
            return dict(restartSupported=self.managed and os.environ.get('HOMEMUSIC_RESTART') == '1',
                        instance=os.environ.get('HOMEMUSIC_INSTANCE', ''),
                        busy=self.busy, startupTimeout=self.startup_timeout)

    def request_restart(self):
        """Record intent before replying; the HTTP handler initiates shutdown afterwards."""
        with self.lock:
            if not self.restart_status()['restartSupported']:
                raise ValueError('Start the server with a restart-capable main.py launcher')
            if self.busy:
                raise ValueError('An update or restart operation is already running')
            write_json(self.home / 'restart.json', {'instance': os.environ['HOMEMUSIC_INSTANCE']})
            self.busy = True
            self.stop.set()
            self.state.update(phase='restarting', error='')
            return dict(accepted=True, instance=os.environ['HOMEMUSIC_INSTANCE'])

    def start(self, action):
        with self.lock:
            if self.busy:
                raise ValueError('An update operation is already running')
            if action not in ('check', 'install'):
                raise ValueError('Unknown update action')
            if action == 'install' and (not self.managed or self.release is None):
                raise ValueError('Check for a compatible update and start the server using main.py')
            self.busy = True
            self.state.update(phase='checking' if action == 'check' else 'downloading', error='')
        threading.Thread(target=self._run, args=(action,), daemon=True).start()
        return self.status()

    def _run(self, action):
        try:
            if action == 'check':
                self._check()
            else:
                self._install()
        except Exception as error:
            with self.lock:
                self.state.update(phase='error', error=str(error))
        finally:
            with self.lock:
                self.busy = False

    def _check(self):
        self.release = None
        try:
            with HTTPSOnlyRedirects.open(f'https://api.github.com/repos/{self.repository}/releases/latest') as source:
                raw = source.read(1024 * 1024 + 1)
        except HTTPError as error:
            if error.code != 404:
                raise
            with self.lock:
                self.state.update(latest=None, checkedAt=time.time(), phase='no_release')
            return
        if len(raw) > 1024 * 1024:
            raise ValueError('Release metadata is too large')
        release = json.loads(raw)
        number = release['tag_name'].removeprefix('v')
        version(number)
        latest = {'version': number, 'notes': str(release.get('body') or '')[:20000]}
        if version(number) > version(self.state['current']):
            asset = next((item for item in release.get('assets', []) if item['name'] == ASSET), None)
            if not asset or not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest') or ''):
                raise ValueError('This release has no verified update archive')
            expected_prefix = f'https://github.com/{self.repository}/releases/download/'
            if not asset['browser_download_url'].startswith(expected_prefix):
                raise ValueError('Unexpected release asset URL')
            self.release = dict(version=number, url=asset['browser_download_url'], digest=asset['digest'][7:])
        with self.lock:
            self.state.update(latest=latest, checkedAt=time.time(),
                              phase='available' if self.release else 'current')

    def _install(self):
        release = dict(self.release)
        archive = self.home / 'download.zip'
        digest, total = hashlib.sha256(), 0
        deadline = time.monotonic() + 180
        with HTTPSOnlyRedirects.open(release['url']) as source, archive.open('wb') as output:
            while block := source.read(65536):
                total += len(block)
                if total > MAX_ARCHIVE or time.monotonic() > deadline:
                    raise ValueError('Release is too large')
                digest.update(block)
                output.write(block)
        if digest.hexdigest() != release['digest']:
            raise ValueError('Release checksum mismatch')
        target = self.home / 'versions' / release['version']
        stage_archive(archive, target, release['version'])
        # Validate Python syntax without importing or executing the downloaded code.
        for source in target.glob('*.py'):
            compile(source.read_bytes(), str(source), 'exec')
        write_json(self.home / 'request.json', {'version': release['version'], 'database': self.database,
                                              'startup_timeout': self.startup_timeout})
        with self.lock:
            self.state['phase'] = 'restarting'
        self.shutdown()

    def schedule(self, enabled):
        if not enabled:
            return
        def check_periodically():
            while not self.stop.is_set():
                try:
                    self.start('check')
                except ValueError:
                    pass
                if self.stop.wait(24 * 60 * 60):
                    break
        threading.Thread(target=check_periodically, daemon=True).start()


def database_copy(source, destination):
    """SQLite backup also includes a committed WAL and avoids raw file copies."""
    source = Path(source).resolve()
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as original, closing(sqlite3.connect(destination)) as backup:
        with backup:
            original.backup(backup)


def stop_child(child):
    if child.poll() is None:
        child.terminate()
    try:
        child.wait(timeout=15)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=15)


def rollback(root, transaction):
    home = root / '.updates'
    if transaction.get('backup'):
        database_copy(transaction['backup'], transaction['database'])
    previous = transaction['previous']
    if previous is None:
        (home / 'current.json').unlink(missing_ok=True)
    else:
        write_json(home / 'current.json', previous)
    write_json(home / 'result.json', {'outcome': 'rolled_back', 'version': transaction['version']})
    (home / 'transaction.json').unlink(missing_ok=True)


@contextmanager
def process_lock(path):
    # OS lock is released automatically even if the launcher is killed.
    with path.open('a+b') as lock:
        try:
            if os.name == 'nt':
                import msvcrt
                lock.write(b'0')
                lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise SystemExit('Another HomeMusic process is already running in this directory')
        yield


def supervise(root, argv):
    """Stay outside replaceable releases, wait for child exit, and own rollback."""
    root = Path(root).resolve()
    home = root / '.updates'
    home.mkdir(exist_ok=True)
    with process_lock(home / 'launcher.lock'):
        # A child can outlive a forcibly terminated parent. Never restore its live DB.
        with process_lock(home / 'server.lock'):
            pass
        return _supervise_locked(root, list(argv))


def _supervise_locked(root, argv):
    home = root / '.updates'
    transaction = read_json(home / 'transaction.json')
    if transaction:
        if transaction.get('committed'):
            write_json(home / 'result.json', {'outcome': 'installed', 'version': transaction['version']})
            (home / 'transaction.json').unlink()
        else:
            rollback(root, transaction)
    (home / 'request.json').unlink(missing_ok=True)
    (home / 'restart.json').unlink(missing_ok=True)
    transaction = None
    while True:
        (home / 'ready.json').unlink(missing_ok=True)
        instance = secrets.token_hex(16)
        environment = dict(os.environ, HOMEMUSIC_ROOT=str(root), HOMEMUSIC_CHILD='1',
                           HOMEMUSIC_INSTANCE=instance, HOMEMUSIC_RESTART='1')
        child = subprocess.Popen([sys.executable, str(current_code(root) / 'main.py'), *argv],
                                 cwd=root, env=environment)
        try:
            if transaction:
                healthy = False
                deadline = time.monotonic() + transaction.get('startup_timeout', 90)
                while child.poll() is None and time.monotonic() < deadline:
                    ready = read_json(home / 'ready.json')
                    if ready and ready.get('instance') == instance:
                        try:
                            with build_opener(ProxyHandler({})).open(
                                    f"http://{ready['host']}:{ready['port']}/api/update-health", timeout=2) as source:
                                healthy = json.load(source).get('instance') == instance
                        except (OSError, ValueError):
                            pass
                    if healthy:
                        break
                    time.sleep(.2)
                if not healthy:
                    stop_child(child)
                    rollback(root, transaction)
                    transaction = None
                    print('Update failed; starting the previous version.', flush=True)
                    continue
                transaction['committed'] = True
                write_json(home / 'transaction.json', transaction)
                write_json(home / 'result.json', {'outcome': 'installed', 'version': transaction['version']})
                (home / 'transaction.json').unlink()
                transaction = None
            result = child.wait()
        except KeyboardInterrupt:
            stop_child(child)
            if transaction:
                rollback(root, transaction)
            return 0
        restart = read_json(home / 'restart.json')
        if result == 76 and restart and restart.get('instance') == instance:
            (home / 'restart.json').unlink()
            continue
        request = read_json(home / 'request.json')
        if result != 75 or not request:
            return result
        (home / 'request.json').unlink()
        version(request['version'])
        database = Path(request['database']).resolve()
        backup = home / ('database-' + secrets.token_hex(8) + '.sqlite3')
        transaction = dict(request, previous=read_json(home / 'current.json'), backup=None)
        try:
            database_copy(database, backup)
            transaction['backup'] = str(backup)
            write_json(home / 'transaction.json', transaction)
            write_json(home / 'current.json', {'version': request['version']})
        except Exception as error:
            if (home / 'transaction.json').exists():
                rollback(root, transaction)
            write_json(home / 'result.json', {'outcome': 'failed', 'error': str(error)})
            transaction = None
            print('Update preparation failed; starting the previous version.', flush=True)
