import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { upsertDirectoryPage, setCapture } from "../src/directory";
import { ingestEvent } from "../src/capture";
import {
  cleanup,
  diagnostics,
  exportConversation,
  getPolicyProposal,
  applyPolicyProposal,
  proposalPolicy,
} from "../src/operations";

const e: Env = {
  ...env,
  OWNER_SUB: "synthetic-owner",
  INSTALLATION_EPOCH: "op-e1",
  CONNECTION_GENERATION: "op-g1",
  MAINTENANCE: "false",
  PUBLIC_ORIGIN: "https://mcp.example.test",
};
const fence = {
  epoch: e.INSTALLATION_EPOCH,
  generation: e.CONNECTION_GENERATION,
};
async function chat() {
  return (
    await upsertDirectoryPage(e, fence, {
      items: [
        {
          externalId: "synthetic-group",
          kind: "group",
          name: "Equipe privada",
        },
      ],
      complete: true,
    })
  ).items[0]!;
}
async function proof(p: Awaited<ReturnType<typeof proposalPolicy>>) {
  return {
    sub: e.OWNER_SUB,
    epoch: e.INSTALLATION_EPOCH,
    purpose: p.kind === "capture" ? ("capture-policy" as const) : p.kind,
    resourceId: p.id,
    envelopeHash: p.hash,
  };
}
beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM policy_proposals; DELETE FROM auth_nonces; DELETE FROM actions; DELETE FROM media_jobs; DELETE FROM media_derivatives; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM pending_statuses; DELETE FROM chats; DELETE FROM policies;",
  );
});
describe("operação local", () => {
  it("proposta de captura exige proof exato e é consumida uma vez", async () => {
    const c = await chat();
    const p = await proposalPolicy(e, {
      kind: "capture",
      chatId: c.id,
      enabled: true,
    });
    expect(p.confirmationUrl).toContain(p.id);
    await expect(
      applyPolicyProposal(e, p.id, {
        ...(await proof(p)),
        envelopeHash: "bad",
      }),
    ).rejects.toThrow();
    expect(
      (await exportConversation(e, { chatId: c.id })).coverage.captureEnabled,
    ).toBe(false);
    expect((await applyPolicyProposal(e, p.id, await proof(p))).status).toBe(
      "applied",
    );
    await expect(
      applyPolicyProposal(e, p.id, await proof(p)),
    ).rejects.toThrow();
    expect(
      (await exportConversation(e, { chatId: c.id })).coverage.captureEnabled,
    ).toBe(true);
    const stop = await proposalPolicy(e, {
      kind: "capture",
      chatId: c.id,
      enabled: false,
    });
    await applyPolicyProposal(e, stop.id, await proof(stop));
    expect(
      (await exportConversation(e, { chatId: c.id })).coverage.discontinuous,
    ).toBe(true);
  });
  it("proposta concorrente com estado antigo não sobrescreve mudança aprovada", async () => {
    const c = await chat();
    const a = await proposalPolicy(e, {
      kind: "capture",
      chatId: c.id,
      enabled: true,
    });
    const b = await proposalPolicy(e, {
      kind: "capture",
      chatId: c.id,
      enabled: false,
    });
    await applyPolicyProposal(e, a.id, await proof(a));
    await expect(
      applyPolicyProposal(e, b.id, await proof(b)),
    ).rejects.toMatchObject({ code: "proposal_stale" });
    expect(
      (await exportConversation(e, { chatId: c.id })).coverage.captureEnabled,
    ).toBe(true);
  });
  it("exclusão lógica remove conteúdo e invalida ação antes do cleanup R2", async () => {
    const c = await chat();
    await setCapture(e, c.id, true, fence);
    await ingestEvent(e, fence, {
      chatExternalId: "synthetic-group",
      externalId: "m1",
      kind: "text",
      fromMe: false,
      text: "segredo",
      timestamp: 1,
    });
    const m = await env.DB.prepare("SELECT id FROM messages WHERE chat_id=?")
      .bind(c.id)
      .first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO media(id,chat_id,message_id,epoch,generation,kind,state,object_key,source_url,created_at) VALUES(?,?,?,?,?,'image','ready',?,'https://private.example/file',?)",
    )
      .bind(
        "med1",
        c.id,
        m!.id,
        fence.epoch,
        fence.generation,
        "private/object",
        Date.now(),
      )
      .run();
    await e.MEDIA.put("private/object", "bytes");
    await env.DB.prepare(
      "INSERT INTO actions(id,epoch,generation,chat_id,envelope_json,hash,status,expires_at,created_at) VALUES(?,?,?,?,?,'hash','approved',?,?)",
    )
      .bind(
        "action1",
        fence.epoch,
        fence.generation,
        c.id,
        '{"text":"secret"}',
        Date.now() + 60000,
        Date.now(),
      )
      .run();
    const p = await proposalPolicy(e, { kind: "delete", chatId: c.id });
    await applyPolicyProposal(e, p.id, await proof(p));
    const view = await exportConversation(e, { chatId: c.id });
    expect(view.items[0]).toMatchObject({ text: null, deleted: true });
    expect(
      (
        await env.DB.prepare("SELECT source_url FROM media WHERE id=?")
          .bind("med1")
          .first<{ source_url: string | null }>()
      )?.source_url,
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT status,envelope_json FROM actions WHERE id=?",
      )
        .bind("action1")
        .first<{ status: string; envelope_json: string }>(),
    ).toMatchObject({ status: "cancelled", envelope_json: "{}" });
    expect(await e.MEDIA.get("private/object")).not.toBeNull();
    await cleanup(e);
    expect(await e.MEDIA.get("private/object")).toBeNull();
    expect(
      (
        await ingestEvent(e, fence, {
          chatExternalId: "synthetic-group",
          externalId: "m2",
          kind: "text",
          fromMe: false,
          text: "after",
          timestamp: 2,
        })
      ).captured,
    ).toBe(false);
  });
  it("retenção opt-in só afeta epoch atual e export usa cursor da busca", async () => {
    const c = await chat();
    await setCapture(e, c.id, true, fence);
    await ingestEvent(e, fence, {
      chatExternalId: "synthetic-group",
      externalId: "old",
      kind: "text",
      fromMe: false,
      text: "antigo",
      timestamp: 1,
    });
    await ingestEvent(e, fence, {
      chatExternalId: "synthetic-group",
      externalId: "new",
      kind: "text",
      fromMe: false,
      text: "recente",
      timestamp: Date.now(),
    });
    const first = await exportConversation(e, { chatId: c.id, limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    const second = await exportConversation(e, {
      chatId: c.id,
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect((await cleanup(e)).retainedMessages).toBe(0);
    const p = await proposalPolicy(e, { kind: "retention", days: 1 });
    await applyPolicyProposal(e, p.id, await proof(p));
    expect((await cleanup(e)).retainedMessages).toBe(1);
    expect(
      (await exportConversation(e, { chatId: c.id })).items.find(
        (x) => x.timestamp === 1,
      ),
    ).toMatchObject({ text: null, deleted: true });
    expect(JSON.stringify(await diagnostics(e))).not.toMatch(
      /Equipe privada|synthetic-group|antigo/,
    );
  });
});
