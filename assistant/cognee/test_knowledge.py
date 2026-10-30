"""Offline native Cognee contract. Run in the pinned Docker image, --network none.
No graph doubles, provider stubs, embeddings, or LLM calls are used.
"""
import asyncio
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

from backend import CogneeBackend
from knowledge import NativeKnowledgeStore

NS = {'installationId': 'synthetic-install', 'generation': 'g1'}
REFS = [{'id': f'message:{i}', 'revision': 1, 'version': 1,
         'hash': hashlib.sha256(str(i).encode()).hexdigest()} for i in range(8)]


def request(ref=REFS[0], **relation):
    return {'origin': 'agent_derived', 'entities': [
        {'id': 'person:a', 'kind': 'person', 'name': 'Nora'},
        {'id': 'person:b', 'kind': 'person', 'name': 'Nora'},
        {'id': 'project:cedar', 'kind': 'project', 'name': 'Cedar'}],
        'relations': [{'subjectId': 'person:a', 'predicate': 'leads',
                       'objectId': 'project:cedar', 'classification': 'reported',
                       'evidence': [{'sourceRef': ref, 'quote': 'Nora leads Cedar.'}], **relation}]}


async def independent_read(root):
    backend = CogneeBackend(root)
    await backend.initialize()
    try:
        store = NativeKnowledgeStore(root, NS, backend.engine.graph, backend.engine.vector)
        await store.initialize()
        page = await store.query({'entityId': 'person:a'})
        assert len(page['claims']) == 1
        assert len(page['claims'][0]['evidence']) == 2
        assert (await store.status('first'))['state'] == 'ready'
        print('independent_process_read_ok')
    finally:
        await backend.close()


class NativeKnowledgeContract(unittest.IsolatedAsyncioTestCase):
    async def test_native_lifecycle_and_durable_operation_receipts(self):
        with tempfile.TemporaryDirectory(prefix='native-knowledge-') as directory:
            root = Path(directory)
            backend = CogneeBackend(root)
            await backend.initialize()
            graph = backend.engine.graph
            store = NativeKnowledgeStore(root, NS, graph, backend.engine.vector)
            try:
                await store.initialize()
                self.assertIsNone(await store.get_entity('missing'))
                with self.subTest('real_native_write_and_independent_query'):
                    first = await store.remember('first', request())
                    self.assertEqual(first['state'], 'ready', first)
                    claims = (await store.query({'entityId': 'person:a'}))['claims']
                    self.assertEqual(len(claims), 1)
                    self.assertEqual(len(claims[0]['supportGroups']), 1)
                    self.assertEqual(claims[0]['subject'], request()['entities'][0])
                    self.assertEqual(claims[0]['object']['name'], 'Cedar')
                    self.assertEqual(claims[0]['evidence'][0]['sourceRef'], REFS[0])
                    self.assertEqual((await store.query({'entityId': 'person:b'}))['claims'], [])
                with self.subTest('operation_identity_conflict_and_semantic_support_merge'):
                    self.assertEqual(await store.remember('first', request()), first)
                    conflict = await store.remember('first', request(REFS[1]))
                    self.assertEqual(conflict['state'], 'conflict')
                    second = await store.remember('second', request(REFS[1]))
                    self.assertEqual(first['claimIds'], second['claimIds'])
                    owner = request(); owner['origin'] = 'owner_report'
                    await store.remember('owner-same-support', owner)
                    page = await store.query({})
                    self.assertEqual(len(page['claims']), 1)
                    self.assertEqual(len(page['claims'][0]['evidence']), 2)
                    self.assertEqual(set(page['claims'][0]['origins']), {'owner_report', 'agent_derived'})
                # Close and read from a new interpreter: no in-memory registry can satisfy it.
                await backend.close()
                for stage, marker in (('read', b'independent_process_read_ok'),
                                      ('continue', b'native_removal_temporal_partial_ok'),
                                      ('lookup', b'native_lookup_continuation_ok')):
                    process = await asyncio.create_subprocess_exec(sys.executable, __file__, stage, str(root),
                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                    out, err = await asyncio.wait_for(process.communicate(), 90)
                    self.assertEqual(process.returncode, 0, err.decode()[-3000:])
                    self.assertIn(marker, out)
            finally:
                if not getattr(graph, '_permanently_closed', False):
                    await backend.close()


async def continue_contract(root):
    backend = CogneeBackend(root); await backend.initialize()
    graph = backend.engine.graph
    store = NativeKnowledgeStore(root, NS, graph, backend.engine.vector)
    await store.initialize()
    try:
        assert (await store.withdraw('drop-one', REFS[0]))['state'] == 'ready'
        page = await store.query({})
        assert len(page['claims']) == 1 and len(page['claims'][0]['evidence']) == 1
        assert page['claims'][0]['evidence'][0]['sourceRef'] == REFS[1]
        assert (await store.withdraw('drop-last', REFS[1]))['state'] == 'ready'
        assert (await store.query({}))['claims'] == []
        assert (await store.remember('first', request()))['state'] == 'uncertain'
        assert (await store.remember('stale-source', request()))['state'] == 'conflict'
        temporal = await store.remember('temporal-one', request(REFS[2], validFrom='2026-01-01T00:00:00Z'))
        temporal_two = await store.remember('temporal-two', request(REFS[3], validFrom='2026-06-01T00:00:00Z'))
        assert temporal['claimIds'] != temporal_two['claimIds']
        equivalent = await store.remember('temporal-equivalent', request(REFS[2], validFrom='2026-01-01T03:00:00+03:00'))
        assert equivalent['claimIds'] == temporal['claimIds']
        first_page = await store.query({'limit': 1})
        second_page = await store.query({'limit': 1, 'after': first_page['nextCursor']})
        assert first_page['claims'][0]['id'] != second_page['claims'][0]['id']
        assert len((await store.query({'predicate': 'leads', 'classification': 'reported'}))['claims']) == 2
        assert (await store.query({'predicate': 'unknown'}))['claims'] == []
        other = NativeKnowledgeStore(root, {**NS, 'generation': 'other'}, graph, backend.engine.vector)
        await other.initialize()
        assert (await other.query({}))['claims'] == []
        assert await other.get_entity('person:a') is None
        assert await store.get_entity('person:a') == request()['entities'][0]
        assert await store.get_entity('missing') is None
        homonym = request(REFS[4], subjectId='person:b')
        homonym_receipt = await store.remember('homonym', homonym)
        assert homonym_receipt['state'] == 'ready'
        assert (await store.query({'entityId': 'person:b'}))['claims'][0]['subject']['id'] == 'person:b'
        found = await store.find_entities({'query': 'Nora', 'kind': 'person', 'limit': 1})
        found_next = await store.find_entities({'query': 'Nora', 'kind': 'person', 'limit': 1, 'after': found['nextCursor']})
        assert {found['entities'][0]['id'], found_next['entities'][0]['id']} == {'person:a', 'person:b'}
        assert (await other.find_entities({}))['entities'] == []
        # A+B is joint support; a later C is an independent alternative.
        joint = request(REFS[4], predicate='joint_fact')
        joint['relations'][0]['evidence'].extend([{'sourceRef': REFS[5]}, {'sourceRef': REFS[5]}])
        assert (await store.remember('joint-ab', joint))['state'] == 'ready'
        joint_claim = (await store.query({'predicate': 'joint_fact'}))['claims'][0]
        assert len(joint_claim['supportGroups']) == 1
        assert len(joint_claim['evidence']) == 2
        for evidence in joint_claim['evidence']:
            native = await graph.get_node_delete_data([evidence['id']])
            assert set(native[evidence['id']].source_ref_keys) == {store._ref_key(evidence['sourceRef'])}
        assert (await store.withdraw('joint-drop-a', REFS[4]))['state'] == 'ready'
        assert (await store.query({'predicate': 'joint_fact'}))['claims'] == []
        independent = request(REFS[2], predicate='joint_fact')
        assert (await store.remember('independent-c', independent))['state'] == 'ready'
        groups = (await store.query({'predicate': 'joint_fact'}))['claims'][0]['supportGroups']
        assert len(groups) == 1 and groups[0]['evidence'][0]['sourceRef'] == REFS[2]
        assert (await store.status('joint-ab'))['state'] == 'partial'
        orphan = request(REFS[6])
        orphan['entities'][0] = {'id': 'person:orphan', 'kind': 'person', 'name': 'Orphan'}
        orphan['entities'][2] = {'id': 'project:orphan', 'kind': 'project', 'name': 'Orphan project'}
        orphan['relations'][0].update(subjectId='person:orphan', objectId='project:orphan')
        orphan['relations'][0]['evidence'].append({'sourceRef': REFS[7]})
        assert (await store.remember('orphan-ab', orphan))['state'] == 'ready'
        assert (await store.find_entities({'query': 'Orphan'}))['entities']
        assert (await store.withdraw('orphan-drop-a', REFS[6]))['state'] == 'ready'
        assert (await store.find_entities({'query': 'Orphan'}))['entities'] == []
        assert await store.get_entity('person:orphan') is None
        # Native corruption/failure boundary: one of two required supports disappears.
        both = request(REFS[2]); both['relations'][0]['evidence'].append({'sourceRef': REFS[3]})
        receipt = await store.remember('two-required', both)
        assert receipt['state'] == 'ready'
        ref_key = store._ref_key(REFS[3])
        evidence_for_ref = next(item for item in (await store.query({'predicate': 'leads'}))['claims']
                                if item['id'] == receipt['claimIds'][0])['evidence']
        evidence_for_ref = next(item['id'] for item in evidence_for_ref if item['sourceRef'] == REFS[3])
        await graph.remove_node_source_refs([evidence_for_ref], [ref_key])
        assert (await store.status('two-required'))['state'] == 'partial'
        assert (await store.query({'predicate': 'leads'}))['coverage']['state'] == 'partial'
        await graph.attach_node_source_refs([evidence_for_ref], [ref_key])
        await graph.query("MATCH (c:Node)-[e:EDGE]->(v:Node) WHERE c.id=$claim AND v.id=$evidence AND e.relationship_name='claim_evidence' DELETE e",
                          {'claim': receipt['claimIds'][0], 'evidence': receipt['evidenceIds'][0]})
        assert (await store.status('two-required'))['state'] == 'partial'
        for evidence_id in receipt['evidenceIds']:
            await graph.query("MATCH (c:Node)-[e:EDGE]->(v:Node) WHERE c.id=$claim AND v.id=$evidence AND e.relationship_name='claim_evidence' DELETE e",
                              {'claim': receipt['claimIds'][0], 'evidence': evidence_id})
        assert (await store.status('two-required'))['state'] == 'uncertain'
        civil = await store.remember('civil-date', request(REFS[2], validFrom='2026-01-01'))
        assert civil['state'] == 'ready'
        civil_claim = next(item for item in (await store.query({}))['claims'] if item['id'] == civil['claimIds'][0])
        assert civil_claim['validFrom'] == '2026-01-01'
        for invalid in ({**request(), 'owner': 'someone'}, {**request(), 'origin': 'owner_note'},
                        request(REFS[2], validFrom='2026-01-01T00:00:00.100000Z', validUntil='2026-01-01T00:00:00Z')):
            try: await store.remember('invalid', invalid)
            except ValueError: pass
            else: raise AssertionError('invalid input accepted')
        for invalid in ({'after': None}, {'after': False}, {'limit': True}):
            try: await store.query(invalid)
            except ValueError: pass
            else: raise AssertionError('invalid query accepted')
        print('native_removal_temporal_partial_ok; paid_calls=0')
    finally:
        await backend.close()


async def lookup_contract(root):
    root.mkdir(parents=True, exist_ok=True)
    backend = CogneeBackend(root); await backend.initialize()
    graph = backend.engine.graph
    store = NativeKnowledgeStore(root, {**NS, 'generation': 'lookup-only'}, graph, backend.engine.vector)
    await store.initialize()
    try:
        records = []
        for index, predicate in enumerate(('first', 'second')):
            receipt = await store.remember(predicate, request(REFS[index], predicate=predicate))
            assert receipt['state'] == 'ready'
            records.append((receipt, REFS[index]))
        broken, ref = min(records, key=lambda item: item[0]['claimIds'][0])
        await graph.remove_node_source_refs([broken['evidenceIds'][0]], [store._ref_key(ref)])
        page = await store.query({'entityId': 'person:a', 'limit': 1})
        assert page['claims'] == [] and page['nextCursor'] and page['coverage']['state'] == 'partial'
        assert await store.get_entity('person:a') == request()['entities'][0]
        assert (await store.find_entities({'query': 'Nora'}))['entities'] == [request()['entities'][0]]
        await origin_contract(root, graph, backend.engine.vector)
        await page_contract(root, graph, backend.engine.vector)
        print('native_lookup_continuation_ok')
    finally:
        await backend.close()


async def origin_contract(root, graph, vector):
    store = NativeKnowledgeStore(root, {**NS, 'generation': 'origin-only'}, graph, vector)
    await store.initialize()
    joint = request(REFS[0]); joint['origin'] = 'owner_report'
    joint['relations'][0]['evidence'].append({'sourceRef': REFS[1]})
    owner = await store.remember('origin-owner-ab', joint)
    agent = await store.remember('origin-agent-a', request(REFS[0]))
    assert owner['state'] == agent['state'] == 'ready'
    assert len(set(owner['evidenceIds']) & set(agent['evidenceIds'])) == 1
    before = (await store.query({}))['claims'][0]
    assert set(before['origins']) == {'owner_report', 'agent_derived'}
    by_group = {group['id']: group for group in before['supportGroups']}
    assert all(item['origins'] == ['owner_report'] for item in by_group[owner['supportGroupIds'][0]]['evidence'])
    assert by_group[agent['supportGroupIds'][0]]['evidence'][0]['origins'] == ['agent_derived']
    assert (await store.withdraw('origin-drop-b', REFS[1]))['state'] == 'ready'
    claim = (await store.query({}))['claims'][0]
    assert len(claim['supportGroups']) == 1
    assert claim['origins'] == ['agent_derived'], claim
    assert claim['evidence'][0]['origins'] == ['agent_derived']
    assert claim['supportGroups'][0]['evidence'][0]['origins'] == ['agent_derived']
    assert (await store.status('origin-owner-ab'))['state'] == 'partial'
    assert (await store.status('origin-agent-a'))['state'] == 'ready'
    # Same group can accumulate both writers, but ready must prove THIS group's origin.
    owner_a = request(REFS[0]); owner_a['origin'] = 'owner_report'
    receipt = await store.remember('origin-owner-a', owner_a)
    assert receipt['state'] == 'ready'
    assert set((await store.query({}))['claims'][0]['origins']) == {'owner_report', 'agent_derived'}
    rows = await graph.query('MATCH (g:Node) WHERE g.id=$id RETURN g.properties',
                             {'id': receipt['supportGroupIds'][0]})
    properties = json.loads(rows[0][0]); properties['origins'] = ['agent_derived']
    await graph.query('MATCH (g:Node) WHERE g.id=$id SET g.properties=$properties',
                      {'id': receipt['supportGroupIds'][0], 'properties': json.dumps(properties)})
    assert (await store.status('origin-owner-a'))['state'] == 'uncertain'
    assert (await store.status('origin-agent-a'))['state'] == 'ready'
    assert (await store.query({}))['claims'][0]['origins'] == ['agent_derived']
    print('native_support_group_origins_ok')


async def page_contract(root, graph, vector):
    store = NativeKnowledgeStore(root, {**NS, 'generation': 'group-page-only'}, graph, vector)
    await store.initialize()
    expected, receipts = {}, []
    for index in range(8):
        value = request(REFS[0])
        quotes = [f'{index}:{slot}:' + 'ç🙂' * (110 * 1024 // 6) for slot in range(2)]
        value['relations'][0]['evidence'] = [
            {'sourceRef': REFS[slot], 'quote': quotes[slot]} for slot in range(2)]
        assert len(json.dumps(value, ensure_ascii=False).encode()) < 256 * 1024
        receipt = await store.remember(f'page-{index}', value)
        assert receipt['state'] == 'ready'
        expected[receipt['supportGroupIds'][0]] = (set(receipt['evidenceIds']), set(quotes))
        receipts.append(receipt)
    seen, cursor, page_count = set(), None, 0
    while True:
        query = {'limit': 20}
        if cursor: query['after'] = cursor
        page = await store.query(query)
        assert len(json.dumps(page, ensure_ascii=False).encode()) <= 3 * 1024 * 1024
        groups = [group for claim in page['claims'] for group in claim['supportGroups']]
        assert groups, page
        for group in groups:
            assert group['id'] not in seen
            ids, quotes = expected[group['id']]
            assert {item['id'] for item in group['evidence']} == ids
            assert {item['quote'] for item in group['evidence']} == quotes
            seen.add(group['id'])
        page_count += 1
        next_cursor = page.get('nextCursor')
        if next_cursor:
            assert len(next_cursor) <= 256 and next_cursor.startswith('kg1.')
            assert next_cursor != cursor and page['coverage']['state'] == 'partial'
            cursor = next_cursor
        else:
            assert page['coverage']['state'] == 'complete'
            break
    assert page_count > 1 and seen == set(expected)
    first = await store.query({'limit': 1})
    assert len(first['claims'][0]['supportGroups']) == 1 and first.get('nextCursor')
    # The lookup must advance the claim+group cursor after incomplete native proof.
    broken = min(receipts, key=lambda receipt: (receipt['claimIds'][0], receipt['supportGroupIds'][0]))
    broken_id = broken['evidenceIds'][0]
    node = await graph.query('MATCH (v:Node) WHERE v.id=$id RETURN v.properties', {'id': broken_id})
    ref = json.loads(node[0][0])['source_ref']
    await graph.remove_node_source_refs([broken_id], [store._ref_key(ref)])
    partial = await store.query({'limit': 1})
    assert partial['claims'] == [] and partial.get('nextCursor') and partial['coverage']['state'] == 'partial'
    assert (await store.status(broken['operationId']))['state'] == 'partial'
    assert await store.get_entity('person:a') == request()['entities'][0]
    assert (await store.find_entities({'query': 'Nora'}))['entities'] == [request()['entities'][0]]
    print('native_group_byte_pages_ok')


async def pagination_contract(root):
    root.mkdir(parents=True, exist_ok=True)
    backend = CogneeBackend(root); await backend.initialize()
    try:
        await page_contract(root, backend.engine.graph, backend.engine.vector)
    finally:
        await backend.close()


if __name__ == '__main__':
    modes = {'read': independent_read, 'continue': continue_contract, 'lookup': lookup_contract, 'pages': pagination_contract}
    if len(sys.argv) > 1 and sys.argv[1] in modes:
        asyncio.run(modes[sys.argv[1]](Path(sys.argv[2])))
    else:
        unittest.main()
