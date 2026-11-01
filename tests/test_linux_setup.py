import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import linux_setup as setup


class LinuxSetupTests(unittest.TestCase):
    def test_additional_sources_resolve_from_installation_without_creating_missing_disks(self):
        path = self.root / 'config.json'
        path.write_text(json.dumps(dict(music_dir='Music', music_sources=[
            dict(id='archive', path='External music', name='Archive')])) , encoding='utf-8')
        _, config, _ = self.prepare()
        self.assertEqual(config['music_sources'][0]['path'], str(self.root / 'External music'))
        self.assertFalse((self.root / 'External music').exists())

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name)
        self.root=self.base/'Player with spaces';self.root.mkdir()
        self.cwd=self.base/'Caller';self.cwd.mkdir()

    def tearDown(self):self.temp.cleanup()

    def args(self,*values):return setup.parser().parse_args(['install',*values])

    def prepare(self,*values):return setup.prepare_config(self.args(*values),root=self.root,cwd=self.cwd)

    def test_first_install_creates_directories_and_absolute_config_without_database(self):
        path,config,backup=self.prepare('--music-dir','Music with spaces')
        self.assertEqual(path,self.root/'config.json')
        self.assertEqual(config['music_dir'],str(self.cwd/'Music with spaces'))
        self.assertTrue(Path(config['music_dir']).is_dir())
        self.assertTrue((self.root/'data').is_dir());self.assertFalse(Path(config['database']).exists())
        self.assertEqual((config['host'],config['port']),('127.0.0.1',8080));self.assertIsNone(backup)

    def test_existing_config_is_merged_backed_up_and_idempotent(self):
        path=self.root/'config.json';original=json.dumps(dict(music_dir='./Music',database='./Data/existing.sqlite3',host='0.0.0.0',port=8090,custom={'preserve':True})).encode()
        path.write_bytes(original)
        path,config,backup=self.prepare()
        self.assertEqual(backup.read_bytes(),original)
        self.assertEqual(config['custom'],{'preserve':True})
        self.assertEqual(config['music_dir'],str(self.root/'Music'))
        self.assertEqual(config['database'],str(self.root/'Data'/'existing.sqlite3'))
        self.assertEqual(config['port'],8090)
        before=path.read_bytes();_,_,backup=self.prepare()
        self.assertIsNone(backup);self.assertEqual(path.read_bytes(),before)

    def test_existing_database_and_music_are_never_recreated_or_modified(self):
        music=self.cwd/'Music';music.mkdir();song=music/'Song.mp3';song.write_bytes(b'audio bytes')
        database=self.cwd/'catalog.sqlite3';database.write_bytes(b'existing database')
        self.prepare('--music-dir','Music','--database','catalog.sqlite3')
        self.assertEqual(song.read_bytes(),b'audio bytes');self.assertEqual(database.read_bytes(),b'existing database')

    def test_cli_values_override_preserved_config_fields(self):
        self.prepare('--music-dir','First','--port','8090')
        _,config,_=self.prepare('--music-dir','Second','--host','0.0.0.0','--port','8088','--max-upload-mb','64','--ffprobe','/opt/tools/ffprobe')
        self.assertEqual((config['host'],config['port'],config['max_upload_mb']),('0.0.0.0',8088,64))
        self.assertEqual(config['ffprobe'],'/opt/tools/ffprobe')

    def test_invalid_values_leave_config_and_music_untouched(self):
        path,_,_=self.prepare('--music-dir','Music');original=path.read_bytes()
        for values in [('--port','0'),('--port','65536'),('--max-upload-mb','-1')]:
            with self.subTest(values=values),self.assertRaises(ValueError):self.prepare(*values)
            self.assertEqual(path.read_bytes(),original)
        self.assertEqual(list((self.cwd/'Music').iterdir()),[])

    def test_custom_config_path_and_bom_are_supported(self):
        folder=self.cwd/'Settings';folder.mkdir();path=folder/'my config.json'
        path.write_bytes(b'\xef\xbb\xbf'+json.dumps({'music_dir':'Music'}).encode())
        result,config,backup=self.prepare('--config','Settings/my config.json')
        self.assertEqual(result,path);self.assertIsNotNone(backup)
        self.assertEqual(config['music_dir'],str(self.root/'Music'))

    def test_missing_storage_is_required_on_first_install(self):
        with self.assertRaisesRegex(ValueError,'--music-dir'):self.prepare()
        self.assertFalse((self.root/'config.json').exists())

    def test_interrupted_atomic_write_leaves_original_config_and_no_temporary_file(self):
        path=self.root/'config.json';path.write_text('original',encoding='utf-8')
        with patch.object(Path,'replace',side_effect=PermissionError('locked')):
            with self.assertRaises(PermissionError):setup.atomic_write(path,'replacement')
        self.assertEqual(path.read_text(encoding='utf-8'),'original');self.assertEqual(list(self.root.iterdir()),[path])

    def test_install_only_prepares_and_does_not_launch_server(self):
        config=self.root/'config.json'
        args=['install','--config',str(config),'--music-dir',str(self.cwd/'Music'),'--database',str(self.root/'data'/'library.sqlite3')]
        with patch.object(setup.sys,'platform','linux'),patch.object(setup,'launch') as launch,patch('builtins.print'):
            self.assertEqual(setup.main(args),0)
        launch.assert_not_called();self.assertTrue(config.is_file())
        self.assertFalse((self.root/'data'/'library.sqlite3').exists())

    def test_launcher_passes_arguments_as_values_and_uses_project_directory(self):
        original=Path.cwd();config=self.cwd/'Config $value.json'
        try:
            with patch.object(setup.os,'execv') as execute:
                setup.launch(config,['--music-dir','Music; no shell','--port','8088'],root=self.root)
                argv=execute.call_args.args[1]
                self.assertEqual(argv[1],str(self.root/'server.py'))
                self.assertIn(str(config),argv);self.assertIn('Music; no shell',argv)
                self.assertEqual(Path.cwd(),self.root)
        finally:os.chdir(original)

    def test_runtime_checks_sqlite_support(self):setup.check_python()


if __name__=='__main__':unittest.main()
