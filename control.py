"""Bounded, ephemeral command delivery to one browser session at a time."""
import copy
import math
import json
import time
import uuid
from listening import identifier


class ControlStore:
    def __init__(self, library):
        self.library = library
        self.commands = {}

    def cleanup(self):
        now = time.time()
        for command in list(self.commands.values()):
            if command['state'] == 'pending' and now > command['expires']:
                self.finish(command, False, 'The device response timed out')
        self.commands = {k: v for k, v in self.commands.items() if now - v['created'] < 300}

    def connected(self, client_id):
        identifier(client_id)
        client = self.library.clients.get(client_id)
        if not client or time.time() - client['lastSeen'] >= 45:
            raise ValueError('Device is offline')
        if client.get('controlVersion') != 1:
            raise ValueError('Refresh the page on the selected device')
        return client

    @staticmethod
    def public(command):
        return {k: command.get(k) for k in ('id', 'target', 'action', 'state', 'error', 'phase')}

    def add(self, key, target, action, value=None, parent=None):
        if len(self.commands) >= 512:
            raise ValueError('Too many commands; try again later')
        command = dict(id=key, target=target, action=action, value=value, parent=parent,
                       created=time.time(), expires=time.time() + (75 if action == 'transfer' else 20),
                       state='pending', error='', phase='')
        self.commands[key] = command
        return command

    def child(self, parent, target, action, value=None):
        self.connected(target)
        command = self.add(uuid.uuid4().hex, target, action, value, parent['id'])
        parent['phase'] = action
        return command

    def send(self, data):
        with self.library.lock:
            self.cleanup()
            key, target = identifier(data.get('id')), identifier(data.get('target'))
            action, value = data.get('action'), data.get('value')
            if action not in {'play', 'pause', 'next', 'previous', 'seek', 'volume', 'transfer'}:
                raise ValueError('Unknown command')
            signature = (target, action, value, data.get('source'))
            old = self.commands.get(key)
            if old:
                if old.get('signature') != signature:
                    raise ValueError('Command ID is already in use')
                return self.public(old)
            self.connected(target)
            if action in {'seek', 'volume'}:
                if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
                    raise ValueError('Invalid command value')
                if not 0 <= value <= (1 if action == 'volume' else 7 * 86400):
                    raise ValueError('Command value out of range')
            if action not in {'seek', 'volume'} and value is not None:
                raise ValueError('This command does not accept a value')
            source = None
            if action == 'transfer':
                source = identifier(data.get('source'))
                if source == target:
                    raise ValueError('Select another device for the transfer')
                self.connected(source)
                transfers = [c for c in self.commands.values() if c['action'] == 'transfer' and c['state'] == 'pending']
                if len(transfers) >= 4 or any({source, target} & {c['source'], c['target']} for c in transfers):
                    raise ValueError('A transfer between these devices is already in progress or the transfer limit has been reached')
                if len(self.commands) > 508:
                    raise ValueError('Too many commands; try again later')
            command = self.add(key, target, action, value)
            command['signature'] = copy.deepcopy(signature)
            if source:
                command['source'] = source
                self.child(command, source, 'export')
            return self.public(command)

    def result(self, data):
        with self.library.lock:
            self.cleanup()
            command = self.commands.get(identifier(data.get('id')))
            if not command:
                raise ValueError('Command not found or expired')
            return self.public(command)

    def poll(self, data):
        with self.library.lock:
            self.cleanup()
            client = identifier(data.get('clientId'))
            for command in self.commands.values():
                if command['target'] == client and command['action'] != 'transfer' and command['state'] == 'pending':
                    return dict(command=copy.deepcopy({k: command[k] for k in ('id', 'action', 'value', 'expires')}))
            return dict(command=None)

    def finish(self, command, ok, error=''):
        command['state'] = 'done' if ok else 'failed'
        command['error'] = str(error)[:500]
        command['value'] = None
        if not ok and command.get('parent'):
            parent = self.commands.get(command['parent'])
            if parent and parent['state'] == 'pending':
                self.finish(parent, False, error)
        if command['action'] == 'transfer' and not ok:
            for child in list(self.commands.values()):
                if child.get('parent') == command['id'] and child['state'] == 'pending':
                    child['state'] = 'failed'
                    child['error'] = command['error']
                    child['value'] = None

    def ack(self, data):
        with self.library.lock:
            self.cleanup()
            command = self.commands.get(identifier(data.get('id')))
            if not command or command['target'] != identifier(data.get('clientId')) or command['action'] == 'transfer':
                raise ValueError('Command is not addressed to this player')
            if command['state'] != 'pending':
                return self.public(command)
            ok = data.get('ok')
            if not isinstance(ok, bool):
                raise ValueError('Expected a command result')
            self.finish(command, ok, data.get('error', ''))
            parent = self.commands.get(command.get('parent'))
            if ok and parent and parent['state'] == 'pending':
                try:
                    if command['action'] == 'export':
                        snapshot = data.get('snapshot')
                        if not isinstance(snapshot, dict) or len(json.dumps(snapshot, ensure_ascii=False).encode()) > 6 * 1024 * 1024:
                            raise ValueError('Invalid queue snapshot')
                        guard = snapshot.get('guard')
                        if (not isinstance(guard, dict) or not isinstance(guard.get('generation'), int)
                                or isinstance(guard.get('generation'), bool) or guard['generation'] < 0):
                            raise ValueError('Invalid source player guard')
                        identifier(guard.get('entryId'))
                        parent['guard'] = copy.deepcopy(guard)
                        self.child(parent, parent['target'], 'import', copy.deepcopy(snapshot))
                    elif command['action'] == 'import':
                        self.child(parent, parent['source'], 'pause', dict(guard=parent.get('guard')))
                    elif command['action'] == 'pause':
                        self.finish(parent, True)
                except (ValueError, TypeError) as error:
                    self.finish(parent, False, str(error))
            return self.public(command)
