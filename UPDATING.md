# Application updates

Start HomeMusic with `run-windows.bat`, `bash run-linux.sh`, or `python main.py`
(`python3` on Linux). The launcher stays running while a child serves the app.
Direct `server.py` launches retain their existing behavior and cannot install updates.

In **Settings → Updates**, read the installed version and release notes, enter
the update owner key shown in the server console, and choose **Check for updates**.
To install, acknowledge the restart and choose **Install and restart**. Playback
may be interrupted. After the server returns, use **Reload interface** to load
the new browser code. An unsuccessful startup restores the previous application
selection and database, and reports that rollback in Settings.

The owner key is created once in `.updates/owner-key` and reused across restarts.
It is never returned by the API or saved in browser storage. Keep this directory
and console logs private. To rotate the key, stop the application, remove that
file, and start it again. This key protects update and restart commands; other existing
HomeMusic features still assume a trusted local network. HTTP does not encrypt
the key; use a trusted connection or an HTTPS reverse proxy for remote access.

## Configuration

Optional `config.json` fields:

```json
{
  "updates_repository": "Nealsbo/HomeMusic",
  "updates_auto_check": true,
  "updates_startup_timeout": 90
}
```

Automatic checking runs on startup and every 24 hours. Installation is always
manual. Disable automatic checking with `false`. Public GitHub repositories are
supported; Git, GitHub Actions, npm, and third-party Python packages are not
required on the server. A missing release produces an informational message.
Network/API errors leave the running application unchanged. The startup timeout
accepts 10–1800 seconds; increase it for slow storage or large library scans.

## Publishing a release

1. Update `VERSION` to a stable numeric version, such as `0.1.1`.
2. Run the Python and client test suites.
3. From the project root, run `python tools/build_release.py`.
4. Create a public GitHub release with the matching tag (`v0.1.1` or `0.1.1`),
   add release notes, and attach `output/homemusic-update.zip` with that exact name.

The builder packages runtime Python files, `web/`, version information, and
license notices. It excludes configuration, music, databases, tests, and working
documents. The archive includes a protocol-1 manifest with file hashes and the
minimum Python version. If Python requirements change, update the builder's
manifest requirement as part of that release. Only the latest stable GitHub
release is offered; branch commits and prereleases are not installed.

The updater requires GitHub's SHA-256 asset digest and checks it before unpacking,
then verifies every packaged file. These checks establish integrity relative to
the configured repository, not an independent publisher signature. Repository
access and release publishing must be trusted; uploaded code runs as the server
user. There is no detached-signature system in this version.

The same owner key also authorizes ordinary server restarts from Settings and
TUI; see [RESTARTING.md](RESTARTING.md). This requires the original launcher to
support restarts. Updating replaceable application code alone does not upgrade
an older stable bootstrap.

## Storage, rollback, and recovery

The installation root remains the working directory. Existing relative music,
database, config, and executable paths keep their meaning. New code goes into
`.updates/versions/<version>/`; `.updates/current.json` selects it. Original
source files, local edits, music, and configuration are not overwritten. Changes
to original source files do not affect an already selected release.

After the old process exits, the launcher makes a consistent SQLite backup,
writes a recovery journal, switches versions, and checks the new server's HTTP
readiness using a per-process identifier. Failed startup restores the backup
and previous selection. This verifies startup, not all possible application
behavior. Backup and rollback cover SQLite; future releases that migrate other
persistent formats must extend the protocol before shipping those migrations.

Pending transactions are recovered on the next launch after interruption. If a
forcibly terminated launcher leaves its server child running, another launcher
refuses to touch the live database: stop the old child before restarting.
Only one managed instance per installation root is supported. Process locks are
local OS locks; sharing one installation across multiple machines is unsupported.

Keep `.updates/` writable and allow room for the archive, expanded code, and a
database backup. Backups and old releases are retained for local recovery; no
automatic cleanup runs. A failed/incomplete staging directory is retained for
inspection. To retry the same version, stop the server and remove only that
version's directory under `.updates/versions/`, then restart and check again.

The original `main.py` and `updater.py` act as the stable bootstrap and are not
replaced by updates. A future incompatible launcher protocol requires a manual
bootstrap upgrade. Continue launching through the original scripts rather than
running files inside `.updates/versions/` directly.

Windows subprocess installation and rollback are covered by automated tests.
The Linux lock path is implemented, but Debian/Armbian and Orange Pi update
installation still need acceptance testing on a real target device.
