import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
from library import Library
from collection_health import CheckCancelled


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.base=Path(self.temp.name);self.root=self.base/'music';self.root.mkdir()
        for name,content in [('a.mp3',b'same bytes'),('b.flac',b'same bytes'),('c.mp3',b'other data'),('unique.mp3',b'unique longer data')]:
            (self.root/name).write_bytes(content)
        self.library=Library(self.root,self.base/'catalog.sqlite3',ffprobe=False,ffmpeg=False)
        self.health=self.library.health
        with self.library.connect() as db:
            db.execute("UPDATE tracks SET title=' Song ', artist=' Artist ' WHERE path IN ('a.mp3','b.flac','c.mp3')")

    def tearDown(self):
        self.library.close();self.temp.cleanup()

    def run_check(self,mode='quick'):
        self.health.start({'mode':mode});self.health.thread.join(5)
        self.assertFalse(self.health.thread.is_alive())
        report=self.health.report()
        self.assertEqual(report['state'],'done',report.get('error'))
        return report

    def test_quick_distinguishes_missing_empty_and_outdated_without_mutation(self):
        (self.root/'a.mp3').unlink();(self.root/'b.flac').write_bytes(b'');(self.root/'c.mp3').write_bytes(b'changed longer file')
        before=self.library.state()
        report=self.run_check()
        self.assertEqual(report['counts']['missing'],1)
        self.assertEqual({i['code'] for i in self.health.report('problems')['items']},{'empty','index_outdated'})
        self.assertEqual(report['bytesRead'],0)
        self.assertEqual(before,self.library.state())

    def test_same_size_is_not_duplicate_and_title_match_is_separate(self):
        before={p.name:p.read_bytes() for p in self.root.iterdir()}
        report=self.run_check('duplicates')
        exact=self.health.report('exact');similar=self.health.report('similar')
        self.assertEqual(exact['exactGroups'],1)
        self.assertEqual({i['path'] for i in exact['items']},{'a.mp3','b.flac'})
        self.assertEqual(similar['similarGroups'],1)
        self.assertEqual({i['path'] for i in similar['items']},{'a.mp3','b.flac','c.mp3'})
        self.assertEqual(report['hashTotal'],3)
        self.assertEqual(report['bytesRead'],30)
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.root.iterdir()})

    def test_quick_does_not_hash_or_claim_exact_copies(self):
        with patch.object(self.health,'_hash',side_effect=AssertionError('must not hash')):
            report=self.run_check()
        self.assertEqual(report['exactGroups'],0)
        self.assertEqual(report['similarGroups'],1)

    def test_verified_exact_title_group_is_not_repeated_as_possible_match(self):
        with self.library.connect() as db:db.execute("UPDATE tracks SET title='Different' WHERE path='c.mp3'")
        report=self.run_check('duplicates')
        self.assertEqual((report['exactGroups'],report['similarGroups']),(1,0))

    def test_permission_errors_and_non_regular_paths_have_reasons(self):
        (self.root/'b.flac').unlink();(self.root/'b.flac').mkdir()
        original=Path.open
        def denied(path,*args,**kw):
            if path==self.root/'a.mp3':raise PermissionError('access denied')
            return original(path,*args,**kw)
        with patch.object(Path,'open',new=denied):self.run_check()
        self.assertEqual({i['code'] for i in self.health.report('problems')['items']},{'not_file','unreadable'})

    def test_metadata_failures_are_separate_from_file_health_and_missing_tools(self):
        with self.library.connect() as db:
            db.execute("UPDATE tracks SET metadata_error='Broken tags' WHERE path='a.mp3'")
            db.execute("UPDATE tracks SET metadata_error='ffprobe не найден: доступны только данные из имени файла' WHERE path='b.flac'")
        report=self.run_check()
        self.assertEqual(report['counts']['metadata'],1)
        self.assertEqual(report['counts']['problems'],0)

    def test_file_changed_after_hash_cannot_remain_an_exact_match(self):
        original=self.health._hash
        def change(path,expected):
            digest=original(path,expected)
            if path.name=='a.mp3':path.write_bytes(b'different size now')
            return digest
        with patch.object(self.health,'_hash',side_effect=change):report=self.run_check('duplicates')
        self.assertEqual(report['exactGroups'],0)
        self.assertTrue(any(i['code']=='changed' for i in self.health.report('problems')['items']))

    def test_cancellation_and_other_requests_are_available_during_hashing(self):
        entered=threading.Event()
        def waiting(path,expected):
            entered.set();self.health.stop.wait(3);raise CheckCancelled()
        with patch.object(self.health,'_hash',side_effect=waiting):
            report=self.health.start({'mode':'duplicates'})
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.library.status()['tracks'],4)
            self.assertEqual(self.health.report()['state'],'running')
            with self.assertRaises(ValueError):self.health.start({'mode':'quick'})
            self.health.cancel({'jobId':report['jobId']});self.health.thread.join(2)
        self.assertEqual(self.health.report()['state'],'cancelled')

    def test_pages_and_old_report_ids_do_not_mix(self):
        for i in range(105):(self.root/f'empty{i:03}.wav').write_bytes(b'')
        self.library.scan();report=self.run_check()
        page=self.health.report('problems',offset=100,limit=50,job_id=report['jobId'])
        self.assertEqual((page['categoryTotal'],len(page['items'])),(105,5))
        with self.assertRaises(ValueError):self.health.report('problems',offset=-1)
        self.run_check()
        with self.assertRaises(ValueError):self.health.report(job_id=report['jobId'])
        with self.assertRaises(ValueError):self.health.cancel({'jobId':report['jobId']})

    def test_unexpected_worker_error_is_reported_and_next_run_is_possible(self):
        with patch.object(self.health,'_groups',side_effect=RuntimeError('test failure')):
            self.health.start({'mode':'quick'});self.health.thread.join(3)
        self.assertEqual(self.health.report()['state'],'failed')
        self.assertIn('test failure',self.health.report()['error'])
        self.run_check()


if __name__=='__main__':unittest.main()
