# Telegram owner tools

Goal: all twelve MCP capability groups available on explicit authenticated owner commands from Telegram, with autonomous WhatsApp replies remaining OFF.

Architecture: reuse the MCP's closed catalog, schemas and existing handlers through a named service capability. Native task ownerRequest is the authority; scheduled, curator, WhatsApp and stale deliveries grant none. Source callbacks recheck authority; durable request claims prevent retries after uncertain effects. Preserve existing critical page confirmations. Do not add providers, broad API tools or lift media limits.

Implementation:
- [ ] Source catalog collector, closed tool RPC, scope/secret checks, request receipts and execution guards.
- [ ] Own task-bound capability and authorization callback, Telegram discovery/execution tools, instructions.
- [ ] Focused real-boundary tests: owner-only vs scheduled/WA, replay/uncertainty, schema/catalog and existing confirmation enforcement. Check types, builds and existing regression suite.
- [ ] Independent adversarial/code review, release and direct deployment preserving production configuration and autonomy OFF. Read-only production smoke; no unsolicited third-party messages.

Ruling: reuse the existing curator fix base (0.53.4); keep that earlier PR separate. No new baseline/harness installed per project exception.
