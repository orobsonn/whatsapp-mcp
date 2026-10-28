import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, open, link, unlink, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
export const CALENDAR_OWNED_SCOPE = "https://www.googleapis.com/auth/calendar.events.owned";
const validPermission = value => value === "read_only" || value === "write_owned";
const redirect = "http://localhost:8977/callback";
const safeSecret = value => typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(value);
export function authorization(clientId, state, verifier, permission = "read_only") {
  if (!validPermission(permission)) throw new Error("configuration");
  if (![clientId, state, verifier].every(safeSecret)) throw new Error("configuration");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: permission === "write_owned" ? CALENDAR_OWNED_SCOPE : CALENDAR_SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  return url.href;
}
export function callbackCode(input, state) {
  const url = new URL(input, redirect);
  if (url.origin !== new URL(redirect).origin || url.pathname !== "/callback" || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state || url.searchParams.has("error") || url.searchParams.getAll("code").length !== 1 || !safeSecret(url.searchParams.get("code"))) throw new Error("callback");
  return url.searchParams.get("code");
}
export function credentialEnvironment(clientId, clientSecret, response, { encryptionKey = randomBytes(32).toString("base64"), secretEpoch = randomUUID(), credentialGeneration, permission = "read_only", configurationVersion = permission === "write_owned" ? 2 : 1 } = {}) {
  const scopes = typeof response.scope === "string" ? response.scope.trim().split(/\s+/) : [];
  if (![clientId, clientSecret, response.refresh_token, response.access_token, credentialGeneration].every(safeSecret) || credentialGeneration.length > 256 || response.token_type !== "Bearer" || !Number.isInteger(response.expires_in) || response.expires_in < 120 || !validPermission(permission) || !Number.isInteger(configurationVersion) || configurationVersion < 1 || !scopes.length || (permission === "write_owned" && !scopes.includes(CALENDAR_OWNED_SCOPE)) || !scopes.every(scope => scope === CALENDAR_SCOPE || scope === "https://www.googleapis.com/auth/calendar.readonly" || (permission === "write_owned" && scope === CALENDAR_OWNED_SCOPE))) throw new Error("token_response");
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  return Object.entries({ CALENDAR_OAUTH_CLIENT_ID: clientId, CALENDAR_OAUTH_CLIENT_SECRET: clientSecret,
    CALENDAR_OAUTH_REFRESH_TOKEN: response.refresh_token, CALENDAR_OAUTH_ENCRYPTION_KEY: encryptionKey,
    CALENDAR_OAUTH_CONFIGURATION_VERSION: String(configurationVersion), CALENDAR_OAUTH_PERMISSION: permission, CALENDAR_OAUTH_SECRET_EPOCH: secretEpoch, CALENDAR_OAUTH_CREDENTIAL_GENERATION: credentialGeneration }).map(([name, value]) => `${name}=${quote(value)}`).join("\n") + "\n";
}
export async function writePrivateEnvironment(destination, content) {
  const target = resolve(destination), folder = dirname(target), temporary = target + "." + randomUUID() + ".tmp";
  await mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    await link(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
}
async function exchange(clientId, clientSecret, code, verifier) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" }) });
    if (response.status !== 200 || !response.body) throw new Error("token_response");
    const reader = response.body.getReader(); let bytes = 0, text = ""; const decoder = new TextDecoder("utf-8", { fatal: true });
    try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 16384) throw new Error("token_response"); text += decoder.decode(part.value, { stream: true }); } }
    finally { void reader.cancel().catch(() => {}); }
    return JSON.parse(text + decoder.decode());
  } finally { clearTimeout(timeout); controller.abort(); }
}
export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) { console.log("Provide CALENDAR_OAUTH_CLIENT_ID, CALENDAR_OAUTH_CLIENT_SECRET and OPERATIONAL_GENERATION through private environment. Run: node scripts/calendar-oauth.mjs [--write-owned] [--out /private/calendar-oauth.env]. Callback: http://localhost:8977/callback. For VPS use SSH -L 8977:127.0.0.1:8977. Tokens are written once to a 0600 file and never printed."); return; }
  const permission = args.includes("--write-owned") ? "write_owned" : "read_only";
  args = args.filter(arg => arg !== "--write-owned");
  const clientId = process.env.CALENDAR_OAUTH_CLIENT_ID, clientSecret = process.env.CALENDAR_OAUTH_CLIENT_SECRET;
  const credentialGeneration = process.env.OPERATIONAL_GENERATION;
  if (!safeSecret(clientId) || !safeSecret(clientSecret) || !safeSecret(credentialGeneration) || credentialGeneration.length > 256) throw new Error("configuration");
  if (args.length && (args.length !== 2 || args[0] !== "--out")) throw new Error("configuration");
  const output = args[1] ?? resolve(homedir(), ".config/assistente-validacao/calendar-oauth.env");
  try { await lstat(output); throw new Error("output_exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const state = randomBytes(32).toString("base64url"), verifier = randomBytes(48).toString("base64url");
  let timer;
  const code = await new Promise((accept, reject) => {
    let claimed = false;
    const server = createServer((request, response) => {
      response.setHeader("Cache-Control", "no-store"); response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("Content-Type", "text/plain; charset=utf-8");
      try {
        if (request.method !== "GET" || claimed) throw new Error("callback");
        const value = callbackCode(request.url, state);
        claimed = true;
        response.end("Authorization received. You can close this window."); clearTimeout(timer); server.close(); accept(value);
      } catch { response.statusCode = 400; response.end("Authorization callback rejected."); }
    });
    server.on("error", error => { clearTimeout(timer); reject(error); });
    server.listen(8977, "127.0.0.1", () => console.log("Open this URL in your own browser:\n" + authorization(clientId, state, verifier, permission)));
    timer = setTimeout(() => { server.close(); reject(new Error("callback_timeout")); }, 300000);
  });
  try { await writePrivateEnvironment(output, credentialEnvironment(clientId, clientSecret, await exchange(clientId, clientSecret, code, verifier), { credentialGeneration, permission })); console.log("Credentials saved privately with mode 0600; no tokens printed. Provision them as assistant Worker secrets."); }
  finally { clearTimeout(timer); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error("Calendar OAuth failed; no secrets printed. Check client configuration, registered callback, consent and private output permissions."); process.exitCode = 1; });
