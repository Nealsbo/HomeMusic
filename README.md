# HomeMusic

**English** · [Русский](README_RU.md)

A lightweight personal music server with a web player for desktop and mobile.
Keep your collection on a Windows or Linux machine and listen from devices on
your local network

## Features

- Library views with albums, artists, folders, search, and cover images
- Playlists, M3U/M3U8 import and export, favorites, and listening history
- Independent playback queues on each device, remote controls, and playback transfer
- File uploads, metadata editing, collection checks, and undo for supported changes
- English and Russian interface, themes, and adjustable text and icon sizes

## Quick start

Requires **Python 3.10+** with SQLite support. No third-party Python packages or
frontend build are needed. Optional **FFmpeg/ffprobe** enables tag reading and
cover extraction.

Download or clone the project. By default, music is read from a `Music` folder
next to the project folder:

```text
parent/
├── HomeMusic/
└── Music/
```

Run from the project folder:

**Windows** — Command Prompt or PowerShell:

```powershell
.\run-windows.bat
```

**Linux:**

```bash
bash run-linux.sh
```

Open `http://localhost:8080` on the server or `http://SERVER-IP:8080` on another
device. Stop the server with **Ctrl+C**.

## Configuration

Defaults: `--listen true --host 0.0.0.0 --port 8080 --music-dir "../Music/"`.
Override them when launching:

```powershell
.\run-windows.bat --music-dir "D:\Music" --port 8090
```

```bash
bash run-linux.sh --music-dir "/srv/music" --port 8090
```

Use `--listen false` to restrict access to this computer (`127.0.0.1`).
`--host` and `--ip` are equivalent.

For persistent settings, copy [config.example.json](config.example.json) to
`config.json` and edit it. The file is loaded automatically; launch arguments
override it. Relative paths are resolved from the project folder. All options:
`python main.py --help` (use `python3` on Linux).

## Notes

Audio plays in the connected device's browser. Codec support depends on that
browser; the server does not transcode audio. The collection, playlists,
favorites, and history are shared, while playback queues are independent.

HomeMusic is intended for a trusted local network and has no user authentication.
Choose the interface language in Settings; the choice is saved in that browser.
To contribute a translation, see [LOCALIZATION.md](LOCALIZATION.md).

## License

[MIT](LICENSE).
