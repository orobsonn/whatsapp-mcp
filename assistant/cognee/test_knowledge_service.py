"""Real loopback HTTP contract with an offline store; no native/model imports."""
import asyncio
from contextlib import redirect_stderr
import http.client
import io
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch

import knowledge_service
from knowledge_service import KnowledgeHTTPServer, KnowledgeService, load_token, parse_args


NS = {'installationId': 'synthetic-install', 'generation': 'knowledge-stable-1'}
TOKEN = b'0123456789abcdef0123456789abcdef'
REF = {'id': 'message:one', 'revision': 1, 'version': 1, 'hash': 'a' * 64}
WRITE = {'origin': 'agent_derived', 'entities': [
    {'id': 'person:one', 'kind': 'person', 'name': 'Synthetic'}], 'relations': [
    {'subjectId': 'person:one', 'predicate': 'knows', 'objectId': 'person:one',
     'classification': 'reported', 'evidence': [{'sourceRef': REF, 'quote': 'Synthetic'}]}]}


class OfflineBackend:
    def __init__(self, root):
        self.engine = type('Engine', (), {'graph': object(), 'vector': object()})()
        self.events = []

    async def initialize(self):
        self.events.append(('initialize', id(asyncio.get_running_loop()), threading.get_ident()))

    async def close(self):
        self.events.append(('close', id(asyncio.get_running_loop()), threading.get_ident()))


class OfflineStore:
    def __init__(self, root, namespace, graph, vector):
        self.events = []
        self.receipts = {}

    async def initialize(self):
        self.events.append(('initialize', id(asyncio.get_running_loop()), threading.get_ident()))

    async def remember(self, operationId, input):
        self.events.append(('remember', id(asyncio.get_running_loop()), threading.get_ident()))
        self.receipts[operationId] = {'operationId': operationId, 'state': 'uncertain'}
        if operationId == 'raises':
            raise RuntimeError('private-source-and-provider-key')
        return {**self.receipts[operationId], 'origin': input['origin']}

    async def status(self, operationId):
        return self.receipts.get(operationId, {'operationId': operationId, 'state': 'not_found'})

    async def query(self, input):
        return {'claims': [], 'received': input}

    async def get_entity(self, id):
        return {'id': id, 'kind': 'person', 'name': 'Synthetic'}

    async def find_entities(self, input):
        return {'entities': [], 'received': input}

    async def withdraw(self, operationId, sourceRef):
        return {'operationId': operationId, 'state': 'ready', 'sourceRef': sourceRef}


class HTTPContract(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.started = threading.Event()
        self.stopped = threading.Event()
        self.service = KnowledgeService(self.root, NS, TOKEN,
            backend_factory=OfflineBackend, store_factory=OfflineStore)
        self.server = KnowledgeHTTPServer(0, self.service, request_timeout=0.2)

        def run():
            try:
                self.service.start()
                self.started.set()
                self.server.serve_forever(poll_interval=0.01)
            finally:
                self.service.close()
                self.stopped.set()

        self.thread = threading.Thread(target=run)
        self.thread.start()
        self.assertTrue(self.started.wait(3))
        self.port = self.server.server_port

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()
        self.assertTrue(self.stopped.is_set())
        self.directory.cleanup()

    def request(self, method='POST', path='/knowledge', body=None, token=TOKEN):
        if body is None:
            body = {'namespace': NS, 'method': 'query', 'input': {}}
        data = json.dumps(body).encode() if isinstance(body, dict) else body
        headers = {'Content-Type': 'application/json'}
        if token is not None:
            headers['Authorization'] = 'Bearer ' + token.decode()
        connection = http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)
        try:
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            self.assertEqual(response.getheader('Connection'), 'close')
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def call(self, method, input):
        return self.request(body={'namespace': NS, 'method': method, 'input': input})

    def raw(self, request):
        with socket.create_connection(('127.0.0.1', self.port), timeout=2) as connection:
            connection.sendall(request)
            response = http.client.HTTPResponse(connection)
            response.begin()
            return response.status, json.loads(response.read())

    def test_authentication_precedes_body_read_and_even_health(self):
        self.assertEqual(self.request(token=None, body=b'bad-json'),
                         (401, {'ok': False, 'error': 'unauthorized'}))
        self.assertEqual(self.request(method='GET', path='/health', body=b'', token=b'wrong'),
                         (401, {'ok': False, 'error': 'unauthorized'}))
        # No body is sent: checking authorization after read would time out instead.
        self.assertEqual(self.raw(b'POST /knowledge HTTP/1.1\r\nHost: localhost\r\n'
                                  b'Content-Length: 262145\r\n\r\n'),
                         (401, {'ok': False, 'error': 'unauthorized'}))

    def test_health_is_authenticated_and_does_not_expose_paths_or_secrets(self):
        self.assertEqual(self.request(method='GET', path='/health', body=b''),
            (200, {'ok': True, 'namespace': NS, 'result': {'ready': True}}))
        self.assertEqual(self.server.server_address[0], '127.0.0.1')

    def test_exact_namespace_and_whitelisted_methods(self):
        payload = {'namespace': {**NS, 'generation': 'operational-generation'}, 'method': 'query', 'input': {}}
        self.assertEqual(self.request(body=payload), (403, {'ok': False, 'error': 'namespace_mismatch'}))
        for name in ('__class__', 'close', 'initialize', 'raw_sql', 'ingest'):
            with self.subTest(name=name):
                self.assertEqual(self.call(name, {}), (400, {'ok': False, 'error': 'invalid_method'}))

    def test_all_six_dispatches_preserve_contract(self):
        cases = [
            ('remember', {'operationId': 'remember-one', 'input': WRITE},
             {'operationId': 'remember-one', 'state': 'uncertain', 'origin': 'agent_derived'}),
            ('status', {'operationId': 'remember-one'}, {'operationId': 'remember-one', 'state': 'uncertain'}),
            ('query', {'entityId': 'person:one', 'limit': 3},
             {'claims': [], 'received': {'entityId': 'person:one', 'limit': 3}}),
            ('get_entity', {'id': 'person:one'}, {'id': 'person:one', 'kind': 'person', 'name': 'Synthetic'}),
            ('find_entities', {'query': 'Synthetic', 'limit': 2},
             {'entities': [], 'received': {'query': 'Synthetic', 'limit': 2}}),
            ('withdraw', {'operationId': 'withdraw-one', 'sourceRef': REF},
             {'operationId': 'withdraw-one', 'state': 'ready', 'sourceRef': REF}),
        ]
        for method, input, result in cases:
            with self.subTest(method=method):
                self.assertEqual(self.call(method, input), (200, {'ok': True, 'namespace': NS, 'result': result}))

    def test_json_shapes_are_strict_including_nested_write(self):
        invalid = [b'not-json', b'[]', b'null', b'{"namespace": NaN}',
            b'{"namespace":{},"namespace":{}}',
            {'namespace': NS, 'method': 'query', 'input': {}, 'url': 'https://invalid'},
            {'namespace': {**NS, 'owner': 'other'}, 'method': 'query', 'input': {}}]
        for body in invalid:
            with self.subTest(body=body):
                self.assertEqual(self.request(body=body), (400, {'ok': False, 'error': 'invalid_request'}))
        cases = [('status', {'operationId': 'x', 'sql': 'hidden'}),
            ('status', {'operationId': 4}), ('get_entity', {}), ('query', {'limit': True}),
            ('query', {'classification': 'secret'}), ('find_entities', {'namespace': NS}),
            ('withdraw', {'operationId': 'x', 'sourceRef': {**REF, 'url': 'hidden'}}),
            ('remember', {'operationId': 'x', 'input': {**WRITE, 'owner': 'hidden'}})]
        extra_entity = json.loads(json.dumps(WRITE))
        extra_entity['entities'][0]['configuration'] = 'hidden'
        cases.append(('remember', {'operationId': 'x', 'input': extra_entity}))
        for method, input in cases:
            with self.subTest(method=method, input=input):
                self.assertEqual(self.call(method, input), (400, {'ok': False, 'error': 'invalid_request'}))

    def test_body_bound_framing_and_timeout_close_connection(self):
        prefix = (b'POST /knowledge HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer '
                  + TOKEN + b'\r\nContent-Type: application/json\r\n')
        cases = [(b'Content-Length: 262145\r\n', 413, 'request_too_large'),
            (b'Content-Length: 1\r\nContent-Length: 1\r\n', 400, 'invalid_request'),
            (b'Transfer-Encoding: chunked\r\n', 400, 'invalid_request'),
            (b'Content-Length: -1\r\n', 400, 'invalid_request'),
            (b'Content-Length: 1, 1\r\n', 400, 'invalid_request'),
            (b'', 411, 'length_required'),
            (b'Content-Length: 2\r\n', 408, 'request_timeout')]
        for header, status, error in cases:
            with self.subTest(header=header):
                self.assertEqual(self.raw(prefix + header + b'\r\n'),
                                 (status, {'ok': False, 'error': error}))
        # Exactly the technical per-call ceiling remains valid JSON.
        data = json.dumps({'namespace': NS, 'method': 'query', 'input': {}}).encode()
        self.assertEqual(self.request(body=data + b' ' * (262144 - len(data)))[0], 200)

    def test_unknown_routes_and_verbs_are_not_admin_access(self):
        for method, path, status in [('POST', '/quiesce', 404), ('GET', '/knowledge', 405),
                                     ('PUT', '/knowledge', 405), ('BOGUS', '/', 405)]:
            with self.subTest(method=method, path=path):
                result = self.request(method=method, path=path, body=b'')
                self.assertEqual(result[0], status)
                self.assertFalse(result[1]['ok'])

    def test_backend_failure_does_not_expose_exception_or_retry_mutation(self):
        self.assertEqual(self.call('remember', {'operationId': 'raises', 'input': WRITE}),
                         (503, {'ok': False, 'error': 'operation_uncertain'}))
        self.assertEqual(self.call('status', {'operationId': 'raises'}),
            (200, {'ok': True, 'namespace': NS, 'result': {'operationId': 'raises', 'state': 'uncertain'}}))

    def test_single_writer_root_lock_and_persistent_event_loop_lifecycle(self):
        competing = KnowledgeService(self.root, NS, TOKEN,
            backend_factory=OfflineBackend, store_factory=OfflineStore)
        with self.assertRaisesRegex(RuntimeError, 'knowledge_service_already_running'):
            competing.start()
        self.call('remember', {'operationId': 'lifecycle', 'input': WRITE})
        backend = self.service.backend
        events = backend.events + self.service.store.events
        self.assertEqual(len({event[1] for event in events}), 1)
        self.assertEqual(len({event[2] for event in events}), 1)
        self.server.shutdown()
        self.thread.join(3)
        self.assertEqual(backend.events[-1][0], 'close')
        self.assertEqual(backend.events[0][1:], backend.events[-1][1:])
        competing.start()
        competing.close()


class Configuration(unittest.TestCase):
    def test_sigterm_finishes_native_work_then_flushes_and_closes(self):
        events, handlers = [], {}

        class Backend(OfflineBackend):
            async def close(self):
                events.append('backend_closed')
                await super().close()

        class Store(OfflineStore):
            async def remember(self, operationId, input):
                events.append('remember_started')
                handlers[knowledge_service.signal.SIGTERM](None, None)
                await asyncio.sleep(0)
                events.append('remember_finished')
                return {'operationId': operationId, 'state': 'ready'}

        class Server:
            def __init__(self, port, service): self.service = service
            def handle_request(self): self.service.call('remember', {'operationId': 'stop', 'input': WRITE})
            def serve_forever(self, **_): self.handle_request()
            def server_close(self): pass

        real_service = KnowledgeService
        def create_service(root, namespace, token):
            return real_service(root, namespace, token, backend_factory=Backend, store_factory=Store)
        def register(signum, handler):
            previous = handlers.get(signum)
            handlers[signum] = handler
            return previous

        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / 'token'
            token.write_bytes(TOKEN)
            token.chmod(0o600)
            with patch.object(knowledge_service, 'KnowledgeService', side_effect=create_service), \
                 patch.object(knowledge_service, 'KnowledgeHTTPServer', Server), \
                 patch.object(knowledge_service.signal, 'signal', side_effect=register):
                self.assertEqual(knowledge_service.main(['--root', directory, '--installation-id', 'install',
                    '--generation', 'knowledge-stable', '--token-file', str(token)]), 0)
        self.assertEqual(events, ['remember_started', 'remember_finished', 'backend_closed'])

    def test_startup_failure_closes_native_backend_and_releases_root_lease(self):
        class BrokenStore(OfflineStore):
            async def initialize(self): raise RuntimeError('synthetic_startup_failure')

        with tempfile.TemporaryDirectory() as directory:
            service = KnowledgeService(Path(directory), NS, TOKEN,
                backend_factory=OfflineBackend, store_factory=BrokenStore)
            with self.assertRaisesRegex(RuntimeError, 'synthetic_startup_failure'): service.start()
            self.assertEqual(service.backend.events[-1][0], 'close')
            replacement = KnowledgeService(Path(directory), NS, TOKEN,
                backend_factory=OfflineBackend, store_factory=OfflineStore)
            replacement.start()
            replacement.close()

    def test_explicit_token_file_requires_private_regular_owned_file(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / 'service-token'
            token_file.write_bytes(TOKEN + b'\n')
            token_file.chmod(0o600)
            self.assertEqual(load_token(token_file), TOKEN)
            token_file.chmod(0o644)
            with self.assertRaises(ValueError): load_token(token_file)
            token_file.chmod(0o600)
            link = Path(directory) / 'link'
            link.symlink_to(token_file)
            with self.assertRaises(ValueError): load_token(link)
            token_file.write_bytes(b'short')
            with self.assertRaises(ValueError): load_token(token_file)

    def test_cli_pins_namespace_and_loopback_without_provider_configuration(self):
        config = parse_args(['--root', '/tmp/synthetic', '--installation-id', 'install',
            '--generation', 'knowledge-stable', '--token-file', '/tmp/token'])
        self.assertEqual(config.port, 8081)
        self.assertEqual(config.generation, 'knowledge-stable')
        with self.assertRaises(SystemExit):
            with redirect_stderr(io.StringIO()):
                parse_args(['--root', '/tmp/synthetic', '--installation-id', 'install',
                    '--generation', 'knowledge-stable', '--token-file', '/tmp/token', '--port', '-1'])


if __name__ == '__main__':
    unittest.main()
