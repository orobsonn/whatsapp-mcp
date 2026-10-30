# Preserve queued deliveries after a failed native model turn

Status: design approved; implementation and local native protocol proof complete.
Code review and real Cloudflare acceptance remain required.

Flue 2.3.0 applies queued joins at `turn_end`, including an assistant message
whose stop reason is `error` or `aborted`. Pi then terminates the failed response.
A newly consumed and finalized join inherits that failed settlement. In P3 this
can lose a new authenticated owner request when an older scheduled task is
cancelled during its already running model transport. Relaxing the old task's
authority would publish stale work and is not an acceptable recovery mechanism.

The assistant Vite build uses one `enforce: pre` transform. Only the exact
`turn_end` call immediately before `turn_messages` changes:

```ts
if (event.message.stopReason !== "error" && event.message.stopReason !== "aborted")
  await this.applyQueuedJoins();
```

Other join sites and successful/tool/length turns retain their original behavior.
The SDK's queued coordinator wakes the next prompt; that new prompt clears the
previous Pi error. The old paid transport is not retried. Flue can resolve a transient-error
continuation; the cancelled grant must reject it before reservation/transport,
and the probe reports such rejected resolutions separately. No synthetic assistant
completion, host retry framework, new provider, or permissive authority fallback
is introduced.

The patch affects **every Flue profile included in the Own assistant bundle**, not
only conversation-runtime. It is not imported by the Source build. The disposable
probe opts into the same plugin explicitly. Installed `node_modules`, other
projects (including Elo), dependencies and postinstall scripts remain untouched.
The plugin is build-only and does not patch Vite development mode.

The build fails closed unless all checks match:

- `@flue/runtime` version `2.3.0`;
- chunk `conversation-stream-store-CXrgv-b0.mjs`;
- original full-chunk SHA256 `a4c828953e70bde8673e25c1e5e30cf7d49d42a8f38e4c82851382fd2260515b`;
- exactly one original target and one transformed module in each built server environment.

An SDK upgrade requires removing this workaround when upstream fixes the seam,
or reviewing the new source and rerunning the protocol proof before repinning.
A missing target cannot silently produce an unpatched production bundle.

## Validation and operational boundary

`node --test scripts/assistant-native-sdk-seam.check.mjs` verifies source drift,
version/site/count checks, normal joins, and error/aborted exclusion. The assistant
build must contain the patched condition in its emitted worker chunk.

`tests/fixtures/assistant-native-sdk-seam-probe.ts` reuses the existing disposable
Cloudflare worker's real ConversationRuntimeAgent, production conversation profile,
Flue/Pi lifecycle and ConversationProvider. Its SSE transport is controlled test
data with no network inference or intelligent-answer claim. Budget entries are
simulated protocol accounting, not provider invoices. It uses synthetic inputs
only, including a typed `mission_due` system event; no timer becomes an incoming
owner message and no Telegram/WhatsApp output is sent.

Prepare the existing private probe with
`node scripts/prepare-native-sdk-seam-probe.mjs <absolute probe folder>`, then build
its Vite config. This preserves its bindings, existing routes and authentication,
and stores code-only `.before-sdk-seam` backups. Root performs deployment and
invocation. `scripts/assistant-native-sdk-seam-cf.mjs` exports a callable assertion
runner or accepts local `SDK_SEAM_PROBE_URL` / `PROBE_BEARER` environment variables.
Never print or commit those credentials.

The error scenario gates the old due model transport, queues an owner input,
revokes only the due task, and releases a controlled response. It must show:
old submission failed, owner succeeded in the **same** native session under its
own prompt/submission, one old transport, one owner transport, unchanged receipt
and operation identities on replay, no paid or external model calls. The normal
scenario proves that an owner input still joins the successful leading response.
Cloudflare receipts, not fixture preparation/build, establish that acceptance.

P3 and migration 0050 must not be promoted as accepted until this real boundary
passes. Own's isolated Telegram replay correction does not depend on this patch.

## Local evidence, 2026-10-29

The compiled private worker passed both native scenarios in Miniflare with its
outbound service rejecting every real network request (`externalCalls=0`). Error
run `b4c6f693-1e4b-41d3-babf-24f86722ea44`: old submission failed, owner succeeded
in the same session under its own submission; one due transport, one owner
transport, one extra due resolution rejected before budget/fetch. Normal run
`78251174-8857-446c-b3b4-baee264394fc`: original joins/cohort preserved. Receipt and
ledger replay remained unchanged in both runs. Each controlled response's 40
microUSD entry is simulated protocol accounting; actual paid calls were zero.

The native execution also caught a P3 render incompatibility: Flue requires a
`useTool` input object at the top level. `task_set_state` now mounts a strict
object while NativeTasks retains its discriminated host validation (follow-up
`resolved` remains denied). This is a separate correction from the SDK patch.
