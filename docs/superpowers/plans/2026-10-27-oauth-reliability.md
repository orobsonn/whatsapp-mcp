# OAuth reliability implementation

User request: fix rotation and publish both fixes. Engineering decisions below are the implementer's, reviewed adversarially; no further product choice is required.

## Contract

One SQLite Durable Object per owner/origin coordinates all OAuth mutations, including consent. MCP business tools stay outside the object. The installed provider retains responsibility for OAuth, client authentication, PKCE, scopes, audience, encryption and owner checks.

A bounded, atomic, one-time import preserves existing KV clients/grants/tokens and their original expirations. Once imported, legacy KV is never read again. Provider mutations are staged and committed atomically with an encrypted response receipt. Failed issuance cannot partly rotate a grant. Identical token requests within 60 seconds recover the original response after a lost reply or restart. A superseded refresh token is usable only in a fixed 60-second grace window, including legacy predecessors. Returning a receipt rechecks current client/grant/owner/epoch/maintenance and never slides the deadline. Unknown tokens cannot revoke a family.

Bounds: 32 pending requests; 16 KiB HTTP input; 10,000 imported records and 8 MiB aggregate import; 10,000 live records/8 MiB staged data; physical expiry cleanup for records, receipts and refresh history. Queue overflow, storage/decryption faults and exceeded limits return sanitized 503. Receipt ciphertext uses AES-GCM, random IV, and domain-separated AAD bound to owner/origin/epoch/request digest.

Adversarial changes incorporated: serialize consent as well as refresh; no fallback to legacy KV; cap bytes as well as rows; remove indefinite previous-token acceptance; cache only recoverable responses; preserve human error pages. Cutover cannot recover a refresh branch already lost before this release.

## Steps

- [ ] Add native DO/provider tests for concurrent refresh, identical retry, changed scope/resource, lost response/restart, atomic commit failure, revocation and expiry.
- [ ] Implement bounded SQLite KV staging, import and read-only resource adapter; implement serialized OAuth authority and encrypted receipts/history.
- [ ] Route OAuth mutations and add binding/migration; preserve production bindings, secrets and runtime settings.
- [ ] Review the diff independently; run TypeScript, full project tests and native tests, build and production-shaped synthetic smoke.
- [ ] Commit/release the milestone; upload an immutable version, validate before promotion where the domain/auth contract permits, promote and verify real production health/discovery/rotation without sending messages.

Validation must distinguish synthetic OAuth proof, real service availability and real connector reauthentication. Do not promise lifetime disconnection immunity or reuse invalid credentials.
