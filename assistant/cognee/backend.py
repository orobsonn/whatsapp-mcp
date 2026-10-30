"""Pinned native Cognee pipeline; returns provenance candidates, never authorization."""
import collections
import importlib.metadata
import inspect
import json
import os
import sqlite3
import math
from server import BROKER, VERSION, source_key


def normalize(value): return str(value).replace('-', '')
def serial(value):
    if isinstance(value, dict): return {str(key): serial(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)): return [serial(item) for item in value]
    if hasattr(value, 'model_dump'): return serial(value.model_dump())
    return value


class CogneeBackend:
    def __init__(self, root): self.root = root
    async def initialize(self):
        # Only the fixed broker and placeholder enter native model clients.
        os.environ.update({
            'TELEMETRY_DISABLED': 'true', 'DO_NOT_TRACK': '1', 'CACHING': 'false', 'HF_HUB_OFFLINE': '1',
            'LITELLM_LOCAL_MODEL_COST_MAP': 'true', 'LOG_LEVEL': 'CRITICAL', 'COGNEE_LOGS_DIR': str(self.root / 'logs'),
            'LLM_API_KEY': 'no-provider-key', 'LLM_PROVIDER': 'openai', 'LLM_MODEL': 'openai/gpt-6-luna',
            'LLM_ENDPOINT': BROKER, 'LLM_MAX_COMPLETION_TOKENS': '6000', 'LLM_RATE_LIMIT_ENABLED': 'false',
            'LLM_ARGS': '{"max_retries":0,"num_retries":0}', 'EMBEDDING_PROVIDER': 'openai',
            'EMBEDDING_MODEL': 'text-embedding-3-small', 'EMBEDDING_DIMENSIONS': '1536',
            'EMBEDDING_API_KEY': 'no-provider-key', 'EMBEDDING_ENDPOINT': BROKER, 'EMBEDDING_MAX_TOKENS': '8191',
            'EMBEDDING_BATCH_SIZE': '1', 'EMBEDDING_MAX_CONCURRENT_DATA_POINTS': '4', 'GRAPH_DATABASE_PROVIDER': 'ladybug',
            'VECTOR_DB_PROVIDER': 'lancedb', 'GRAPH_DATABASE_SUBPROCESS_ENABLED': 'false',
            'VECTOR_DB_SUBPROCESS_ENABLED': 'false', 'KUZU_BUFFER_POOL_SIZE': '134217728',
            'KUZU_MAX_DB_SIZE': '1073741824', 'KUZU_NUM_THREADS': '2', 'DB_PROVIDER': 'sqlite', 'DB_NAME': 'assistant_index',
            'SYSTEM_ROOT_DIRECTORY': str(self.root / 'system'), 'DATA_ROOT_DIRECTORY': str(self.root / 'data'),
            'COGNEE_DATA_ROOT_DIRECTORY': str(self.root / 'data'), 'ENABLE_BACKEND_ACCESS_CONTROL': 'false',
            # Host pins provider/model/dimensions. Skip Cognee connectivity probes
            # and keyless fallback/preflight; never fabricate a model response.
            'COGNEE_SKIP_CONNECTION_TEST': 'true',
            'PERSONALIZATION_ENABLED': 'false', 'NO_PROXY': 'broker.internal,127.0.0.1,localhost,::1',
        })
        import cognee
        import litellm
        from tenacity import stop_after_attempt
        from cognee.infrastructure.llm.structured_output_framework.litellm_native import native_adapter
        from cognee.infrastructure.databases.vector.embeddings.LiteLLMEmbeddingEngine import LiteLLMEmbeddingEngine
        if importlib.metadata.version('cognee') != VERSION: raise RuntimeError('cognee_version')
        litellm.num_retries = 0
        native_adapter._MAX_VALIDATION_RETRIES = 1
        native_adapter.NativeLiteLLMAdapter.MAX_RETRIES = 0
        native_adapter.NativeLiteLLMAdapter.acreate_structured_output.retry.stop = stop_after_attempt(1)
        LiteLLMEmbeddingEngine.embed_text.retry.stop = stop_after_attempt(1)
        cognee.config.system_root_directory(str(self.root / 'system')); cognee.config.data_root_directory(str(self.root / 'data'))
        self.cognee = cognee
        from cognee.infrastructure.databases.unified import get_unified_engine
        self.engine = await get_unified_engine()
    async def snapshot(self):
        nodes, edges = serial(await self.engine.graph.get_graph_data())
        chunks = []
        for node_id, node in nodes:
            if node.get('type') != 'DocumentChunk': continue
            metadata = node.get('external_metadata')
            if isinstance(metadata, str): metadata = json.loads(metadata)
            if not isinstance(metadata, dict) or not {'id', 'version', 'hash'} <= metadata.keys(): continue
            chunks.append({'chunkId': str(node_id), 'ref': {key: metadata[key] for key in ('id', 'version', 'hash')}})
        by_chunk = {normalize(item['chunkId']): item['ref'] for item in chunks}
        support = collections.defaultdict(list)
        database = self.root / 'system/databases/assistant_index'
        with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as connection:
            for edge_id, chunk_id in connection.execute('SELECT edge_id,chunk_id FROM provenance_edge_evidence'):
                ref = by_chunk.get(normalize(chunk_id))
                if ref: support[normalize(edge_id)].append(ref)
        return chunks, dict(support), len(nodes), len(edges)
    async def ingest(self, source):
        from cognee.tasks.ingestion.data_item import DataItem
        ref = {key: source[key] for key in ('id', 'version', 'hash')}
        # Distinct sources/versions cannot coalesce solely because their text matches.
        envelope = 'AssistantSource ' + json.dumps(ref, sort_keys=True) + '\n' + source['text']
        await self.cognee.add(DataItem(data=envelope, literal_text=True, external_metadata=ref),
                              dataset_name='assistant', node_set=['assistant'], skip_connection_test=True)
        await self.cognee.cognify(datasets=['assistant'], chunks_per_batch=1, data_per_batch=1,
            run_in_background=False, summary_method='from_extraction', extractor='llm', data_cache=False)
        chunks, support, nodes, edges = await self.snapshot()
        selected = [item for item in chunks if item['ref'] == ref]
        if not selected: raise RuntimeError('source_provenance_missing')
        return {'chunks': len(selected), 'relations': sum(ref in refs for refs in support.values()), 'nodes': nodes, 'edges': edges}
    async def search(self, query, allowed, limit):
        chunks, support, _, _ = await self.snapshot()
        permitted = {source_key(ref): ref for ref in allowed}
        chunks = [item for item in chunks if source_key(item['ref']) in permitted and item['ref'] == permitted[source_key(item['ref'])]]
        if len(chunks) > 256: raise ValueError('allowed_chunk_limit')
        represented = {source_key(item['ref']) for item in chunks}
        missing = [ref for ref in allowed if source_key(ref) not in represented]
        if missing: return {'candidates': [], 'missing': missing}
        # Rank the explicitly authorized IDs before top-k, avoiding post-filter starvation.
        vector = (await self.engine.vector.embedding_engine.embed_text([query]))[0]
        hits = await self.engine.vector.score_by_ids('DocumentChunk_text', [item['chunkId'] for item in chunks], vector)
        mapped = {normalize(item['chunkId']): item['ref'] for item in chunks}
        ranked = list(dict.fromkeys(source_key(mapped[normalize(hit.id)]) for hit in sorted(hits, key=lambda hit: (float(hit.score), str(hit.id)))))
        # Restrict native relation provenance before any graph scoring/top-k.
        # This lane measures connections to allowed chunks, not global semantic graph search.
        counts = collections.Counter()
        for refs in support.values():
            for key in {source_key(ref) for ref in refs if source_key(ref) in permitted and ref == permitted[source_key(ref)]}:
                counts[key] += 1
        graph = sorted((key for key in ranked if counts[key]), key=lambda key: (-counts[key], ranked.index(key), key))
        scores = collections.Counter()
        for lane in (ranked, graph):
            for rank, key in enumerate(lane): scores[key] += 1 / (61 + rank)
        return {'candidates': [{**permitted[key], 'via': [name for name, lane in (('chunks', ranked), ('graph', graph)) if key in lane],
                 'relationCount': counts[key]} for key in sorted(scores, key=lambda key: (-scores[key], key))[:limit]], 'missing': []}
    async def close(self):
        for engine in (self.engine.graph, self.engine.vector):
            result = engine.close()
            if inspect.isawaitable(result): await result
        from cognee.infrastructure.databases.relational import get_relational_engine
        await get_relational_engine().engine.dispose()
        database = self.root / 'system/databases/assistant_index'
        if database.exists():
            with sqlite3.connect(database) as connection:
                result = connection.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
                if result and result[0]: raise RuntimeError('sqlite_checkpoint_busy')
        os.sync()
    async def verify_vectors(self, chunks):
        if not chunks: return
        if await self.engine.vector.get_stored_vector_size() != 1536: raise RuntimeError('vector_dimensions')
        ids = list(dict.fromkeys(item['chunkId'] for item in chunks))
        for offset in range(0, len(ids), 128):
            batch = ids[offset:offset + 128]
            rows = await self.engine.vector.score_by_ids('DocumentChunk_text', batch, [1.0] * 1536)
            if {normalize(row.id) for row in rows} != {normalize(item) for item in batch} or any(not math.isfinite(float(row.score)) for row in rows):
                raise RuntimeError('vector_provenance_missing')
