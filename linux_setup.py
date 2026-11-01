"""Shared Linux installer/launcher implementation; standard library only."""
import argparse
import json
import os
from pathlib import Path
import shutil
import shlex
import sys
import tempfile
import uuid

from storage import directory_sources

ROOT = Path(__file__).resolve().parent


def absolute(value, base):
    if not isinstance(value, str) or not value or any(ord(c) < 32 for c in value):
        raise ValueError('Path must be a nonempty string without control characters')
    path = Path(value).expanduser()
    return (path if path.is_absolute() else base / path).resolve()


def check_python():
    if sys.version_info < (3, 10):
        raise ValueError('Python 3.10 or newer is required')
    try:
        import sqlite3
        db = sqlite3.connect(':memory:')
        try:
            db.execute('SELECT sqlite_version()').fetchone()
        finally:
            db.close()
    except ImportError as error:
        raise ValueError('Python has no sqlite3 support. Install SQLite support using your distribution’s packages.') from error


def atomic_write(path, content):
    """Write in the same directory so interruption cannot leave partial JSON."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='\n',
                                         dir=path.parent, prefix=path.name + '.', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def prepare_config(args, root=ROOT, cwd=None):
    cwd = cwd or Path.cwd()
    config_path = absolute(args.config, cwd) if args.config else (root / 'config.json').resolve()
    previous = config_path.read_bytes() if config_path.exists() else None
    config = json.loads(previous.decode('utf-8-sig')) if previous is not None else {}
    if not isinstance(config, dict):
        raise ValueError('Config must contain a JSON object')
    if args.music_dir is not None:
        config['music_dir'] = str(absolute(args.music_dir, cwd))
    elif not config.get('music_dir'):
        raise ValueError('For the first installation, specify --music-dir /path/to/music')
    config['music_dir'] = str(absolute(config['music_dir'], root))
    if 'music_sources' in config:
        sources = config['music_sources']
        if not isinstance(sources, list):
            raise ValueError('music_sources must be a list')
        for source in sources:
            if not isinstance(source, dict):
                raise ValueError('Music source must be an object')
            source['path'] = str(absolute(source.get('path'), root))
        directory_sources(config['music_dir'], sources)
    if args.database is not None:
        config['database'] = str(absolute(args.database, cwd))
    else:
        config['database'] = str(absolute(config.get('database', str(root / 'data' / 'library.sqlite3')), root))
    for key, default in [('host', '127.0.0.1'), ('port', 8080), ('max_upload_mb', 512)]:
        value = getattr(args, key)
        if value is not None:
            config[key] = value
        else:
            config.setdefault(key, default)
    for key in ('ffprobe', 'ffmpeg'):
        value = getattr(args, key)
        if value is not None:
            config[key] = value
        configured = config.get(key)
        if configured is not None and configured is not False and not isinstance(configured, str):
            raise ValueError('Invalid path ' + key)
    if not isinstance(config['host'], str) or not config['host'].strip() or any(ord(c) < 32 for c in config['host']):
        raise ValueError('Invalid --host address')
    for key, maximum in [('port', 65535), ('max_upload_mb', 2147483647)]:
        value = config[key]
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
            raise ValueError('Invalid value ' + key)
    music = Path(config['music_dir'])
    database = Path(config['database'])
    if database == music or (database.exists() and not database.is_file()):
        raise ValueError('Database path must point to a SQLite file')
    music.mkdir(parents=True, exist_ok=True)
    database.parent.mkdir(parents=True, exist_ok=True)
    for directory in (music, database.parent):
        if not os.access(directory, os.R_OK | os.W_OK | os.X_OK):
            raise ValueError('Read and write permissions required: ' + str(directory))
    if database.exists() and not os.access(database, os.R_OK | os.W_OK):
        raise ValueError('No database access: ' + str(database))
    content = json.dumps(config, ensure_ascii=False, indent=2) + '\n'
    backup = None
    if previous != content.encode('utf-8'):
        if previous is not None:
            backup = config_path.with_name(config_path.name + '.bak-' + uuid.uuid4().hex[:12])
            with backup.open('xb') as stream:
                stream.write(previous)
        atomic_write(config_path, content)
    return config_path, config, backup


def launch(config=None, extra=(), root=ROOT):
    command = [sys.executable, str(root / 'server.py')]
    if config is not None:
        command += ['--config', str(config)]
    command.extend(extra)
    os.chdir(root)
    os.environ['PYTHONUNBUFFERED'] = '1'
    os.execv(sys.executable, command)


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    actions = result.add_subparsers(dest='action', required=True)
    install = actions.add_parser('install', prog='install-linux.sh', help='Prepare directories, config and dependencies; does not start the server')
    install.add_argument('--music-dir', help='Explicit music storage directory; required on first install')
    install.add_argument('--database', help='SQLite file; defaults to project/data/library.sqlite3')
    install.add_argument('--config', help='Config file; defaults to project/config.json')
    install.add_argument('--host', help='Listen address; default 127.0.0.1; use 0.0.0.0 for LAN')
    install.add_argument('--port', type=int, help='Listen port, 1..65535; default 8080')
    install.add_argument('--max-upload-mb', type=int)
    install.add_argument('--ffprobe', help='Custom ffprobe executable')
    install.add_argument('--ffmpeg', help='Custom ffmpeg executable')
    install.add_argument('--install-deps', action='store_true', help='Shell wrapper installs Python with apt-get')
    install.add_argument('--with-ffmpeg', action='store_true', help='Shell wrapper also installs optional FFmpeg with apt-get')
    run = actions.add_parser('run', prog='run-linux.sh', help='Run from the project directory; extra arguments go to server.py',
                             description='Run the music server. Extra arguments (--music-dir, --host, --port, etc.) are passed to server.py.',
                             epilog='Server options: python3 server.py --help')
    run.add_argument('--config', help='Config file; defaults to project/config.json')
    return result


def main(argv=None):
    command_parser = parser()
    args, extra = command_parser.parse_known_args(argv)
    if args.action == 'install' and extra:
        command_parser.error('Unknown arguments: ' + ' '.join(extra))
    try:
        if not sys.platform.startswith('linux'):
            raise ValueError('These scripts are for Linux; on Windows run python server.py.')
        check_python()
        if args.action == 'run':
            config = absolute(args.config, Path.cwd()) if args.config else ROOT / 'config.json'
            if args.config and not config.is_file():
                raise ValueError('Config not found: ' + str(config))
            if not config.is_file() and not any(arg == '--music-dir' or arg.startswith('--music-dir=') for arg in extra):
                raise ValueError('First run bash install-linux.sh --music-dir /path/to/music')
            launch(config if config.is_file() else None, extra)
            return 0
        config_path, config, backup = prepare_config(args)
        print('Config: ' + str(config_path), flush=True)
        print('Music: ' + config['music_dir'], flush=True)
        print('Database: ' + config['database'], flush=True)
        if backup:
            print('Previous config: ' + str(backup), flush=True)
        if not shutil.which(config.get('ffprobe') or 'ffprobe'):
            print('FFprobe not found; tags/covers require FFmpeg (--with-ffmpeg on apt-based systems).', flush=True)
        print('Preparation complete. Start: ' + shlex.join(['bash', str(ROOT / 'run-linux.sh'), '--config', str(config_path)]), flush=True)
        return 0
    except (OSError, ValueError) as error:
        print('Installation/start failed: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
