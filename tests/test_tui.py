import unittest
from tui import clean, clip, render_status, keyboard_command, send_command
from unittest.mock import patch
import os
import sys
import tui


class TerminalTests(unittest.TestCase):
    def test_interactive_restart_requires_explicit_confirmation_without_any_player(self):
        with patch.object(sys, 'argv', ['tui.py']), patch.object(sys.stdin, 'isatty', return_value=True), \
                patch.object(sys.stdout, 'isatty', return_value=True), patch.dict(os.environ, TERM='xterm'), \
                patch('tui.Terminal') as terminal, patch('tui.fetch_status', return_value={'clients':[]}), \
                patch('tui.render_status', return_value='screen') as render, patch('tui.time.sleep'), \
                patch('builtins.print'), patch('tui.restart_server') as restart:
            terminal.return_value.__enter__.return_value.key.side_effect = ['S', 'n', 'S', 'y', 'q']
            self.assertEqual(tui.main(), 0)
            restart.assert_called_once()
            notices = [call.args[-1] for call in render.call_args_list]
            self.assertTrue(any('restart cancelled' in notice for notice in notices if notice))
            self.assertTrue(any('Press y to confirm' in notice for notice in notices if notice))

    def test_untrusted_names_cannot_inject_terminal_control_sequences(self):
        self.assertEqual(clean('hello\x1b[2J\nworld\x07'), 'hello world ')
        self.assertNotIn('\x1b', clean('\x1b]0;title\x07'))

    def test_narrow_terminal_and_offline_snapshot(self):
        text = render_status(None, 'http://localhost:8080', width=25, height=7, error='offline')
        self.assertLessEqual(len(text.splitlines()), 7)
        self.assertTrue(all(len(line) <= 25 for line in text.splitlines()))
        self.assertIn('offline', text)

    def test_selected_session_playlist_and_error_are_visible(self):
        data = dict(tracks=1, libraryBytes=100, streams=0, uptime=30, bytesSent=10, storage='/music',
            playlists=[dict(name='Evening', tracks=1)], clients=[dict(name='Browser', state='paused',
            connected=True, track=dict(id='a',title='Song',artist='Artist'), playlistName='Evening',
            queueCount=1, age=2, position=10, duration=60, error='HTTP 403', trackId='a',
            queueIndex=0, queueStart=0, queue=[dict(id='a',title='Song')])])
        screen = render_status(data, 'http://localhost:8080', width=100, height=32)
        for value in ['Song', 'Evening', 'HTTP 403', '0:10 / 1:00']:
            self.assertIn(value, screen)

    def test_keyboard_commands_are_explicit_and_bounded(self):
        client=dict(state='paused',position=5,duration=60,volume=.98)
        self.assertEqual(keyboard_command(' ',client),('play',None))
        self.assertEqual(keyboard_command('h',client),('seek',0))
        self.assertEqual(keyboard_command('+',client),('volume',1))
        client['state']='playing'
        self.assertEqual(keyboard_command(' ',client),('pause',None))
        self.assertIsNone(keyboard_command('j',client))

    def test_send_command_addresses_target_and_transfer_source(self):
        with patch('tui.control_request',return_value={'state':'pending'}) as request:
            send_command('http://localhost:8080','phone','transfer',source='pc')
            body=request.call_args.args[2]
            self.assertEqual((body['target'],body['source'],body['action']),('phone','pc','transfer'))
            self.assertTrue(body['id'])

    def test_clip_uses_terminal_width_for_wide_characters(self):
        self.assertEqual(clip('abcd', 3), 'ab~')
        self.assertLessEqual(len(clip('abcdef', 1)), 1)


if __name__ == '__main__':
    unittest.main()
