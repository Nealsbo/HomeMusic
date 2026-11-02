# Music sources

The existing `music_dir` is the primary source. Existing track IDs, paths,
playlists, favorites and listening history keep their meaning. Uploads without
an explicit destination still go to the primary directory.

Add directories in `config.json`, then restart HomeMusic:

```json
{
  "music_dir": "D:/Music",
  "music_sources": [
    {"id": "archive", "name": "Archive", "type": "directory", "path": "E:/Music"},
    {"id": "albums", "name": "Albums", "type": "directory", "path": "F:/Albums"}
  ]
}
```

On Linux use paths such as `/srv/music` and `/media/archive/music`. Relative
paths are relative to the installation root, just like `music_dir`.
`--music-dir` overrides the primary directory only. `music_sources` is optional
and defaults to an empty list. The additional directories must already exist;
HomeMusic never creates a missing additional source automatically.

All sources appear in one library. Settings show source names, absolute paths
and availability; folder filters, uploads and move destinations include their
folders. Read permissions are sufficient for listening; uploading, creating
folders and moving files require the corresponding filesystem permissions.

Source IDs must remain stable and must not be reused for unrelated content.
Renaming the display name or relocating the directory while retaining its ID
and relative file layout preserves catalog identity. IDs contain 1–64 ASCII
letters, numbers, underscores or hyphens; `primary` is reserved.
Directories cannot overlap, including through resolved symlinks. Symbolic links
inside a source are skipped and cannot be accessed through the API.

Additional catalog paths have the form `@sources/archive/Artist/Track.flac`.
These are logical paths, not directories created in the primary source.
`@sources` is reserved at the top level of the primary directory; an existing
directory with that name must be renamed before using this version. Exports and
imports of HomeMusic M3U playlists use these logical paths. Displayed folder
names use the configured source names.

An unavailable source, an incomplete scan or removing a source from the config
does not delete its catalog records, playlist membership or favorites. Returning
the source with the same ID and refreshing the index restores file access.
An actually missing file in a successfully scanned source is removed from the
catalog, following the existing single-directory behavior. An empty mounted
directory is indistinguishable from a genuinely empty source: filesystem mount
monitoring is not implemented. Confirm external disks are mounted before scanning.

Moves within one filesystem work across source directories and support undo.
Moves across different filesystems are rejected before recording an operation;
copying across disks remains an external file operation in this version.

The `type` field and filesystem source adapter in `storage.py` provide a place
for future source backends. Only `directory` is currently supported. HomeMusic
does not mount SMB/NFS shares, handle network credentials or fetch remote URLs.

