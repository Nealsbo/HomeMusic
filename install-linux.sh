#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
python_bin="${PYTHON_BIN:-python3}"
install_deps=false
with_ffmpeg=false
help_requested=false
inspect_args=("$@")
index=0
while [[ "$index" -lt "${#inspect_args[@]}" ]]; do
    arg="${inspect_args[$index]}"
    case "$arg" in
        --music-dir|--database|--config|--host|--port|--max-upload-mb|--ffprobe|--ffmpeg)
            index=$((index + 2)); continue ;;
        --install-deps) install_deps=true ;;
        --with-ffmpeg) install_deps=true; with_ffmpeg=true ;;
        --help|-h) help_requested=true ;;
        --) break ;;
    esac
    index=$((index + 1))
done

if "$install_deps" && ! "$help_requested"; then
    if [[ "$(uname -s)" != Linux ]]; then
        printf '%s\n' 'Dependency installation requires Linux.' >&2
        exit 1
    fi
    if ! command -v apt-get >/dev/null 2>&1; then
        printf '%s\n' '--install-deps supports Debian/Ubuntu/Raspberry Pi OS (apt-get).' \
            'On other distributions install Python 3.10+ with sqlite3, and optionally FFmpeg, then run without this flag.' >&2
        exit 1
    fi
    elevate=()
    if [[ "$EUID" -ne 0 ]]; then
        command -v sudo >/dev/null 2>&1 || { printf '%s\n' 'sudo is required to install system packages.' >&2; exit 1; }
        elevate=(sudo)
    fi
    packages=(python3)
    if "$with_ffmpeg"; then packages+=(ffmpeg); fi
    "${elevate[@]}" apt-get update
    "${elevate[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
fi

command -v "$python_bin" >/dev/null 2>&1 || {
    printf '%s\n' 'Python is missing. Use --install-deps on Debian/Ubuntu, or install Python 3.10+ manually.' >&2
    exit 1
}
exec "$python_bin" "$script_dir/linux_setup.py" install "$@"
