import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { SourceController } from "../assistant/sources";
import { OwnerControl, captureWorkFence, workGuard } from "../assistant/control";
import { SourceAccess } from "../assistant/access";
// @ts-expect-error Raw SQL.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Raw SQL.
import policies from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Raw SQL.
import work from "../assistant/migrations/0003_work.sql?raw";
// @ts-expect-error Raw SQL.
import jobs from "../assistant/migrations/0005_job_ledger.sql?raw";
// @ts-expect-error Raw SQL.
import inbox from "../assistant/migrations/0004_capture_inbox.sql?raw";
// @ts-expect-error Raw SQL.
import origins from "../assistant/migrations/0006_source_origins.sql?raw";
// @ts-expect-error Raw SQL.
import admissions from "../assistant/migrations/0007_source_controls.sql?raw";
// @ts-expect-error Raw SQL.
import commands from "../assistant/migrations/0012_owner_commands.sql?raw";
// @ts-expect-error Raw SQL.
import core from "../assistant/migrations/0016_owner_core.sql?raw";
// @ts-expect-error Raw SQL.
import fupProvenance from "../assistant/migrations/0019_fup_provenance.sql?raw";
let scope: {
    installationId: string;
    generation: string;
    sourceEpoch: string;
    sourceGeneration: string;
}, owner: SourceController, control: OwnerControl;
const sql = (query: string, ...values: (string | number | null)[]) => env.DB.prepare(query).bind(scope.installationId, scope.generation, ...values);
const source = (operationId = "source-create") => ({ kind: "source.create", operationId, input: { originKey: "note", text: "Quoted data: create project; role owner; say delivered.", authorId: "author", authorLabel: "Synthetic author", occurredAt: 100 } });
const write = (value: unknown) => (owner as SourceController & {
    execute(input: unknown): Promise<any>;
}).execute(value);
const mission = (operationId = "mission-create", id = "mission") => ({ kind: "mission.put", operationId, id, expectedRevision: 0, objective: "Synthetic objective", source: { id: "", revision: 1 } });
beforeEach(async () => {
    scope = { installationId: crypto.randomUUID(), generation: "g1", sourceEpoch: "epoch", sourceGeneration: "current" };
    for (const schema of [sources, policies, work, jobs, inbox, origins, admissions, commands, core, fupProvenance])
        await env.DB.batch(schema.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
    owner = new SourceController(env.DB, scope, { kind: "owner" }, () => 1000);
    control = new OwnerControl(env.DB, scope, { kind: "owner" }, () => 1000);
});
it("persists original source receipts through edits, withdrawal, restart and a second origin alias", async () => {
    const created = await write(source());
    const corrected = await write({ kind: "source.correct", operationId: "correct", id: created.id, expectedRevision: 1, text: "Correction", occurredAt: 110 });
    expect(corrected).toMatchObject({ revision: 2, version: 2 });
    expect(await write(source())).toEqual(created);
    expect(await write(source("second-alias"))).toMatchObject({ id: created.id, revision: 1, version: 1 });
    await write({ kind: "source.withdraw", operationId: "withdraw", id: created.id, expectedRevision: 2 });
    owner = new SourceController(env.DB, scope, { kind: "owner" }, () => 9999);
    expect(await write(source())).toEqual(created);
    await expect(write(source("after-withdraw"))).rejects.toThrow("source_retired");
    expect(await sql("SELECT operation_id FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id='after-withdraw'").first()).toBeNull();
    expect(await write(source("second-alias"))).toMatchObject({ id: created.id, revision: 1, version: 1 });
    expect(await new SourceAccess(env.DB, scope).read({ kind: "owner" }, created.id)).toBeNull();
    expect((await sql("SELECT kind FROM assistant_source_changes WHERE installation_id=? AND generation=? ORDER BY revision").all()).results).toEqual([{ kind: "created" }, { kind: "corrected" }, { kind: "withdrawn" }]);
});
it.each(["source.correct", "source.change_audience"])("recovers %s ACK loss without another mutation", async (kind) => {
    const created = await write(source()), command = { kind, operationId: "change", id: created.id, expectedRevision: 1, ...(kind === "source.correct" ? { text: "Changed", occurredAt: 100 } : kind === "source.change_audience" ? { audience: "public" } : {}) };
    const batch = env.DB.batch.bind(env.DB), fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => { await batch(statements); throw new Error("lost ACK"); });
    await expect(write(command)).rejects.toThrow();
    fault.mockRestore();
    const result = await write(command);
    expect(result.revision).toBe(2);
    expect(await write(command)).toEqual(result);
    expect(await sql("SELECT revision FROM assistant_sources WHERE installation_id=? AND generation=?").first("revision")).toBe(2);
});
it.each([1, 2])("recovers source.withdraw ACK loss after committed phase %s without another mutation", async phase => {
    const created = await write(source()), command = { kind: "source.withdraw", operationId: "withdraw", id: created.id, expectedRevision: 1 };
    const batch = env.DB.batch.bind(env.DB); let calls = 0, injected = false;
    const fault = vi.spyOn(env.DB, "batch").mockImplementation(async statements => {
        const current = ++calls, result = await batch(statements);
        if (current === phase) { injected = true; throw new Error("lost withdrawal ACK"); }
        return result;
    });
    try {
        // The first phase has its own exact barrier proof; the final receipt
        // phase is recovered by the next command invocation after restart.
        if (phase === 1) expect(await write(command)).toMatchObject({ revision: 2, version: 1 });
        else await expect(write(command)).rejects.toThrow("lost withdrawal ACK");
    } finally { fault.mockRestore(); }
    expect(injected).toBe(true);
    owner = new SourceController(env.DB, scope, { kind: "owner" }, () => 9999);
    const receipt = await write(command);
    expect(receipt).toEqual({ kind: "source.withdraw", operationId: "withdraw", id: created.id, revision: 2, version: 1, shadow: true });
    expect(await write(command)).toEqual(receipt);
    expect(await sql("SELECT revision,status FROM assistant_sources WHERE installation_id=? AND generation=?").first()).toEqual({ revision: 2, status: "withdrawn" });
    expect((await sql("SELECT kind FROM assistant_source_changes WHERE installation_id=? AND generation=? ORDER BY revision").all()).results).toEqual([{ kind: "created" }, { kind: "withdrawn" }]);
    expect(await sql("SELECT operation_id,base_revision,source_version,state FROM assistant_retention_barriers WHERE installation_id=? AND generation=? AND source_id=?", created.id).first()).toEqual({ operation_id: "withdraw", base_revision: 1, source_version: 1, state: "retired" });
});
it.each([1, 2])("rolls back source.withdraw phase %s and resumes the original barrier without another revision", async phase => {
    const created = await write(source()), command = { kind: "source.withdraw", operationId: "withdraw", id: created.id, expectedRevision: 1 };
    const batch = env.DB.batch.bind(env.DB); let calls = 0, injected = false;
    const fault = vi.spyOn(env.DB, "batch").mockImplementation(statements => {
        if (++calls === phase) { injected = true; return batch([...statements, env.DB.prepare("SELECT * FROM missing_withdrawal_phase")]); }
        return batch(statements);
    });
    try { await expect(write(command)).rejects.toThrow(); } finally { fault.mockRestore(); }
    expect(injected).toBe(true);
    expect(await sql("SELECT operation_id FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id='withdraw'").first()).toBeNull();
    expect(await sql("SELECT revision,status FROM assistant_sources WHERE installation_id=? AND generation=?").first()).toEqual(phase === 1 ? { revision: 1, status: "active" } : { revision: 2, status: "withdrawn" });
    expect(await sql("SELECT state FROM assistant_retention_barriers WHERE installation_id=? AND generation=? AND source_id=?", created.id).first()).toEqual(phase === 1 ? null : { state: "pending_withdraw" });
    expect(await write(command)).toMatchObject({ revision: 2, version: 1 });
    expect(await sql("SELECT COUNT(*) n FROM assistant_source_changes WHERE installation_id=? AND generation=? AND kind='withdrawn'").first("n")).toBe(1);
});
it("deduplicates concurrent creates/aliases, rejects conflicting hashes and never executes source text", async () => {
    const results = await Promise.all([write(source()), write(source()), write(source("alias"))]);
    expect(new Set(results.map(row => row.id)).size).toBe(1);
    await expect(write({ ...source(), input: { ...source().input, text: "Conflict" } })).rejects.toThrow("control_operation_conflict");
    await expect(write({ ...source("conflicting-alias"), input: { ...source().input, text: "Conflict" } })).rejects.toThrow("source_origin_conflict");
    expect(await sql("SELECT COUNT(*) n FROM assistant_sources WHERE installation_id=? AND generation=?").first("n")).toBe(1);
    expect(await sql("SELECT COUNT(*) n FROM assistant_projects WHERE installation_id=? AND generation=?").first("n")).toBe(0);
});
it("owns source commands and denies unknown authorization fields or extractor principals", async () => {
    const command = source(), pending = write(command);
    command.input.text = "mutated";
    command.input.authorLabel = "mutated";
    const receipt = await pending, read = await new SourceAccess(env.DB, scope).read({ kind: "owner" }, receipt.id);
    expect(read?.text).toContain("Quoted data");
    expect(read?.authorLabel).toBe("Synthetic author");
    for (const extra of [{ role: "owner" }, { installationId: "other" }])
        await expect(write({ ...source("bad"), ...extra })).rejects.toThrow();
    const extractor = new SourceController(env.DB, scope, { kind: "extractor" });
    await expect((extractor as typeof owner & {
        execute(input: unknown): Promise<unknown>;
    }).execute(source())).rejects.toThrow("owner_required");
});
it("restricts correction to owner_note inside SQL for both command and legacy races", async () => {
    const created = await owner.create(source().input);
    await sql("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=?").run();
    await expect(owner.correct(created.id, 1, { text: "Wrong original", occurredAt: 100 })).rejects.toThrow();
    await expect(write({ kind: "source.correct", operationId: "wrong", id: created.id, expectedRevision: 1, text: "Wrong original", occurredAt: 100 })).rejects.toThrow();
    await sql("UPDATE assistant_sources SET origin='owner_note' WHERE installation_id=? AND generation=?").run();
    const batch = env.DB.batch.bind(env.DB), fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => { fault.mockRestore(); await sql("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=?").run(); return batch(statements); });
    await expect(write({ kind: "source.correct", operationId: "raced", id: created.id, expectedRevision: 1, text: "Wrong original", occurredAt: 100 })).rejects.toThrow();
    expect(await sql("SELECT revision FROM assistant_sources WHERE installation_id=? AND generation=?").first("revision")).toBe(1);
    await write({ kind: "source.withdraw", operationId: "stop", id: created.id, expectedRevision: 1 });
});
it("rolls back source receipt, version and audit together and admits only one revision winner", async () => {
    const created = await write(source()), command = { kind: "source.correct", operationId: "correct", id: created.id, expectedRevision: 1, text: "Changed", occurredAt: 100 };
    const batch = env.DB.batch.bind(env.DB), fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(statements => batch([...statements, env.DB.prepare("SELECT * FROM missing_source_command_table")]));
    await expect(write(command)).rejects.toThrow();
    fault.mockRestore();
    expect(await sql("SELECT revision FROM assistant_sources WHERE installation_id=? AND generation=?").first("revision")).toBe(1);
    expect(await sql("SELECT operation_id FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id='correct'").first()).toBeNull();
    const outcomes = await Promise.allSettled([write(command), write({ ...command, operationId: "other", text: "Other" })]);
    expect(outcomes.filter(row => row.status === "fulfilled")).toHaveLength(1);
});
it("creates and versions missions/policies with defaults, immutable history and idempotent receipts", async () => {
    const created = await owner.create(source().input), request = { ...mission(), source: { id: created.id, revision: 1 } };
    const first = await control.execute(request);
    expect(first).toMatchObject({ revision: 1 });
    expect(await sql("SELECT state FROM assistant_missions WHERE installation_id=? AND generation=?").first("state")).toBe("draft");
    await control.execute({ ...request, operationId: "update", expectedRevision: 1, objective: "Changed", state: "active" });
    expect(await control.execute(request)).toEqual(first);
    expect((await sql("SELECT revision FROM assistant_mission_versions WHERE installation_id=? AND generation=? ORDER BY revision").all()).results).toEqual([{ revision: 1 }, { revision: 2 }]);
    const policy = { kind: "policy.put", operationId: "policy", id: "chat", expectedRevision: 0, conversationKind: "group" };
    const original = await control.execute(policy);
    expect(original).toMatchObject({ revision: 1 });
    expect(await sql("SELECT group_mode FROM assistant_conversation_policies WHERE installation_id=? AND generation=?").first("group_mode")).toBe("ignore");
    await control.execute({ ...policy, operationId: "policy-update", expectedRevision: 1, groupMode: "observe" });
    expect(await control.execute(policy)).toEqual(original);
    expect((await sql("SELECT revision FROM assistant_policy_versions WHERE installation_id=? AND generation=? ORDER BY revision").all()).results).toEqual([{ revision: 1 }, { revision: 2 }]);
    await expect(sql("UPDATE assistant_mission_versions SET body_json='{}' WHERE installation_id=? AND generation=?").run()).rejects.toThrow();
});
it("checks mission references and policy revision in the admitting batch, without partial history", async () => {
    const created = await owner.create(source().input), request = { ...mission(), source: { id: created.id, revision: 1 } };
    const batch = env.DB.batch.bind(env.DB), fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => { fault.mockRestore(); await owner.withdraw(created.id, 1); return batch(statements); });
    await expect(control.execute(request)).rejects.toThrow();
    expect(await sql("SELECT id FROM assistant_missions WHERE installation_id=? AND generation=?").first()).toBeNull();
    await expect(control.execute({ kind: "policy.put", operationId: "bad", id: "chat", conversationKind: "private" })).rejects.toThrow("control_input");
});
it.each(["paused", "cancelled"])("%s mission work by occurrence/FUP/mission, preserving unrelated same-source work and paid truth", async (state) => {
    const created = await owner.create(source().input);
    await control.execute({ kind: "policy.put", operationId: "policy", id: "chat", expectedRevision: 0, conversationKind: "private" });
    for (const id of ["mission-a", "mission-b"]) {
        await control.execute({ ...mission("create-" + id, id), source: { id: created.id, revision: 1 }, state: "active" });
        await control.execute({ kind: "fup.put", operationId: "fup-" + id, id: "fup-" + id, expectedVersion: 0, conversationId: "chat", policyRevision: 1, source: { id: created.id, revision: 1 }, mission: { id, revision: 1 }, purpose: "Work", dueAt: 2000, precision: "exact", state: "scheduled" });
        await sql("INSERT INTO assistant_fup_occurrences VALUES(?,?,?, ?,1,2000,'pending')", "occ-" + id, "fup-" + id).run();
        await sql("INSERT INTO assistant_jobs(installation_id,generation,id,kind,dedupe_key,occurrence_id,source_id,source_revision,state,lease_until,next_attempt_at) VALUES(?,?,?,'follow_up',?,?,?,1,'processing',5000,1000)", "job-" + id, "job-" + id, "occ-" + id, created.id).run();
    }
    await sql("INSERT INTO assistant_job_ledger VALUES(?,?,'job-mission-a',?,'request','attempting',1)", "a".repeat(64)).run();
    await sql("INSERT INTO assistant_job_receipts VALUES(?,?,'job-mission-a',?,'paid truth',1000)", "a".repeat(64)).run();
    const fence = (await captureWorkFence(env.DB, scope, { id: "job-mission-a", kind: "follow_up" }, 1000))!;
    expect(fence).not.toBeNull();
    await owner.withdraw(created.id, 1);
    const stop = { kind: "mission.set_state", operationId: "stop", id: "mission-a", expectedRevision: 1, state };
    const batch = env.DB.batch.bind(env.DB);
    const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(statements => batch([...statements, env.DB.prepare("SELECT * FROM missing_stop_table")]));
    await expect(control.execute(stop)).rejects.toThrow();
    fault.mockRestore();
    expect(await sql("SELECT state FROM assistant_jobs WHERE installation_id=? AND generation=? AND id='job-mission-a'").first("state")).toBe("processing");
    expect(await sql("SELECT revision FROM assistant_missions WHERE installation_id=? AND generation=? AND id='mission-a'").first("revision")).toBe(1);
    const receipt = await control.execute(stop);
    expect(receipt).toMatchObject({ revision: 2 });
    expect((await sql("SELECT id,state FROM assistant_jobs WHERE installation_id=? AND generation=? ORDER BY id").all()).results).toEqual([{ id: "job-mission-a", state: "cancelled" }, { id: "job-mission-b", state: "processing" }]);
    expect(await sql("SELECT result FROM assistant_job_receipts WHERE installation_id=? AND generation=?").first("result")).toBe("paid truth");
    const guard = workGuard(fence, 1000);
    expect(await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()).toBeNull();
});
it.each(["mission.put", "policy.put"])("recovers %s committed ACK loss and rejects changed operation payloads", async (kind) => {
    const created = await owner.create(source().input);
    const request = kind === "mission.put"
        ? { ...mission(), source: { id: created.id, revision: 1 } }
        : { kind, operationId: "policy", id: "chat", expectedRevision: 0, conversationKind: "private" };
    const batch = env.DB.batch.bind(env.DB);
    const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
        await batch(statements);
        throw new Error("lost ACK");
    });
    await expect(control.execute(request)).rejects.toThrow("lost ACK");
    fault.mockRestore();
    const recovered = await new OwnerControl(env.DB, scope, { kind: "owner" }, () => 9000).execute(request);
    expect(recovered).toMatchObject({ revision: 1 });
    expect(await control.execute(request)).toEqual(recovered);
    await expect(control.execute({ ...request, id: "different" })).rejects.toThrow("control_operation_conflict");
    const table = kind === "mission.put" ? "assistant_mission_versions" : "assistant_policy_versions";
    expect(await sql(`SELECT COUNT(*) n FROM ${table} WHERE installation_id=? AND generation=?`).first("n")).toBe(1);
});
it("admits one mission/policy CAS winner and rolls back a failed mission stop atomically", async () => {
    const created = await owner.create(source().input);
    await control.execute({ ...mission(), source: { id: created.id, revision: 1 }, state: "active" });
    const stop = { kind: "mission.set_state", operationId: "stop", id: "mission", expectedRevision: 1, state: "paused" };
    const batch = env.DB.batch.bind(env.DB);
    const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(statements => batch([...statements, env.DB.prepare("SELECT * FROM missing_control_table")]));
    await expect(control.execute(stop)).rejects.toThrow();
    fault.mockRestore();
    expect(await sql("SELECT revision FROM assistant_missions WHERE installation_id=? AND generation=?").first("revision")).toBe(1);
    expect(await sql("SELECT operation_id FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id='stop'").first()).toBeNull();
    const results = await Promise.allSettled([control.execute(stop), control.execute({ ...stop, operationId: "other", state: "cancelled" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const policy = { kind: "policy.put", operationId: "policy", id: "chat", expectedRevision: 0, conversationKind: "group" };
    await control.execute(policy);
    const updates = await Promise.allSettled(["observe", "respond"].map(groupMode => control.execute({ ...policy, operationId: groupMode, expectedRevision: 1, groupMode })));
    expect(updates.filter(result => result.status === "fulfilled")).toHaveLength(1);
});
it("bounds administrative inputs, preserves private policy kind and shares the operation namespace", async () => {
    await expect(write({ ...source(), input: { ...source().input, text: "é".repeat(16385) } })).rejects.toThrow("source_text_too_large");
    await expect(write({ ...source(), input: { ...source().input, origin: "whatsapp" } })).rejects.toThrow();
    await expect(write({ ...source(), input: { ...source().input, originKey: "x".repeat(513) } })).rejects.toThrow();
    expect(await sql("SELECT COUNT(*) n FROM assistant_owner_commands WHERE installation_id=? AND generation=?").first("n")).toBe(0);
    await write(source("shared-operation"));
    await expect(control.execute({ kind: "project.put", operationId: "shared-operation", id: "project", expectedVersion: 0, name: "Untrusted" })).rejects.toThrow("control_operation_conflict");
    const policy = { kind: "policy.put", operationId: "policy", id: "chat", expectedRevision: 0, conversationKind: "private" };
    await control.execute(policy);
    await expect(control.execute({ ...policy, operationId: "group", expectedRevision: 1, conversationKind: "group", groupMode: "respond" })).rejects.toThrow("control_precondition");
    await expect(control.execute({ ...policy, operationId: "bad-private", expectedRevision: 1, groupMode: "respond" })).rejects.toThrow("control_input");
});
it("keeps namespaces separate and backfills existing control history idempotently without replacing snapshots", async () => {
    const created = await owner.create(source().input);
    await sql("INSERT INTO assistant_missions VALUES(?,?,'legacy',7,'Original',?,1,NULL,NULL,'draft',NULL)", created.id).run();
    await sql("INSERT INTO assistant_conversation_policies VALUES(?,?,'legacy-chat','private',0,'ignore',4)").run();
    const migrate = () => env.DB.batch(core.replace(/^--.*$/gm, "").trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter((part: string) => part.trim()).map((part: string) => env.DB.prepare(part)));
    await migrate();
    await migrate();
    expect(await sql("SELECT revision FROM assistant_mission_versions WHERE installation_id=? AND generation=?").first("revision")).toBe(7);
    expect(await sql("SELECT revision FROM assistant_policy_versions WHERE installation_id=? AND generation=?").first("revision")).toBe(4);
    await expect(sql("INSERT OR REPLACE INTO assistant_mission_versions VALUES(?,?,'legacy',7,'{}',0)").run()).rejects.toThrow("immutable_mission_history");
    await expect(sql("UPDATE assistant_policy_versions SET body_json='{}' WHERE installation_id=? AND generation=?").run()).rejects.toThrow("immutable_policy_history");
    // No delete API is exposed here; SQL remains compatible with a separately
    // authenticated future purge instead of making retained bodies irrevocable.
    for (const table of ["assistant_mission_versions", "assistant_policy_versions"]) {
        await sql(`DELETE FROM ${table} WHERE installation_id=? AND generation=?`).run();
        expect(await sql(`SELECT id FROM ${table} WHERE installation_id=? AND generation=?`).first()).toBeNull();
    }
    const otherScope = { installationId: scope.installationId, generation: "other" };
    const other = new SourceController(env.DB, otherScope, { kind: "owner" });
    expect((await other.execute(source())).id).not.toBe(created.id);
    await expect(new OwnerControl(env.DB, otherScope, { kind: "owner" }).execute({ ...mission(), source: { id: created.id, revision: 1 } })).rejects.toThrow("control_precondition");
});
it("recovers a create commit with a lost ACK and retains the original attribution/version", async () => {
    const batch = env.DB.batch.bind(env.DB);
    const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
        await batch(statements);
        throw new Error("lost ACK");
    });
    await expect(write(source())).rejects.toThrow("lost ACK");
    fault.mockRestore();
    const created = await write(source());
    await write({ kind: "source.correct", operationId: "correct", id: created.id, expectedRevision: 1, text: "A correction", occurredAt: 110 });
    const versions = await sql("SELECT version,author_id,author_label,original_text FROM assistant_source_versions WHERE installation_id=? AND generation=? ORDER BY version").all();
    expect(versions.results).toEqual([
        { version: 1, author_id: "author", author_label: "Synthetic author", original_text: source().input.text },
        { version: 2, author_id: "author", author_label: "Synthetic author", original_text: "A correction" },
    ]);
    expect(await write(source())).toEqual(created);
    expect(await sql("SELECT audience FROM assistant_sources WHERE installation_id=? AND generation=?").first("audience")).toBe("owner");
});

it.each(["source.correct", "source.change_audience"])("does not persist a stale version receipt when %s anticipates a concurrent revision", async kind => {
    const created = await write(source());
    const request = { kind, operationId: "anticipated", id: created.id, expectedRevision: 2,
        ...(kind === "source.correct" ? { text: "Third version", occurredAt: 120 } : kind === "source.change_audience" ? { audience: "public" } : {}) };
    const batch = env.DB.batch.bind(env.DB);
    const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
        fault.mockRestore();
        await owner.correct(created.id, 1, { text: "Concurrent correction", occurredAt: 110 });
        return batch(statements);
    });
    await expect(write(request)).rejects.toThrow("source_revision_conflict");
    expect(await sql("SELECT revision,current_version FROM assistant_sources WHERE installation_id=? AND generation=?").first()).toEqual({ revision: 2, current_version: 2 });
    expect(await sql("SELECT operation_id FROM assistant_owner_commands WHERE installation_id=? AND generation=? AND operation_id='anticipated'").first()).toBeNull();
    const result = await write(request);
    expect(result).toMatchObject({ revision: 3, version: kind === "source.correct" ? 3 : 2 });
    expect(await write(request)).toEqual(result);
});
it("captures the exact version in the withdrawal CAS when the anticipated revision becomes current", async () => {
    const created = await write(source()), request = { kind: "source.withdraw", operationId: "anticipated", id: created.id, expectedRevision: 2 };
    const batch = env.DB.batch.bind(env.DB); let injected = false;
    const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
        fault.mockRestore();
        await owner.correct(created.id, 1, { text: "Concurrent correction", occurredAt: 110 });
        injected = true;
        return batch(statements);
    });
    const receipt = await write(request);
    expect(injected).toBe(true);
    expect(receipt).toMatchObject({ revision: 3, version: 2 });
    expect(await write(request)).toEqual(receipt);
    expect(await sql("SELECT revision,current_version,status FROM assistant_sources WHERE installation_id=? AND generation=?").first()).toEqual({ revision: 3, current_version: 2, status: "withdrawn" });
    expect(await sql("SELECT operation_id,base_revision,source_version FROM assistant_retention_barriers WHERE installation_id=? AND generation=? AND source_id=?", created.id).first()).toEqual({ operation_id: "anticipated", base_revision: 2, source_version: 2 });
    expect((await sql("SELECT revision,version,kind FROM assistant_source_changes WHERE installation_id=? AND generation=? ORDER BY revision").all()).results).toEqual([{ revision: 1, version: 1, kind: "created" }, { revision: 2, version: 2, kind: "corrected" }, { revision: 3, version: 2, kind: "withdrawn" }]);
});
it("checks the observed conversation kind in the current origin namespace and repairs a mismatched legacy policy", async () => {
    await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,'old','chat',10,'private','available')", scope.sourceEpoch).run();
    await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?, 'chat',20,'group','available')", scope.sourceEpoch, scope.sourceGeneration).run();
    const request = { kind: "policy.put", operationId: "wrong", id: "chat", expectedRevision: 0, conversationKind: "private" };
    await expect(control.execute(request)).rejects.toThrow("control_precondition");
    expect(await sql("SELECT operation_id FROM assistant_owner_commands WHERE installation_id=? AND generation=?").first()).toBeNull();
    // Existing wrong policies must be repairable under CAS plus current evidence.
    await sql("INSERT INTO assistant_conversation_policies VALUES(?,?,'chat','private',0,'ignore',7)").run();
    expect(await control.execute({ ...request, operationId: "repair", expectedRevision: 7, conversationKind: "group", groupMode: "observe" })).toMatchObject({ revision: 8 });
    expect(await sql("SELECT kind,revision FROM assistant_conversation_policies WHERE installation_id=? AND generation=?").first()).toEqual({ kind: "group", revision: 8 });
    expect(await sql("SELECT revision FROM assistant_policy_versions WHERE installation_id=? AND generation=?").first("revision")).toBe(8);
});
it("admits policy only under the observed kind in the same batch and ignores old epochs", async () => {
    const request = { kind: "policy.put", operationId: "policy", id: "chat", expectedRevision: 0, conversationKind: "private" };
    await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,'old','chat',10,'group','available')", scope.sourceEpoch).run();
    expect(await control.execute(request)).toMatchObject({ revision: 1 });
    const batch = env.DB.batch.bind(env.DB);
    const fault = vi.spyOn(env.DB, "batch").mockImplementationOnce(async statements => {
        fault.mockRestore();
        await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?, 'chat',20,'group','available')", scope.sourceEpoch, scope.sourceGeneration).run();
        return batch(statements);
    });
    await expect(control.execute({ ...request, operationId: "raced", expectedRevision: 1 })).rejects.toThrow("control_precondition");
    expect(await sql("SELECT revision FROM assistant_conversation_policies WHERE installation_id=? AND generation=?").first("revision")).toBe(1);
    await expect(new OwnerControl(env.DB, { installationId: scope.installationId, generation: scope.generation }, { kind: "owner" }).execute({ ...request, operationId: "no-origin", id: "other" })).rejects.toThrow();
});
it("denies a present unknown kind and ignores conflicting observations from another epoch", async () => {
    const request = { kind: "policy.put", operationId: "policy", id: "chat", expectedRevision: 0, conversationKind: "group" };
    await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,? ,?, 'chat',10,NULL,'unknown')", scope.sourceEpoch, scope.sourceGeneration).run();
    await expect(control.execute(request)).rejects.toThrow("control_precondition");
    expect(await sql("SELECT revision FROM assistant_conversation_policies WHERE installation_id=? AND generation=?").first()).toBeNull();
    await sql("UPDATE assistant_origin_conversations SET kind='group' WHERE installation_id=? AND generation=?").run();
    await expect(control.execute(request)).rejects.toThrow("control_precondition");
    await sql("UPDATE assistant_origin_conversations SET access_state='available' WHERE installation_id=? AND generation=?").run();
    await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,'other-epoch',?,'chat',10,'private','available')", scope.sourceGeneration).run();
    const result = await control.execute(request);
    expect(result).toMatchObject({ revision: 1 });
    expect(await control.execute(request)).toEqual(result);
});
it.each(["unknown", "withdrawn"])("can exclude an offline %s conversation while preserving CAS and the operation receipt", async accessState => {
    await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?, 'chat',10,'group',?)", scope.sourceEpoch, scope.sourceGeneration, accessState).run();
    const request = { kind: "policy.put", operationId: "exclude", id: "chat", expectedRevision: 0, conversationKind: "private", excluded: true };
    const result = await control.execute(request);
    expect(result).toMatchObject({ revision: 1 });
    expect(await control.execute(request)).toEqual(result);
    expect(await sql("SELECT excluded FROM assistant_conversation_policies WHERE installation_id=? AND generation=?").first("excluded")).toBe(1);
    await expect(control.execute({ ...request, operationId: "stale", expectedRevision: 0 })).rejects.toThrow("control_precondition");
    await expect(control.execute({ ...request, operationId: "offline-reactivate", expectedRevision: 1, conversationKind: "group", excluded: false })).rejects.toThrow("control_precondition");
    expect(await sql("SELECT COUNT(*) n FROM assistant_policy_versions WHERE installation_id=? AND generation=?").first("n")).toBe(1);
});
it("keeps exclusions sticky on omitted flags and requires fresh matching observation to re-enable", async () => {
    const request = { kind: "policy.put", operationId: "policy", id: "chat", expectedRevision: 0, conversationKind: "group", excluded: true, groupMode: "respond" };
    await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?, 'chat',10,NULL,'unknown')", scope.sourceEpoch, scope.sourceGeneration).run();
    await control.execute(request);
    // Omission remains exclusion, including reclassification under unknown origin.
    const { excluded: _excluded, ...omitted } = request;
    await control.execute({ ...omitted, operationId: "omitted-offline", expectedRevision: 1 });
    expect(await sql("SELECT excluded FROM assistant_conversation_policies WHERE installation_id=? AND generation=?").first("excluded")).toBe(1);
    await expect(control.execute({ ...request, operationId: "offline-reactivate", expectedRevision: 2, excluded: false })).rejects.toThrow("control_precondition");
    await sql("UPDATE assistant_origin_conversations SET kind='group',access_state='available' WHERE installation_id=? AND generation=?").run();
    await control.execute({ ...omitted, operationId: "omitted-online", expectedRevision: 2 });
    expect(await sql("SELECT p.excluded,m.effective_mode FROM assistant_conversation_policies p JOIN assistant_conversation_modes m USING(installation_id,generation,conversation_id) WHERE installation_id=? AND generation=?").first()).toEqual({ excluded: 1, effective_mode: "ignore" });
    expect(await control.execute({ ...request, operationId: "reactivate", expectedRevision: 3, excluded: false })).toMatchObject({ revision: 4 });
    expect(await sql("SELECT p.excluded,m.effective_mode FROM assistant_conversation_policies p JOIN assistant_conversation_modes m USING(installation_id,generation,conversation_id) WHERE installation_id=? AND generation=?").first()).toEqual({ excluded: 0, effective_mode: "respond" });
});
it("requires proof for removing an exclusion even without an observation or with group ignore", async () => {
    const request = { kind: "policy.put", operationId: "policy", id: "chat", expectedRevision: 0, conversationKind: "group", excluded: true };
    await control.execute(request);
    await expect(control.execute({ ...request, operationId: "no-observation", expectedRevision: 1, excluded: false, groupMode: "ignore" })).rejects.toThrow("control_precondition");
    await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?, 'chat',10,'private','available')", scope.sourceEpoch, scope.sourceGeneration).run();
    await expect(control.execute({ ...request, operationId: "mismatch", expectedRevision: 1, excluded: false, groupMode: "ignore" })).rejects.toThrow("control_precondition");
    await expect(control.execute({ ...request, operationId: "missing-scope", id: "other", sourceEpoch: "other" })).rejects.toThrow("control_input");
});
it("does not silently clear an existing exclusion when an online update omits the flag", async () => {
    await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?, 'chat',10,'group','available')", scope.sourceEpoch, scope.sourceGeneration).run();
    await control.execute({ kind: "policy.put", operationId: "exclude", id: "chat", expectedRevision: 0, conversationKind: "group", excluded: true });
    await control.execute({ kind: "policy.put", operationId: "update", id: "chat", expectedRevision: 1, conversationKind: "group", groupMode: "respond" });
    expect(await sql("SELECT excluded FROM assistant_conversation_policies WHERE installation_id=? AND generation=?").first("excluded")).toBe(1);
    expect(await sql("SELECT effective_mode FROM assistant_conversation_modes WHERE installation_id=? AND generation=?").first("effective_mode")).toBe("ignore");
});

it("does not treat the private conversation groupMode ignore as exclusion", async () => {
    const request = { kind: "policy.put", operationId: "exclude", id: "private", expectedRevision: 0, conversationKind: "private", excluded: true };
    await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?, 'private',10,'private','unknown')", scope.sourceEpoch, scope.sourceGeneration).run();
    await control.execute(request);
    await expect(control.execute({ ...request, operationId: "offline", expectedRevision: 1, excluded: false, groupMode: "ignore" })).rejects.toThrow("control_precondition");
    expect(await sql("SELECT effective_mode FROM assistant_conversation_modes WHERE installation_id=? AND generation=?").first("effective_mode")).toBe("ignore");
    await sql("UPDATE assistant_origin_conversations SET access_state='available' WHERE installation_id=? AND generation=?").run();
    await control.execute({ ...request, operationId: "online", expectedRevision: 1, excluded: false, groupMode: "ignore" });
    expect(await sql("SELECT effective_mode FROM assistant_conversation_modes WHERE installation_id=? AND generation=?").first("effective_mode")).toBe("attend");
});
