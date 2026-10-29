import io
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
import wave

from database import SCHEMA_VERSION, migrate
from library import Library
from media_metadata import MetadataReader


def write_wav(path):
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(8000)
        wav.writeframes(b'\0\0' * 800)


class CatalogMigrationTests(unittest.TestCase):
    def test_legacy_catalog_backup_preserves_even_blank_manual_edits(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'music'
            root.mkdir()
            write_wav(root / 'file.wav')
            filename = Path(temp) / 'catalog.sqlite3'
            db = sqlite3.connect(filename)
            db.executescript('''
                CREATE TABLE tracks(id TEXT PRIMARY KEY,path TEXT UNIQUE,title TEXT,artist TEXT,album TEXT,size INTEGER,modified REAL,position INTEGER);
                CREATE TABLE playlists(id TEXT PRIMARY KEY,name TEXT);
                CREATE TABLE items(playlist TEXT,track TEXT,position INTEGER,PRIMARY KEY(playlist,track),
                    FOREIGN KEY(playlist) REFERENCES playlists(id) ON DELETE CASCADE,
                    FOREIGN KEY(track) REFERENCES tracks(id) ON DELETE CASCADE);
                CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
                INSERT INTO tracks VALUES('t','file.wav','Manual title','','Manual album',0,0,7);
                INSERT INTO playlists VALUES('p','My playlist');
                INSERT INTO items VALUES('p','t',0);
                INSERT INTO settings VALUES('title','"My server"');
            ''')
            db.close()
            library = Library(root, filename, ffprobe=False)
            library.index_pending()
            state = library.state()
            self.assertEqual(state['schemaVersion'], SCHEMA_VERSION)
            self.assertEqual(state['playlists'][0]['tracks'], ['t'])
            track = state['tracks'][0]
            self.assertEqual((track['title'],track['artist'],track['album'],track['position']),
                             ('Manual title','','Manual album',7))
            self.assertEqual(state['settings']['title'], 'My server')
            backup = sqlite3.connect(str(filename) + '.pre-v1.bak')
            try:
                self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0],0)
                self.assertEqual(backup.execute('SELECT title FROM tracks').fetchone()[0],'Manual title')
            finally:
                backup.close()
            # Reopening the migrated database is idempotent and keeps IDs/settings.
            restored = Library(root, filename, ffprobe=False)
            self.assertEqual(restored.state()['playlists'],state['playlists'])
            restored.action('metadata',{'id':'t','reset':True})
            self.assertEqual(restored.track('t')['title'],'file')

    def test_failed_migration_rolls_back_ddl_and_version(self):
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        db.executescript('''CREATE TABLE tracks(id TEXT,title TEXT,artist TEXT,album TEXT,genre TEXT);
            CREATE TABLE playlists(id TEXT); CREATE TABLE settings(key TEXT);''')
        with self.assertRaises(sqlite3.OperationalError):
            migrate(db, ':memory:')  # Existing genre forces a failure partway through migration.
        self.assertEqual([r['name'] for r in db.execute('PRAGMA table_info(tracks)')],
                         ['id','title','artist','album','genre'])
        self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],0)
        db.close()

    def test_future_schema_is_rejected(self):
        db = sqlite3.connect(':memory:')
        db.execute('PRAGMA user_version=999')
        with self.assertRaisesRegex(RuntimeError,'newer'):
            migrate(db, ':memory:')
        db.close()


class MetadataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / 'music'
        self.root.mkdir()
        self.file = self.root / 'Artist - Song.wav'
        write_wav(self.file)
        self.library = Library(self.root,self.base / 'catalog.sqlite3')

    def tearDown(self):
        self.library.close()
        self.temp.cleanup()

    def test_missing_tools_degrade_to_filename_without_preventing_playback(self):
        reader = MetadataReader(self.base / 'other-covers',ffprobe=False,ffmpeg=False)
        result = reader.read(self.file)
        self.assertEqual((result['title'],result['artist']),('Song','Artist'))
        self.assertTrue(result['metadata_error'])
        self.assertFalse(reader.capabilities()['tags'])

    @unittest.skipUnless(shutil.which('ffprobe'), 'ffprobe required')
    def test_unchanged_files_are_not_reprobed_and_wav_technical_data_is_read(self):
        with patch.object(self.library.reader,'read', wraps=self.library.reader.read) as read:
            self.library.index_pending()
            self.assertEqual(read.call_count,1)
            t = self.library.state()['tracks'][0]
            self.assertAlmostEqual(t['duration'],.1,places=2)
            self.assertEqual((t['codec'],t['sample_rate'],t['channels']),('pcm_s16le',8000,1))
            self.library.scan()
            self.library.index_pending()
            self.assertEqual(read.call_count,1)
            self.file.write_bytes(self.file.read_bytes() + b'\0\0')
            self.library.scan()
            self.library.index_pending()
            self.assertEqual(read.call_count,2)

    def test_manual_overrides_survive_reindex_and_reset_is_explicit(self):
        first = self.library.state()['tracks'][0]
        self.library.action('metadata',dict(id=first['id'],title='Manual',artist='',genre='Rock'))
        original = self.library.reader.read
        def tagged(path):
            result = original(path)
            result.update(title='From tags',artist='Tagged artist',album='Album',album_artist='Various',genre='Jazz',year='2001',track_number=3,disc_number=2)
            return result
        with patch.object(self.library.reader,'read',side_effect=tagged):
            self.library.index_pending()
            t = self.library.track(first['id'])
            self.assertEqual((t['title'],t['artist'],t['album'],t['genre']),('Manual','','Album','Rock'))
            self.library.action('metadata',dict(id=t['id'],reset=True))
            restored = self.library.track(t['id'])
            self.assertEqual((restored['title'],restored['artist'],restored['genre']),('From tags','Tagged artist','Jazz'))
            self.assertEqual(json.loads(restored['overrides']),{})

    def test_indexing_does_not_hold_library_lock_or_overwrite_concurrent_edits(self):
        def read(path):
            # A separate thread can edit while expensive metadata is being read.
            import threading
            t = self.library.state()['tracks'][0]
            completed = threading.Event()
            thread = threading.Thread(target=lambda: (self.library.action('metadata',{'id':t['id'],'title':'During probe'}),completed.set()))
            thread.start()
            self.assertTrue(completed.wait(2))
            thread.join()
            result = MetadataReader(self.base / 'fallback',ffprobe=False).read(path)
            result['title'] = 'Imported'
            return result
        with patch.object(self.library.reader,'read',side_effect=read):
            self.library.index_pending()
        self.assertEqual(self.library.state()['tracks'][0]['title'],'During probe')

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg tools required')
    def test_real_tags_and_cached_embedded_cover(self):
        ffmpeg = shutil.which('ffmpeg')
        picture = self.base / 'cover.jpg'
        subprocess.run([ffmpeg,'-v','error','-f','lavfi','-i','color=c=green:s=96x64','-frames:v','1','-update','1',str(picture)],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        tagged = self.root / 'unrelated-name.mp3'
        command = [ffmpeg,'-v','error','-i',str(self.file),'-i',str(picture),'-map','0:a:0','-map','1:v:0',
                   '-c:a','libmp3lame','-c:v','copy','-disposition:v','attached_pic',
                   '-metadata','title=Tagged title','-metadata','artist=Tagged artist','-metadata','album=Tagged album',
                   '-metadata','album_artist=Various Artists','-metadata','genre=Jazz',
                   '-metadata','date=2022','-metadata','track=3/12','-metadata','disc=2/2',str(tagged)]
        subprocess.run(command,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.library.scan()
        self.library.index_pending()
        t = next(t for t in self.library.state()['tracks'] if t['path'].endswith('.mp3'))
        self.assertEqual((t['title'],t['artist'],t['album']),('Tagged title','Tagged artist','Tagged album'))
        self.assertEqual((t['album_artist'],t['genre'],t['year'],t['track_number'],t['disc_number']),('Various Artists','Jazz','2022',3,2))
        self.assertRegex(t['cover_id'],r'^[a-f0-9]{64}$')
        cached = self.library.reader.cache / (t['cover_id'] + '.jpg')
        self.assertTrue(cached.exists())
        mtime = cached.stat().st_mtime_ns
        self.library.scan()
        self.assertEqual(self.library.index_pending(),0)
        self.assertEqual(cached.stat().st_mtime_ns,mtime)

    def test_background_worker_completes_pending_index(self):
        self.library.reader = MetadataReader(self.base / 'fallback',ffprobe=False)
        self.library.start_metadata_worker()
        deadline = time.monotonic() + 5
        while self.library.state()['metadata']['pending'] and time.monotonic() < deadline:
            time.sleep(.02)
        self.assertEqual(self.library.state()['metadata']['pending'],0)



    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg tools required')
    def test_flac_ogg_m4a_tags_and_audio_properties(self):
        for extension in ['flac','ogg','m4a']:
            with self.subTest(extension=extension):
                target = self.root / ('tagged.' + extension)
                subprocess.run([shutil.which('ffmpeg'),'-v','error','-i',str(self.file),
                    '-metadata','title=Container title','-metadata','artist=Container artist',
                    '-metadata','album=Container album','-metadata','track=4/10',str(target)],
                    check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                result = self.library.reader.read(target)
                self.assertEqual((result['title'],result['artist'],result['album'],result['track_number']),
                                 ('Container title','Container artist','Container album',4))
                self.assertGreater(result['duration'],0)
                self.assertTrue(result['codec'])
                self.assertFalse(result['metadata_error'])

    def test_cli_starts_and_serves_split_frontend_and_background_index(self):
        import os
        import queue
        import re
        import sys
        import threading
        from urllib.request import urlopen
        process = subprocess.Popen([sys.executable,'server.py','--music-dir',str(self.root),
            '--database',str(self.base / 'cli.sqlite3'),'--host','127.0.0.1','--port','0'],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',
            env={**os.environ,'PYTHONIOENCODING':'utf-8'})
        lines = queue.Queue()
        reader = threading.Thread(target=lambda: [lines.put(line) for line in process.stdout],daemon=True)
        reader.start()
        try:
            first = lines.get(timeout=10)
            second = lines.get(timeout=10)
            self.assertIn('Music storage:',first)
            url = re.search(r'http://127.0.0.1:\d+',second)[0]
            for name in ['','catalog.js','collection.js','queue.js','core.js','settings.js','library.js','views.js','player.js','app.js']:
                with urlopen(url + '/' + name,timeout=5) as response:
                    self.assertEqual(response.status,200)
                    self.assertTrue(response.read())
            deadline = time.monotonic() + 5
            while True:
                with urlopen(url + '/api/state',timeout=5) as response:
                    state = json.loads(response.read())
                if not state['metadata']['pending'] or time.monotonic() >= deadline:
                    break
                time.sleep(.02)
            self.assertEqual(state['metadata']['pending'],0)
            self.assertEqual(state['tracks'][0]['title'],'Song')
            if shutil.which('ffprobe'):
                self.assertGreater(state['tracks'][0]['duration'],0)
        finally:
            process.terminate()
            process.wait(timeout=10)
            reader.join(timeout=2)
            process.stdout.close()
            process.stderr.close()


if __name__ == '__main__':
    unittest.main()
