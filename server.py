"""Dependency-free music server entry point (Python 3.10+)."""
import argparse
import json

from library import Library
from http_api import Handler, Server  # Re-exported for integrations using server.py.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='JSON configuration file')
    parser.add_argument('--music-dir', help='Explicit music storage directory')
    parser.add_argument('--host', default=None)
    parser.add_argument('--port', type=int, default=None)
    parser.add_argument('--database', default=None)
    parser.add_argument('--max-upload-mb', type=int, default=None)
    parser.add_argument('--ffprobe', help='ffprobe executable path')
    parser.add_argument('--ffmpeg', help='ffmpeg executable path')
    parser.add_argument('--verbose', action='store_true')
    args = parser.parse_args()
    config = {}
    if args.config:
        with open(args.config, encoding='utf-8-sig') as source:
            config = json.load(source)
    root = args.music_dir or config.get('music_dir')
    if not root:
        parser.error('Specify --music-dir or music_dir in --config')
    limit = args.max_upload_mb or config.get('max_upload_mb', 512)
    if not isinstance(limit, int) or limit <= 0:
        parser.error('max_upload_mb must be a positive integer')
    library = Library(root, args.database or config.get('database', './data/library.sqlite3'), limit,
                      args.ffprobe or config.get('ffprobe'), args.ffmpeg or config.get('ffmpeg'))
    host = args.host if args.host is not None else config.get('host', '127.0.0.1')
    port = args.port if args.port is not None else config.get('port', 8080)
    server = Server((host, port), Handler)
    server.library, server.verbose = library, args.verbose
    library.start_metadata_worker()
    print(f'Music storage: {library.root}\nWeb player: http://{host}:{server.server_port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        library.close()


if __name__ == '__main__':
    main()
