"""Real Cognee DB close/filesystem copy/new-process restore; HTTP models synthetic.
Cloudflare snapshot API must still be homologated independently.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from aiohttp import web
from backend import CogneeBackend
from server import Service, VERSION
from test_real_cognee import generate


async def reopened(root):
    backend = CogneeBackend(root); service = Service(root, 'synthetic-install', 'g1', backend); await service.initialize()
    try:
        proof = await service.call('/inspect-index', {})
        assert not proof['closed'] and len(proof['sources']) == 2
        first = sorted(service.record['sources'].values(), key=lambda item: item['source']['id'])[0]['source']
        ref = {key: first[key] for key in ('id', 'version', 'hash')}
        result = await service.call('/search', {'operationId': 'new-query-alias', 'query': 'Who leads Cedar?', 'allowedSources': [ref], 'limit': 1})
        assert result['candidates'][0]['hash'] == first['hash']
        await service.call('/ingest', {'operationId': 'new-ingest-alias', 'source': first})
        print(json.dumps({'restored_originals': len(proof['sources']), 'manifest_hash': proof['manifestHash'], 'fresh_process': True}))
    finally: await backend.close()


class RealCheckpoints(unittest.IsolatedAsyncioTestCase):
    async def test_closed_native_databases_reopen_without_model_replay(self):
        calls = []
        async def stub(request):
            body = await request.json(); calls.append(request.path)
            if request.path == '/v1/chat/completions':
                schema = body.get('response_format', {}).get('json_schema', {}).get('schema')
                content = generate(schema, schema.get('$defs', {}), json.dumps(body['messages'])) if schema else 'test'
                return web.json_response({'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': json.dumps(content) if schema else content}, 'finish_reason': 'stop'}],
                    'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})
            inputs = body['input']; inputs = [inputs] if isinstance(inputs, str) else inputs
            return web.json_response({'data': [{'index': i, 'embedding': [(hashlib.sha256(text.encode()).digest()[j % 32] + 1) / 256 for j in range(1536)]} for i, text in enumerate(inputs)],
                'usage': {'prompt_tokens': len(inputs), 'total_tokens': len(inputs)}})
        app = web.Application(); app.router.add_post('/v1/chat/completions', stub); app.router.add_post('/v1/embeddings', stub)
        runner = web.AppRunner(app, access_log=None); await runner.setup(); await web.TCPSite(runner, '127.0.0.1', 80).start()
        temporary = tempfile.TemporaryDirectory(); root = Path(temporary.name) / 'index'; root.mkdir()
        backend = CogneeBackend(root); service = Service(root, 'synthetic-install', 'g1', backend)
        try:
            os.environ['ASSISTANT_CONFIGURATION_HASH'] = 'c' * 64; service.configuration_hash = 'c' * 64
            await service.initialize(); sources = []
            for index, text in enumerate(['Nora leads the synthetic Cedar project.', 'Ivo leads the synthetic Juniper project.']):
                item = {'id': f'message:synthetic-{index}', 'version': index + 1, 'hash': hashlib.sha256(text.encode()).hexdigest(), 'text': text, 'occurredAt': 0}
                sources.append(item); await service.call('/ingest', {'operationId': f'ingest-{index}', 'source': item})
            ref = {key: sources[0][key] for key in ('id', 'version', 'hash')}
            await service.call('/search', {'operationId': 'query-first', 'query': 'Who leads Cedar?', 'allowedSources': [ref], 'limit': 1})
            manifest = {'identity': {**service.namespace, 'imageRef': 'offline-docker', 'buildFingerprint': service.build_fingerprint, 'configurationHash': service.configuration_hash, 'engineVersion': VERSION},
                'indexEpoch': 'index-one', 'indexRevision': 'd' * 64, 'sources': [{**{key: item[key] for key in ('id', 'version', 'hash')}, 'revision': 1} for item in sources]}
            await service.call('/quiesce', {'manifest': manifest}); before = len(calls)
            snapshot = Path(temporary.name) / 'snapshot'; shutil.copytree(root, snapshot); shutil.rmtree(root); shutil.copytree(snapshot, root)
            process = await asyncio.create_subprocess_exec(sys.executable, __file__, 'restore', str(root), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            output, error = await asyncio.wait_for(process.communicate(), 90)
            self.assertEqual(process.returncode, 0, error.decode()[-2000:]); self.assertIn(b'"fresh_process": true', output)
            self.assertEqual(len(calls), before)
            print(json.dumps({'native_close_restore': True, 'fresh_process': True, 'originals': 2, 'new_model_calls_after_restore': len(calls) - before, 'paid_calls': 0}))
        finally:
            if not service.closed and hasattr(backend, 'engine'): await backend.close()
            await runner.cleanup(); temporary.cleanup()


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'restore': asyncio.run(reopened(Path(sys.argv[2])))
    else: unittest.main()
