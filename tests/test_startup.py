import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import main as launcher
import server


class StartupTests(unittest.TestCase):
    def test_additional_sources_are_passed_to_library_with_primary_cli_override(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'config.json'
            sources = [dict(id='archive', path='Extra music', type='directory')]
            config.write_text(json.dumps(dict(music_sources=sources)), encoding='utf-8')
            library, _ = self.launch(['--config', str(config), '--music-dir', 'Primary'])
            self.assertEqual(library.args[0], 'Primary')
            self.assertEqual(library.kwargs['music_sources'], sources)

    def launch(self, args=()):
        with patch.object(server, 'Library') as library, patch.object(server, 'Server') as http, \
                patch('builtins.print'), patch.object(launcher.os, 'chdir'):
            http.return_value.server_port = 8080
            launcher.main(list(args))
            return library.call_args, http.call_args

    def test_clean_start_uses_requested_defaults(self):
        with patch.object(launcher.Path, 'is_file', return_value=False):
            library, http = self.launch()
        self.assertEqual(library.args[0], '../Music/')
        self.assertEqual(http.args[0], ('0.0.0.0', 8080))

    def test_config_overrides_defaults_and_cli_overrides_config(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'config.json'
            config.write_text(json.dumps(dict(music_dir='Configured Music', host='192.168.1.2', port=8090)), encoding='utf-8')
            library, http = self.launch(['--config', str(config)])
            self.assertEqual(library.args[0], 'Configured Music')
            self.assertEqual(http.args[0], ('192.168.1.2', 8090))
            library, http = self.launch(['--config', str(config), '--music-dir', 'CLI Music', '--port', '9090', '--ip', '0.0.0.0'])
            self.assertEqual(library.args[0], 'CLI Music')
            self.assertEqual(http.args[0], ('0.0.0.0', 9090))

    def test_listen_false_forces_loopback_even_with_explicit_host(self):
        _, http = self.launch(['--listen', 'false', '--host', '0.0.0.0'])
        self.assertEqual(http.args[0], ('127.0.0.1', 8080))

    def test_config_listen_false_and_cli_true_override(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / 'config.json'
            config.write_text(json.dumps(dict(listen=False)), encoding='utf-8')
            _, http = self.launch(['--config', str(config)])
            self.assertEqual(http.args[0][0], '127.0.0.1')
            _, http = self.launch(['--config', str(config), '--listen', 'true'])
            self.assertEqual(http.args[0][0], '0.0.0.0')

    def test_automatic_config_is_loaded(self):
        with patch.object(launcher.Path, 'is_file', return_value=True), \
                patch('builtins.open', unittest.mock.mock_open(read_data='{"port": 9091}')):
            _, http = self.launch()
        self.assertEqual(http.args[0], ('0.0.0.0', 9091))

    def test_invalid_listen_is_rejected_before_library_creation(self):
        with patch.object(server, 'Library') as library, patch('sys.stderr'), self.assertRaises(SystemExit):
            server.main(['--music-dir', 'Unused', '--listen', 'maybe'])
        library.assert_not_called()
