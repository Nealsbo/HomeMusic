#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
python_bin="${PYTHON_BIN:-python3}"
command -v "$python_bin" >/dev/null 2>&1 || {
    printf '%s\n' 'Python is missing. Run install-linux.sh --install-deps, or install Python 3.10+.' >&2
    exit 1
}
exec "$python_bin" "$script_dir/main.py" "$@"
