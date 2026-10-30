"""Start the music server: command-line options override config.json and defaults."""
import os
from pathlib import Path

import server


def main(argv=None):
    root = Path(__file__).resolve().parent
    os.chdir(root)
    config = root / 'config.json'
    server.main(argv, defaults={
        'listen': True,
        'host': '0.0.0.0',
        'port': 8080,
        'music_dir': '../Music/',
    }, default_config=str(config) if config.is_file() else None)


if __name__ == '__main__':
    main()
