import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { renderInstallation, prepareBridge, pinAffinity } from "./assistant-install.mjs";
const manifest = () => ({ schema: 1, accountId: "ab9f6d8988145943bf8bbab313e45e6e", installationId: "synthetic-install", generation: "g1",
  databaseId: "11111111-1111-4111-8111-111111111111", imageDigest: `registry.cloudflare.com/account/assistant-cognee@sha256:${"a".repeat(64)}`,
  archiveBaseline: { versionId: "22222222-2222-4222-8222-222222222222", settingsHash: "b".repeat(64) } });
test("artifact rendering is private, idempotent, local-only and refuses a changed plan instead of overwriting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-install-check-"));
  try {
    const result = await renderInstallation(manifest(), directory, "/synthetic/root", "synthetic-head");
    assert.equal(result.state, "rendered_only"); assert.equal(result.deployment, "not_performed");
    for (const file of result.files) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
    assert.deepEqual(await renderInstallation(manifest(), directory, "/synthetic/root", "synthetic-head"), result);
    await assert.rejects(renderInstallation({ ...manifest(), generation: "other" }, directory, "/synthetic/root", "synthetic-head"));
    const review = JSON.parse(await readFile(join(directory, "review.json"), "utf8")); assert.equal(review.sourceHead, "synthetic-head");
    await assert.rejects(renderInstallation(manifest(), "/unrelated-project/install", "/synthetic/root"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("bridge credentials are prepared once in private files, recover exact aliases and pin affinity without automatic rotation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-install-check-"));
  try {
    const first = await prepareBridge(manifest(), directory, "/synthetic/root"), assistant = JSON.parse(await readFile(join(directory, "assistant.bridge.secrets.json"), "utf8")), archive = JSON.parse(await readFile(join(directory, "archive.bridge.secrets.json"), "utf8"));
    assert.match(assistant.BRIDGE_SECRET, /^[a-f0-9]{64}$/); assert.equal(archive.ASSISTANT_READER_SECRET, assistant.BRIDGE_SECRET); assert.equal(archive.ASSISTANT_BRIDGE_SECRET, assistant.BRIDGE_SECRET);
    assert.equal(JSON.stringify(first).includes(assistant.BRIDGE_SECRET), false);
    assert.equal((await prepareBridge(manifest(), directory, "/synthetic/root")).state, "existing_private_key_recovered");
    const observed = { observation: "capture_installation_affinity", state: "available", fence: { epoch: "synthetic-private-epoch", generation: "synthetic-private-source-g" } };
    const pinned = await pinAffinity(manifest(), observed, directory, "/synthetic/root"); assert.equal(pinned.automaticRotation, false); assert.equal(JSON.stringify(pinned).includes("synthetic-private"), false);
    assert.deepEqual(await pinAffinity(manifest(), observed, directory, "/synthetic/root"), pinned);
    assert.deepEqual(await pinAffinity(manifest(), { ...observed, fence: { generation: observed.fence.generation, epoch: observed.fence.epoch } }, directory, "/synthetic/root"), pinned);
    await assert.rejects(pinAffinity(manifest(), { ...observed, fence: { ...observed.fence, generation: "changed" } }, directory, "/synthetic/root"));
    await assert.rejects(prepareBridge({ ...manifest(), generation: "other" }, directory, "/synthetic/root"));
    assert.equal((await stat(join(directory, "assistant.affinity.secrets.json"))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("CLI rejects cloud apply and credential-bearing manifests without printing their values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-install-check-"));
  try {
    const path = join(directory, "manifest.json"); await writeFile(path, JSON.stringify({ ...manifest(), OPENAI_API_KEY: "synthetic-do-not-print" }));
    const result = spawnSync(process.execPath, [new URL("./assistant-install.mjs", import.meta.url).pathname, "plan", "--manifest", path], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.equal((result.stdout + result.stderr).includes("synthetic-do-not-print"), false);
    const apply = spawnSync(process.execPath, [new URL("./assistant-install.mjs", import.meta.url).pathname, "apply", "--manifest", path], { encoding: "utf8" }); assert.equal(apply.status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
