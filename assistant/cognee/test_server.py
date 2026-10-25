"""Synthetic contract tests; backend double is explicit, not Cognee proof."""
import asyncio
import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from server import Service, validate_source
from backend import CogneeBackend


def source(**changes):
    text = 'Nora leads the synthetic Cedar project.'
    return dict(id='message:opaque-483', version=47, text=text,
                hash=hashlib.sha256(text.encode()).hexdigest(), occurredAt=0, **changes)


class Backend:
    def __init__(self): self.ingestions = 0; self.fail = False
    async def initialize(self): pass
    async def ingest(self, item):
        self.ingestions += 1
        if self.fail: raise RuntimeError('DO-NOT-ECHO-provider-secret')
        return {'chunks': 1, 'relations': 1}
    async def search(self, query, allowed, limit):
        return {'candidates': [{'id': item['id'], 'version': item['version'], 'hash': item['hash'], 'via': ['chunks', 'graph']} for item in allowed][:limit], 'missing': []}


class Contract(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.backend = Backend()
        self.service = Service(Path(self.directory.name), 'synthetic-install', 'generation-9', self.backend)
        await self.service.initialize()
    async def asyncTearDown(self): self.directory.cleanup()
    async def ingest(self, operation='operation-1', item=None):
        return await self.service.call('/ingest', {'operationId': operation, 'source': item or source()})
    async def test_real_ids_versions_and_original(self):
        await self.ingest()
        result = await self.service.call('/inspect-source', {'id': source()['id'], 'version': 47})
        self.assertEqual(result['source'], source())
        self.assertEqual(result['state'], 'completed')
    async def test_conflict_and_no_operation_id_budget_bypass(self):
        await self.ingest()
        await self.ingest('different-job-id')
        self.assertEqual(self.backend.ingestions, 1)
        changed = source(); changed['text'] = 'Changed'; changed['hash'] = hashlib.sha256(b'Changed').hexdigest()
        with self.assertRaisesRegex(ValueError, 'immutable_source_conflict'): await self.ingest('other', changed)
    async def test_uncertain_is_never_replayed(self):
        self.backend.fail = True
        with self.assertRaises(RuntimeError): await self.ingest()
        self.assertEqual((await self.service.call('/operation', {'operationId': 'operation-1'}))['state'], 'uncertain')
        with self.assertRaisesRegex(ValueError, 'operation_uncertain'): await self.ingest('other-job')
        self.assertEqual(self.backend.ingestions, 1)
        self.assertEqual(self.service.health()['poisoned'], True)
        with self.assertRaisesRegex(ValueError, 'not_ready'):
            await self.service.call('/search', {'operationId': 'after-failure', 'query': 'Who?', 'allowedSources': [], 'limit': 1})
        restarted = Service(Path(self.directory.name), 'synthetic-install', 'generation-9', Backend())
        await restarted.initialize()
        self.assertFalse(restarted.health()['ready'])
        self.assertEqual((await restarted.call('/operation', {'operationId': 'operation-1'}))['state'], 'uncertain')
    async def test_search_requires_exact_completed_hash(self):
        await self.ingest()
        item = source(); allowed = [{k: item[k] for k in ('id', 'version', 'hash')}]
        result = await self.service.call('/search', {'operationId': 'query-1', 'query': 'Who leads Cedar?', 'allowedSources': allowed, 'limit': 10})
        self.assertEqual(result['candidates'][0]['hash'], item['hash'])
        allowed[0]['hash'] = '0' * 64
        result = await self.service.call('/search', {'operationId': 'query-2', 'query': 'Who?', 'allowedSources': allowed, 'limit': 10})
        self.assertEqual(result['candidates'], [])
        self.assertEqual(len(result['missing']), 1)
    async def test_input_is_strict_and_bounded(self):
        for field, value in [('id', '../path'), ('version', True), ('hash', '0' * 64), ('text', 'x' * 32769), ('url', 'https://invalid.test')]:
            item = source(); item[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): validate_source(item)
        with self.assertRaisesRegex(ValueError, 'request_fields'):
            await self.service.call('/ingest', {'operationId': 'op', 'source': source(), 'sql': 'SELECT 1'})
    async def test_operation_conflict_and_namespace_fixed(self):
        await self.ingest()
        with self.assertRaisesRegex(ValueError, 'operation_conflict'):
            await self.service.call('/search', {'operationId': 'operation-1', 'query': 'Who?', 'allowedSources': [], 'limit': 1})
        self.assertEqual(self.service.health()['namespace'], {'installationId': 'synthetic-install', 'generation': 'generation-9'})
    async def test_missing_search_is_invalidated_after_index_advances(self):
        item = source(); ref = {key: item[key] for key in ('id', 'version', 'hash')}
        query = {'operationId': 'before', 'query': 'Cedar', 'allowedSources': [ref], 'limit': 1}
        self.assertEqual((await self.service.call('/search', query))['candidates'], [])
        await self.ingest()
        query['operationId'] = 'after'
        self.assertEqual(len((await self.service.call('/search', query))['candidates']), 1)
    async def test_private_relations_are_removed_before_graph_scoring(self):
        allowed = {key: source()[key] for key in ('id', 'version', 'hash')}
        private = {**allowed, 'id': 'private-source'}
        chunks = [{'chunkId': 'allowed-chunk', 'ref': allowed}, {'chunkId': 'private-chunk', 'ref': private}]
        async def embed(_query): return [[1.0]]
        async def score(_collection, ids, _vector):
            self.assertEqual(ids, ['allowed-chunk'])
            return [SimpleNamespace(id='allowed-chunk', score=2.0)]
        backend = CogneeBackend(Path(self.directory.name))
        backend.engine = SimpleNamespace(vector=SimpleNamespace(embedding_engine=SimpleNamespace(embed_text=embed), score_by_ids=score))
        support = {'allowed-edge': [allowed]}
        async def snapshot(): return chunks, support, 2, len(support)
        backend.snapshot = snapshot
        before = await backend.search('query', [allowed], 1)
        support.update({f'private-edge-{i}': [private] for i in range(1000)})
        self.assertEqual(await backend.search('query', [allowed], 1), before)
        self.assertEqual(before['candidates'][0]['relationCount'], 1)
    async def test_busy_rejects_second_pipeline_but_operation_is_visible(self):
        entered = asyncio.Event(); release = asyncio.Event()
        original = self.backend.ingest
        async def blocked(item): entered.set(); await release.wait(); return await original(item)
        self.backend.ingest = blocked
        pending = asyncio.create_task(self.ingest())
        await entered.wait()
        self.assertEqual((await self.service.call('/operation', {'operationId': 'operation-1'}))['state'], 'started')
        with self.assertRaisesRegex(ValueError, 'busy'): await self.ingest('other')
        release.set(); await pending
    async def test_provider_value_error_cannot_become_a_public_error_code(self):
        from aiohttp.test_utils import TestClient, TestServer
        from server import make_app
        async def fail(_source): raise ValueError('private_provider_token')
        self.backend.ingest = fail
        async with TestClient(TestServer(make_app(self.service))) as client:
            result = await client.post('/ingest', json={'operationId': 'failed-source', 'source': source()})
            body = await result.json()
            self.assertNotIn('private_provider_token', str(body))
            self.assertEqual(body, {'ok': False, 'error': 'operation_failed'})
            self.assertFalse(self.service.health()['ready'])


if __name__ == '__main__': unittest.main()
