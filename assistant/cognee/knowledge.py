"""Trusted host primitive for native Cognee knowledge candidates.

The constructor fixes installation/generation. The host must resolve entities,
re-read originals with SourceAccess(purpose=knowledge), validate quotes, stamp
origin, synchronize withdrawals, and revalidate originals before exposure. This
module grants no authority and accepts no SQL, URL, namespace, or owner payload.
Each relation's evidence list is one joint support group (AND); separate
relations for the same claim are alternative groups (OR). Only complete groups
are returned. Coverage describes a native candidate page, never archive/fact
coverage. Names are mutable attributes; canonical IDs are host resolved.
Native graph nodes/edges hold semantics; SQLite holds only operation receipts,
expected native IDs and source withdrawal fences. No embeddings/LLM are invoked.
"""
import asyncio
from contextlib import asynccontextmanager, contextmanager
from datetime import date, datetime, timezone
import fcntl
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from uuid import NAMESPACE_URL, UUID, uuid5

from cognee.infrastructure.engine import DataPoint
from cognee.infrastructure.databases.provenance.source_refs import make_source_ref_key
from cognee.infrastructure.databases.unified.provenance_delete_planner import execute_source_ref_removal


# Leaves headroom inside the host's 4 MiB response envelope. This bounds one
# transport page, never the corpus or the number of alternatives for a claim.
MAX_QUERY_PAGE_BYTES = 3 * 1024 * 1024


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class AssistantEntity(DataPoint):
    canonical_key: str
    external_id: str
    kind: str
    name: str
    metadata: dict = {'identity_fields': ['canonical_key'], 'index_fields': []}


class AssistantClaim(DataPoint):
    canonical_key: str
    name: str
    predicate: str
    classification: str
    valid_from: str | None = None
    valid_until: str | None = None
    metadata: dict = {'identity_fields': ['canonical_key'], 'index_fields': []}


class AssistantEvidence(DataPoint):
    canonical_key: str
    name: str
    source_ref: dict
    quote: str | None = None
    metadata: dict = {'identity_fields': ['canonical_key'], 'index_fields': []}


class AssistantSupportGroup(DataPoint):
    canonical_key: str
    # A native scalar projection for count filtering, never an identity/label merge.
    name: str
    required_evidence_ids: list[str]
    origins: list[str]
    metadata: dict = {'identity_fields': ['canonical_key'], 'index_fields': []}


class NativeKnowledgeStore:
    def __init__(self, root: Path, namespace: dict, graph, vector):
        if set(namespace) != {'installationId', 'generation'}:
            raise ValueError('knowledge_namespace')
        for value in namespace.values():
            self._text(value)
        self.space = digest(['assistant-knowledge-v1', namespace])
        self.root = Path(root) / 'knowledge' / self.space
        self.root.mkdir(parents=True, exist_ok=True)
        self.database = self.root / 'operations.sqlite3'
        self.graph, self.vector = graph, vector
        self._lock = asyncio.Lock()
        self._initialized = False

    @contextmanager
    def _db(self):
        connection = sqlite3.connect(self.database, timeout=30)
        try:
            connection.execute('PRAGMA synchronous=FULL')
            with connection:
                yield connection
        finally:
            connection.close()

    @asynccontextmanager
    async def _writer(self):
        # Serialize only mutations/reconciliation, including competing host processes.
        # Native reads stay concurrent. The adapter owns its own graph write locks.
        async with self._lock:
            with (self.root / 'writer.lock').open('a') as handle:
                while True:
                    try:
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        await asyncio.sleep(0.05)
                try:
                    yield
                finally:
                    fcntl.flock(handle, fcntl.LOCK_UN)

    async def initialize(self):
        if self._initialized:
            return
        with self._db() as connection:
            connection.executescript('''
                CREATE TABLE IF NOT EXISTS operations (
                    id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL,
                    kind TEXT NOT NULL, receipt TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS supports (
                    operation_id TEXT NOT NULL, claim_id TEXT NOT NULL,
                    evidence_id TEXT NOT NULL, source_key TEXT NOT NULL, group_id TEXT NOT NULL,
                    PRIMARY KEY(operation_id, claim_id, evidence_id, group_id));
                CREATE TABLE IF NOT EXISTS sources (
                    source_key TEXT PRIMARY KEY, source_ref TEXT NOT NULL,
                    withdrawn INTEGER NOT NULL DEFAULT 0);
            ''')
        async with self._writer():
            from cognee.infrastructure.databases.provenance import (
                GRAPH_PROVENANCE_VERSION_KEY, GRAPH_PROVENANCE_VERSION,
                GRAPH_DELETE_MODE_KEY, GRAPH_DELETE_MODE_GRAPH_PROVENANCE)
            metadata = await self.graph.get_graph_metadata()
            expected = {GRAPH_PROVENANCE_VERSION_KEY: GRAPH_PROVENANCE_VERSION,
                        GRAPH_DELETE_MODE_KEY: GRAPH_DELETE_MODE_GRAPH_PROVENANCE}
            if any(metadata.get(key) != value for key, value in expected.items()):
                if not await self.graph.is_empty():
                    raise RuntimeError('knowledge_graph_provenance_migration_required')
                await self.graph.set_graph_metadata(expected)
            self._initialized = True

    @staticmethod
    def _text(value):
        if not isinstance(value, str) or not value.strip() or '\x00' in value:
            raise ValueError('knowledge_text')
        return value

    @classmethod
    def _source(cls, value):
        if not isinstance(value, dict) or set(value) != {'id', 'revision', 'version', 'hash'}:
            raise ValueError('knowledge_source_ref')
        cls._text(value['id'])
        for field in ('revision', 'version'):
            if type(value[field]) is not int or value[field] < 1:
                raise ValueError('knowledge_source_revision')
        if not isinstance(value['hash'], str) or not re.fullmatch('[0-9a-f]{64}', value['hash']):
            raise ValueError('knowledge_source_hash')
        return dict(value)

    @classmethod
    def _temporal(cls, value):
        cls._text(value)
        try:
            if re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
                return date.fromisoformat(value).isoformat()
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None or parsed.utcoffset() is None:
                raise ValueError('timezone_required')
            return parsed.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
        except ValueError as error:
            raise ValueError('knowledge_temporal') from error

    def _key(self, *parts):
        return digest([self.space, *parts])

    def _id(self, *parts):
        return str(uuid5(NAMESPACE_URL, self._key(*parts)))

    def _ref_key(self, ref):
        return make_source_ref_key(uuid5(NAMESPACE_URL, self.space),
                                   uuid5(NAMESPACE_URL, self._key('source', ref)))

    def _prepare(self, value):
        if not isinstance(value, dict) or set(value) != {'entities', 'relations', 'origin'}:
            raise ValueError('knowledge_input')
        if value['origin'] not in ('owner_report', 'agent_derived'):
            raise ValueError('knowledge_origin')
        if not isinstance(value['entities'], list) or not isinstance(value['relations'], list) or not value['relations']:
            raise ValueError('knowledge_relations')
        entities = {}
        for item in value['entities']:
            if not isinstance(item, dict) or set(item) != {'id', 'kind', 'name'}:
                raise ValueError('knowledge_entity')
            for field in item.values(): self._text(field)
            if item['id'] in entities and entities[item['id']] != item:
                raise ValueError('knowledge_entity_conflict')
            entities[item['id']] = dict(item)
        prepared = []
        for relation in value['relations']:
            required = {'subjectId', 'predicate', 'objectId', 'classification', 'evidence'}
            if not isinstance(relation, dict) or not required <= set(relation) or set(relation) - required - {'validFrom', 'validUntil'}:
                raise ValueError('knowledge_relation')
            self._text(relation['subjectId']); self._text(relation['objectId'])
            if relation['subjectId'] not in entities or relation['objectId'] not in entities:
                raise ValueError('knowledge_unresolved_entity')
            self._text(relation['predicate'])
            if relation['classification'] not in ('reported', 'inferred'):
                raise ValueError('knowledge_classification')
            relation = dict(relation)
            for field in ('validFrom', 'validUntil'):
                if field in relation: relation[field] = self._temporal(relation[field])
            if relation.get('validFrom') and relation.get('validUntil'):
                start, end = relation['validFrom'], relation['validUntil']
                if len(start) == 10 and len(end) == 10:
                    reversed_interval = end < start
                elif len(start) > 10 and len(end) > 10:
                    reversed_interval = datetime.fromisoformat(end) < datetime.fromisoformat(start)
                else:
                    raise ValueError('knowledge_temporal_mixed_precision')
                if reversed_interval: raise ValueError('knowledge_temporal_order')
            if not isinstance(relation['evidence'], list) or not relation['evidence']:
                raise ValueError('knowledge_evidence_required')
            identity = ['claim', relation['subjectId'], relation['predicate'], relation['objectId'],
                        relation['classification'], relation.get('validFrom'), relation.get('validUntil')]
            claim = AssistantClaim(id=UUID(self._id(*identity)), canonical_key=self._key(*identity), name=self.space,
                predicate=relation['predicate'], classification=relation['classification'],
                valid_from=relation.get('validFrom'), valid_until=relation.get('validUntil'))
            endpoints = []
            for field in ('subjectId', 'objectId'):
                item = entities[relation[field]]
                endpoints.append(AssistantEntity(id=UUID(self._id('entity', item['id'])),
                    canonical_key=self._key('entity', item['id']), external_id=item['id'], kind=item['kind'], name=item['name']))
            relation_supports = []
            for support in relation['evidence']:
                if not isinstance(support, dict) or not {'sourceRef'} <= set(support) or set(support) - {'sourceRef', 'quote'}:
                    raise ValueError('knowledge_evidence')
                ref = self._source(support['sourceRef'])
                quote = support.get('quote')
                if quote is not None: self._text(quote)
                eid = ['evidence', str(claim.id), ref, quote]
                evidence = AssistantEvidence(id=UUID(self._id(*eid)), canonical_key=self._key(*eid),
                    name='source evidence', source_ref=ref, quote=quote)
                relation_supports.append((claim, endpoints, evidence, self._ref_key(ref)))
            required_ids = sorted({str(item[2].id) for item in relation_supports})
            group_identity = ['support_group', str(claim.id), required_ids]
            group = AssistantSupportGroup(id=UUID(self._id(*group_identity)),
                canonical_key=self._key(*group_identity), name=str(len(required_ids)),
                required_evidence_ids=required_ids, origins=[value['origin']])
            prepared.extend((*item, group) for item in relation_supports)
        return prepared

    def _receipt(self, operation_id):
        with self._db() as connection:
            row = connection.execute('SELECT receipt FROM operations WHERE id=?', (operation_id,)).fetchone()
        return json.loads(row[0]) if row else {'operationId': operation_id, 'state': 'not_found'}

    def _set_state(self, operation_id, state, error=None):
        receipt = self._receipt(operation_id)
        receipt['state'] = state
        receipt.pop('error', None)
        if error: receipt['error'] = error
        with self._db() as connection:
            connection.execute('UPDATE operations SET receipt=? WHERE id=?', (canonical(receipt), operation_id))
        return receipt

    def _register(self, operation_id, kind, payload, receipt):
        self._text(operation_id)
        payload_hash = digest([kind, payload])
        with self._db() as connection:
            row = connection.execute('SELECT payload_hash FROM operations WHERE id=?', (operation_id,)).fetchone()
            if row:
                return (self._receipt(operation_id) if row[0] == payload_hash else
                        {'operationId': operation_id, 'state': 'conflict', 'error': 'operation_payload_conflict'})
            connection.execute('INSERT INTO operations VALUES (?,?,?,?)',
                               (operation_id, payload_hash, kind, canonical(receipt)))
        return None

    async def remember(self, operationId, input):
        await self.initialize()
        prepared = self._prepare(input)
        async with self._writer():
            receipt = {'operationId': operationId, 'state': 'accepted', 'origin': input['origin'],
                'claimIds': sorted({str(item[0].id) for item in prepared}),
                'evidenceIds': sorted({str(item[2].id) for item in prepared}),
                'supportGroupIds': sorted({str(item[4].id) for item in prepared})}
            existing = self._register(operationId, 'remember', input, receipt)
            if existing:
                return existing if existing['state'] == 'conflict' else await self._reconcile(operationId)
            with self._db() as connection:
                for claim, _, evidence, ref_key, group in prepared:
                    row = connection.execute('SELECT withdrawn FROM sources WHERE source_key=?', (ref_key,)).fetchone()
                    if row and row[0]:
                        return self._set_state(operationId, 'conflict', 'source_withdrawn')
                for claim, _, evidence, ref_key, group in prepared:
                    connection.execute('INSERT OR IGNORE INTO sources VALUES (?,?,0)', (ref_key, canonical(evidence.source_ref)))
                    connection.execute('INSERT OR IGNORE INTO supports VALUES (?,?,?,?,?)',
                                       (operationId, str(claim.id), str(evidence.id), ref_key, str(group.id)))
            self._set_state(operationId, 'indexing')
            try:
                for claim, endpoints, evidence, ref_key, group in prepared:
                    rows = await self.graph.query('MATCH (g:Node) WHERE g.id=$id RETURN g.properties', {'id': str(group.id)})
                    if rows:
                        previous = json.loads(rows[0][0])
                        group.origins = sorted(set(previous.get('origins', [])) | set(group.origins))
                    await self.graph.add_nodes([*endpoints, claim, group, evidence], source_ref_key=ref_key)
                    await self.graph.add_edges([
                        (str(claim.id), str(endpoints[0].id), 'claim_subject', {}),
                        (str(claim.id), str(endpoints[1].id), 'claim_object', {}),
                        (str(claim.id), str(evidence.id), 'claim_evidence', {}),
                        (str(claim.id), str(group.id), 'claim_support_group', {}),
                        (str(group.id), str(evidence.id), 'support_evidence', {})], source_ref_key=ref_key)
            except Exception:
                # Native writes may have committed before the exception. Never retry here.
                self._set_state(operationId, 'uncertain', 'native_write_uncertain')
            return await self._reconcile(operationId)

    async def _rows(self, claim_id, complete=True, group_id=None):
        rows = await self.graph.query("""MATCH (c:Node)-[s:EDGE]->(a:Node),
            (c)-[o:EDGE]->(b:Node),(c)-[e:EDGE]->(v:Node),
            (c)-[k:EDGE]->(g:Node),(g)-[ge:EDGE]->(v)
            WHERE c.id=$claim AND c.name=$space AND c.type='AssistantClaim'
              AND s.relationship_name='claim_subject' AND o.relationship_name='claim_object'
              AND e.relationship_name='claim_evidence' AND v.type='AssistantEvidence'
              AND k.relationship_name='claim_support_group' AND g.type='AssistantSupportGroup'
              AND ge.relationship_name='support_evidence'
              AND ($support_group_id='' OR g.id=$support_group_id)
            RETURN c.properties,a.properties,a.name,b.properties,b.name,v.id,v.properties,
              a.id,b.id,c.source_ref_keys,a.source_ref_keys,b.source_ref_keys,v.source_ref_keys,
              s.source_ref_keys,o.source_ref_keys,e.source_ref_keys,
              g.id,g.properties,g.source_ref_keys,k.source_ref_keys,ge.source_ref_keys
            ORDER BY g.id,v.id""", {'claim': claim_id, 'space': self.space, 'support_group_id': group_id or ''})
        valid, required, seen = [], {}, {}
        for row in rows:
            claim, subject, obj, evidence, group = (json.loads(row[index]) for index in (0, 1, 3, 6, 17))
            identity = ['claim', subject['external_id'], claim['predicate'], obj['external_id'],
                        claim['classification'], claim.get('valid_from'), claim.get('valid_until')]
            ref_key = self._ref_key(self._source(evidence['source_ref']))
            expected_evidence = self._id('evidence', claim_id, evidence['source_ref'], evidence.get('quote'))
            ids = group['required_evidence_ids']
            origins = group.get('origins')
            if (not isinstance(origins, list) or not origins or
                any(origin not in ('owner_report', 'agent_derived') for origin in origins)):
                continue
            if (not ids or len(ids) != len(set(ids)) or sorted(ids) != ids or
                self._id('support_group', claim_id, ids) != row[16] or
                expected_evidence != row[5] or row[5] not in ids or
                self._id(*identity) != claim_id or claim['canonical_key'] != self._key(*identity) or
                self._id('entity', subject['external_id']) != row[7] or
                self._id('entity', obj['external_id']) != row[8]):
                continue
            # Existence alone is insufficient: every required artifact must carry
            # this exact original/version/hash ref, including evidence-owned nodes.
            if any('|' + ref_key + '|' not in (row[index] or '') for index in (*range(9, 16), 18, 19, 20)):
                continue
            with self._db() as connection:
                source = connection.execute('SELECT withdrawn FROM sources WHERE source_key=?', (ref_key,)).fetchone()
            if not source or source[0]:
                continue
            required[row[16]] = set(ids)
            seen.setdefault(row[16], set()).add(row[5])
            valid.append(row)
        return [row for row in valid if not complete or seen[row[16]] == required[row[16]]]

    async def _reconcile(self, operation_id):
        with self._db() as connection:
            operation = connection.execute('SELECT kind FROM operations WHERE id=?', (operation_id,)).fetchone()
            supports = connection.execute('SELECT claim_id,evidence_id,source_key,group_id FROM supports WHERE operation_id=?', (operation_id,)).fetchall()
        if not operation: return self._receipt(operation_id)
        receipt = self._receipt(operation_id)
        if receipt['state'] == 'conflict': return receipt
        try:
            if operation[0] == 'withdraw':
                ref_key = receipt['sourceKey']
                remaining = await self.graph.find_nodes_by_source_ref(ref_key)
                edges = await self.graph.find_edges_by_source_ref(ref_key)
                return self._set_state(operation_id, 'partial' if remaining or edges else 'ready')
            found = 0
            for claim_id, group_id in {(item[0], item[3]) for item in supports}:
                rows = await self._rows(claim_id, complete=False, group_id=group_id)
                by_id = {(row[5], row[16]): (json.loads(row[6]), json.loads(row[17])['origins']) for row in rows}
                for _, evidence_id, ref_key, expected_group in (item for item in supports if item[0] == claim_id and item[3] == group_id):
                    support = by_id.get((evidence_id, expected_group))
                    if support and self._ref_key(support[0]['source_ref']) == ref_key and receipt['origin'] in support[1]:
                        found += 1
            return self._set_state(operation_id, 'ready' if supports and found == len(supports) else 'partial' if found else 'uncertain')
        except Exception:
            return self._set_state(operation_id, 'uncertain', 'native_read_uncertain')

    async def status(self, operationId):
        await self.initialize()
        self._text(operationId)
        async with self._writer():
            return await self._reconcile(operationId)

    async def get_entity(self, id):
        await self.initialize()
        self._text(id)
        rows = await self.graph.query(
            "MATCH (n:Node) WHERE n.id=$id AND n.type='AssistantEntity' RETURN n.properties,n.name",
            {'id': self._id('entity', id)})
        if not rows: return None
        item = json.loads(rows[0][0])
        if not await self._entity_has_complete_claim(id):
            return None
        return {'id': item['external_id'], 'kind': item['kind'], 'name': rows[0][1]}

    async def _entity_has_complete_claim(self, entity_id):
        # A partial candidate page is not absence. Advance only this entity's
        # native claim cursor until an independently verified group is found.
        cursor = None
        while True:
            query = {'entityId': entity_id, 'limit': 1}
            if cursor is not None: query['after'] = cursor
            page = await self.query(query)
            if page['claims']: return True
            cursor = page.get('nextCursor')
            if cursor is None: return False

    async def find_entities(self, input):
        await self.initialize()
        if not isinstance(input, dict) or set(input) - {'query', 'kind', 'after', 'limit'}:
            raise ValueError('knowledge_entity_query')
        limit = input.get('limit', 20)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('knowledge_page_limit')
        params = {'after': input.get('after', ''), 'limit': limit + 1,
                  'dataset': '|' + str(uuid5(NAMESPACE_URL, self.space)) + '|'}
        if not isinstance(params['after'], str): raise ValueError('knowledge_cursor')
        params['space'] = self.space
        conditions = ["n.type='AssistantEntity'", 'n.id>$after', 'n.source_dataset_ids CONTAINS $dataset',
            "c.type='AssistantClaim'", 'c.name=$space',
            "endpoint.relationship_name IN ['claim_subject','claim_object']",
            "k.relationship_name='claim_support_group'", "g.type='AssistantSupportGroup'",
            "ge.relationship_name='support_evidence'", "v.type='AssistantEvidence'"]
        if 'query' in input:
            params['query'] = self._text(input['query']).lower()
            conditions.append('lower(n.name) CONTAINS $query')
        if 'kind' in input:
            params['kind'] = json.dumps('kind') + ': ' + json.dumps(self._text(input['kind']))
            conditions.append('n.properties CONTAINS $kind')
        rows = await self.graph.query('''MATCH (c:Node)-[endpoint:EDGE]->(n:Node),
            (c)-[k:EDGE]->(g:Node),(g)-[ge:EDGE]->(v:Node) WHERE ''' + ' AND '.join(conditions) +
            ' WITH n,c,g,count(DISTINCT v.id) AS support_count WHERE support_count=CAST(g.name AS INT64) '
            'RETURN DISTINCT n.id,n.properties,n.name ORDER BY n.id LIMIT $limit', params)
        entities = []
        for _, properties, name in rows[:limit]:
            item = json.loads(properties)
            if not await self._entity_has_complete_claim(item['external_id']):
                continue
            entities.append({'id': item['external_id'], 'kind': item['kind'], 'name': name})
        page = {'entities': entities, 'coverage': self._coverage(len(rows[:limit]), len(entities), len(rows) > limit)}
        if len(rows) > limit: page['nextCursor'] = rows[limit - 1][0]
        return page

    @staticmethod
    def _coverage(candidates, returned, more=False):
        return {'scope': 'native_candidate_page', 'state': 'partial' if more or candidates != returned else 'complete',
                'candidates': candidates, 'returned': returned}

    @staticmethod
    def _group_cursor(claim_id, group_id):
        return f'kg1.{claim_id}.{group_id}'

    @staticmethod
    def _parse_group_cursor(cursor):
        if not isinstance(cursor, str) or len(cursor) > 256:
            raise ValueError('knowledge_cursor')
        if not cursor: return '', ''
        parts = re.fullmatch(r'kg1\.([0-9a-f-]{36})\.([0-9a-f-]{36})', cursor)
        if not parts: raise ValueError('knowledge_cursor')
        try:
            values = tuple(str(UUID(part)) for part in parts.groups())
        except ValueError as error:
            raise ValueError('knowledge_cursor') from error
        if values != parts.groups(): raise ValueError('knowledge_cursor')
        return values

    @staticmethod
    def _claim_from_rows(claim_id, supports):
        first = supports[0]
        claim, subject, obj = json.loads(first[0]), json.loads(first[1]), json.loads(first[3])
        evidence_by_id, groups = {}, {}
        for row in supports:
            item = json.loads(row[6])
            group_origins = sorted(set(json.loads(row[17])['origins']))
            entry = {'id': row[5], 'sourceRef': item['source_ref'], 'origins': group_origins}
            if item.get('quote') is not None: entry['quote'] = item['quote']
            if row[5] in evidence_by_id:
                flattened = evidence_by_id[row[5]]
                flattened['origins'] = sorted(set(flattened['origins']) | set(group_origins))
            else:
                evidence_by_id[row[5]] = {**entry, 'origins': list(group_origins)}
            groups.setdefault(row[16], {'id': row[16], 'evidence': []})['evidence'].append(entry)
        evidence = list(evidence_by_id.values())
        result = {'id': claim_id, 'subject': {'id': subject['external_id'], 'kind': subject['kind'], 'name': first[2]},
            'predicate': claim['predicate'], 'object': {'id': obj['external_id'], 'kind': obj['kind'], 'name': first[4]},
            'classification': claim['classification'], 'evidence': evidence, 'supportGroups': list(groups.values()),
            'origins': sorted({origin for item in evidence for origin in item['origins']})}
        for field, native in (('validFrom', 'valid_from'), ('validUntil', 'valid_until')):
            if claim.get(native) is not None: result[field] = claim[native]
        return result

    @staticmethod
    def _merge_claim_groups(current, addition):
        # Copy the flattened origin lists: per-group origins must remain local.
        evidence = {item['id']: {**item, 'origins': list(item['origins'])} for item in current['evidence']}
        for item in addition['evidence']:
            if item['id'] in evidence:
                evidence[item['id']]['origins'] = sorted(set(evidence[item['id']]['origins']) | set(item['origins']))
            else:
                evidence[item['id']] = {**item, 'origins': list(item['origins'])}
        return {**current, 'supportGroups': [*current['supportGroups'], *addition['supportGroups']],
            'evidence': list(evidence.values()),
            'origins': sorted({origin for item in evidence.values() for origin in item['origins']})}

    async def query(self, input):
        """Page indivisible support groups; claims contain ONLY groups in this page.

        limit counts native candidate groups. The opaque cursor orders claim/group
        IDs, so a claim's other alternatives remain retrievable without loading its
        whole history. Coverage is partial whenever continuation exists. Structural
        candidates remain subject to host authorization and original revalidation.
        """
        await self.initialize()
        if not isinstance(input, dict) or set(input) - {'entityId', 'predicate', 'classification', 'after', 'limit'}:
            raise ValueError('knowledge_query')
        limit = input.get('limit', 20)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('knowledge_page_limit')
        after_claim, after_group = self._parse_group_cursor(input.get('after', ''))
        params = {'space': self.space, 'limit': limit + 1, 'after_claim': after_claim, 'after_group': after_group}
        conditions = ["c.name=$space", "c.type='AssistantClaim'",
                      '(c.id>$after_claim OR (c.id=$after_claim AND g.id>$after_group))',
                      "s.relationship_name='claim_subject'", "o.relationship_name='claim_object'",
                      "e.relationship_name='claim_evidence'", "v.type='AssistantEvidence'",
                      "k.relationship_name='claim_support_group'", "g.type='AssistantSupportGroup'",
                      "ge.relationship_name='support_evidence'"]
        if 'entityId' in input:
            self._text(input['entityId'])
            params['entity'] = self._id('entity', input['entityId'])
            conditions.append('(a.id=$entity OR b.id=$entity)')
        for field in ('predicate', 'classification'):
            if field in input:
                self._text(input[field])
                if field == 'classification' and input[field] not in ('reported', 'inferred'):
                    raise ValueError('knowledge_classification')
                params[field] = json.dumps(field) + ': ' + json.dumps(input[field])
                conditions.append(f'c.properties CONTAINS ${field}')
        rows = await self.graph.query('''MATCH (c:Node)-[s:EDGE]->(a:Node),
            (c)-[o:EDGE]->(b:Node),(c)-[e:EDGE]->(v:Node),
            (c)-[k:EDGE]->(g:Node),(g)-[ge:EDGE]->(v) WHERE ''' + ' AND '.join(conditions) +
            ' WITH c,g,count(DISTINCT v.id) AS support_count WHERE support_count=CAST(g.name AS INT64) '
            'RETURN DISTINCT c.id,g.id ORDER BY c.id,g.id LIMIT $limit', params)
        claims, consumed, returned, last = {}, 0, 0, None
        more = len(rows) > limit
        for claim_id, group_id in rows[:limit]:
            supports = await self._rows(claim_id, group_id=group_id)
            if not supports:
                consumed += 1
                last = (claim_id, group_id)
                continue
            addition = self._claim_from_rows(claim_id, supports)
            candidate = dict(claims)
            candidate[claim_id] = (self._merge_claim_groups(claims[claim_id], addition)
                                   if claim_id in claims else addition)
            # Reserve maximal counter digits, cursor, and the longer state label.
            # Count the actual UTF-8 JSON, including duplicated flattened evidence.
            reserved = {'claims': list(candidate.values()),
                        'coverage': self._coverage(limit, limit),
                        'nextCursor': self._group_cursor(claim_id, group_id)}
            size = len(json.dumps(reserved, ensure_ascii=False, allow_nan=False).encode('utf-8'))
            if size > MAX_QUERY_PAGE_BYTES:
                if not returned:
                    # The host's <=256 KiB write envelope guarantees accepted
                    # dataplane groups fit. Oversize direct internal writes cannot
                    # be hidden as an empty or perpetually repeated cursor page.
                    raise ValueError('knowledge_support_group_exceeds_page_budget')
                more = True
                break
            claims = candidate
            consumed += 1
            returned += 1
            last = (claim_id, group_id)
        page = {'claims': list(claims.values()), 'coverage': self._coverage(consumed, returned, more)}
        if more and last: page['nextCursor'] = self._group_cursor(*last)
        return page

    async def withdraw(self, operationId, sourceRef):
        await self.initialize()
        ref = self._source(sourceRef)
        ref_key = self._ref_key(ref)
        async with self._writer():
            receipt = {'operationId': operationId, 'state': 'accepted', 'sourceKey': ref_key,
                       'claimIds': [], 'evidenceIds': []}
            existing = self._register(operationId, 'withdraw', ref, receipt)
            if existing:
                return existing if existing['state'] == 'conflict' else await self._reconcile(operationId)
            with self._db() as connection:
                connection.execute('INSERT INTO sources VALUES (?,?,1) ON CONFLICT(source_key) DO UPDATE SET withdrawn=1',
                                   (ref_key, canonical(ref)))
                receipt['claimIds'] = [row[0] for row in connection.execute('SELECT DISTINCT claim_id FROM supports WHERE source_key=?', (ref_key,))]
                connection.execute('UPDATE operations SET receipt=? WHERE id=?', (canonical(receipt), operationId))
            self._set_state(operationId, 'indexing')
            try:
                nodes = await self.graph.find_nodes_by_source_ref(ref_key)
                edges = await self.graph.find_edges_by_source_ref(ref_key)
                await execute_source_ref_removal(self.graph, self.vector,
                    node_data=await self.graph.get_node_delete_data(nodes),
                    edge_data=await self.graph.get_edge_delete_data(edges),
                    refs_by_node={item: [ref_key] for item in nodes}, refs_by_edge={item: [ref_key] for item in edges})
            except Exception:
                self._set_state(operationId, 'uncertain', 'native_withdraw_uncertain')
            return await self._reconcile(operationId)
