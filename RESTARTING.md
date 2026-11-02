# Restarting HomeMusic

Start HomeMusic with `python main.py`, `run-windows.bat` or `bash run-linux.sh`.
The launcher remains running and starts a new server child after an authorized
restart. The new child reads the configuration again and retains the selected
application version, database, music and owner key. Explicit launch arguments
still override the configuration. Restart does not install an update or create
an update transaction or database backup.

In **Settings → Server and storage → Server restart**, enter the server owner
key shown in the console, choose **Restart server**, and confirm. This is the
same owner key used by Updates. It is cleared from the restart field after the
request and is not saved in browser storage. The page waits for a different
server instance to respond, then reloads. Playback may be interrupted and
unsaved settings are lost; existing browser queue persistence remains in use.
Restart does not automatically start playback again.

In the interactive TUI press uppercase **S**, then **y** to confirm. Other keys
cancel the confirmation (`q` still quits). TUI resumes polling and reconnects
without requiring a browser player to be present. Its existing **r** shortcut
continues to refresh status.

For a command-line restart:

```powershell
python tui.py --restart
```

For another URL or owner-key file:

```bash
python3 tui.py --url http://192.168.1.20:8080 --restart --owner-key-file /private/home-music-owner-key --wait 120
```

The default key file is `.updates/owner-key` beside the original `tui.py`.
The command waits for a new server instance and exits with a nonzero code if
the request fails or the server does not return within `--wait` seconds.
The secret is read from the file and sent in the Authorization header; it is
never a command-line argument or part of the JSON body.

An active update check, installation or restart blocks another restart. Browser
requests also use the existing same-origin check. Other application features
retain their existing access model.

Direct `server.py` starts cannot restart themselves. Older stable launchers do
not advertise restart support, even if an installed release contains the new
button: update the original bootstrap manually before using this feature.
The UI disables the button when restart support is unavailable.

If the edited configuration changes the host or port, reconnect using the new
URL. The browser and TUI continue checking their original URL. Invalid
configuration can prevent startup; inspect the server console and fix the
configuration. An ordinary restart does not roll back configuration changes.
