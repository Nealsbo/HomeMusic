"""Build the update asset: python tools/build_release.py [output.zip]."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from updater import ASSET, PROTOCOL, safe_name, version


def build(output):
    number = (ROOT / 'VERSION').read_text().strip()
    version(number)
    files = sorted([*ROOT.glob('*.py'), ROOT / 'VERSION', ROOT / 'LICENSE', ROOT / 'THIRD_PARTY_NOTICES.md',
                    *(path for path in (ROOT / 'web').rglob('*') if path.is_file())])
    manifest = dict(protocol=PROTOCOL, version=number, python='3.10', files={})
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for source in files:
            name = source.relative_to(ROOT).as_posix()
            safe_name(name)
            content = source.read_bytes()
            manifest['files'][name] = hashlib.sha256(content).hexdigest()
            archive.writestr(name, content)
        archive.writestr('update-manifest.json', json.dumps(manifest, indent=2))
    print(f'{output}\nSHA-256: {hashlib.sha256(output.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    build(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'output' / ASSET)
