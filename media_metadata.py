"""Read local audio metadata and cache small cover images using FFmpeg tools."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import uuid

TEXT_FIELDS = ('title', 'artist', 'album', 'album_artist', 'genre', 'year')
EDIT_FIELDS = (*TEXT_FIELDS, 'track_number', 'disc_number')
TECH_FIELDS = ('duration', 'codec', 'bitrate', 'sample_rate', 'channels', 'cover_id')


def number(value, integer=False):
    try:
        result = float(value)
        if not math.isfinite(result) or result < 0:
            return 0
        return int(min(result,2147483647)) if integer else result
    except (ValueError, TypeError, OverflowError):
        return 0


def fallback(path):
    artist, sep, title = Path(path).stem.partition(' - ')
    return dict(title=title if sep else artist, artist=artist if sep else '', album='',
                album_artist='', genre='', year='', track_number=0, disc_number=0)


class MetadataReader:
    def __init__(self, cache, ffprobe=None, ffmpeg=None):
        self.cache = Path(cache)
        self.cache.mkdir(parents=True, exist_ok=True)
        self.ffprobe = shutil.which(ffprobe or 'ffprobe') if ffprobe is not False else None
        self.ffmpeg = shutil.which(ffmpeg or 'ffmpeg') if ffmpeg is not False else None
        self.key = f'ffmpeg-v1:{bool(self.ffprobe)}:{bool(self.ffmpeg)}'

    def capabilities(self):
        return dict(tags=bool(self.ffprobe), covers=bool(self.ffprobe and self.ffmpeg))

    def run(self, args, timeout=20):
        return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout, check=False,
                              creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

    def read(self, path):
        result = fallback(path)
        result.update(dict.fromkeys(TECH_FIELDS, 0))
        result.update(codec='', cover_id='', metadata_error='')
        if not self.ffprobe:
            result['metadata_error'] = 'ffprobe not found: only file name data is available'
            return result
        try:
            fields = ('format=duration,bit_rate:format_tags=title,artist,album,album_artist,albumartist,genre,date,year,track,disc:'
                      'stream=index,codec_type,codec_name,duration,bit_rate,sample_rate,channels,width,height:'
                      'stream_tags=title,artist,album,album_artist,albumartist,genre,date,year,track,disc:'
                      'stream_disposition=attached_pic')
            probe = self.run([self.ffprobe, '-v', 'error', '-protocol_whitelist', 'file,pipe',
                              '-probesize', '5000000', '-analyzeduration', '5000000',
                              '-show_entries', fields, '-of', 'json', str(path)])
            if probe.returncode:
                raise ValueError(probe.stderr.decode('utf-8', errors='replace')[-500:].strip() or 'Could not read audio')
            if len(probe.stdout) > 4 * 1024 * 1024:
                raise ValueError('Metadata block is too large')
            data = json.loads(probe.stdout)
            streams = data.get('streams', [])
            audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
            if audio is None:
                raise ValueError('No audio stream found')
            info = data.get('format', {})
            tags = {str(k).lower(): str(v) for k, v in audio.get('tags', {}).items()}
            tags.update({str(k).lower(): str(v) for k, v in info.get('tags', {}).items()})
            for field in ('title', 'artist', 'album', 'genre'):
                if field in tags:
                    result[field] = tags[field][:300]
            result['album_artist'] = tags.get('album_artist', tags.get('albumartist', ''))[:300]
            year = re.search(r'\d{4}', tags.get('date', tags.get('year', '')))
            result['year'] = year[0] if year else ''
            for field, key in [('track_number', 'track'), ('disc_number', 'disc')]:
                value = re.match(r'\d+', tags.get(key, ''))
                result[field] = min(99999,int(value[0])) if value else 0
            result.update(duration=number(info.get('duration') or audio.get('duration')),
                          codec=str(audio.get('codec_name', ''))[:80],
                          bitrate=number(audio.get('bit_rate') or info.get('bit_rate'), True),
                          sample_rate=number(audio.get('sample_rate'), True),
                          channels=number(audio.get('channels'), True))
            picture = next((s for s in streams if s.get('disposition', {}).get('attached_pic')), None)
            if picture and self.ffmpeg:
                try:
                    result['cover_id'] = self.cover(path, picture)
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    result['metadata_error'] = f'Cover: {error}'[:600]
        except (OSError, ValueError, TypeError, subprocess.SubprocessError) as error:
            result['metadata_error'] = str(error)[:600]
        return result

    def cover(self, path, picture):
        if number(picture.get('width')) * number(picture.get('height')) > 25_000_000:
            raise ValueError('Cover image exceeds 25 megapixels')
        temporary = self.cache / ('.cover-' + uuid.uuid4().hex + '.jpg')
        try:
            output = self.run([self.ffmpeg, '-v', 'error', '-nostdin', '-y', '-max_alloc', '67108864',
                '-threads', '1', '-protocol_whitelist', 'file,pipe', '-i', str(path),
                '-map', f"0:{int(picture['index'])}", '-an', '-frames:v', '1',
                '-vf', 'scale=320:320:force_original_aspect_ratio=decrease',
                '-threads', '1', '-c:v', 'mjpeg', '-q:v', '4', '-update', '1', str(temporary)], timeout=30)
            if output.returncode or not temporary.exists():
                raise ValueError('Could not extract the image')
            if temporary.stat().st_size > 2 * 1024 * 1024:
                raise ValueError('Thumbnail is too large')
            identifier = hashlib.sha256(temporary.read_bytes()).hexdigest()
            target = self.cache / (identifier + '.jpg')
            if not target.exists():
                temporary.replace(target)
            return identifier
        finally:
            temporary.unlink(missing_ok=True)
