"""Private offline migration check. Reference data arrives over stdin, never argv."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def ledger_digest(root):
    paths = list((Path(root) / 'knowledge').glob('*/operations.sqlite3'))
    if len(paths) != 1:
        raise RuntimeError('native_snapshot_ledger_identity')
    result = {}
    with sqlite3.connect('file:' + str(paths[0]) + '?mode=ro', uri=True) as connection:
        for table, columns in (('operations', 4), ('supports', 5), ('sources', 3)):
            order = ','.join(str(index) for index in range(1, columns + 1))
            result[table] = connection.execute('SELECT * FROM ' + table + ' ORDER BY ' + order).fetchall()
    # JSON normalizes tuple/list representation across the stdin boundary.
    return digest(result)


def main():
    if len(sys.argv) != 2:
        raise RuntimeError('native_snapshot_root_required')
    root = Path(sys.argv[1]).resolve(strict=True)
    reference = json.load(sys.stdin)
    before = ledger_digest(root)
    if before != reference['ledgerHash']:
        raise RuntimeError('native_snapshot_ledger_changed')
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from check_native_environment import main as check_environment
    check_environment()
    from knowledge_service import KnowledgeService
    service = KnowledgeService(root, reference['namespace'], b'snapshot-validation-only-token-0000')
    service.start()
    try:
        paths = []
        for descriptor in Path('/proc/self/fd').glob('*'):
            try:
                value = str(descriptor.readlink())
            except OSError:
                continue
            if 'cognee_graph_ladybug' in value:
                paths.append(value)
        if not paths or any(not value.startswith(str(root) + '/') for value in paths):
            raise RuntimeError('native_snapshot_storage_path')
        claims, seen, after = [], set(), None
        while True:
            page = service.call('query', {'limit': 37, **({'after': after} if after else {})})
            claims.extend(page['claims'])
            after = page.get('nextCursor')
            if not after:
                break
            if after in seen:
                raise RuntimeError('native_snapshot_cursor_cycle')
            seen.add(after)
        claims.sort(key=lambda claim: claim['id'])
        if claims != sorted(reference['claims'], key=lambda claim: claim['id']):
            raise RuntimeError('native_snapshot_claims_changed')
        if ledger_digest(root) != before:
            raise RuntimeError('native_snapshot_receipts_changed')
    finally:
        service.close()
    if ledger_digest(root) != before:
        raise RuntimeError('native_snapshot_receipts_changed_on_close')
    print(json.dumps({'state': 'native_snapshot_verified', 'claims': len(claims),
                      'claimHash': digest(claims), 'ledgerHash': before,
                      'sourcesEvidenceAndReceiptsPreserved': True, 'paidModelCalls': 0}))


if __name__ == '__main__':
    main()
