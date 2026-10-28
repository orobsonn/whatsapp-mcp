import { afterEach, describe, expect, it, vi } from "vitest";
import assistant from "../assistant/index";

afterEach(() => vi.restoreAllMocks());

describe("assistant shadow boundary", () => {
  it("reports shadow capabilities without claiming an operational pilot", async () => {
    const response = await assistant.fetch(
      new Request("https://assistant.example/health"),
      {},
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      mode: "shadow",
      capabilities: { whatsappSend: false, whatsappAutonomousSend: false, calendarWrite: false },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["POST", "/send"],
    ["POST", "/whatsapp/send"],
    ["POST", "/actions"],
    ["POST", "/actions/synthetic/execute"],
    ["POST", "/calendar/events"],
    ["PATCH", "/calendar/events/synthetic"],
    ["DELETE", "/calendar/events/synthetic"],
    ["GET", "/send?mode=live"],
    ["POST", "/health"],
    ["POST", "/unregistered-action"],
  ])("rejects %s %s without external I/O", async (method, path) => {
    const external = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("External I/O is forbidden in this boundary");
    });
    const response = await assistant.fetch(
      new Request(`https://assistant.example${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-Mode": "live" },
        ...(method !== "GET" ? { body: '{"approved":true,"mode":"live"}' } : {}),
      }),
      {},
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "shadow_only" });
    expect(external).not.toHaveBeenCalled();
  });
});
