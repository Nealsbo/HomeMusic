import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from library import Library
from operations import move_no_replace, fingerprint


class UndoTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name);self.root=self.base/'music';self.root.mkdir()
        (self.root/'First.mp3').write_bytes(b'first audio');(self.root/'Second.mp3').write_bytes(b'second audio')
        self.filename=self.base/'catalog.sqlite3'
        self.library=Library(self.root,self.filename,ffprobe=False,ffmpeg=False)
        self.ids=[t['id'] for t in self.library.state()['tracks']]
        self.library.action('folder',{'path':'Target'})

    def tearDown(self):
        self.library.close();self.temp.cleanup()

    def undo(self,result):
        return self.library.action('undo',{'id':result['operationId']})

    def test_metadata_reset_and_sequential_conflict_checked_undo(self):
        a=self.library.action('metadata',{'id':self.ids[0],'title':'Manual','artist':''})
        b=self.library.action('metadata',{'id':self.ids[0],'title':'Later'})
        with self.assertRaisesRegex(ValueError,'changed later'):self.undo(a)
        self.undo(b);self.assertEqual(self.library.track(self.ids[0])['title'],'Manual')
        reset=self.library.action('metadata',{'id':self.ids[0],'reset':True})
        self.undo(reset);self.assertEqual(self.library.track(self.ids[0])['title'],'Manual')
        self.undo(a);self.assertEqual(json.loads(self.library.track(self.ids[0])['overrides']),{})
        self.assertEqual(self.undo(a)['state'],'undone')

    def test_metadata_undo_uses_latest_imported_tags_without_overwriting_them(self):
        result=self.library.action('metadata',{'id':self.ids[0],'title':'Manual'})
        with self.library.connect() as db:db.execute('UPDATE tracks SET source_tags=? WHERE id=?',(json.dumps({'title':'New tag title','artist':'New artist'}),self.ids[0]))
        self.undo(result)
        self.assertEqual(self.library.track(self.ids[0])['title'],'New tag title')
        self.assertEqual(self.library.track(self.ids[0])['artist'],'New artist')

    def test_playlist_create_rename_contents_delete_and_import_are_reversible(self):
        created=self.library.action('playlist',{'name':'Mix'});key=created['id']
        contents=self.library.action('playlistTracks',{'id':key,'tracks':list(reversed(self.ids))})
        renamed=self.library.action('playlist',{'id':key,'name':'Later'})
        with self.assertRaises(ValueError):self.undo(contents)
        deleted=self.library.action('deletePlaylist',{'id':key});self.undo(deleted)
        self.undo(renamed);self.undo(contents)
        self.assertEqual(self.library.state()['playlists'][0]['tracks'],[])
        self.undo(created);self.assertEqual(self.library.state()['playlists'],[])
        imported=self.library.action('import',{'name':'M3U','content':'First.mp3\nSecond.mp3'})
        self.assertEqual(imported['matched'],2);self.undo(imported);self.assertEqual(self.library.state()['playlists'],[])

    def test_missing_track_prevents_partial_playlist_restore(self):
        created=self.library.action('playlist',{'name':'Mix'});key=created['id']
        self.library.action('playlistTracks',{'id':key,'tracks':self.ids})
        deleted=self.library.action('deletePlaylist',{'id':key})
        (self.root/'First.mp3').unlink();self.library.scan()
        with self.assertRaisesRegex(ValueError,'deleted tracks'):self.undo(deleted)
        self.assertEqual(self.library.state()['playlists'],[])

    def test_move_and_undo_keep_track_identity_playlist_and_listening_references(self):
        key=self.library.action('playlist',{'name':'Mix'})['id']
        self.library.action('playlistTracks',{'id':key,'tracks':self.ids})
        self.library.action('listen',dict(id='listen',trackId=self.ids[0],deviceId='pc',seq=1,listened=31,position=31,duration=100))
        a=self.library.action('move',{'folder':'Target','tracks':self.ids})
        self.assertTrue((self.root/'Target'/'First.mp3').exists())
        self.undo(a)
        self.assertTrue((self.root/'First.mp3').exists());self.assertTrue((self.root/'Second.mp3').exists())
        self.assertEqual(self.library.state()['playlists'][0]['tracks'],self.ids)
        self.assertEqual([t['id'] for t in self.library.state()['tracks']],self.ids)
        self.assertEqual(self.library.listening.history()['items'][0]['trackId'],self.ids[0])

    def test_undo_chain_of_moves_uses_stable_file_identity(self):
        self.library.action('folder',{'path':'Another'})
        a=self.library.action('move',{'folder':'Target','tracks':[self.ids[0]]})
        b=self.library.action('move',{'folder':'Another','tracks':[self.ids[0]]})
        with self.assertRaises(ValueError):self.undo(a)
        self.undo(b);self.undo(a)
        self.assertEqual(self.library.track(self.ids[0])['path'],'First.mp3')

    def test_undo_collision_preflights_entire_batch_without_overwriting(self):
        result=self.library.action('move',{'folder':'Target','tracks':self.ids})
        (self.root/'Second.mp3').write_bytes(b'new unrelated file')
        with self.assertRaisesRegex(ValueError,'Path is already occupied'):self.undo(result)
        self.assertTrue((self.root/'Target'/'First.mp3').exists())
        self.assertEqual((self.root/'Second.mp3').read_bytes(),b'new unrelated file')
        self.assertEqual(self.library.operations.page()['items'][0]['state'],'done')

    def test_changed_file_or_missing_original_directory_blocks_undo(self):
        result=self.library.action('move',{'folder':'Target','tracks':[self.ids[0]]})
        (self.root/'Target'/'First.mp3').write_bytes(b'new changed content longer')
        with self.assertRaisesRegex(ValueError,'File changed'):self.undo(result)

    def test_late_destination_collision_is_not_overwritten(self):
        original=move_no_replace
        def collide(source,target):
            target.write_bytes(b'external race')
            original(source,target)
        with patch('operations.move_no_replace',side_effect=collide):
            with self.assertRaises(ValueError):self.library.action('move',{'folder':'Target','tracks':[self.ids[0]]})
        self.assertEqual((self.root/'Target'/'First.mp3').read_bytes(),b'external race')
        self.assertEqual((self.root/'First.mp3').read_bytes(),b'first audio')
        self.assertEqual(self.library.track(self.ids[0])['path'],'First.mp3')

    def test_second_file_failure_rolls_back_first_file_and_catalog(self):
        original=move_no_replace;calls=0
        def fail_second(source,target):
            nonlocal calls
            calls+=1
            if calls==2:raise PermissionError('locked second file')
            original(source,target)
        with patch('operations.move_no_replace',side_effect=fail_second):
            with self.assertRaises(ValueError):self.library.action('move',{'folder':'Target','tracks':self.ids})
        self.assertTrue((self.root/'First.mp3').exists());self.assertTrue((self.root/'Second.mp3').exists())
        self.assertFalse((self.root/'Target'/'First.mp3').exists())
        self.assertEqual(self.library.operations.page()['items'][0]['state'],'failed')

    def test_failed_rollback_is_recoverable_and_blocks_index_until_resolved(self):
        original=move_no_replace;calls=0
        def fail(source,target):
            nonlocal calls
            calls+=1
            if calls>1:raise PermissionError('locked')
            original(source,target)
        with patch('operations.move_no_replace',side_effect=fail):
            with self.assertRaises(ValueError):self.library.action('move',{'folder':'Target','tracks':self.ids})
        item=self.library.operations.page()['items'][0]
        self.assertEqual(item['state'],'recovery')
        with self.assertRaises(ValueError):self.library.scan()
        self.library.action('operation-recover',{'id':item['id']})
        self.assertTrue((self.root/'First.mp3').exists());self.library.scan()
        self.assertEqual([t['id'] for t in self.library.state()['tracks']],self.ids)

    def interrupted(self, undo=False):
        if undo:
            result=self.library.action('move',{'folder':'Target','tracks':self.ids});key=result['operationId']
            with self.library.connect() as db:
                db.execute("UPDATE operations SET state='undoing',phase='undo' WHERE id=?",(key,))
            move_no_replace(self.root/'Target'/'First.mp3',self.root/'First.mp3')
        else:
            before=[dict(id=key,path=self.library.track(key)['path'],fingerprint=fingerprint(self.root/self.library.track(key)['path'])) for key in self.ids]
            after=[{**r,'path':'Target/'+r['path']} for r in before]
            with self.library.connect() as db:key=self.library.operations.record(db,'move','','interrupted',before,after,'pending')
            move_no_replace(self.root/'First.mp3',self.root/'Target'/'First.mp3')
        restored=Library(self.root,self.filename,ffprobe=False,ffmpeg=False)
        return restored,key

    def test_restart_preserves_pending_move_ids_and_recovery_restores_paths(self):
        restored,key=self.interrupted()
        try:
            self.assertTrue(restored.state()['operationRecovery'])
            self.assertEqual([t['id'] for t in restored.state()['tracks']],self.ids)
            restored.action('operation-recover',{'id':key})
            self.assertTrue((self.root/'First.mp3').exists());self.assertFalse(restored.state()['operationRecovery'])
            restored.scan();self.assertEqual([t['id'] for t in restored.state()['tracks']],self.ids)
        finally:restored.close()

    def test_interrupted_undo_restores_pre_attempt_state_and_can_be_retried(self):
        restored,key=self.interrupted(undo=True)
        try:
            restored.action('operation-recover',{'id':key})
            self.assertTrue((self.root/'Target'/'First.mp3').exists())
            restored.action('undo',{'id':key})
            self.assertTrue((self.root/'First.mp3').exists())
        finally:restored.close()

    def test_ambiguous_recovery_never_overwrites_existing_source(self):
        restored,key=self.interrupted()
        try:
            (self.root/'First.mp3').write_bytes(b'other file')
            with self.assertRaisesRegex(ValueError,'Ambiguous'):restored.action('operation-recover',{'id':key})
            self.assertEqual((self.root/'First.mp3').read_bytes(),b'other file')
            self.assertTrue(restored.state()['operationRecovery'])
        finally:restored.close()

    def test_history_survives_restart_and_noop_is_not_journaled(self):
        result=self.library.action('metadata',{'id':self.ids[0],'title':'Manual'})
        noop=self.library.action('metadata',{'id':self.ids[0],'title':'Manual'})
        self.assertIsNone(noop['operationId'])
        restored=Library(self.root,self.filename,ffprobe=False,ffmpeg=False)
        try:restored.action('undo',{'id':result['operationId']});self.assertEqual(restored.track(self.ids[0])['title'],'First')
        finally:restored.close()

    def test_missing_original_folder_blocks_undo_without_touching_file(self):
        (self.root/'Original').mkdir();(self.root/'Original'/'Nested.mp3').write_bytes(b'nested')
        self.library.scan();track=next(t for t in self.library.state()['tracks'] if t['path']=='Original/Nested.mp3')
        result=self.library.action('move',{'folder':'Target','tracks':[track['id']]})
        (self.root/'Original').rmdir()
        with self.assertRaisesRegex(ValueError,'Destination folder is missing'):self.undo(result)
        self.assertTrue((self.root/'Target'/'Nested.mp3').exists())

    def test_sql_failure_rolls_back_file_moves_and_retains_failed_record(self):
        from contextlib import contextmanager
        original_connect=self.library.connect
        failed=False
        class Proxy:
            def __init__(proxy,db):proxy.db=db
            def __getattr__(proxy,name):return getattr(proxy.db,name)
            def execute(proxy,sql,*args):
                nonlocal failed
                if sql.startswith('UPDATE tracks SET path=') and not failed:
                    failed=True;raise sqlite3.OperationalError('injected write failure')
                return proxy.db.execute(sql,*args)
        @contextmanager
        def broken():
            with original_connect() as db:yield Proxy(db)
        with patch.object(self.library,'connect',broken):
            with self.assertRaisesRegex(ValueError,'injected write failure'):self.library.action('move',{'folder':'Target','tracks':self.ids})
        self.assertTrue((self.root/'First.mp3').exists())
        self.assertFalse((self.root/'Target'/'First.mp3').exists())
        self.assertEqual(self.library.operations.page()['items'][0]['state'],'failed')

    def test_history_retention_and_pages_do_not_discard_recovery_records(self):
        import time
        with self.library.connect() as db:
            for i in range(505):self.library.operations.record(db,'metadata',self.ids[0],str(i),{}, {'title':str(i)})
            self.assertEqual(db.execute('SELECT COUNT(*) FROM operations').fetchone()[0],500)
            row=db.execute('SELECT id FROM operations ORDER BY created LIMIT 1').fetchone()[0]
            db.execute("UPDATE operations SET state='recovery',created=? WHERE id=?",(time.time()-40*86400,row))
            db.execute("UPDATE operations SET created=? WHERE state='done'",(time.time()-40*86400,))
        page=self.library.operations.page()
        self.assertEqual((page['total'],page['recovery']),(1,True))
        with self.assertRaises(ValueError):self.library.operations.page(-1)

    def test_v2_migration_preserves_catalog_and_creates_backup(self):
        self.library.action('metadata',{'id':self.ids[0],'title':'Manual'})
        with self.library.connect() as db:db.execute('DROP TABLE operations');db.execute('PRAGMA user_version=2')
        restored=Library(self.root,self.filename,ffprobe=False,ffmpeg=False)
        try:
            self.assertEqual(restored.state()['schemaVersion'],3)
            self.assertEqual(restored.track(self.ids[0])['title'],'Manual')
            backup=sqlite3.connect(str(self.filename)+'.pre-v3.bak')
            try:self.assertEqual(backup.execute('PRAGMA user_version').fetchone()[0],2)
            finally:backup.close()
        finally:restored.close()


if __name__=='__main__':unittest.main()
