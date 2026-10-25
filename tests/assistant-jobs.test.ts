import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { JobQueue, type JobLease } from "../assistant/queue";
import { JobController, type ShadowProvider } from "../assistant/jobs";
import type { TrustedActor } from "../assistant/access";
// @ts-expect-error Vite raw SQL imports, without app configuration changes.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Vite raw SQL imports, without app configuration changes.
import policies from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Vite raw SQL imports, without app configuration changes.
import work from "../assistant/migrations/0003_work.sql?raw";
// @ts-expect-error Vite raw SQL imports, without app configuration changes.
import ledger from "../assistant/migrations/0005_job_ledger.sql?raw";

let scope = { installationId: "jobs-test", generation: "g1" };
let now: number;
let queue: JobQueue;
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g1" };
  for (const sql of [sources, policies, work, ledger]) {
    const statements = sql.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|$)/).filter((s: string) => s.trim());
    if (statements.length) await env.DB.batch(statements.map((s: string) => env.DB.prepare(s)));
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key)
      VALUES(?,'g1','source','owner_note','source')`).bind(scope.installationId),
    env.DB.prepare(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at)
      VALUES(?,'g1','source',1,'Synthetic source',?,0)`).bind(scope.installationId, "a".repeat(64)),
  ]);
  now = 100;
  queue = new JobQueue(env.DB, scope);
});

const guest: TrustedActor = { kind: "interlocutor", provider: "whatsapp", address: "synthetic-address",
  conversationId: "conversation", conversationKind: "private", action: "reply_text", mandateId: "mandate" };
const sql = (query: string) => env.DB.prepare(query).bind(scope.installationId).run();
async function guestQueue(restricted = false) {
  await sql(`UPDATE assistant_sources SET audience='${restricted ? "restricted" : "public"}' WHERE installation_id=?`);
  await sql(`INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind)
    VALUES(?,'g1','conversation','private')`);
  if (restricted) await env.DB.batch([
    env.DB.prepare(`INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key) VALUES(?,'g1','proof','owner_note','proof')`).bind(scope.installationId),
    env.DB.prepare(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at)
      VALUES(?,'g1','proof',1,'Synthetic proof',?,0)`).bind(scope.installationId, "b".repeat(64)),
    env.DB.prepare(`INSERT INTO assistant_people VALUES(?,'g1','person','Synthetic person')`).bind(scope.installationId),
    env.DB.prepare(`INSERT INTO assistant_provider_identities VALUES(?,'g1','whatsapp','synthetic-address','person','proof',1,'owner_confirmed',0)`).bind(scope.installationId),
    env.DB.prepare(`INSERT INTO assistant_mandates VALUES(?,'g1','mandate',1,'conversation',NULL,'Synthetic purpose','active',0,200)`).bind(scope.installationId),
    env.DB.prepare(`INSERT INTO assistant_mandate_actions VALUES(?,'g1','mandate',1,'reply_text')`).bind(scope.installationId),
    env.DB.prepare(`INSERT INTO assistant_mandate_sources VALUES(?,'g1','mandate',1,'source')`).bind(scope.installationId),
  ]);
  // Trusted adapter actor; a restarted default-owner queue must use the stored actor.
  queue = new JobQueue(env.DB, scope, guest);
}
it.each([
  ["policy revision", `UPDATE assistant_conversation_policies SET revision=2 WHERE installation_id=?`],
  ["explicit exclusion", `UPDATE assistant_conversation_policies SET excluded=1 WHERE installation_id=?`],
  ["audience", `UPDATE assistant_sources SET audience='owner' WHERE installation_id=? AND id='source'`],
  ["origin scope", `UPDATE assistant_sources SET origin='github',conversation_id='other' WHERE installation_id=? AND id='source'`],
])("blocks %s changed after the captured fence before admission", async (_name, change) => {
  await guestQueue();
  const job = await enqueue();
  const lease = await claim();
  await sql(change);
  const fake = provider();
  expect(await controller(fake.api).process(lease)).toBe("blocked");
  expect(fake.executions()).toBe(0);
  expect(await queue.ledger(job.id)).toMatchObject({ state: "prepared" });
});
it.each([
  ["latest mandate revoke", `INSERT INTO assistant_mandates VALUES(?,'g1','mandate',2,'conversation',NULL,'Revoked','revoked',0,200)`],
  ["identity proof withdrawal", `UPDATE assistant_sources SET status='withdrawn',revision=2 WHERE installation_id=? AND id='proof'`],
  ["action removal", `DELETE FROM assistant_mandate_actions WHERE installation_id=?`],
  ["source grant removal", `DELETE FROM assistant_mandate_sources WHERE installation_id=?`],
])("blocks %s after enqueue without invoking the provider", async (_name, change) => {
  await guestQueue(true);
  await enqueue();
  await sql(change);
  const fake = provider();
  expect(await controller(fake.api).process(await claim())).toBe("blocked");
  expect(fake.executions()).toBe(0);
});
it("checks expiration using the admission clock", async () => {
  await guestQueue(true);
  await enqueue();
  now = 200;
  const fake = provider();
  expect(await controller(fake.api).process(await claim())).toBe("blocked");
  expect(fake.executions()).toBe(0);
});
it("retains a result receipt but prevents publication and owner-restart promotion after exclusion", async () => {
  await guestQueue();
  const job = await enqueue();
  const fake = provider();
  const execute = fake.api.execute;
  fake.api.execute = async (...args) => {
    const result = await execute(...args);
    await sql(`UPDATE assistant_conversation_policies SET excluded=1 WHERE installation_id=?`);
    return result;
  };
  const lease = await claim();
  expect(await controller(fake.api).process(lease)).toBe("blocked");
  expect(await queue.receipt(job.id)).toBe("Synthetic shadow answer");
  expect(await new JobQueue(env.DB, scope).publish(lease, now)).toBe(false);
  expect(fake.executions()).toBe(1);
});
it("fences the exact current body version and hash even without a source revision change", async () => {
  await enqueue();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at)
      VALUES(?,'g1','source',2,'Changed body',?,0)`).bind(scope.installationId, "c".repeat(64)),
    env.DB.prepare(`UPDATE assistant_sources SET current_version=2 WHERE installation_id=? AND id='source'`).bind(scope.installationId),
  ]);
  const fake = provider();
  expect(await controller(fake.api).process(await claim())).toBe("blocked");
  expect(fake.executions()).toBe(0);
});
it.each(["budget_blocked", "uncertain"])("does not admit or execute when budget preparation is %s", async (outcome) => {
  const job = await enqueue();
  const fake = provider();
  fake.api.prepare = async () => { if (outcome === "uncertain") throw new Error("lost reserve ACK"); return "budget_blocked"; };
  expect(await controller(fake.api).process(await claim())).toBe("blocked");
  expect(fake.executions()).toBe(0);
  expect(await queue.ledger(job.id)).toMatchObject({ state: "prepared", admitted_lease_generation: null });
  expect(await queue.get(job.id)).toMatchObject({ state: "failed", last_error: outcome === "uncertain" ? "budget_preparation_uncertain" : "budget_blocked" });
});
it("allows a prepared reservation to proceed exactly once", async () => {
  await enqueue();
  const fake = provider();
  let reservations = 0;
  fake.api.prepare = async (_key, hash, request) => {
    reservations++;
    expect(await queue.ledger((await queue.list())[0].id)).toMatchObject({ state: "prepared", request_hash: hash, request_json: request });
    return "ready";
  };
  expect(await controller(fake.api).process(await claim())).toBe("shadow_completed");
  expect(reservations).toBe(1);
  expect(fake.executions()).toBe(1);
});
it("does not let a late budget refusal fail a concurrent admitted winner", async () => {
  const job = await enqueue();
  const lease = await claim();
  const preparing = deferred<void>(); const refuse = deferred<void>();
  const executing = deferred<void>(); const finish = deferred<void>();
  const fake = provider(); const execute = fake.api.execute;
  let prepares = 0;
  fake.api.prepare = async () => {
    if (++prepares === 1) { preparing.resolve(); await refuse.promise; return "budget_blocked"; }
    return "ready";
  };
  fake.api.execute = async (...args) => { executing.resolve(); await finish.promise; return execute(...args); };
  const loser = controller(fake.api).process(lease);
  await preparing.promise;
  const winner = controller(fake.api).process(lease);
  await executing.promise;
  refuse.resolve();
  expect(await loser).toBe("stale");
  expect(await queue.get(job.id)).toMatchObject({ state: "processing" });
  finish.resolve();
  expect(await winner).toBe("shadow_completed");
  expect(fake.executions()).toBe(1);
});
// Changes just before the actual D1 mutation, after all application-side reads.
function beforeMutation(fragment: string, change: () => Promise<unknown>): D1Database {
  return new Proxy(env.DB, { get(db, property) {
    if (property === "prepare") return (query: string) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === "first" && query.includes(fragment)) return async (...args: Parameters<D1PreparedStatement["first"]>) => {
          await change(); return target.first(...args);
        };
        const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
      } });
      return wrap(db.prepare(query));
    };
    const value = Reflect.get(db, property); return typeof value === "function" ? value.bind(db) : value;
  } });
}
it.each(["admission", "publication"])("checks current ACL inside the %s mutation itself", async (stage) => {
  await guestQueue();
  const job = await enqueue();
  const lease = await claim();
  if (stage === "publication") expect(await queue.admit(lease, now)).not.toBeNull();
  const db = beforeMutation(stage === "admission" ? "SET state='attempting'" : "SET state='shadow_completed'",
    () => sql(`UPDATE assistant_conversation_policies SET excluded=1 WHERE installation_id=?`));
  queue = new JobQueue(db, scope);
  if (stage === "admission") {
    const fake = provider();
    expect(await controller(fake.api).process(lease)).toBe("blocked");
    expect(fake.executions()).toBe(0);
  } else {
    expect(await queue.complete(lease, "Synthetic receipt", now)).toBe(false);
    expect(await queue.receipt(job.id)).toBe("Synthetic receipt");
  }
});
it("snapshots caller input before its first asynchronous boundary", async () => {
  const input = { kind: "reasoning" as const, dedupeKey: "initial", sourceId: "source", sourceRevision: 1, request: "Original request" };
  const pending = queue.enqueue(input, now);
  input.request = "Mutated request"; input.sourceId = "other"; input.dedupeKey = "mutated";
  const job = await pending;
  expect(JSON.parse((await queue.ledger(job.id))!.request_json)).toMatchObject({ sourceId: "source", input: "Original request", actor: { kind: "owner" } });
});
const enqueue = (key = "work", request = "Synthetic request", maxAttempts = 3) => queue.enqueue({
  kind: "reasoning", dedupeKey: key, sourceId: "source", sourceRevision: 1, request, maxAttempts,
}, now);
async function claim(): Promise<JobLease> {
  const lease = await queue.claim(now, 10);
  expect(lease).not.toBeNull();
  return lease!;
}
function provider() {
  const results = new Map<string, string>();
  let executions = 0;
  const api: ShadowProvider = {
    async execute(key, hash, request) {
      executions++;
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(request).toContain("Synthetic request");
      const result = "Synthetic shadow answer";
      results.set(key, result);
      return result;
    },
    async lookup(key) {
      const result = results.get(key);
      return result === undefined ? { state: "not_found" } : { state: "complete", result };
    },
  };
  return { api, results, executions: () => executions };
}
const controller = (api: ShadowProvider) => new JobController(queue, api, () => now);
const withdraw = () => env.DB.prepare(`UPDATE assistant_sources SET status='withdrawn',revision=2
  WHERE installation_id=? AND generation='g1' AND id='source'`).bind(scope.installationId).run();

it("persists ten admissions across controller restart and scopes reads", async () => {
  for (let index = 0; index < 10; index++) await enqueue(`work-${index}`);
  const restarted = new JobQueue(env.DB, scope);
  expect(await restarted.list()).toHaveLength(10);
  expect(await new JobQueue(env.DB, { ...scope, generation: "g2" }).list()).toEqual([]);
});
it("atomically grants only one consumer a lease", async () => {
  await enqueue();
  const leases = await Promise.all([queue.claim(now, 10), new JobQueue(env.DB, scope).claim(now, 10)]);
  expect(leases.filter(Boolean)).toHaveLength(1);
  expect((await queue.list())[0]).toMatchObject({ state: "processing", attempts: 1, lease_generation: 1 });
});
it("rejects conflicting effective request hashes under the same dedupe key", async () => {
  const job = await enqueue();
  expect((await enqueue()).id).toBe(job.id);
  await expect(enqueue("work", "Changed request")).rejects.toThrow("dedupe_request_conflict");
  expect(await queue.list()).toHaveLength(1);
});
it("completes only shadow computation and saves its receipt", async () => {
  const job = await enqueue();
  expect(await controller(provider().api).process(await claim())).toBe("shadow_completed");
  expect(await queue.get(job.id)).toMatchObject({ state: "shadow_completed" });
  expect(await queue.receipt(job.id)).toBe("Synthetic shadow answer");
});
it("denies stale lease completion while retaining late receipts", async () => {
  const job = await enqueue();
  const old = await claim();
  expect(await queue.admit(old, now)).not.toBeNull();
  now = 110;
  const current = await claim();
  expect(await queue.complete(old, "Late answer", now)).toBe(false);
  expect(await queue.receipt(job.id)).toBe("Late answer");
  expect(await queue.get(job.id)).toMatchObject({ state: "processing", lease_generation: 2 });
  expect(await controller(provider().api).process(current)).toBe("shadow_completed");
});
it("recovers a lost provider acknowledgement by lookup without a second execution", async () => {
  const job = await enqueue();
  const fake = provider();
  const execute = fake.api.execute;
  fake.api.execute = async (...args) => { await execute(...args); throw new Error("lost acknowledgement"); };
  expect(await controller(fake.api).process(await claim())).toBe("uncertain");
  now = 111;
  expect(await controller(fake.api).process(await claim())).toBe("shadow_completed");
  expect(fake.executions()).toBe(1);
  expect(await queue.receipt(job.id)).toBe("Synthetic shadow answer");
});
it("does not let a prepared old lease execute after a new lease is admitted", async () => {
  await enqueue();
  const old = await claim();
  now = 110;
  const current = await claim();
  const fake = provider();
  expect(await controller(fake.api).process(current)).toBe("shadow_completed");
  expect(await controller(fake.api).process(old)).toBe("stale");
  expect(fake.executions()).toBe(1);
});
it("never reexecutes an expired attempted job when provider lookup says not_found", async () => {
  const job = await enqueue();
  const old = await claim();
  expect(await queue.admit(old, now)).not.toBeNull();
  now = 110;
  const fake = provider();
  expect(await controller(fake.api).process(await claim())).toBe("uncertain");
  expect(fake.executions()).toBe(0);
  expect(await queue.get(job.id)).toMatchObject({ state: "failed", last_error: "provider_result_uncertain" });
});
it("expires the final crashed lease to a visible terminal failure", async () => {
  const job = await enqueue("work", "Synthetic request", 1);
  await queue.admit(await claim(), now);
  now = 110;
  expect(await queue.claim(now, 10)).toBeNull();
  expect(await queue.get(job.id)).toMatchObject({ state: "failed", last_error: "attempt_limit_exhausted" });
  expect(await queue.ledger(job.id)).toMatchObject({ state: "uncertain" });
});
it("blocks withdrawn sources before provider admission", async () => {
  const job = await enqueue();
  const lease = await claim();
  await withdraw();
  const fake = provider();
  expect(await controller(fake.api).process(lease)).toBe("blocked");
  expect(fake.executions()).toBe(0);
  expect(await queue.get(job.id)).toMatchObject({ state: "failed", last_error: "admission_rejected" });
});
it("retains a receipt but blocks publication when the source changes during execution", async () => {
  const job = await enqueue();
  const fake = provider();
  const execute = fake.api.execute;
  fake.api.execute = async (...args) => { const result = await execute(...args); await withdraw(); return result; };
  expect(await controller(fake.api).process(await claim())).toBe("blocked");
  expect(await queue.receipt(job.id)).toBe("Synthetic shadow answer");
  expect(await queue.get(job.id)).toMatchObject({ state: "failed", last_error: "publication_rejected" });
});
it("does not execute when the attempting commit acknowledgement is lost", async () => {
  const job = await enqueue();
  const admit = queue.admit.bind(queue);
  queue.admit = async (...args) => { await admit(...args); throw new Error("D1 acknowledgement lost"); };
  const fake = provider();
  expect(await controller(fake.api).process(await claim())).toBe("uncertain");
  expect(fake.executions()).toBe(0);
  expect(await queue.get(job.id)).toMatchObject({ state: "processing", lease_generation: 1 });
  expect(await queue.ledger(job.id)).toMatchObject({ state: "attempting", admitted_lease_generation: 1 });
  now = 111;
  queue.admit = admit;
  expect(await controller(fake.api).process(await claim())).toBe("uncertain");
  expect(fake.executions()).toBe(0);
  expect(await queue.get(job.id)).toMatchObject({ state: "failed", last_error: "provider_result_uncertain" });
});
it("keeps unavailable provider failures visible without claiming completion", async () => {
  const job = await enqueue();
  const api: ShadowProvider = {
    async execute() { throw new Error("provider unavailable"); },
    async lookup() { return { state: "unavailable" }; },
  };
  expect(await controller(api).process(await claim())).toBe("uncertain");
  expect(await queue.get(job.id)).toMatchObject({ state: "pending", last_error: "provider_execution_uncertain" });
  now = 111;
  expect(await controller(api).process(await claim())).toBe("uncertain");
  expect(await queue.get(job.id)).toMatchObject({ state: "failed", last_error: "provider_result_uncertain" });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
it("keeps the winning executor live when the same active lease is replayed", async () => {
  const job = await enqueue();
  const lease = await claim();
  const entered = deferred<void>();
  const release = deferred<void>();
  const fake = provider();
  const execute = fake.api.execute;
  fake.api.execute = async (...args) => { entered.resolve(); await release.promise; return execute(...args); };
  const first = controller(fake.api).process(lease);
  await entered.promise;
  expect(await controller(fake.api).process(lease)).toBe("stale");
  expect(await queue.get(job.id)).toMatchObject({ state: "processing" });
  release.resolve();
  expect(await first).toBe("shadow_completed");
  expect(fake.executions()).toBe(1);
});
it("fences an old executor paused with a prepared request before its admission", async () => {
  await enqueue();
  const old = await claim();
  const reached = deferred<void>();
  const release = deferred<void>();
  const admit = queue.admit.bind(queue);
  queue.admit = async (lease, timestamp) => {
    if (lease.lease_generation === old.lease_generation) { reached.resolve(); await release.promise; }
    return admit(lease, timestamp);
  };
  const fake = provider();
  const oldProcess = controller(fake.api).process(old);
  await reached.promise;
  now = 110;
  expect(await controller(fake.api).process(await claim())).toBe("shadow_completed");
  release.resolve();
  expect(await oldProcess).toBe("stale");
  expect(fake.executions()).toBe(1);
});
it("stores an actual late executor answer without publishing through its expired lease", async () => {
  const job = await enqueue();
  const entered = deferred<void>();
  const release = deferred<void>();
  const fake = provider();
  const execute = fake.api.execute;
  fake.api.execute = async (...args) => { entered.resolve(); await release.promise; return execute(...args); };
  const pending = controller(fake.api).process(await claim());
  await entered.promise;
  now = 110;
  const current = await claim();
  release.resolve();
  expect(await pending).toBe("stale");
  expect(await queue.receipt(job.id)).toBe("Synthetic shadow answer");
  expect(await queue.get(job.id)).toMatchObject({ state: "processing", lease_generation: 2 });
  expect(await controller(fake.api).process(current)).toBe("shadow_completed");
  expect(fake.executions()).toBe(1);
});
it("does not fail the winner when two prepared readers race for the same admission CAS", async () => {
  const job = await enqueue();
  const lease = await claim();
  const reached = deferred<void>();
  const release = deferred<void>();
  const admit = queue.admit.bind(queue);
  let calls = 0;
  queue.admit = async (...args) => {
    if (++calls === 1) { reached.resolve(); await release.promise; }
    return admit(...args);
  };
  const fake = provider();
  const first = controller(fake.api).process(lease);
  await reached.promise;
  expect(await controller(fake.api).process(lease)).toBe("shadow_completed");
  release.resolve();
  expect(await first).toBe("stale");
  expect(await queue.get(job.id)).toMatchObject({ state: "shadow_completed" });
  expect(fake.executions()).toBe(1);
});
it("does not let a stale admission error demote the newer executor ledger", async () => {
  const job = await enqueue();
  const old = await claim();
  const oldAdmission = deferred<void>();
  const rejectOld = deferred<void>();
  const executing = deferred<void>();
  const finish = deferred<void>();
  const admit = queue.admit.bind(queue);
  queue.admit = async (lease, timestamp) => {
    if (lease.lease_generation === old.lease_generation) {
      oldAdmission.resolve(); await rejectOld.promise; throw new Error("old admission failed without commit");
    }
    return admit(lease, timestamp);
  };
  const fake = provider();
  const execute = fake.api.execute;
  fake.api.execute = async (...args) => { executing.resolve(); await finish.promise; return execute(...args); };
  const oldProcess = controller(fake.api).process(old);
  await oldAdmission.promise;
  now = 110;
  const current = await claim();
  const currentProcess = controller(fake.api).process(current);
  await executing.promise;
  rejectOld.resolve();
  expect(await oldProcess).toBe("uncertain");
  expect(await queue.ledger(job.id)).toMatchObject({ state: "attempting", admitted_lease_generation: 2 });
  expect(await controller(fake.api).process(current)).toBe("stale");
  expect(await queue.get(job.id)).toMatchObject({ state: "processing" });
  finish.resolve();
  expect(await currentProcess).toBe("shadow_completed");
  expect(fake.executions()).toBe(1);
});
it("keeps the result bound to the original job when a caller mutates its lease during execution", async () => {
  const first = await enqueue("first");
  const lease = await claim();
  const second = await enqueue("second");
  const other = await claim();
  await queue.admit(other, now);
  const fake = provider();
  const execute = fake.api.execute;
  fake.api.execute = async (...args) => { lease.id = second.id; return execute(...args); };
  expect(await controller(fake.api).process(lease)).toBe("shadow_completed");
  expect(await queue.receipt(first.id)).toBe("Synthetic shadow answer");
  expect(await queue.receipt(second.id)).toBeNull();
  expect(await queue.get(second.id)).toMatchObject({ state: "processing" });
});
it("preserves a same-generation admission winner when its competing admission throws without committing", async () => {
  const job = await enqueue();
  const lease = await claim();
  const firstAtAdmission = deferred<void>(), rejectFirst = deferred<void>();
  const executing = deferred<void>(), finish = deferred<void>();
  const admit = queue.admit.bind(queue);
  let admissions = 0;
  queue.admit = async (...args) => {
    if (++admissions === 1) { firstAtAdmission.resolve(); await rejectFirst.promise; throw new Error("competing admission failed"); }
    return admit(...args);
  };
  const fake = provider(), execute = fake.api.execute;
  fake.api.execute = async (...args) => { executing.resolve(); await finish.promise; return execute(...args); };
  const first = controller(fake.api).process(lease);
  await firstAtAdmission.promise;
  const winner = controller(fake.api).process(lease);
  await executing.promise;
  rejectFirst.resolve();
  expect(await first).toBe("uncertain");
  expect(await queue.ledger(job.id)).toMatchObject({ state: "attempting", admitted_lease_generation: 1 });
  expect(await queue.get(job.id)).toMatchObject({ state: "processing" });
  expect(await controller(fake.api).process(lease)).toBe("stale");
  finish.resolve();
  expect(await winner).toBe("shadow_completed");
  expect(fake.executions()).toBe(1);
});
