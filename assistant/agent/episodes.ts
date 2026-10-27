import { bridgeHash } from "../ingress";
import type { JobLease } from "../queue";
import type { SourceScope } from "../sources";
import type { AccessGuard } from "../access";
const ns = "installation_id=? AND generation=?";
const active = "state IN ('prepared','dispatching','accepted','running') AND deadline>?";
type Seed = { lease: JobLease; requestHash: string; profile: string; checkpoint: string; binding: unknown; deadline: number; maxCalls: number; episodeGeneration?: number };
export type Episode = { id: string; job_id: string; request_hash: string; binding_hash: string; profile: "owner" | "interlocutor"; runtime_id: string; state: string; deadline: number; max_calls: number; binding: unknown; receipt: unknown; result: unknown; envelope: unknown; dispatch_hash: string | null; submission_id: string | null; reason: string | null };
type EpisodeRow = Omit<Episode, "binding" | "receipt" | "result" | "envelope"> & { binding_json: string; receipt_json: string | null; result_json: string | null; dispatch_json: string | null };
export type CallSlot = { ordinal: number; payload_hash: string; token: string; operation_key: string | null; state: string };
/** Metadata/control only. Creating a binding/slot grants no inference authority. */
export class Episodes {
  private readonly scope: Readonly<SourceScope>;
  constructor(private readonly db: D1Database, scope: SourceScope, private readonly clock = Date.now) { this.scope = Object.freeze({ ...scope }); }
  private keys() { return [this.scope.installationId, this.scope.generation]; }
  async prepare(input: Seed): Promise<Episode> {
    const serialized = JSON.stringify(input), owned: Seed = JSON.parse(serialized), now = this.clock();
    if (new TextEncoder().encode(serialized).length > 131072 || !["owner", "interlocutor"].includes(owned.profile) ||
      !/^[a-f0-9]{64}$/.test(owned.requestHash) || !/^[a-f0-9]{64}$/.test(owned.checkpoint) ||
      !Number.isSafeInteger(owned.deadline) || owned.deadline <= now || owned.deadline > now + 120000 || owned.deadline > owned.lease.lease_until ||
      !Number.isSafeInteger(owned.maxCalls) || owned.maxCalls < 1 || owned.maxCalls > 3) throw new Error("episode_input");
    const generation = owned.episodeGeneration ?? 1, hash = await bridgeHash(owned);
    const id = await bridgeHash([...this.keys(), owned.lease.id, generation]), runtimeId = "episode-" + id;
    await this.db.prepare(`INSERT INTO assistant_episodes(installation_id,generation,id,job_id,episode_generation,request_hash,binding_hash,binding_json,profile,runtime_id,deadline,max_calls)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? FROM assistant_jobs j JOIN assistant_job_ledger l ON l.installation_id=j.installation_id AND l.generation=j.generation AND l.job_id=j.id
      WHERE j.installation_id=? AND j.generation=? AND j.id=? AND j.state='processing' AND j.lease_generation=? AND j.lease_until>? AND l.request_hash=? AND l.state='prepared'
      AND NOT EXISTS(SELECT 1 FROM assistant_episodes prior WHERE prior.installation_id=j.installation_id AND prior.generation=j.generation AND prior.job_id=j.id AND prior.episode_generation<>? AND prior.state<>'settled')
      ON CONFLICT DO NOTHING`).bind(...this.keys(), id, owned.lease.id, generation, owned.requestHash, hash, JSON.stringify(owned.binding), owned.profile, runtimeId, owned.deadline, owned.maxCalls,
        ...this.keys(), owned.lease.id, owned.lease.lease_generation, now, owned.requestHash, generation).run();
    const row = await this.get(id); if (!row || row.binding_hash !== hash) throw new Error("episode_conflict"); return row;
  }
  async get(id: string): Promise<Episode | null> {
    const row = await this.db.prepare(`SELECT * FROM assistant_episodes WHERE ${ns} AND id=?`).bind(...this.keys(), id).first<EpisodeRow>();
    if (!row) return null;
    const { binding_json, receipt_json, result_json, dispatch_json, ...rest } = row;
    return { ...rest, binding: JSON.parse(binding_json), receipt: receipt_json ? JSON.parse(receipt_json) : null, result: result_json ? JSON.parse(result_json) : null, envelope: dispatch_json ? JSON.parse(dispatch_json) : null };
  }
  async envelope(id: string, input: unknown) {
    const json = JSON.stringify(input);
    if (!json || new TextEncoder().encode(json).length > 65536) throw new Error("episode_envelope_conflict");
    const hash = await bridgeHash(JSON.parse(json));
    await this.db.prepare(`UPDATE assistant_episodes SET dispatch_json=?,dispatch_hash=? WHERE ${ns} AND id=? AND state='prepared' AND dispatch_json IS NULL`)
      .bind(json, hash, ...this.keys(), id).run();
    const row = await this.get(id); if (!row || row.dispatch_hash !== hash || JSON.stringify(row.envelope) !== json) throw new Error("episode_envelope_conflict");
    return row;
  }
  async dispatch(id: string) {
    return !!await this.db.prepare(`UPDATE assistant_episodes SET state='dispatching',transport_attempts=transport_attempts+1 WHERE ${ns} AND id=? AND state='prepared' AND transport_attempts=0 AND dispatch_json IS NOT NULL AND receipt_json IS NULL AND deadline>? RETURNING id`).bind(...this.keys(), id, this.clock()).first();
  }
  async replayDispatch(id: string, additional?: AccessGuard) {
    return !!await this.db.prepare(`UPDATE assistant_episodes SET transport_attempts=transport_attempts+1 WHERE ${ns} AND id=? AND state IN ('dispatching','uncertain') AND transport_attempts<2 AND dispatch_json IS NOT NULL AND receipt_json IS NULL AND deadline+300000>?
      ${additional ? `AND (${additional.sql})` : ""} RETURNING id`).bind(...this.keys(), id, this.clock(), ...(additional?.values ?? [])).first();
  }
  async submission(id: string, submissionId: string) {
    if (typeof submissionId !== "string" || !submissionId || submissionId.length > 256) return false;
    return !!await this.db.prepare(`UPDATE assistant_episodes SET submission_id=? WHERE ${ns} AND id=? AND (${active}) AND (submission_id IS NULL OR submission_id=?) RETURNING id`)
      .bind(submissionId, ...this.keys(), id, this.clock(), submissionId).first();
  }
  async accept(id: string, receipt: unknown, submissionId: string | null = null) {
    const json = JSON.stringify(receipt); if (new TextEncoder().encode(json).length > 4096) throw new Error("episode_receipt");
    if (submissionId !== null && (!submissionId || submissionId.length > 256)) throw new Error("episode_receipt");
    await this.db.prepare(`UPDATE assistant_episodes SET receipt_json=?,submission_id=COALESCE(submission_id,?),state=CASE WHEN state='dispatching' THEN 'accepted' ELSE state END
      WHERE ${ns} AND id=? AND receipt_json IS NULL AND (? IS NULL OR submission_id IS NULL OR submission_id=?)`).bind(json, submissionId, ...this.keys(), id, submissionId, submissionId).run();
    if (JSON.stringify((await this.get(id))?.receipt) !== json) throw new Error("episode_receipt_conflict");
  }
  async slot(id: string, hash: string): Promise<CallSlot | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("episode_payload");
    await this.db.prepare(`INSERT INTO assistant_episode_calls(installation_id,generation,episode_id,ordinal,payload_hash,token)
      SELECT installation_id,generation,id,COALESCE((SELECT MAX(ordinal) FROM assistant_episode_calls c WHERE c.installation_id=e.installation_id AND c.generation=e.generation AND c.episode_id=e.id),0)+1,?,?
      FROM assistant_episodes e WHERE ${ns} AND id=? AND ${active} AND (SELECT COUNT(*) FROM assistant_episode_calls c WHERE c.installation_id=e.installation_id AND c.generation=e.generation AND c.episode_id=e.id)<max_calls
      ON CONFLICT DO NOTHING`).bind(hash, crypto.randomUUID(), ...this.keys(), id, this.clock()).run();
    return this.db.prepare(`SELECT c.* FROM assistant_episode_calls c JOIN assistant_episodes e ON e.installation_id=c.installation_id AND e.generation=c.generation AND e.id=c.episode_id
      WHERE e.installation_id=? AND e.generation=? AND e.id=? AND e.${active} AND c.payload_hash=?`).bind(...this.keys(), id, this.clock(), hash).first<CallSlot>();
  }
  async finish(id: string, ordinal: number) { await this.db.prepare(`UPDATE assistant_episode_calls SET state='complete' WHERE ${ns} AND episode_id=? AND ordinal=? AND state IN ('prepared','attempting')`).bind(...this.keys(), id, ordinal).run(); }
  async budgetBlocked(id: string) {
    await this.db.prepare(`UPDATE assistant_episodes SET state='blocked',reason='budget_blocked' WHERE ${ns} AND id=? AND ${active}
      AND NOT EXISTS(SELECT 1 FROM assistant_episode_calls c WHERE c.installation_id=assistant_episodes.installation_id AND c.generation=assistant_episodes.generation AND c.episode_id=assistant_episodes.id AND c.state IN ('attempting','uncertain'))`)
      .bind(...this.keys(), id, this.clock()).run();
  }
  async uncertain(id: string, reason = "uncertain") {
    if (!["uncertain", "dispatch_ack", "admission_ack", "model_uncertain"].includes(reason)) throw new Error("episode_reason");
    await this.db.batch([
      this.db.prepare(`UPDATE assistant_episodes SET state='uncertain',reason=? WHERE ${ns} AND id=? AND state<>'settled'`).bind(reason, ...this.keys(), id),
      this.db.prepare(`UPDATE assistant_episode_calls SET state='uncertain' WHERE ${ns} AND episode_id=? AND state IN ('prepared','attempting')`).bind(...this.keys(), id),
    ]);
  }
}
