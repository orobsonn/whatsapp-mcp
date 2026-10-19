import { expect, it } from "vitest";
import {
  groupConfirmationMode,
  policyConfirmationMode,
  assertChatConfirmation,
  readableConfirmation,
} from "../src/approval";
import { confirmationPage } from "../src/pages";
it("keeps routine actions in chat and critical or unknown operations on the owner page", () => {
  for (const operation of [
    "create",
    "name",
    "photo",
    "description",
    "add_participants",
    "approve_participants",
    "reject_participants",
    "accept_invite",
    "reset_invite",
    "mention_members",
    "mention_groups",
    "mention_all",
    "chat_read",
    "chat_archive",
    "chat_pin",
    "chat_mute",
  ])
    expect(groupConfirmationMode({ operation })).toBe("chat");
  for (const operation of [
    "chat_clear",
    "chat_delete",
    "remove_participants",
    "leave",
    "promote_admins",
    "demote_admins",
    "settings",
    "link_groups",
    "unlink_groups",
    "unknown",
  ])
    expect(groupConfirmationMode({ operation })).toBe("page");
  expect(
    groupConfirmationMode({
      operation: "chat_expiration",
      chatExpiration: "OFF",
    }),
  ).toBe("chat");
  expect(
    groupConfirmationMode({
      operation: "chat_expiration",
      chatExpiration: "7_DAYS",
    }),
  ).toBe("page");
  expect(policyConfirmationMode({ kind: "capture", enabled: true })).toBe(
    "chat",
  );
  expect(policyConfirmationMode({ kind: "delete" })).toBe("page");
  expect(
    policyConfirmationMode({ kind: "retention", previous: null, days: 30 }),
  ).toBe("page");
  expect(
    policyConfirmationMode({ kind: "retention", previous: 30, days: 7 }),
  ).toBe("page");
  expect(
    policyConfirmationMode({ kind: "retention", previous: 30, days: 90 }),
  ).toBe("chat");
  expect(
    policyConfirmationMode({ kind: "retention", previous: 30, days: null }),
  ).toBe("chat");
});
it("binds client chat attestation to the frozen hash and rejects critical actions", () => {
  const hash = "a".repeat(64);
  expect(() =>
    assertChatConfirmation({ confirmed: true, hash }, hash, "chat"),
  ).not.toThrow();
  for (const c of [
    undefined,
    { confirmed: false, hash },
    { confirmed: true, hash: "b".repeat(64) },
  ])
    expect(() => assertChatConfirmation(c, hash, "chat")).toThrow();
  expect(() =>
    assertChatConfirmation({ confirmed: true, hash }, hash, "page"),
  ).toThrow("browser_confirmation_required");
});
it("renders human names and consequences, with technical data collapsed and escaped", async () => {
  const envelope = {
    operation: { operation: "remove_participants", chatId: "internal-id" },
    targets: [
      { kind: "group", name: "Equipe", id: "internal-id" },
      { kind: "member", name: "<script>Ana</script>", id: "member-id" },
    ],
    warnings: [],
  };
  const display = readableConfirmation("group", envelope);
  const html = await confirmationPage({
    title: "Confirmar operação",
    summary: "",
    envelope: JSON.stringify(envelope),
    hash: "a".repeat(64),
    nonce: "n",
    action: "/confirm/group/test",
    display,
  }).text();
  expect(html).toContain("Remover participantes");
  expect(html).toContain("Equipe");
  expect(html).toContain("&lt;script&gt;Ana&lt;/script&gt;");
  expect(html).not.toContain("<script>Ana</script>");
  expect(html.indexOf("<details>")).toBeLessThan(html.indexOf("internal-id"));
  expect(html).toContain("Detalhes técnicos");
});
