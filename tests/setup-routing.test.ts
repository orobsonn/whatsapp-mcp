import { env, createExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
const e: Env = {
  ...env,
  PUBLIC_ORIGIN: "https://setup-router.example",
  RUNTIME_CONFIG: "database",
  OWNER_SUB: "owner",
  INSTALLATION_EPOCH: "setup-router-e",
  CONNECTION_GENERATION: "pending",
  MAINTENANCE: "false",
  ZAPI_INSTANCE_ID: "DO-NOT-USE-LEGACY",
  ZAPI_TOKEN: "DO-NOT-USE-TOKEN",
  ZAPI_CLIENT_TOKEN: "DO-NOT-USE-CLIENT",
};
const call = (path: string) =>
  app.fetch(new Request(e.PUBLIC_ORIGIN + path), e, createExecutionContext());
it("setup exige login independente do MCP mesmo antes da ativação", async () => {
  expect((await call("/setup")).status).toBe(403);
});
it("health sinaliza configuração ausente sem ativar credenciais legadas", async () => {
  const r = await call("/health");
  expect(r.status).toBe(200);
  const text = await r.text();
  expect(JSON.parse(text)).toMatchObject({
    connectionConfigured: false,
    maintenance: true,
  });
  expect(text).not.toMatch(/DO-NOT|owner|setup-router-e/);
});
it("raiz encaminha para página privada e não expõe formulário público", async () => {
  const r = await call("/");
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/setup");
});
