import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from control import ControlStore


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.library = SimpleNamespace(lock=threading.RLock(), clients={name:dict(lastSeen=time.time(),controlVersion=1) for name in ('pc','phone','other')})
        self.store = ControlStore(self.library)

    def send(self, action='next', target='pc', key='request', **kw):
        return self.store.send(dict(id=key,target=target,action=action,**kw))

    def poll(self, target):
        return self.store.poll(dict(clientId=target))['command']

    def ack(self, target, command, ok=True, **kw):
        return self.store.ack(dict(clientId=target,id=command['id'],ok=ok,**kw))

    def test_addressing_redelivery_acknowledgement_and_idempotency(self):
        sent = self.send()
        self.assertEqual(sent['state'],'pending')
        self.assertIsNone(self.poll('phone'))
        cmd=self.poll('pc')
        self.assertEqual(self.poll('pc'),cmd)
        with self.assertRaises(ValueError):self.ack('phone',cmd)
        self.assertEqual(self.ack('pc',cmd)['state'],'done')
        self.assertIsNone(self.poll('pc'))
        self.assertEqual(self.send()['state'],'done')
        with self.assertRaises(ValueError):self.send(action='pause')

    def test_offline_and_old_clients_cannot_receive_new_commands(self):
        self.library.clients['pc']['lastSeen']-=50
        with self.assertRaises(ValueError):self.send()
        self.library.clients['phone']['controlVersion']=0
        with self.assertRaises(ValueError):self.send(target='phone')
        with self.assertRaises(ValueError):self.send(target='missing')

    def test_values_are_finite_and_bounded(self):
        for action,value in [('seek',-1),('volume',2),('volume',float('nan')),('seek',True),('play',{'large':'payload'})]:
            with self.subTest(action=action,value=value),self.assertRaises(ValueError):self.send(action=action,value=value)
        self.assertEqual(self.send(action='volume',value=.3)['state'],'pending')

    def test_expired_commands_are_failed_and_not_delivered(self):
        self.send()
        with patch('control.time.time',return_value=time.time()+21):
            self.assertIsNone(self.poll('pc'))
            self.assertEqual(self.store.result({'id':'request'})['state'],'failed')

    def test_transfer_pauses_source_only_after_destination_success(self):
        self.send(action='transfer',target='phone',source='pc')
        export=self.poll('pc');self.assertEqual(export['action'],'export');self.assertIsNone(self.poll('phone'))
        snapshot=dict(queueModel={},guard=dict(generation=4,entryId='entry'),position=32,playing=True)
        self.ack('pc',export,snapshot=snapshot)
        imported=self.poll('phone');self.assertEqual(imported['value'],snapshot)
        self.assertIsNone(self.poll('pc'))
        self.ack('phone',imported)
        pause=self.poll('pc');self.assertEqual(pause['action'],'pause');self.assertEqual(pause['value']['guard'],snapshot['guard'])
        self.assertEqual(self.store.result({'id':'request'})['state'],'pending')
        self.ack('pc',pause)
        self.assertEqual(self.store.result({'id':'request'})['state'],'done')
        self.assertIsNone(self.store.commands[imported['id']]['value'])

    def test_failed_destination_never_sends_pause_to_source(self):
        self.send(action='transfer',target='phone',source='pc')
        self.ack('pc',self.poll('pc'),snapshot={'guard':{'generation':1,'entryId':'entry'}})
        self.ack('phone',self.poll('phone'),ok=False,error='Autoplay blocked')
        self.assertIsNone(self.poll('pc'))
        self.assertEqual(self.store.result({'id':'request'})['error'],'Autoplay blocked')

    def test_transfer_timeout_and_overlap_are_explicit_failures(self):
        self.send(action='transfer',target='phone',source='pc')
        with self.assertRaises(ValueError):self.send(action='transfer',target='other',source='pc',key='second')
        with patch('control.time.time',return_value=time.time()+21):
            self.assertIsNone(self.poll('pc'))
            self.assertEqual(self.store.result({'id':'request'})['state'],'failed')

    def test_replayed_export_ack_cannot_enqueue_duplicate_import(self):
        self.send(action='transfer',target='phone',source='pc')
        export=self.poll('pc')
        self.ack('pc',export,snapshot={'guard':{'generation':1,'entryId':'entry'}})
        self.ack('pc',export,snapshot={'guard':{'generation':1,'entryId':'entry'}})
        self.assertEqual(sum(c['action']=='import' for c in self.store.commands.values()),1)

    def test_export_without_source_guard_cannot_continue_transfer(self):
        self.send(action='transfer',target='phone',source='pc')
        self.ack('pc',self.poll('pc'),snapshot={'guard':None})
        self.assertIsNone(self.poll('phone'))
        self.assertEqual(self.store.result({'id':'request'})['state'],'failed')

    def test_queue_snapshot_can_contain_twenty_thousand_occurrences(self):
        self.send(action='transfer',target='phone',source='pc')
        entries=[{'id':f'entry-{i:030}','trackId':'a'*32} for i in range(20000)]
        snapshot=dict(queueModel=dict(entries=entries,order=[e['id'] for e in entries]),guard={'generation':1,'entryId':'entry'})
        self.ack('pc',self.poll('pc'),snapshot=snapshot)
        self.assertEqual(len(self.poll('phone')['value']['queueModel']['entries']),20000)


if __name__=='__main__':unittest.main()
