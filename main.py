"""Start the music server: command-line options override config.json and defaults."""
import os
from pathlib import Path
import sys

import server


def main(argv=None):
    root = Path(os.environ.get('HOMEMUSIC_ROOT', Path(__file__).resolve().parent))
    os.chdir(root)
    config = root / 'config.json'
    server.main(argv, defaults={
        'listen': True,
        'host': '0.0.0.0',
        'port': 8080,
        'music_dir': '../Music/',
    }, default_config=str(config) if config.is_file() else None)


if __name__ == '__main__':
    if os.environ.get('HOMEMUSIC_CHILD') == '1':
        from updater import process_lock
        with process_lock(Path(os.environ['HOMEMUSIC_ROOT']) / '.updates' / 'server.lock'):
            main()
    else:
        from updater import supervise
        raise SystemExit(supervise(Path(__file__).resolve().parent, sys.argv[1:]))
