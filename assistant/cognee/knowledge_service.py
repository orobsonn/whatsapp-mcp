"""Private, single-writer HTTP adapter for the native knowledge graph.

No model/provider routes are exposed. Native dependencies are loaded only at
startup, so the transport contract can be tested with stdlib alone.
"""
import argparse
import asyncio
import fcntl
import hmac
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import threading


MAX_BODY = 262144
METHODS = frozenset(('remember', 'status', 'query', 'withdraw', 'get_entity', 'find_entities'))


def fields(value, required=(), optional=()):
    if (not isinstance(value, dict) or not set(required) <= value.keys()
            or value.keys() - set(required) - set(optional)):
        raise ValueError('invalid_request')


def text(value):
    if not isinstance(value, str) or not value.strip() or '\x00' in value:
        raise ValueError('invalid_request')


def source_ref(value):
    fields(value, ('id', 'revision', 'version', 'hash'))
    text(value['id'])
    if any(type(value[key]) is not int or value[key] < 1 for key in ('revision', 'version')):
        raise ValueError('invalid_request')
    if not isinstance(value['hash'], str) or not re.fullmatch('[0-9a-f]{64}', value['hash']):
        raise ValueError('invalid_request')


def validate_input(method, value):
    if method == 'remember':
        fields(value, ('operationId', 'input'))
        text(value['operationId'])
        write = value['input']
        fields(write, ('entities', 'relations', 'origin'))
        if (write['origin'] not in ('owner_report', 'agent_derived')
                or not isinstance(write['entities'], list)
                or not isinstance(write['relations'], list) or not write['relations']):
            raise ValueError('invalid_request')
        for entity in write['entities']:
            fields(entity, ('id', 'kind', 'name'))
            for item in entity.values(): text(item)
        for relation in write['relations']:
            fields(relation, ('subjectId', 'predicate', 'objectId', 'classification', 'evidence'),
                   ('validFrom', 'validUntil'))
            for key in ('subjectId', 'predicate', 'objectId'): text(relation[key])
            if relation['classification'] not in ('reported', 'inferred'):
                raise ValueError('invalid_request')
            for key in ('validFrom', 'validUntil'):
                if key in relation: text(relation[key])
            if not isinstance(relation['evidence'], list) or not relation['evidence']:
                raise ValueError('invalid_request')
            for evidence in relation['evidence']:
                fields(evidence, ('sourceRef',), ('quote',))
                source_ref(evidence['sourceRef'])
                if 'quote' in evidence: text(evidence['quote'])
    elif method in ('status', 'withdraw'):
        fields(value, ('operationId', 'sourceRef') if method == 'withdraw' else ('operationId',))
        text(value['operationId'])
        if method == 'withdraw': source_ref(value['sourceRef'])
    elif method == 'get_entity':
        fields(value, ('id',))
        text(value['id'])
    else:
        allowed = ('entityId', 'predicate', 'classification', 'after', 'limit') if method == 'query' else ('query', 'kind', 'after', 'limit')
        fields(value, optional=allowed)
        for key, item in value.items():
            if key == 'limit':
                if type(item) is not int or not 1 <= item <= 100:
                    raise ValueError('invalid_request')
            elif key == 'after' and item == '':
                continue
            else:
                text(item)
        if 'classification' in value and value['classification'] not in ('reported', 'inferred'):
            raise ValueError('invalid_request')


def load_token(path):
    """Read a private host-owned token, rejecting symlinks and broad permissions."""
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        info = os.fstat(descriptor)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                or info.st_uid != os.geteuid()):
            raise ValueError('invalid_token_file')
        token = os.read(descriptor, 258).removesuffix(b'\n')
        if not re.fullmatch(rb'[A-Za-z0-9_-]{32,256}', token):
            raise ValueError('invalid_token_file')
        return token
    except OSError:
        raise ValueError('invalid_token_file') from None
    finally:
        if descriptor is not None: os.close(descriptor)


def native_backend(root):
    from backend import CogneeBackend
    return CogneeBackend(root)


def native_store(root, namespace, graph, vector):
    from knowledge import NativeKnowledgeStore
    return NativeKnowledgeStore(root, namespace, graph, vector)


class KnowledgeService:
    """Own the root lease, native engines and one persistent asyncio loop.

    All lifecycle and call methods execute on the HTTP serving thread. The HTTP
    server is deliberately serial; native graph clients never cross threads.
    """
    def __init__(self, root, namespace, token, *, backend_factory=native_backend, store_factory=native_store):
        fields(namespace, ('installationId', 'generation'))
        for item in namespace.values(): text(item)
        if not isinstance(token, bytes) or not re.fullmatch(rb'[A-Za-z0-9_-]{32,256}', token):
            raise ValueError('invalid_token_file')
        self.root, self.namespace, self.token = Path(root), dict(namespace), token
        self.backend_factory, self.store_factory = backend_factory, store_factory
        self.ready = False
        self.loop = self.lease = self.backend = self.store = None
        self.backend_started = False
        self.thread_id = None

    def start(self):
        if self.ready: return
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(self.root / 'knowledge-service.lock',
                             os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(descriptor)
            raise RuntimeError('knowledge_service_already_running') from None
        self.lease = descriptor
        self.thread_id = threading.get_ident()
        self.loop = asyncio.new_event_loop()
        try:
            self.backend = self.backend_factory(self.root)
            self.loop.run_until_complete(self._initialize())
            self.ready = True
        except BaseException:
            self.close()
            raise

    async def _initialize(self):
        await self.backend.initialize()
        self.backend_started = True
        self.store = self.store_factory(self.root, self.namespace, self.backend.engine.graph, self.backend.engine.vector)
        await self.store.initialize()

    def call(self, method, value):
        if not self.ready or threading.get_ident() != self.thread_id:
            raise RuntimeError('service_unavailable')
        return self.loop.run_until_complete(self._dispatch(method, value))

    async def _dispatch(self, method, value):
        # Explicit dispatch: no caller-controlled attribute lookup or native API.
        if method == 'remember': return await self.store.remember(value['operationId'], value['input'])
        if method == 'status': return await self.store.status(value['operationId'])
        if method == 'query': return await self.store.query(value)
        if method == 'withdraw': return await self.store.withdraw(value['operationId'], value['sourceRef'])
        if method == 'get_entity': return await self.store.get_entity(value['id'])
        if method == 'find_entities': return await self.store.find_entities(value)
        raise ValueError('invalid_method')

    def close(self):
        self.ready = False
        try:
            if self.loop is not None and self.backend_started:
                self.loop.run_until_complete(self.backend.close())
        finally:
            self.backend_started = False
            if self.loop is not None:
                self.loop.run_until_complete(self.loop.shutdown_asyncgens())
                self.loop.run_until_complete(self.loop.shutdown_default_executor())
                self.loop.close()
                self.loop = None
            if self.lease is not None:
                os.close(self.lease)
                self.lease = None


def json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result: raise ValueError('invalid_request')
        result[key] = value
    return result


def invalid_constant(_):
    raise ValueError('invalid_request')


class KnowledgeHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    server_version = 'KnowledgeService'
    sys_version = ''

    def log_message(self, *_):
        # The stdlib access/error logger includes paths and arbitrary client text.
        pass

    def _authorized(self):
        headers = getattr(self, 'headers', None)
        values = headers.get_all('Authorization', []) if headers else []
        supplied = values[0].encode('utf-8') if len(values) == 1 else b''
        return hmac.compare_digest(supplied, b'Bearer ' + self.server.service.token)

    def _reply(self, status, result=None, *, error=None):
        self.close_connection = True
        value = {'ok': False, 'error': error} if error else {
            'ok': True, 'namespace': self.server.service.namespace, 'result': result}
        try:
            body = json.dumps(value, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')
            if len(body) > MAX_BODY: raise ValueError('response_too_large')
        except (TypeError, ValueError, RecursionError):
            status, body = 503, b'{"ok":false,"error":"response_unavailable"}'
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Connection', 'close')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass  # The persisted operation ID is reconciled by a later status call.

    def send_error(self, code, message=None, explain=None):
        self._reply(405 if self._authorized() else 401,
                    error='method_not_allowed' if self._authorized() else 'unauthorized')

    def _framing(self, *, required):
        if self.headers.get_all('Transfer-Encoding') or self.headers.get_all('Content-Encoding') or self.headers.get_all('Expect'):
            self._reply(400, error='invalid_request')
            return None
        values = self.headers.get_all('Content-Length', [])
        if not values:
            if required: self._reply(411, error='length_required')
            return None if required else 0
        if len(values) != 1 or not re.fullmatch('[0-9]{1,10}', values[0]):
            self._reply(400, error='invalid_request')
            return None
        length = int(values[0])
        if length > MAX_BODY:
            self._reply(413, error='request_too_large')
            return None
        return length

    def do_GET(self):
        if not self._authorized(): return self._reply(401, error='unauthorized')
        length = self._framing(required=False)
        if length is None: return
        if length: return self._reply(400, error='invalid_request')
        if self.path == '/knowledge': return self._reply(405, error='method_not_allowed')
        if self.path != '/health': return self._reply(404, error='not_found')
        self._reply(200 if self.server.service.ready else 503, {'ready': self.server.service.ready})

    def do_POST(self):
        if not self._authorized(): return self._reply(401, error='unauthorized')
        if self.path != '/knowledge': return self._reply(404, error='not_found')
        length = self._framing(required=True)
        if length is None: return
        content_types = self.headers.get_all('Content-Type', [])
        if len(content_types) != 1 or content_types[0].lower() not in ('application/json', 'application/json; charset=utf-8'):
            return self._reply(415, error='unsupported_media_type')
        try:
            body = self.rfile.read(length)
            if len(body) != length: raise ValueError('invalid_request')
            payload = json.loads(body.decode('utf-8'), object_pairs_hook=json_object, parse_constant=invalid_constant)
            fields(payload, ('namespace', 'method', 'input'))
            fields(payload['namespace'], ('installationId', 'generation'))
            for item in payload['namespace'].values(): text(item)
            text(payload['method'])
            if payload['namespace'] != self.server.service.namespace:
                return self._reply(403, error='namespace_mismatch')
            if payload['method'] not in METHODS:
                return self._reply(400, error='invalid_method')
            validate_input(payload['method'], payload['input'])
        except TimeoutError:
            return self._reply(408, error='request_timeout')
        except (ValueError, TypeError, RecursionError):
            return self._reply(400, error='invalid_request')
        try:
            result = self.server.service.call(payload['method'], payload['input'])
        except Exception:
            error = 'operation_uncertain' if payload['method'] in ('remember', 'withdraw') else 'service_unavailable'
            return self._reply(503, error=error)
        self._reply(200, result)


class KnowledgeHTTPServer(HTTPServer):
    """A serial loopback listener; one active request and one native writer."""
    allow_reuse_address = True
    request_queue_size = 16

    def __init__(self, port, service, *, request_timeout=5):
        self.service, self.request_timeout = service, request_timeout
        super().__init__(('127.0.0.1', port), KnowledgeHandler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(self.request_timeout)
        return connection, address

    def handle_error(self, request, client_address):
        # No traceback or source-bearing exception text in stderr.
        pass


def port_number(value):
    number = int(value)
    if not 0 <= number <= 65535: raise argparse.ArgumentTypeError('invalid_port')
    return number


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description='Private native knowledge service (loopback only)')
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--installation-id', required=True)
    parser.add_argument('--generation', required=True, help='Stable knowledge-space generation; never the operational generation')
    parser.add_argument('--token-file', type=Path, required=True)
    parser.add_argument('--port', type=port_number, default=8081)
    return parser.parse_args(argv)


def main(argv=None):
    config = parse_args(argv)
    service = server = None
    stopped = False
    exit_code = 0
    previous_handlers = {}
    def stop(_signum, _frame):
        # Do not interrupt an in-flight graph mutation or asyncio.run_until_complete.
        nonlocal stopped
        stopped = True
    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(signum, stop)
        service = KnowledgeService(config.root,
            {'installationId': config.installation_id, 'generation': config.generation}, load_token(config.token_file))
        service.start()
        server = KnowledgeHTTPServer(config.port, service)
        server.timeout = 0.25
        while not stopped:
            server.handle_request()
    except Exception:
        print('knowledge_service_unavailable', file=sys.stderr)
        exit_code = 1
    finally:
        if server is not None: server.server_close()
        try:
            if service is not None: service.close()
        except Exception:
            print('knowledge_service_close_failed', file=sys.stderr)
            exit_code = 1
        for signum, handler in previous_handlers.items():
            signal.signal(signum, handler)
    return exit_code


if __name__ == '__main__':
    raise SystemExit(main())
