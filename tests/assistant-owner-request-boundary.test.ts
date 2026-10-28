import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { SourceController } from "../assistant/sources";
import { SourceAccess } from "../assistant/access";
import { OwnerQueries } from "../assistant/mcp";
import { JobQueue } from "../assistant/queue";

const owner = { kind: "owner" } as const;
let scope: { installationId: string; generation: string; sourceEpoch: string; sourceGeneration: string };
let requestId: string, controller: SourceController;
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g1", sourceEpoch: "epoch", sourceGeneration: "capture" };
  controller = new SourceController(env.DB, scope, owner);
  const source = await controller.create({ originKey: "synthetic-operational-fixture", text: "Será que devo criar uma missão?", occurredAt: 1 });
  requestId = source.id;
  // Synthetic fixture only: production must capture from an admitted turn.
  await env.DB.prepare("UPDATE assistant_sources SET origin='owner_request',origin_key=? WHERE installation_id=? AND generation=? AND id=?")
    .bind(JSON.stringify(["telegram-owner-request-v1", "synthetic_bot", 3]), scope.installationId, scope.generation, requestId).run();
});

it("keeps an exact owner audit read while excluding operational requests from factual inventories and lists", async () => {
  const access = new SourceAccess(env.DB, scope);
  expect((await access.read(owner, requestId))?.text).toBe("Será que devo criar uma missão?");
  for (const query of [access.ownerRows(), access.inventory(owner, undefined, Date.now())]) {
    const rows = (await env.DB.prepare(query.sql).bind(...query.values).all<{ id: string }>()).results;
    expect(rows.map(row => row.id)).not.toContain(requestId);
  }
  const result = await new OwnerQueries(env.DB, scope).execute({ kind: "sources", limit: 10 });
  expect(JSON.stringify(result)).not.toContain(requestId);
});

it("denies correction and sharing of an operational request through both direct and ledger commands", async () => {
  await expect(controller.correct(requestId, 1, { text: "fato inventado", occurredAt: 2 })).rejects.toThrow("source_revision_conflict");
  await expect(controller.changeAudience(requestId, 1, "public")).rejects.toThrow("source_revision_conflict");
  await expect(controller.execute({ kind: "source.change_audience", operationId: "share-request", id: requestId, expectedRevision: 1, audience: "public" })).rejects.toThrow("source_revision_conflict");
  expect((await new SourceAccess(env.DB, scope).read(owner, requestId))?.fence.source).toMatchObject({ revision: 1, origin: "owner_request", audience: "owner" });
});

it("does not allow ordinary extraction or reasoning jobs to execute an operational request", async () => {
  const queue = new JobQueue(env.DB, scope);
  for (const kind of ["extraction", "reasoning"] as const)
    await expect(queue.enqueue({ kind, dedupeKey: kind, sourceId: requestId, sourceRevision: 1, request: "synthetic request" }, Date.now())).rejects.toThrow("operational_source_requires_owner_dialogue");
});

it("enforces private immutable operational request identity at the database boundary while permitting withdrawal", async () => {
  const mutate = (assignment: string) => env.DB.prepare(`UPDATE assistant_sources SET ${assignment} WHERE installation_id=? AND generation=? AND id=?`)
    .bind(scope.installationId, scope.generation, requestId).run();
  await expect(mutate("audience='public'")).rejects.toThrow("immutable_owner_request");
  await expect(mutate("origin='owner_note'")).rejects.toThrow("immutable_owner_request");
  await expect(mutate("origin_key='other-message'")).rejects.toThrow("immutable_owner_request");
  await expect(mutate("project_id='fake-project'")).rejects.toThrow("immutable_owner_request");
  await mutate("status='withdrawn',current_version=NULL,revision=revision+1");
  expect(await new SourceAccess(env.DB, scope).read(owner, requestId)).toBeNull();
});
