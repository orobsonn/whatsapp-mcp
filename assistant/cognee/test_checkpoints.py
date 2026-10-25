"""Snapshot protocol with a named backend double; real DB recovery is separate."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from server import Service, encoded, digest, VERSION
from test_server import source


class Backend:
    def __init__(self): self.items = []; self.closed = False
    async def initialize(self): self.closed = False
    async def ingest(self, item):
        self.items.append(item); return {'chunks': 1, 'relations': 0}
    async def snapshot(self):
        return ([{'chunkId': str(i), 'ref': {key: item[key] for key in ('id', 'version', 'hash')}} for i, item in enumerate(self.items)], {}, 1, 0)
    async def close(self): self.closed = True
    async def verify_vectors(self, chunks): pass


class Checkpoints(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.backend = Backend()
        os.environ['ASSISTANT_CONFIGURATION_HASH'] = 'c' * 64
        self.service = Service(Path(self.directory.name), 'synthetic-install', 'g1', self.backend)
        await self.service.initialize(); self.item = source()
        await self.service.call('/ingest', {'operationId': 'ingest-one', 'source': self.item})
        self.manifest = {'indexEpoch': 'epoch-1', 'indexRevision': 'd' * 64,
            'identity': {**self.service.namespace, 'imageRef': 'pinned-image', 'buildFingerprint': self.service.build_fingerprint,
                         'configurationHash': 'c' * 64, 'engineVersion': VERSION},
            'sources': [{key: self.item[key] for key in ('id', 'version', 'hash')} | {'revision': 1}]}
    async def asyncTearDown(self): self.directory.cleanup()
    async def test_quiesce_closes_before_sealing_and_rejects_later_mutation(self):
        proof = await self.service.call('/quiesce', {'manifest': self.manifest})
        self.assertTrue(self.backend.closed); self.assertFalse(self.service.health()['ready'])
        self.assertTrue(proof['closed']); self.assertEqual(proof['manifestHash'], digest(encoded(self.manifest)))
        self.assertEqual(proof['sources'][0]['originalHash'], self.item['hash'])
        with self.assertRaisesRegex(ValueError, 'not_ready'):
            await self.service.call('/search', {'operationId': 'query', 'query': 'Who?', 'allowedSources': [], 'limit': 1})
    async def test_restarted_process_validates_source_and_provenance_without_ingest(self):
        await self.service.call('/quiesce', {'manifest': self.manifest})
        restored_backend = Backend(); restored_backend.items = [self.item]
        restored = Service(Path(self.directory.name), 'synthetic-install', 'g1', restored_backend); await restored.initialize()
        proof = await restored.call('/inspect-index', {})
        self.assertFalse(proof['closed']); self.assertEqual(proof['indexRevision'], self.manifest['indexRevision'])
        self.assertEqual(len(restored_backend.items), 1)
        restored_backend.items = []
        with self.assertRaises(RuntimeError): await restored.call('/inspect-index', {})
    async def test_stale_hash_or_namespace_never_closes_a_healthy_index(self):
        self.manifest['sources'][0]['hash'] = '0' * 64
        with self.assertRaises(ValueError): await self.service.call('/quiesce', {'manifest': self.manifest})
        self.assertFalse(self.backend.closed); self.assertTrue(self.service.health()['ready'])
    async def test_missing_vectors_do_not_produce_a_sealed_checkpoint(self):
        async def missing(_chunks): raise RuntimeError('missing_vectors')
        self.backend.verify_vectors = missing
        with self.assertRaises(RuntimeError): await self.service.call('/quiesce', {'manifest': self.manifest})
        self.assertFalse(self.backend.closed)


if __name__ == '__main__': unittest.main()
