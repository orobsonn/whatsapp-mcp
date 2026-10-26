"""Native fresh-index reconstruction using exact, source-scoped HTTP receipts.
Run in the pinned image with --network none. Responses are synthetic, never paid.
"""
import asyncio
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from aiohttp import web
from test_real_cognee import generate


def effective(path, payload):
    value = json.loads(json.dumps(payload))
    if path == '/v1/chat/completions':
        value['max_completion_tokens'] = value.pop('max_tokens', value.get('max_completion_tokens', 6000))
        value.pop('stream', None); value.pop('n', None)
    else:
        value.setdefault('dimensions', 1536); value.setdefault('encoding_format', 'float')
    return json.dumps([path, value], sort_keys=True, ensure_ascii=False, separators=(',', ':'))


async def materialize(root, mode, marker):
    from backend import CogneeBackend
    from server import Service, VERSION, encoded, digest
    backend = CogneeBackend(root); service = Service(root, 'synthetic-rebuild', 'g1', backend)
    try:
        await service.initialize()
        corpus = list(enumerate(['Nora leads the synthetic Cedar project.', 'Ivo leads the synthetic Juniper project.']))
        if mode == 'reverse': corpus.reverse()
        if mode == 'subset': corpus = corpus[1:]
        sources = []
        for index, text in corpus:
            if mode == 'divergent' and index == 0: text += ' Corrected source.'
            item = dict(id=f'message:rebuild-{index}', version=1, hash=hashlib.sha256(text.encode()).hexdigest(), text=text, occurredAt=0)
            marker.write_text(json.dumps([item['id'], 1, item['version'], item['hash']]))
            await service.call('/ingest', dict(operationId=f'{mode}-{index}', source=item)); sources.append({key: item[key] for key in ('id', 'version', 'hash')})
        manifest = dict(identity={**service.namespace, 'imageRef': 'pinned-offline', 'buildFingerprint': service.build_fingerprint, 'configurationHash': service.configuration_hash, 'engineVersion': VERSION},
                        indexEpoch=f'epoch-{mode}', indexRevision='d' * 64, sources=[{**source, 'revision': 1} for source in sources])
        proof = await service.call('/verify-index', {'manifest': manifest})
        assert not proof['closed'] and not proof['poisoned'] and proof['pendingOperations'] == 0
        assert proof['manifestHash'] == digest(encoded(manifest)) and len(proof['sources']) == len(sources)
        assert all(source['hash'] == source['originalHash'] and source['chunks'] > 0 for source in proof['sources'])
        print(json.dumps(dict(freshProcess=True, originals=len(sources), physicallyVerified=True)))
    finally:
        await backend.close()


class RealRebuild(unittest.IsolatedAsyncioTestCase):
    async def test_exact_receipts_reverse_order_subset_and_changed_payload(self):
        with tempfile.TemporaryDirectory(prefix='assistant91-') as temporary:
            directory = Path(temporary); marker = directory / 'current-source'; marker.write_text('uninitialized')
            receipts = {}; calls = {}; misses = []; mode = 'record'
            async def stub(request):
                body = await request.json(); payload = effective(request.path, body)
                key = (marker.read_text(), payload); calls[mode] = calls.get(mode, 0) + 1
                if mode != 'record':
                    if key in receipts: return web.json_response(receipts[key])
                    misses.append(dict(mode=mode, payloadSeenElsewhere=any(stored[1] == payload for stored in receipts)))
                    return web.json_response({'error': {'message': 'replay_unavailable'}}, status=409)
                if request.path == '/v1/chat/completions':
                    schema = body.get('response_format', {}).get('json_schema', {}).get('schema')
                    content = generate(schema, schema.get('$defs', {}), json.dumps(body['messages'])) if schema else 'test'
                    result = dict(choices=[dict(message=dict(content=json.dumps(content) if schema else content))], usage=dict(prompt_tokens=1, completion_tokens=1, total_tokens=2))
                else:
                    inputs = body['input']; inputs = [inputs] if isinstance(inputs, str) else inputs
                    result = dict(data=[dict(index=i, embedding=[(hashlib.sha256(text.encode()).digest()[j % 32] + 1) / 256 for j in range(1536)]) for i, text in enumerate(inputs)], usage=dict(prompt_tokens=len(inputs), total_tokens=len(inputs)))
                receipts[key] = result; return web.json_response(result)
            app = web.Application(); app.router.add_post('/v1/chat/completions', stub); app.router.add_post('/v1/embeddings', stub)
            runner = web.AppRunner(app, access_log=None); await runner.setup(); await web.TCPSite(runner, '127.0.0.1', 80).start()
            try:
                for mode in ['record', 'same', 'reverse', 'subset', 'divergent']:
                    root = directory / ('fresh-' + mode); root.mkdir()
                    process = await asyncio.create_subprocess_exec(sys.executable, __file__, 'child', str(root), mode, str(marker), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    output, error = await asyncio.wait_for(process.communicate(), 160)
                    if mode == 'divergent': self.assertNotEqual(process.returncode, 0)
                    else:
                        self.assertEqual(process.returncode, 0, error.decode()[-1500:]); self.assertIn(b'"physicallyVerified": true', output)
                    shutil.rmtree(root)
                self.assertEqual(misses, [dict(mode='divergent', payloadSeenElsewhere=False)])
                self.assertGreater(calls['record'], 0); self.assertEqual(calls['record'], calls['same']); self.assertEqual(calls['same'], calls['reverse'])
                self.assertLess(calls['subset'], calls['same'])
                print(json.dumps(dict(nativeCognee='1.6.5', freshDirectories=5, sourceScoped=True, reverse=True, removedFirstSource=True,
                    calls=calls, replayMisses=len(misses), paidCalls=0, preservedReceipts=len(receipts))))
            finally: await runner.cleanup()


if __name__ == '__main__':
    if len(sys.argv) == 5 and sys.argv[1] == 'child': asyncio.run(materialize(Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4])))
    else: unittest.main()
