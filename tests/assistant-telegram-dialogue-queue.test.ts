import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { JobQueue, type NewJob } from "../assistant/queue";
import { TelegramOwnerInbox, type TelegramOwnerTurn } from "../assistant/telegram-owner-inbox";
import { TelegramOwnerRequests } from "../assistant/telegram-owner-requests";
import { TelegramLink } from "../assistant/telegram-auth";
import { SourceController } from "../assistant/sources";
import { InferenceBudget } from "../assistant/budget";
import { CogneeModelBroker } from "../assistant/model-broker";

const bot = "synthetic_dialogue_bot", secret = "synthetic-dialogue-webhook-secret-for-tests";
let scope: { installationId: string; generation: string; sourceEpoch: string; sourceGeneration: string };
let inbox: TelegramOwnerInbox, turn: TelegramOwnerTurn, queue: JobQueue, link: TelegramLink, input: NewJob;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const admission = () => ({ id: crypto.randomUUID(), guard: inbox.guard(turn), statements: [] });
beforeEach(async () => {
  scope = { installationId: crypto.randomUUID(), generation: "g1", sourceEpoch: "epoch", sourceGeneration: "capture" };
  await env.DB.prepare("INSERT INTO assistant_telegram_links VALUES(?,?,?,?,?,1,'active','101','101',?)")
    .bind(scope.installationId, scope.generation, bot, scope.sourceEpoch, scope.sourceGeneration, Math.floor(Date.now() / 1000) - 10).run();
  link = new TelegramLink(env.DB, scope, bot, secret); inbox = new TelegramOwnerInbox(env.DB, scope, bot);
  const activation = await inbox.activate(); await wait(Math.max(1, (activation.cutoffSecond + 1) * 1000 - Date.now() + 10));
  expect(await link.receive({ update_id: 3, message: { message_id: 103, date: Math.floor(Date.now() / 1000), from: { id: 101, is_bot: false }, chat: { id: 101, type: "private" }, text: "O que ficou pendente?" } })).toBe("pending");
  turn = (await inbox.claim(3))!;
  const source = (await new TelegramOwnerRequests(env.DB, inbox, { allow: async () => {}, withdraw: async () => {} }).capture(turn))!;
  queue = new JobQueue(env.DB, scope, { kind: "owner" }, async () => ({ guard: inbox.guard(turn), statements: [] }));
  input = { kind: "reasoning", dedupeKey: "telegram-owner-v1:synthetic-request", sourceId: source.id, sourceRevision: 1, request: "telegram-owner-dialogue-v1", maxAttempts: 1, runtime: "flue_owner_dialogue" };
});

it("admits an explicit owner dialogue without copying its text or inventing a shadow decision", async () => {
  const job = await queue.enqueue(input, Date.now(), admission());
  const ledger = (await queue.ledger(job.id))!;
  expect(ledger.request_json).not.toContain(turn.text);
  expect(JSON.parse(ledger.request_json)).toMatchObject({ runtime: "flue_owner_dialogue", input: "telegram-owner-dialogue-v1", actor: { kind: "owner" } });
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_decision_jobs WHERE installation_id=? AND generation=?").bind(scope.installationId, scope.generation).first("n")).toBe(0);
  expect(await new JobQueue(env.DB, scope).claim(Date.now())).toBeNull();
  expect(await new JobQueue(env.DB, scope).claimId(job.id, Date.now())).toBeNull();
  const lease = (await queue.claimId(job.id, Date.now(), 60000, inbox.guard(turn)))!;
  expect(lease).toMatchObject({ id: job.id, attempts: 1, max_attempts: 1 });
  expect(await queue.admit(lease, Date.now())).not.toBeNull();
  expect(await queue.isAuthorized(lease, Date.now())).toBe(true);
  expect(await new JobQueue(env.DB, scope).isAuthorized(lease, Date.now())).toBe(false);
});

it("requires current host admission, the dialogue runtime and an operational owner source", async () => {
  await expect(queue.enqueue(input, Date.now())).rejects.toThrow("owner_dialogue_admission_required");
  await expect(new JobQueue(env.DB, scope).enqueue(input, Date.now(), admission())).rejects.toThrow("owner_dialogue_admission_required");
  const note = await new SourceController(env.DB, scope, { kind: "owner" }).create({ originKey: "note", text: "factual note", occurredAt: 1 });
  await expect(queue.enqueue({ ...input, sourceId: note.id }, Date.now(), admission())).rejects.toThrow("owner_dialogue_source_required");
  for (const patch of [{ maxAttempts: 2 }, { kind: "extraction" }, { request: turn.text }, { dedupeKey: "ordinary" }, { runtime: undefined }])
    await expect(queue.enqueue({ ...input, ...patch } as NewJob, Date.now(), admission())).rejects.toThrow();
});

it("does not execute after link revocation even when the job already owns a lease", async () => {
  const job = await queue.enqueue(input, Date.now(), admission()), lease = (await queue.claimId(job.id, Date.now(), 60000, inbox.guard(turn)))!;
  await link.execute({ kind: "telegram_link.revoke", operationId: "revoke-dialogue", expectedRevision: 1 });
  expect(await queue.admit(lease, Date.now())).toBeNull();
  expect(await queue.isAuthorized(lease, Date.now())).toBe(false);
});

it.each(["dedupe_key", "max_attempts"])("pins the dialogue's %s when recovering authorization", async field => {
  const job = await queue.enqueue(input, Date.now(), admission()), lease = (await queue.claimId(job.id, Date.now(), 60000, inbox.guard(turn)))!;
  expect(await queue.isAuthorized(lease, Date.now())).toBe(true);
  await env.DB.prepare(`UPDATE assistant_jobs SET ${field}=? WHERE installation_id=? AND generation=? AND id=?`)
    .bind(field === "dedupe_key" ? "ordinary-job" : 2, scope.installationId, scope.generation, job.id).run();
  expect(await queue.admit(lease, Date.now())).toBeNull(); expect(await queue.isAuthorized(lease, Date.now())).toBe(false);
});

it("refuses generic completion before writing any receipt or completing the ledger", async () => {
  const job = await queue.enqueue(input, Date.now(), admission()), lease = (await queue.claimId(job.id, Date.now(), 60000, inbox.guard(turn)))!;
  await queue.admit(lease, Date.now());
  await expect(queue.recordResult(lease, "made-up-completion", Date.now())).rejects.toThrow("owner_dialogue_completion_required");
  await expect(queue.complete(lease, "made-up-completion", Date.now())).rejects.toThrow("owner_dialogue_completion_required");
  expect(await queue.receipt(job.id)).toBeNull(); expect((await queue.ledger(job.id))?.state).toBe("attempting");
  expect(await queue.publish(lease, Date.now())).toBe(false);
  expect(await queue.publicationPlan(lease, Date.now(), { sql: "1", values: [] })).toBeNull();
});

it("keeps dialogue attempts out of global expiry sweeps as well as the global claim", async () => {
  const job = await queue.enqueue(input, Date.now(), admission()), lease = (await queue.claimId(job.id, Date.now(), 1000, inbox.guard(turn)))!;
  await queue.admit(lease, Date.now());
  expect(await new JobQueue(env.DB, scope).claim(lease.lease_until + 1)).toBeNull();
  expect(await queue.get(job.id)).toMatchObject({ state: "processing", lease_until: lease.lease_until, attempts: 1 });
  expect((await queue.ledger(job.id))?.state).toBe("attempting");
});

it("keeps the complete dialogue execution guard inside the broker's real transactional admission", async () => {
  const job = await queue.enqueue(input, Date.now(), admission()), lease = (await queue.claimId(job.id, Date.now(), 60000, inbox.guard(turn)))!;
  const budgetScope = { ...scope, period: "2026-10-28" }; await new InferenceBudget(env.DB, budgetScope).configure(50);
  let calls = 0;
  const broker = new CogneeModelBroker(env.DB, budgetScope, { extractionConfig: "synthetic-dialogue-depth", priceVersion: "synthetic", chatModel: "gpt-6-luna", embeddingModel: "text-embedding-3-small", maxOutputTokens: 100, chatCeiling: 5, embeddingCeiling: 2 }, async () => {
    calls++; return { status: 200, body: '{"choices":[{"message":{"content":"synthetic intent"}}]}', actualUnits: 1 };
  }, Date.now, { uncertain: () => queue.uncertain(lease), prepare: async () => {
    const plan = await queue.admissionPlan(lease, Date.now());
    return plan ? { statements: [...plan.statements, plan.statement], guard: plan.executionGuard } : null;
  } });
  const token = await broker.issuePermit(input.sourceId, 1, turn.deadlineAt);
  expect(await broker.invoke(token, "/v1/chat/completions", { model: "gpt-6-luna", messages: [{ role: "user", content: turn.text }] })).toMatchObject({ state: "complete" });
  expect(calls).toBe(1);
});
