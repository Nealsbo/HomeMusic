"""Terminal dashboard and remote control for a running music server; no dependencies."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
import unicodedata
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

STATES = {'idle': 'idle', 'playing': 'playing', 'paused': 'paused',
          'buffering': 'buffering', 'ended': 'ended', 'error': 'error'}


def clean(value):
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', str(value))
    return ''.join(' ' if unicodedata.category(c).startswith('C') else c for c in text)


def clip(text, width):
    result, cells = '', 0
    for c in clean(text):
        size = 0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in 'WF' else 1
        if cells + size > width:
            return result[:-1] + '~' if result else ''
        result += c
        cells += size
    return result


def clock(seconds):
    seconds = max(0, int(seconds or 0))
    return f'{seconds // 60}:{seconds % 60:02d}'


def human_bytes(size):
    for unit in ('B', 'KiB', 'MiB', 'GiB', 'TiB'):
        if size < 1024 or unit == 'TiB':
            return f'{size:.1f} {unit}'
        size /= 1024


def fetch_status(url, timeout=3):
    request = Request(url.rstrip('/') + '/api/status', headers={'Accept': 'application/json'})
    with urlopen(request, timeout=timeout) as response:
        body = response.read(4 * 1024 * 1024 + 1)
    if len(body) > 4 * 1024 * 1024:
        raise ValueError('Server response is too large')
    result = json.loads(body)
    if not isinstance(result, dict) or result.get('server') != 'online' or not isinstance(result.get('clients'), list):
        raise ValueError('The server does not support /api/status. Update and restart the server.')
    return result


def control_request(url, endpoint, data, timeout=3):
    request = Request(url.rstrip('/') + '/api/' + endpoint,
                      data=json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read(65536))
    except HTTPError as error:
        try:
            message = json.loads(error.read(65536)).get('error', str(error))
        except (ValueError, AttributeError):
            message = str(error)
        raise ValueError(message) from error


def send_command(url, target, action, value=None, source=None):
    return control_request(url, 'control', dict(id=uuid.uuid4().hex, target=target,
                                              action=action, value=value, source=source))


def keyboard_command(key, client):
    if key == ' ':
        return ('pause' if client['state'] in ('playing', 'buffering') else 'play'), None
    if key in ('n', 'p'):
        return ('next' if key == 'n' else 'previous'), None
    if key in ('h', 'l'):
        return 'seek', max(0, min(client.get('duration') or 7 * 86400,
                                 client.get('position', 0) + (10 if key == 'l' else -10)))
    if key in ('+', '-', '='):
        return 'volume', round(max(0, min(1, client.get('volume', .75) + (-.05 if key == '-' else .05))), 2)
    return None


def render_status(data, url, selected=0, width=100, height=32, error=None, notice=None):
    width, height = max(20, width), max(6, height)
    rows = ['QUIET WAVE / TERMINAL', f'Server: {url}', '-' * width]
    if notice:
        rows += [clean(notice)]
    if error:
        rows += ['NO CONNECTION: ' + clean(error), 'Showing the last received snapshot.' if data else 'Waiting for connection...']
    if not data:
        return '\n'.join(clip(r, width) for r in (rows + ['', 'q: quit | r: refresh'])[:height])
    rows += [f"Library: {data['tracks']} tracks / {human_bytes(data['libraryBytes'])} | Streams: {data['streams']}",
             f"Uptime: {clock(data['uptime'])} | Transferred: {human_bytes(data['bytesSent'])}",
             'Storage: ' + data['storage'], '']
    clients = data['clients']
    rows.append(f'PLAYERS ({len(clients)})  j/k or arrows: select')
    if not clients:
        rows += ['  No browser reports. Open the updated web player.']
    else:
        selected %= len(clients)
        first = max(0, selected - 2)
        for index in range(first, min(len(clients), first + 4)):
            c = clients[index]
            status = STATES.get(c['state'], c['state']) if c['connected'] else 'no recent report'
            title = (c.get('track') or {}).get('title', 'No track selected')
            rows.append(f"{'>' if index == selected else ' '} {index + 1}. {c['name']} | {status} | {title}")
        c = clients[selected]
        rows += ['', 'SELECTED PLAYER: ' + c['name'] + ' / ' + c.get('clientId', '')[-6:],
                 f"State: {STATES.get(c['state'], c['state'])} | Report: {int(c['age'])} s ago",
                 f"Playlist / queue: {c['playlistName']} ({c['queueCount']} tracks)"]
        if c.get('track'):
            rows += ['Track: ' + c['track']['title'] + ' / ' + (c['track']['artist'] or 'No artist'),
                     f"Reported position: {clock(c['position'])} / {clock(c['duration'])}"]
        if c.get('error'):
            rows.append('Error: ' + c['error'])
        queue_room = max(0, height - len(rows) - 7)
        preview = c['queue']
        # The API returns a small window around the current track, even for huge queues.
        current = max(0, c['queueIndex'] - c['queueStart'])
        start = max(0, current - 1)
        for offset in range(start, min(len(preview), start + min(6, queue_room))):
            t = preview[offset]
            rows.append(f"  {'>' if (t.get('entryId') == c.get('queueEntryId') if t.get('entryId') else t['id'] == c['trackId']) else ' '} {c['queueStart'] + offset + 1}. {t['title']}")
    remaining = height - len(rows) - 4
    rows += ['', f"PLAYLISTS ({len(data['playlists'])})"]
    for p in data['playlists'][:max(0, remaining)]:
        rows.append(f"  {p['name']} / {p['tracks']} tracks")
    if not data['playlists'] and remaining > 0:
        rows.append('  No playlists yet.')
    rows = rows[:height - 2] + ['-' * width, 'q: quit | j/k: player | Space: play/pause | n/p: track | h/l: ±10s | +/-: volume | t: transfer']
    return '\n'.join(clip(r, width) for r in rows)


class Terminal:
    """Restore input mode and screen even on errors and Ctrl+C."""
    def __enter__(self):
        self.mode = None
        if os.name == 'nt':
            import ctypes
            kernel = ctypes.windll.kernel32
            # Standard handles are pointer sized, including on 64-bit Windows.
            kernel.GetStdHandle.restype = ctypes.c_void_p
            self.handle = kernel.GetStdHandle(-11)
            mode = ctypes.c_ulong()
            if kernel.GetConsoleMode(ctypes.c_void_p(self.handle), ctypes.byref(mode)):
                self.mode = mode.value
                kernel.SetConsoleMode(ctypes.c_void_p(self.handle), mode.value | 4)
        else:
            import termios
            import tty
            self.mode = termios.tcgetattr(sys.stdin.fileno())
            tty.setcbreak(sys.stdin.fileno())
        print('\x1b[?1049h\x1b[?25l', end='', flush=True)
        return self

    def __exit__(self, *args):
        print('\x1b[?25h\x1b[?1049l', end='', flush=True)
        if self.mode is not None:
            if os.name == 'nt':
                import ctypes
                ctypes.windll.kernel32.SetConsoleMode(ctypes.c_void_p(self.handle), self.mode)
            else:
                import termios
                termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, self.mode)

    def key(self):
        if os.name == 'nt':
            import msvcrt
            if not msvcrt.kbhit():
                return None
            key = msvcrt.getwch()
            if key in ('\x00', '\xe0'):
                return {'H': 'k', 'P': 'j'}.get(msvcrt.getwch())
            return key
        import select
        if not select.select([sys.stdin], [], [], 0)[0]:
            return None
        key = os.read(sys.stdin.fileno(), 32).decode(errors='replace')
        return {'\x1b[A': 'k', '\x1b[B': 'j'}.get(key, key[-1:])


def main():
    for stream in (sys.stdout, sys.stderr):
        if not stream.isatty() and hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8080', help='Server URL')
    parser.add_argument('--interval', type=float, default=2, help='Polling interval in seconds (>= 1)')
    parser.add_argument('--once', action='store_true', help='Print a snapshot without screen control')
    parser.add_argument('--json', action='store_true', help='Print one status snapshot as JSON')
    parser.add_argument('--target', help='Target browser clientId from --json')
    parser.add_argument('--command', choices=['play','pause','next','previous','seek','volume','transfer'])
    parser.add_argument('--value', type=float, help='Position in seconds or volume from 0 to 1')
    parser.add_argument('--source', help='Source browser clientId for transfer')
    parser.add_argument('--wait', type=float, default=90, help='Command confirmation timeout, seconds')
    args = parser.parse_args()
    parsed = urlsplit(args.url)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc or parsed.query or parsed.fragment:
        parser.error('--url must be an HTTP(S) URL without query or fragment')
    if not 1 <= args.interval <= 3600:
        parser.error('--interval must be between 1 and 3600 seconds')
    if not 1 <= args.wait <= 300:
        parser.error('--wait must be between 1 and 300 seconds')
    if args.command:
        if not args.target:
            parser.error('--command requires --target (clientId from --json)')
        if args.command == 'transfer' and not args.source:
            parser.error('--command transfer requires --source')
        try:
            result = send_command(args.url, args.target, args.command, args.value, args.source)
            deadline = time.monotonic() + args.wait
            while result['state'] == 'pending' and time.monotonic() < deadline:
                time.sleep(.5)
                result = control_request(args.url, 'control-result', {'id': result['id']})
            print(json.dumps(result, ensure_ascii=False))
            return 0 if result['state'] == 'done' else 1
        except (OSError, ValueError, HTTPError, URLError) as error:
            print('Failed: ' + clean(error), file=sys.stderr)
            return 1
    once = args.once or args.json or not (sys.stdin.isatty() and sys.stdout.isatty()) or os.getenv('TERM') == 'dumb'
    if once:
        try:
            snapshot = fetch_status(args.url)
        except (OSError, ValueError, HTTPError, URLError) as error:
            print('No connection: ' + clean(error), file=sys.stderr)
            return 1
        print(json.dumps(snapshot, ensure_ascii=False, indent=2) if args.json else
              render_status(snapshot, args.url, width=shutil.get_terminal_size((100, 40)).columns, height=40))
        return 0
    snapshot, error, selected, next_fetch = None, None, 0, 0
    pending, notice, transfer_source = None, None, None
    try:
        with Terminal() as terminal:
            while True:
                key = terminal.key()
                if key in ('q', 'Q', '\x03'):
                    break
                redraw = key is not None
                if key in ('j', 'k') and snapshot and snapshot['clients']:
                    selected = (selected + (1 if key == 'j' else -1)) % len(snapshot['clients'])
                if key == '\x1b':
                    transfer_source = None
                    notice = 'Transfer cancelled.'
                if snapshot and snapshot['clients']:
                    client = snapshot['clients'][selected]
                    command = keyboard_command(key, client)
                    try:
                        if key in ('t', 'T'):
                            transfer_source = client['clientId']
                            notice = 'Transfer: select the receiving player with j/k, Enter to transfer, Esc to cancel.'
                        elif key in ('\r', '\n') and transfer_source:
                            result = send_command(args.url, client['clientId'], 'transfer', source=transfer_source)
                            pending, transfer_source = result['id'], None
                            notice = 'Transfer sent; waiting for confirmation.'
                        elif command and not transfer_source:
                            result = send_command(args.url, client['clientId'], *command)
                            pending = result['id']
                            notice = 'Command sent; waiting for confirmation.'
                    except (OSError, ValueError, HTTPError, URLError) as exc:
                        notice = 'Failed: ' + str(exc)
                if key in ('r', 'R'):
                    next_fetch = 0
                if time.monotonic() >= next_fetch:
                    try:
                        selected_id = snapshot['clients'][selected]['clientId'] if snapshot and snapshot['clients'] else None
                        snapshot = fetch_status(args.url)
                        selected = next((i for i, c in enumerate(snapshot['clients']) if c['clientId'] == selected_id), 0)
                        if pending:
                            result = control_request(args.url, 'control-result', {'id': pending})
                            if result['state'] != 'pending':
                                notice = 'The device confirmed completion.' if result['state'] == 'done' else 'Failed: ' + result['error']
                                pending = None
                        error = None
                    except (OSError, ValueError, HTTPError, URLError) as exc:
                        error = str(exc)
                    next_fetch = time.monotonic() + args.interval
                    redraw = True
                if redraw:
                    size = shutil.get_terminal_size((100, 32))
                    screen = render_status(snapshot, args.url, selected, size.columns - 1, size.lines - 1, error, notice)
                    print('\x1b[H\x1b[J' + screen, end='', flush=True)
                time.sleep(.1)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
