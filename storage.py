"""Named filesystem sources. Catalog paths are independent of absolute locations."""
from dataclasses import dataclass
import os
from pathlib import Path
import re

PREFIX = '@sources'


@dataclass(frozen=True)
class DirectorySource:
    id: str
    name: str
    root: Path
    primary: bool = False
    type: str = 'directory'

    @property
    def prefix(self):
        return '' if self.primary else f'{PREFIX}/{self.id}'

    def catalog_path(self, path):
        relative = path.relative_to(self.root).as_posix()
        return '/'.join(p for p in (self.prefix, '' if relative == '.' else relative) if p)

    def directories(self):
        if not self.root.is_dir():
            raise FileNotFoundError(f'Storage unavailable: {self.name}')
        def fail(error):
            raise error
        for directory, dirs, files in os.walk(self.root, followlinks=False, onerror=fail):
            dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
            yield Path(directory), files


def directory_sources(root, configured=None):
    primary = DirectorySource('primary', 'Primary storage', Path(root).resolve(), True)
    if configured is None:
        configured = []
    if not isinstance(configured, list):
        raise ValueError('music_sources must be a list')
    sources = [primary]
    for item in configured:
        if not isinstance(item, dict) or item.get('type', 'directory') != 'directory':
            raise ValueError('Only directory music sources are supported')
        identifier = item.get('id', '')
        path = item.get('path')
        name = item.get('name', identifier)
        if (not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', identifier)
                or identifier in {s.id for s in sources}):
            raise ValueError('Music source IDs must be unique letters, numbers, underscores or hyphens')
        if not isinstance(path, str) or not path.strip():
            raise ValueError('Music source path is required')
        if not isinstance(name, str) or not name.strip() or len(name) > 120:
            raise ValueError('Music source name must contain 1 to 120 characters')
        location = Path(path).resolve()
        if any(location.is_relative_to(s.root) or s.root.is_relative_to(location) for s in sources):
            raise ValueError('Music source directories must not overlap')
        sources.append(DirectorySource(identifier, name.strip(), location))
    if (primary.root / PREFIX).exists():
        raise ValueError(f'{PREFIX} is reserved for additional music sources')
    return sources
