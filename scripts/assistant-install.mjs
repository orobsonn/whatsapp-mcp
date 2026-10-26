import { readFile, mkdir, open, stat, lstat, realpath } from "node:fs/promises";
import { dirname, resolve, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { installationManifest, installationConfigs, installationPlan, validateAssistantInstallConfig } from "../assistant/installation.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function json(path) { const text = await readFile(path, "utf8"); if (Buffer.byteLength(text) > 65536) throw new Error("installation_input_limit"); return JSON.parse(text); }
async function privateFile(path, content) {
  try { const file = await open(path, "wx", 0o600); try { await file.writeFile(content); await file.sync(); } finally { await file.close(); } }
  catch (error) { if (error.code !== "EEXIST") throw new Error("installation_artifact_conflict"); const previous = await lstat(path);
    if (!previous.isFile() || previous.mode & 0o077 || await readFile(path, "utf8") !== content) throw new Error("installation_artifact_conflict"); }
}
async function privateDirectory(output, repositoryRoot) {
  const allowed = path => path.startsWith(resolve(repositoryRoot, "local") + sep) || path.startsWith(join(tmpdir(), "assistant-install-"));
  if (!allowed(resolve(output))) throw new Error("installation_output_path");
  let ancestor = resolve(output);
  for (;;) { try { await lstat(ancestor); break; } catch (error) { if (error.code !== "ENOENT") throw error; ancestor = dirname(ancestor); } }
  const actualAncestor = await realpath(ancestor);
  if (!allowed(actualAncestor) && !(ancestor === resolve(repositoryRoot) && actualAncestor === resolve(repositoryRoot)) && !(ancestor === tmpdir() && actualAncestor === await realpath(tmpdir()))) throw new Error("installation_output_path");
  await mkdir(output, { recursive: true, mode: 0o700 });
  const directory = await stat(output); if (!directory.isDirectory() || directory.mode & 0o077 || !allowed(await realpath(output))) throw new Error("installation_private_directory");
}
export async function renderInstallation(input, output, repositoryRoot = root, sourceHead = "not_provided") {
  const manifest = installationManifest.parse(input), configs = installationConfigs(manifest, repositoryRoot), plan = installationPlan(manifest, repositoryRoot);
  validateAssistantInstallConfig(configs.assistant, repositoryRoot);
  await privateDirectory(output, repositoryRoot);
  const artifacts = { "assistant.wrangler.jsonc": configs.assistant, "parser.wrangler.jsonc": configs.pdf, "archive.delta.json": configs.archiveDelta,
    "plan.json": plan, "review.json": { sourceHead, manifestHash: digest(manifest), configHash: digest(configs), databaseId: manifest.databaseId, imageDigest: manifest.imageDigest,
      archiveBaseline: manifest.archiveBaseline, deployment: "not_performed", inference: "not_called" } };
  for (const [name, value] of Object.entries(artifacts)) await privateFile(join(output, name), JSON.stringify(value, null, 2) + "\n");
  return { state: "rendered_only", effects: "local_private_files", files: Object.keys(artifacts), configHash: digest(configs), deployment: "not_performed", activation: "off_paused" };
}
export async function prepareBridge(input, output, repositoryRoot = root) {
  const manifest = installationManifest.parse(input); await privateDirectory(output, repositoryRoot);
  const receiptPath = join(output, "bridge.receipt.json"), assistantPath = join(output, "assistant.bridge.secrets.json"), archivePath = join(output, "archive.bridge.secrets.json");
  let key, previous = false;
  try {
    for (const path of [receiptPath, assistantPath, archivePath]) if ((await lstat(path)).mode & 0o077 || !(await lstat(path)).isFile()) throw new Error("installation_private_file");
    const receipt = await json(receiptPath), assistant = await json(assistantPath), archive = await json(archivePath);
    if (receipt.installationId !== manifest.installationId || receipt.generation !== manifest.generation || !/^[a-f0-9]{64}$/.test(assistant.BRIDGE_SECRET) || archive.ASSISTANT_READER_SECRET !== assistant.BRIDGE_SECRET || archive.ASSISTANT_BRIDGE_SECRET !== assistant.BRIDGE_SECRET || receipt.keyHash !== digest(assistant.BRIDGE_SECRET)) throw new Error("installation_bridge_conflict");
    key = assistant.BRIDGE_SECRET; previous = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    for (const path of [receiptPath, assistantPath, archivePath]) { try { await lstat(path); throw new Error("installation_partial_bridge_requires_reconciliation"); } catch (error) { if (error.code !== "ENOENT") throw error; } }
    key = randomBytes(32).toString("hex");
  }
  await privateFile(assistantPath, JSON.stringify({ BRIDGE_SECRET: key }, null, 2) + "\n");
  await privateFile(archivePath, JSON.stringify({ ASSISTANT_READER_SECRET: key, ASSISTANT_BRIDGE_SECRET: key }, null, 2) + "\n");
  await privateFile(receiptPath, JSON.stringify({ installationId: manifest.installationId, generation: manifest.generation, keyHash: digest(key), provisioning: "not_performed" }, null, 2) + "\n");
  return { state: previous ? "existing_private_key_recovered" : "fresh_private_key_prepared", provisioning: "not_performed", keyHash: digest(key), valuesPrinted: false };
}
export async function pinAffinity(input, observed, output, repositoryRoot = root) {
  const manifest = installationManifest.parse(input); await privateDirectory(output, repositoryRoot);
  if (!observed || typeof observed !== "object" || Object.keys(observed).sort().join(",") !== "fence,observation,state" || observed.observation !== "capture_installation_affinity" || observed.state !== "available" || !observed.fence || Object.keys(observed.fence).sort().join(",") !== "epoch,generation" || ![observed.fence.epoch, observed.fence.generation].every(value => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value))) throw new Error("installation_affinity_invalid");
  const receiptPath = join(output, "bridge.receipt.json"), receiptStat = await lstat(receiptPath);
  if (!receiptStat.isFile() || receiptStat.mode & 0o077) throw new Error("installation_private_file");
  const bridge = await json(receiptPath);
  if (bridge.installationId !== manifest.installationId || bridge.generation !== manifest.generation) throw new Error("installation_bridge_conflict");
  const fence = { epoch: observed.fence.epoch, generation: observed.fence.generation };
  await privateFile(join(output, "assistant.affinity.secrets.json"), JSON.stringify({ BRIDGE_SOURCE_EPOCH: fence.epoch, BRIDGE_SOURCE_GENERATION: fence.generation }, null, 2) + "\n");
  await privateFile(join(output, "affinity.receipt.json"), JSON.stringify({ installationId: manifest.installationId, generation: manifest.generation, fenceHash: digest(fence), provenance: "provided_private_named_rpc_response_requires_live_binding_verification", automaticRotation: false }, null, 2) + "\n");
  return { state: "private_affinity_pinned", fenceHash: digest(fence), valuesPrinted: false, automaticRotation: false };
}
export async function main(args = process.argv.slice(2)) {
  if (!args.length || args.includes("--help")) { console.log("Assistant installation artifacts only; never creates cloud resources, deploys, migrates or activates. Commands: plan --manifest FILE; render --manifest FILE [--output PRIVATE_DIRECTORY]; prepare-bridge --manifest FILE --output PRIVATE_DIRECTORY; pin-affinity --manifest FILE --input PRIVATE_RPC_FILE --output PRIVATE_DIRECTORY; check-config --config FILE. Node>=22.19. Private local credentials are created only by explicit prepare-bridge, never printed. Use ASSISTANT_INSTALL_CONFIG during the official Flue build."); return; }
  const command = args.shift(), options = {};
  if (!["plan", "render", "prepare-bridge", "pin-affinity", "check-config"].includes(command)) throw new Error("installation_command");
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index], value = args[index + 1]; if (!["--manifest", "--output", "--input", "--config"].includes(name) || !value || name in options) throw new Error("installation_arguments"); options[name] = value;
  }
  if (command === "check-config") { if (!options["--config"] || options["--manifest"] || options["--output"] || options["--input"]) throw new Error("installation_arguments"); validateAssistantInstallConfig(await json(options["--config"]), root); console.log(JSON.stringify({ state: "validated_staged_config", effects: "none" })); return; }
  if (!options["--manifest"] || options["--config"] || command === "plan" && options["--output"]) throw new Error("installation_arguments");
  const manifest = installationManifest.parse(await json(options["--manifest"]));
  if (command === "prepare-bridge" || command === "pin-affinity") { if (!options["--output"] || command === "prepare-bridge" && options["--input"] || command === "pin-affinity" && !options["--input"]) throw new Error("installation_arguments");
    console.log(JSON.stringify(command === "prepare-bridge" ? await prepareBridge(manifest, resolve(options["--output"])) : await pinAffinity(manifest, await json(options["--input"]), resolve(options["--output"])))); return; }
  if (options["--input"]) throw new Error("installation_arguments");
  if (command === "plan") { console.log(JSON.stringify(installationPlan(manifest, root), null, 2)); return; }
  const output = resolve(options["--output"] ?? join(root, "local/assistant-build/install"));
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const result = await renderInstallation(manifest, output, root, sourceHead);
  console.log(JSON.stringify({ ...result, sourceHead, outputDirectory: output }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("Installation artifacts rejected. Verify the manifest, new assistant resource IDs, pinned image, archive baseline and private output permissions. No cloud action was executed."); process.exitCode = 1; });
