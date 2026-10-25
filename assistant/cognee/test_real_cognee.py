"""Actual Cognee/Ladybug/LanceDB; HTTP models are deterministic synthetic stubs.
Run only in Docker --network none --add-host broker.internal:127.0.0.1.
This verifies wiring/provenance and restrictions, not semantic model quality.
"""
import asyncio
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
from backend import CogneeBackend
from server import Service, make_app


def generate(schema, definitions, corpus):
    if '$ref' in schema: return generate(definitions[schema['$ref'].split('/')[-1]], definitions, corpus)
    if 'enum' in schema: return schema['enum'][0]
    if 'anyOf' in schema: return generate(next(item for item in schema['anyOf'] if item.get('type') != 'null'), definitions, corpus)
    if schema.get('type') == 'object' or 'properties' in schema:
        properties = schema.get('properties', {})
        if 'nodes' in properties and 'edges' in properties:
            person, project = ('Ivo', 'Juniper') if 'Ivo' in corpus else ('Nora', 'Cedar')
            return {'nodes': [{'id': person, 'name': person, 'type': 'Person', 'description': 'Synthetic lead'},
                              {'id': project, 'name': project, 'type': 'Project', 'description': 'Synthetic project'}],
                    'edges': [{'source_node_id': person, 'target_node_id': project, 'relationship_name': 'leads',
                               'description': f'{person} leads {project}.'}]}
        return {key: generate(value, definitions, corpus) for key, value in properties.items() if key in schema.get('required', [])}
    if schema.get('type') == 'array': return []
    if schema.get('type') == 'boolean': return True
    if schema.get('type') in ('integer', 'number'): return 1
    return 'test'


class RealCognee(unittest.IsolatedAsyncioTestCase):
    async def test_fresh_ingestion_and_restricted_http_contract(self):
        calls = []; broker_error = False
        async def stub(request):
            payload = await request.json()
            calls.append({'path': request.path, 'keys': sorted(payload), 'types': {key: type(value).__name__ for key, value in payload.items()}})
            if broker_error: return web.json_response({'error': {'message': 'DO_NOT_ECHO_synthetic_secret', 'type': 'rejected'}}, status=400)
            if request.path == '/v1/chat/completions':
                schema = payload.get('response_format', {}).get('json_schema', {}).get('schema')
                content = generate(schema, schema.get('$defs', {}), json.dumps(payload['messages'])) if schema else 'test'
                return web.json_response({'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': json.dumps(content) if schema else content}, 'finish_reason': 'stop'}],
                    'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})
            self.assertEqual(request.path, '/v1/embeddings')
            texts = payload['input']; texts = [texts] if isinstance(texts, str) else texts
            self.assertLessEqual(len(texts), 4)
            values = []
            for index, text in enumerate(texts):
                # Private Juniper is deliberately nearest the query; Cedar is far.
                far = ('Nora' in str(text) or 'Cedar' in str(text)) and 'Who leads' not in str(text)
                vector = ([0.0, 1.0] if far else [1.0, 0.0]) + [0.0] * 1534
                values.append({'index': index, 'embedding': vector})
            return web.json_response({'data': values,
                                     'usage': {'prompt_tokens': len(texts), 'total_tokens': len(texts)}})
        broker = web.Application(); broker.router.add_post('/v1/chat/completions', stub); broker.router.add_post('/v1/embeddings', stub)
        runner = web.AppRunner(broker, access_log=None); await runner.setup(); await web.TCPSite(runner, '127.0.0.1', 80).start()
        directory = tempfile.TemporaryDirectory(prefix='assistant-cognee-real-')
        backend = CogneeBackend(Path(directory.name)); service = Service(Path(directory.name), 'synthetic-installation', 'generation-47', backend)
        try:
            await service.initialize()
            client = TestClient(TestServer(make_app(service))); await client.start_server()
            try:
                response = await client.get('/health'); self.assertEqual((await response.json())['mode'], 'shadow')
                corpus = []
                for index, text in enumerate(('Nora leads the synthetic Cedar project.', 'Ivo leads the synthetic Juniper project.')):
                    item = {'id': f'message:synthetic-{index}', 'version': 47 + index, 'hash': hashlib.sha256(text.encode()).hexdigest(), 'text': text, 'occurredAt': 0}
                    corpus.append(item)
                    response = await client.post('/ingest', json={'operationId': f'ingestion-{index}', 'source': item})
                    body = await response.json()
                    self.assertEqual(response.status, 200, body)
                    self.assertGreater(body['result']['chunks'], 0)
                    self.assertGreater(body['result']['relations'], 0)
                count = len(calls)
                await service.call('/ingest', {'operationId': 'another-job-id', 'source': corpus[0]})
                self.assertEqual(len(calls), count)
                baseline = await backend.engine.vector.search('DocumentChunk_text', query_vector=[1.0, 0.0] + [0.0] * 1534,
                                                              limit=1, include_payload=True)
                private_chunks = {item['chunkId'].replace('-', '') for item in (await backend.snapshot())[0] if item['ref']['id'] == corpus[1]['id']}
                self.assertIn(str(baseline[0].id).replace('-', ''), private_chunks)
                ref = {key: corpus[0][key] for key in ('id', 'version', 'hash')}
                response = await client.post('/search', json={'operationId': 'query-1', 'query': 'Who leads Cedar?', 'allowedSources': [ref], 'limit': 1})
                body = await response.json(); self.assertEqual(response.status, 200, body)
                self.assertEqual(body['result']['missing'], [])
                self.assertEqual([{key: item[key] for key in ref} for item in body['result']['candidates']], [ref])
                self.assertIn('graph', body['result']['candidates'][0]['via'])
                response = await client.post('/inspect-source', json={'id': ref['id'], 'version': ref['version']})
                self.assertEqual((await response.json())['result']['source'], corpus[0])
                response = await client.post('/ingest', data='x' * 70000, headers={'Content-Type': 'application/json'})
                self.assertEqual(response.status, 413)
                response = await client.post('/ingest', json={'operationId': 'bad', 'source': {**corpus[0], 'hash': '0' * 64}})
                self.assertEqual(response.status, 400)
                broker_error = True
                response = await client.post('/search', json={'operationId': 'failed-query', 'query': 'Different query', 'allowedSources': [ref], 'limit': 1})
                self.assertEqual(response.status, 500)
                self.assertEqual(await response.json(), {'ok': False, 'error': 'operation_failed'})
                print(json.dumps({'cognee': '1.6.5', 'native_pipeline': True, 'new_originals': 2, 'original_hash_match': True,
                    'restricted_candidate': ref, 'relation_provenance': True, 'duplicate_job_new_calls': 0,
                    'private_wins_global_top1': True, 'authorized_prefilter_recovers_target': True,
                    'models': 'deterministic HTTP stubs, not semantic quality', 'calls': len(calls),
                    'request_shapes': list({json.dumps(call, sort_keys=True): call for call in calls}.values()), 'paid_calls': 0}))
            finally: await client.close()
        finally:
            if hasattr(backend, 'engine'): await backend.close()
            await runner.cleanup(); directory.cleanup()


if __name__ == '__main__': unittest.main()
