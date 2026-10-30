"""Dependency-free music server entry point (Python 3.10+)."""
import argparse
import json

from library import Library
from http_api import Handler, Server  # Re-exported for integrations using server.py.


def boolean(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.lower() in ('true', 'false'):
        return value.lower() == 'true'
    raise argparse.ArgumentTypeError('listen must be true or false')


def main(argv=None, *, defaults=None, default_config=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default=default_config, help='JSON configuration file')
    parser.add_argument('--music-dir', help='Explicit music storage directory')
    parser.add_argument('--listen', type=boolean, default=None,
                        help='true: allow configured network address; false: localhost only')
    parser.add_argument('--host', '--ip', dest='host', default=None)
    parser.add_argument('--port', type=int, default=None)
    parser.add_argument('--database', default=None)
    parser.add_argument('--max-upload-mb', type=int, default=None)
    parser.add_argument('--ffprobe', help='ffprobe executable path')
    parser.add_argument('--ffmpeg', help='ffmpeg executable path')
    parser.add_argument('--verbose', action='store_true')
    args = parser.parse_args(argv)
    config = dict(defaults or {})
    if args.config:
        with open(args.config, encoding='utf-8-sig') as source:
            config.update(json.load(source))
    root = args.music_dir or config.get('music_dir')
    if not root:
        parser.error('Specify --music-dir or music_dir in --config')
    limit = args.max_upload_mb or config.get('max_upload_mb', 512)
    if not isinstance(limit, int) or limit <= 0:
        parser.error('max_upload_mb must be a positive integer')
    host = args.host if args.host is not None else config.get('host', '127.0.0.1')
    try:
        listen = boolean(args.listen if args.listen is not None else config.get('listen', True))
    except argparse.ArgumentTypeError as error:
        parser.error(str(error))
    if not listen:
        host = '127.0.0.1'
    port = args.port if args.port is not None else config.get('port', 8080)
    library = Library(root, args.database or config.get('database', './data/library.sqlite3'), limit,
                      args.ffprobe or config.get('ffprobe'), args.ffmpeg or config.get('ffmpeg'))
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
