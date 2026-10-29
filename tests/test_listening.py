import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

from library import Library
from database import SCHEMA_VERSION


class ListeningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / 'music'
        self.root.mkdir()
        (self.root / 'First.mp3').write_bytes(b'audio')
        (self.root / 'Second.mp3').write_bytes(b'audio')
        self.filename = self.base / 'catalog.sqlite3'
        self.library = Library(self.root,self.filename,ffprobe=False,ffmpeg=False)
        self.track = self.library.state()['tracks'][0]['id']

    def tearDown(self):
        self.library.close()
        self.temp.cleanup()

    def send(self, **values):
        data = dict(id='event1',trackId=self.track,deviceId='device1',deviceName='PC',seq=1,
                    listened=0,position=0,duration=120,ended=False)
        data.update(values)
        return self.library.action('listen',data)

    def test_threshold_seeks_retries_and_new_occurrences(self):
        self.assertFalse(self.send()['qualified'])
        self.assertFalse(self.send(seq=2,listened=29,position=119)['qualified'])
        self.assertEqual(self.library.listening.history()['total'],0)
        self.assertTrue(self.send(seq=3,listened=30,position=120)['newlyQualified'])
        self.assertTrue(self.send(seq=3,listened=30)['qualified'])
        self.send(seq=1,listened=120)
        self.send(seq=4,listened=35,position=5)
        self.assertEqual(self.library.listening.history()['total'],1)
        t = self.library.state()['tracks'][0]
        self.assertEqual((t['play_count'],t['listened_seconds']),(1,35))
        self.send(id='event2',listened=31)
        self.assertEqual(self.library.state()['tracks'][0]['play_count'],2)

    def test_delayed_delivery_preserves_actual_start_timestamp(self):
        started = time.time() - 3600
        self.send(listened=31,startedAt=started)
        self.assertEqual(self.library.listening.history()['items'][0]['started'],started)
        self.send(seq=2,listened=40,startedAt=time.time())
        self.assertEqual(self.library.listening.history()['items'][0]['started'],started)

    def test_short_track_threshold_and_unknown_duration(self):
        self.assertFalse(self.send(listened=4.9,duration=10)['qualified'])
        self.assertTrue(self.send(seq=2,listened=5,duration=10)['qualified'])
        self.assertFalse(self.send(id='unknown',listened=29,duration=0)['qualified'])
        self.assertTrue(self.send(id='unknown',seq=2,listened=30,duration=0)['qualified'])

    def test_persisted_metadata_duration_is_authoritative(self):
        with self.library.connect() as db:
            db.execute('UPDATE tracks SET duration=120 WHERE id=?',(self.track,))
        self.assertFalse(self.send(listened=1,duration=1)['qualified'])
        self.assertTrue(self.send(seq=2,listened=30,duration=1)['qualified'])

    def test_replayed_out_of_order_reports_cannot_change_progress(self):
        self.send(seq=5,listened=35,position=55,ended=True)
        self.send(seq=3,listened=100,position=100)
        self.send(seq=6,listened=10,position=1)
        row = self.library.listening.history()['items'][0]
        self.assertEqual((row['listened'],row['position'],row['ended']),(35,1,1))
        with self.assertRaises(ValueError):
            self.send(seq=7,deviceId='different')
        with self.assertRaises(ValueError):
            self.send(seq=7,trackId=self.library.state()['tracks'][1]['id'])

    def test_favorites_are_shared_idempotent_and_survive_restart_and_move(self):
        self.library.action('favorite',{'id':self.track,'value':True})
        added = self.library.state()['tracks'][0]['favorite_at']
        self.library.action('favorite',{'id':self.track,'value':True})
        self.assertEqual(self.library.state()['tracks'][0]['favorite_at'],added)
        self.library.action('folder',{'path':'Moved'})
        self.library.action('move',{'folder':'Moved','tracks':[self.track]})
        restored = Library(self.root,self.filename,ffprobe=False,ffmpeg=False)
        self.assertTrue(next(t for t in restored.state()['tracks'] if t['id']==self.track)['favorite'])
        restored.action('favorite',{'id':self.track,'value':False})
        self.assertFalse(next(t for t in self.library.state()['tracks'] if t['id']==self.track)['favorite'])
        restored.close()

    def test_devices_filter_and_rename_existing_history(self):
        self.send(listened=31)
        self.send(id='event2',deviceId='phone',deviceName='Phone',listened=31)
        result = self.library.listening.history(device='phone')
        self.assertEqual(result['total'],1)
        self.assertEqual(result['items'][0]['deviceName'],'Phone')
        self.library.action('device',{'id':'phone','name':'Kitchen'})
        self.assertEqual(self.library.listening.history(device='phone')['items'][0]['deviceName'],'Kitchen')
        self.assertEqual(len(result['devices']),2)

    def test_history_and_last_position_survive_server_restart(self):
        self.send(listened=31,position=78)
        restored = Library(self.root,self.filename,ffprobe=False,ffmpeg=False)
        self.assertEqual(restored.listening.history()['items'][0]['position'],78)
        self.assertEqual(restored.state()['tracks'][0]['play_count'],1)
        restored.close()

    def test_history_preserves_snapshot_for_removed_file_and_favorites_cascade(self):
        self.library.action('favorite',{'id':self.track,'value':True})
        self.send(listened=31)
        source = self.library.track(self.track)['path']
        (self.root / source).unlink()
        self.library.scan()
        event = self.library.listening.history()['items'][0]
        self.assertIsNone(event['trackId'])
        self.assertEqual(event['title'],'First')
        with self.library.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM favorites').fetchone()[0],0)

    def test_keyset_pagination_has_no_overlap_and_handles_identical_times(self):
        with patch('listening.time.time',return_value=time.time()):
            for i in range(6): self.send(id=f'event{i}',listened=31)
            first = self.library.listening.history(limit=2)
            self.send(id='eventZ',listened=31)
            second = self.library.listening.history(limit=2,before_started=first['nextCursor']['started'],before_id=first['nextCursor']['id'])
        self.assertEqual([r['id'] for r in first['items']],['event5','event4'])
        self.assertEqual([r['id'] for r in second['items']],['event3','event2'])
        self.assertFalse({r['id'] for r in first['items']} & {r['id'] for r in second['items']})

    def test_retention_and_bounded_drafts(self):
        self.send(listened=31)
        self.send(id='draft',listened=1)
        with self.library.connect() as db:
            db.execute('UPDATE listens SET started=? WHERE id=?',(time.time()-366*86400,'event1'))
            db.execute('UPDATE listens SET last_seen=? WHERE id=?',(time.time()-8*86400,'draft'))
        self.library.listening.last_cleanup=0
        self.library.listening.cleanup()
        self.assertEqual(self.library.listening.history()['total'],0)
        with self.library.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM listens').fetchone()[0],0)
        for i in range(6): self.send(id=f'keep{i}',listened=31)
        for i in range(3): self.send(id=f'draft{i}',listened=1)
        with patch('listening.MAX_HISTORY',2),patch('listening.MAX_DRAFTS',1):
            self.library.listening.last_cleanup=0
            self.library.listening.cleanup()
        with self.library.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM listens WHERE qualified=1').fetchone()[0],2)
            self.assertEqual(db.execute('SELECT COUNT(*) FROM listens WHERE qualified=0').fetchone()[0],1)

    def test_invalid_reports_and_queries_do_not_create_rows(self):
        for invalid in [dict(listened=float('nan')),dict(position=-1),dict(duration=float('inf')),dict(seq=True),dict(id='../escape'),dict(ended='yes')]:
            with self.subTest(invalid=invalid),self.assertRaises(ValueError): self.send(**invalid)
        for values in [dict(limit=0),dict(limit=101),dict(device='invalid/'),dict(before_started='nan',before_id='valid')]:
            with self.assertRaises(ValueError): self.library.listening.history(**values)
        self.assertEqual(self.library.listening.history()['total'],0)

    def test_v1_migration_preserves_metadata_and_creates_backup(self):
        self.library.action('metadata',{'id':self.track,'title':'Manual title','album':'Manual album'})
        with self.library.connect() as db:
            before = dict(db.execute('SELECT * FROM tracks WHERE id=?',(self.track,)).fetchone())
            db.execute('DROP TABLE listens')
            db.execute('DROP TABLE favorites')
            db.execute('DROP TABLE devices')
            db.execute('PRAGMA user_version=1')
        restored=Library(self.root,self.filename,ffprobe=False,ffmpeg=False)
        self.assertEqual(restored.state()['schemaVersion'],SCHEMA_VERSION)
        self.assertEqual(restored.track(self.track)['overrides'],before['overrides'])
        self.assertEqual(restored.track(self.track)['title'],'Manual title')
        backup=sqlite3.connect(str(self.filename)+'.pre-v2.bak')
        self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0],1)
        backup.close(); restored.close()


if __name__ == '__main__': unittest.main()
