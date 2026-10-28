import { bridgeHash } from "./ingress";
import { sourceTextHash, type SourceRef } from "./sources";
import { jsonStatement } from "./d1-statement";
import type { SourceRetirementGuard } from "./retention-authority";
import type { TelegramOwnerInbox, TelegramOwnerTurn } from "./telegram-owner-inbox";

/** Capture genuine admitted input for the existing model broker's source FK.
 * Audit source only: not a fact, memory note, command or job admission. */
export class TelegramOwnerRequests {
  constructor(private readonly db: D1Database, private readonly inbox: TelegramOwnerInbox,
    private readonly retirement: SourceRetirementGuard) {}
  async capture(turn: TelegramOwnerTurn): Promise<SourceRef | null> {
    const frame = this.inbox.replyFence(turn), checkpoint = await this.inbox.checkpoint(turn);
    const keys = [frame.installationId, frame.generation], originKey = JSON.stringify(["telegram-owner-request-v1", frame.botInstance, turn.updateId]);
    const id = "request:" + await bridgeHash(["telegram-owner-request-v1", ...keys, originKey]);
    const hash = await sourceTextHash(turn.text), admissionHash = await bridgeHash(["telegram-owner-request-admission-v1", checkpoint.fingerprint, hash]);
    await this.retirement.allow("owner_request", originKey, id);
    const guard = this.inbox.guard(turn);
    const source = `s.installation_id=? AND s.generation=? AND s.id=? AND s.origin='owner_request'
      AND s.origin_key=? AND s.status='active' AND s.revision=1 AND s.current_version=1 AND s.audience='owner'
      AND s.conversation_id IS NULL AND s.project_id IS NULL`;
    const admitted = `EXISTS(SELECT 1 FROM assistant_source_admissions a WHERE a.installation_id=s.installation_id
      AND a.generation=s.generation AND a.source_id=s.id AND a.request_hash=?)`;
    const sql = (query: string, values: (string | number | null)[]) => jsonStatement(this.db, query, values);
    const pinned = [...keys, id, originKey];
    await this.db.batch([
      sql(`INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,title,audience)
        SELECT ?,?,?,'owner_request',?,'Pedido no Telegram','owner' WHERE (${guard.sql})
        AND NOT EXISTS(SELECT 1 FROM assistant_retention_barriers WHERE installation_id=? AND (source_id=? OR (origin='owner_request' AND origin_key=?)))
        ON CONFLICT DO NOTHING`, [...pinned, ...guard.values, frame.installationId, id, originKey]),
      sql(`INSERT INTO assistant_source_admissions SELECT s.installation_id,s.generation,s.id,? FROM assistant_sources s
        WHERE ${source} AND (${guard.sql}) ON CONFLICT DO NOTHING`, [admissionHash, ...pinned, ...guard.values]),
      // Once the exact immutable packet is admitted, complete its children
      // under that witness. Expiry must not silently omit the final trace.
      // The return below independently requires current input authority.
      sql(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at)
        SELECT s.installation_id,s.generation,s.id,1,?,?,? FROM assistant_sources s WHERE ${source} AND ${admitted}
        AND NOT EXISTS(SELECT 1 FROM assistant_source_versions v WHERE v.installation_id=s.installation_id AND v.generation=s.generation AND v.source_id=s.id AND v.version=1)`,
        [turn.text, hash, turn.occurredAt, ...pinned, admissionHash]),
      sql(`INSERT INTO assistant_source_changes(installation_id,generation,source_id,revision,version,kind,changed_at)
        SELECT s.installation_id,s.generation,s.id,1,1,'created',? FROM assistant_sources s WHERE ${source} AND ${admitted}
        AND EXISTS(SELECT 1 FROM assistant_source_versions v WHERE v.installation_id=s.installation_id AND v.generation=s.generation AND v.source_id=s.id AND v.version=1 AND v.content_hash=?)
        ON CONFLICT DO NOTHING`, [turn.occurredAt, ...pinned, admissionHash, hash]),
    ]);
    // Return only a reference while the original input authority remains live.
    // Historical source recovery does not authorize another model or mutation.
    const ref = await sql(`SELECT s.id,s.revision,s.current_version AS version FROM assistant_sources s
      JOIN assistant_source_versions v ON v.installation_id=s.installation_id AND v.generation=s.generation AND v.source_id=s.id AND v.version=1
      WHERE ${source} AND ${admitted} AND v.content_hash=? AND (${guard.sql})`, [...pinned, admissionHash, hash, ...guard.values]).first<SourceRef>();
    return ref ? Object.freeze(ref) : null;
  }
}
