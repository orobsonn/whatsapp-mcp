import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { authorization, callbackCode, credentialEnvironment, writePrivateEnvironment, CALENDAR_SCOPE } from "./calendar-oauth.mjs";

test("authorization fixes Google endpoint, readonly/offline grant, state and PKCE without putting the client secret in the URL", () => {
  const state = "synthetic-state", verifier = "s".repeat(64), url = new URL(authorization("synthetic-client", state, verifier));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(url.searchParams.get("scope"), CALENDAR_SCOPE); assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("include_granted_scopes"), "false"); assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
  assert.equal(url.searchParams.has("client_secret"), false); assert.equal(url.searchParams.has("code_verifier"), false);
});
test("the callback validates fixed local origin/path, exact single state/code and denial", () => {
  assert.equal(callbackCode("/callback?state=synthetic-state&code=synthetic-code", "synthetic-state"), "synthetic-code");
  for (const url of ["https://other.invalid/callback?state=synthetic-state&code=c", "/other?state=synthetic-state&code=c", "/callback?state=wrong&code=c", "/callback?state=synthetic-state&code=c&state=synthetic-state", "/callback?state=synthetic-state&code=c&code=d", "/callback?state=synthetic-state&error=access_denied"]) assert.throws(() => callbackCode(url, "synthetic-state"));
});
test("private environment stores the refresh credential and encryption key but never an access token", async () => {
  const folder = await mkdtemp(join(tmpdir(), "assistant-oauth-check-")), destination = join(folder, "nested", "credentials.env");
  const response = { access_token: "synthetic-access-secret", refresh_token: "synthetic-refresh-secret", expires_in: 3600, token_type: "Bearer", scope: CALENDAR_SCOPE };
  try {
    const content = credentialEnvironment("synthetic-client", "synthetic-client-secret", response, { credentialGeneration: "synthetic-g" });
    assert.match(content, /CALENDAR_OAUTH_PERMISSION='read_only'/);
    assert.equal(content.includes("synthetic-access-secret"), false); assert.equal(content.includes("synthetic-refresh-secret"), true);
    await writePrivateEnvironment(destination, content); assert.equal((await stat(destination)).mode & 0o777, 0o600); assert.equal(await readFile(destination, "utf8"), content);
    await assert.rejects(writePrivateEnvironment(destination, "must-not-overwrite")); assert.equal(await readFile(destination, "utf8"), content);
    for (const patch of [{ scope: "https://www.googleapis.com/auth/calendar" }, { scope: undefined }, { refresh_token: undefined }, { token_type: "DPoP" }, { expires_in: 1 }]) assert.throws(() => credentialEnvironment("synthetic-client", "synthetic-secret", { ...response, ...patch }, { credentialGeneration: "synthetic-g" }));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("write-owned opt-in requests only event management on owned calendars and requires this scope in response", () => {
  const owned = "https://www.googleapis.com/auth/calendar.events.owned";
  const url = new URL(authorization("synthetic-client", "synthetic-state", "v".repeat(64), "write_owned"));
  assert.equal(url.searchParams.get("scope"), owned);
  const response = { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600, token_type: "Bearer", scope: owned };
  const options = { credentialGeneration: "synthetic-g", permission: "write_owned" };
  const content = credentialEnvironment("synthetic-client", "synthetic-secret", response, options);
  assert.match(content, /CALENDAR_OAUTH_PERMISSION='write_owned'/);
  assert.match(content, /CALENDAR_OAUTH_CONFIGURATION_VERSION='2'/);
  assert.throws(() => credentialEnvironment("synthetic-client", "synthetic-secret", { ...response, scope: CALENDAR_SCOPE }, options));
  assert.throws(() => credentialEnvironment("synthetic-client", "synthetic-secret", response, { credentialGeneration: "synthetic-g" }));
});
