"""Restricted derived index. Canonical state, authorization and budget live in the host."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re

VERSION = '1.6.5'
BROKER = 'http://broker.internal/v1'
MAX_BODY = 65536
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
ERROR_CODES = set('invalid_id request_fields source_version source_hash source_size source_time request_size not_found busy immutable_source_conflict source_capacity source_version_order query_size query_limit allowed_sources_limit allowed_sources_duplicate operation_conflict operation_uncertain operation_capacity not_ready allowed_chunk_limit'.split())


def encoded(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
def digest(value): return hashlib.sha256(value).hexdigest()
def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value): raise ValueError('invalid_id')
    return value

def fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= value.keys() or value.keys() - set(required) - set(optional):
        raise ValueError('request_fields')

def validate_ref(value):
    fields(value, ('id', 'version', 'hash'))
    identifier(value['id'])
    if type(value['version']) is not int or not 1 <= value['version'] <= 2147483647: raise ValueError('source_version')
    if not isinstance(value['hash'], str) or not HASH.fullmatch(value['hash']): raise ValueError('source_hash')
    return value

def validate_source(value):
    fields(value, ('id', 'version', 'hash', 'text', 'occurredAt'), ('authorId', 'projectId'))
    validate_ref({key: value[key] for key in ('id', 'version', 'hash')})
    if not isinstance(value['text'], str) or not value['text'] or len(value['text'].encode()) > 32768: raise ValueError('source_size')
    if digest(value['text'].encode()) != value['hash']: raise ValueError('source_hash')
    if type(value['occurredAt']) is not int or not 0 <= value['occurredAt'] <= 9007199254740991: raise ValueError('source_time')
    for key in ('authorId', 'projectId'):
        if value.get(key) is not None: identifier(value[key])
    return json.loads(encoded(value))


def source_key(value): return json.dumps([value['id'], value['version']], separators=(',', ':'))


class Service:
    def __init__(self, root, installation, generation, backend):
        self.root = Path(root); self.root.mkdir(parents=True, exist_ok=True)
        self.namespace = {'installationId': identifier(installation), 'generation': identifier(generation)}
        self.backend = backend; self.lock = asyncio.Lock(); self.ready = False
        build_path = Path(__file__).with_name('build-fingerprint.json')
        self.build_fingerprint = json.loads(build_path.read_text())['buildFingerprint'] if build_path.exists() else digest(b'unbuilt-test')
        self.configuration_hash = os.environ.get('ASSISTANT_CONFIGURATION_HASH', '0' * 64)
        self.closed = False
        self.path = self.root / 'manifest.json'
        self.record = json.loads(self.path.read_text()) if self.path.exists() else {'namespace': self.namespace, 'sources': {}, 'operations': {}, 'ids': {}}
        if self.record['namespace'] != self.namespace: raise ValueError('namespace_conflict')
        for operation in self.record['operations'].values():
            if operation['state'] == 'started': operation['state'] = 'uncertain'
        for item in self.record['sources'].values():
            if item['state'] in ('started', 'uncertain'):
                item['state'] = 'uncertain'; self.record['poisoned'] = True
    def persist(self):
        temporary = self.path.with_suffix('.tmp')
        with temporary.open('wb') as stream:
            stream.write(encoded(self.record)); stream.flush(); os.fsync(stream.fileno())
        temporary.replace(self.path)
        directory = os.open(self.root, os.O_RDONLY)
        try: os.fsync(directory)
        finally: os.close(directory)
    async def initialize(self):
        build_path = Path(__file__).with_name('build-fingerprint.json')
        if build_path.exists():
            build = json.loads(build_path.read_text())
            if digest(encoded(build['files'])) != self.build_fingerprint: raise RuntimeError('build_fingerprint')
            for name, expected in build['files'].items():
                if digest(Path(__file__).with_name(name).read_bytes()) != expected: raise RuntimeError('build_fingerprint')
        await self.backend.initialize(); self.ready = not self.record.get('poisoned', False); self.persist()
    def health(self):
        return {'ready': self.ready, 'poisoned': self.record.get('poisoned', False), 'busy': self.lock.locked(), 'cognee': VERSION, 'namespace': self.namespace, 'mode': 'shadow'}
    async def call(self, path, payload):
        if len(encoded(payload)) > MAX_BODY: raise ValueError('request_size')
        if path == '/quiesce':
            fields(payload, ('manifest',))
            if self.lock.locked(): raise ValueError('busy')
            async with self.lock:
                if not self.ready: raise ValueError('not_ready')
                manifest = json.loads(encoded(payload['manifest']))
                proof = await self.checkpoint_proof(manifest)
                if proof['pendingOperations'] or proof['poisoned']: raise ValueError('operation_uncertain')
                self.ready = False
                try:
                    await self.backend.close(); self.closed = True
                    self.record['checkpoint'] = manifest; self.persist(); os.sync()
                    return {**proof, 'closed': True}
                except BaseException:
                    self.record['poisoned'] = True; self.persist(); raise RuntimeError('operation_failed') from None
        if path == '/inspect-index':
            fields(payload, ())
            if self.lock.locked() or not self.ready: raise ValueError('not_ready')
            if 'checkpoint' not in self.record: raise ValueError('not_ready')
            return await self.checkpoint_proof(self.record['checkpoint'])
        if path == '/operation':
            fields(payload, ('operationId',)); identifier(payload['operationId'])
            key = self.record['ids'].get(payload['operationId'])
            if key is None: return {'state': 'not_found'}
            return self.record['operations'][key]
        if path == '/inspect-source':
            fields(payload, ('id', 'version'))
            validate_ref({**payload, 'hash': '0' * 64})
            item = self.record['sources'].get(source_key(payload))
            if item is not None: validate_source(item['source'])
            return {'state': 'not_found'} if item is None else item
        if path not in ('/ingest', '/search'): raise ValueError('not_found')
        if self.lock.locked(): raise ValueError('busy')
        async with self.lock:
            fields(payload, ('operationId', 'source') if path == '/ingest' else ('operationId', 'query', 'allowedSources', 'limit'))
            operation_id = identifier(payload['operationId'])
            if path == '/ingest':
                source = validate_source(payload['source']); existing = self.record['sources'].get(source_key(source))
                if existing and existing['source'] != source: raise ValueError('immutable_source_conflict')
                if not existing and len(self.record['sources']) >= 128: raise ValueError('source_capacity')
                versions = [item['source']['version'] for item in self.record['sources'].values() if item['source']['id'] == source['id']]
                if not existing and versions and source['version'] <= max(versions): raise ValueError('source_version_order')
            else:
                if not isinstance(payload['query'], str) or not payload['query'].strip() or len(payload['query'].encode()) > 2048: raise ValueError('query_size')
                if type(payload['limit']) is not int or not 1 <= payload['limit'] <= 10: raise ValueError('query_limit')
                allowed = payload['allowedSources']
                if not isinstance(allowed, list) or len(allowed) > 64: raise ValueError('allowed_sources_limit')
                for item in allowed: validate_ref(item)
                if len({source_key(item) for item in allowed}) != len(allowed): raise ValueError('allowed_sources_duplicate')
            request = {key: value for key, value in payload.items() if key != 'operationId'}
            revision = sum(item['state'] == 'completed' for item in self.record['sources'].values()) if path == '/search' else None
            key = digest(encoded({'path': path, 'namespace': self.namespace, 'request': request, 'indexRevision': revision}))
            prior_key = self.record['ids'].get(operation_id)
            if prior_key is not None and prior_key != key: raise ValueError('operation_conflict')
            prior = self.record['operations'].get(key)
            if prior:
                if prior['state'] != 'completed': raise ValueError('operation_uncertain')
                if len(self.record['ids']) >= 256 and operation_id not in self.record['ids']: raise ValueError('operation_capacity')
                self.record['ids'][operation_id] = key; self.persist(); return prior['result']
            if not self.ready: raise ValueError('not_ready')
            if len(self.record['ids']) >= 256: raise ValueError('operation_capacity')
            self.record['ids'][operation_id] = key
            operation = self.record['operations'][key] = {'state': 'started', 'payloadHash': key}
            if path == '/ingest': self.record['sources'][source_key(source)] = {'state': 'started', 'source': source}
            if path == '/ingest': self.record.pop('checkpoint', None)
            self.persist()
            try:
                if path == '/ingest':
                    stats = await asyncio.wait_for(self.backend.ingest(source), 240)
                    result = {**{name: source[name] for name in ('id', 'version', 'hash')}, 'state': 'completed', **stats}
                    self.record['sources'][source_key(source)]['state'] = 'completed'
                else:
                    missing = [item for item in allowed if not self.indexed(item)]
                    indexed = {'candidates': [], 'missing': []} if missing or not allowed else await asyncio.wait_for(self.backend.search(payload['query'], allowed, payload['limit']), 240)
                    missing += indexed['missing']
                    candidates = [] if missing else indexed['candidates']
                    # Backend output never widens the host's explicit source pack.
                    permitted = {(item['id'], item['version'], item['hash']) for item in allowed}
                    if len(candidates) > payload['limit'] or any((item['id'], item['version'], item['hash']) not in permitted for item in candidates): raise RuntimeError('candidate_scope')
                    result = {'candidates': candidates, 'missing': missing}
                if len(encoded(result)) > MAX_BODY: raise RuntimeError('result_size')
                operation.update(state='completed', result=result); self.persist(); return result
            except BaseException as error:
                operation['state'] = 'uncertain'
                if path == '/ingest':
                    self.record['sources'][source_key(source)]['state'] = 'uncertain'
                    self.record['poisoned'] = True; self.ready = False
                self.persist()
                if isinstance(error, asyncio.CancelledError): raise
                # Provider ValueError text is not one of our input error codes.
                raise RuntimeError('operation_failed') from None
    def indexed(self, item):
        known = self.record['sources'].get(source_key(item))
        return known is not None and known['state'] == 'completed' and known['source']['hash'] == item['hash']
    async def checkpoint_proof(self, manifest):
        fields(manifest, ('identity', 'indexEpoch', 'indexRevision', 'sources'))
        identity = manifest['identity']
        fields(identity, ('installationId', 'generation', 'imageRef', 'buildFingerprint', 'configurationHash', 'engineVersion'))
        expected = {**self.namespace, 'buildFingerprint': self.build_fingerprint,
                    'configurationHash': self.configuration_hash, 'engineVersion': VERSION}
        if any(identity[key] != value for key, value in expected.items()): raise ValueError('invalid_input')
        identifier(manifest['indexEpoch'])
        if manifest['indexRevision'] != 'empty' and not HASH.fullmatch(manifest['indexRevision']): raise ValueError('invalid_input')
        refs = manifest['sources']
        if not isinstance(refs, list) or len(refs) > 128 or len({item.get('id') for item in refs}) != len(refs): raise ValueError('invalid_input')
        chunks = (await self.backend.snapshot())[0]
        if len(chunks) > 4096: raise RuntimeError('checkpoint_capacity')
        await self.backend.verify_vectors(chunks)
        current = self.record['sources']; sources = []
        if len(current) != len(refs): raise ValueError('invalid_input')
        for ref in refs:
            fields(ref, ('id', 'version', 'hash', 'revision')); validate_ref({key: ref[key] for key in ('id', 'version', 'hash')})
            if type(ref['revision']) is not int or not 1 <= ref['revision'] <= 9007199254740991: raise ValueError('invalid_input')
            stored = current.get(source_key(ref))
            if not stored or stored['state'] != 'completed': raise ValueError('operation_uncertain')
            original = validate_source(stored['source'])
            if original['hash'] != ref['hash']: raise ValueError('source_hash')
            count = sum(item['ref'] == {key: ref[key] for key in ('id', 'version', 'hash')} for item in chunks)
            if not count: raise RuntimeError('source_provenance_missing')
            sources.append({**{key: ref[key] for key in ('id', 'version', 'hash')}, 'originalHash': digest(original['text'].encode()), 'chunks': count})
        return {**expected, 'indexEpoch': manifest['indexEpoch'], 'indexRevision': manifest['indexRevision'],
                'manifestHash': digest(encoded(manifest)), 'sources': sources, 'closed': self.closed,
                'poisoned': self.record.get('poisoned', False), 'pendingOperations': sum(op['state'] != 'completed' for op in self.record['operations'].values())}


def make_app(service):
    from aiohttp import web
    app = web.Application(client_max_size=MAX_BODY)
    async def endpoint(request):
        if request.method == 'GET' and request.path == '/health': return web.json_response(service.health())
        if request.method != 'POST': return web.json_response({'error': 'not_found'}, status=404)
        try:
            result = await service.call(request.path, await request.json())
            return web.json_response({'ok': True, 'result': result})
        except ValueError as error:
            code = str(error)
            if code not in ERROR_CODES: code = 'invalid_input'
            return web.json_response({'ok': False, 'error': code}, status=409 if code in ('busy', 'operation_uncertain', 'operation_conflict', 'immutable_source_conflict') else 400)
        except web.HTTPRequestEntityTooLarge:
            return web.json_response({'ok': False, 'error': 'request_size'}, status=413)
        except Exception:
            return web.json_response({'ok': False, 'error': 'operation_failed'}, status=500)
    app.router.add_route('*', '/{path:.*}', endpoint)
    return app


async def application():
    from backend import CogneeBackend
    root = Path('/data')
    service = Service(root, os.environ['ASSISTANT_INSTALLATION_ID'], os.environ['ASSISTANT_GENERATION'], CogneeBackend(root))
    await service.initialize()
    return make_app(service)


if __name__ == '__main__':
    from aiohttp import web
    web.run_app(application(), host='0.0.0.0', port=8080, access_log=None, print=None)
