import { beforeAll, afterEach, describe, it, expect, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import app from "../src/index";
import { upsertDirectoryPage, setCapture } from "../src/directory";
import type { Env } from "../src/env";

const e: Env = {
  ...env,
  PUBLIC_ORIGIN: "https://journey.example",
  ACCESS_ISSUER: "https://journey.cloudflareaccess.com",
  ACCESS_AUD: "aud",
  OWNER_SUB: "owner",
  INSTALLATION_EPOCH: "epoch-j",
  CONNECTION_GENERATION: "gen-j",
  MAINTENANCE: "false",
  CONNECTED_PHONE: "synthetic-device",
  ZAPI_INSTANCE_ID: "synthetic-instance",
  ZAPI_TOKEN: "PRIVATE-INSTANCE-TOKEN",
  ZAPI_CLIENT_TOKEN: "PRIVATE-CLIENT-TOKEN",
  WEBHOOK_SECRET: "synthetic-webhook-secret-long-enough",
};
let key: CryptoKey, jwk: Record<string, unknown>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  key = pair.privateKey;
  jwk = {
    ...(await exportJWK(pair.publicKey)),
    kid: "journey-key",
    alg: "RS256",
  };
});
afterEach(() => vi.unstubAllGlobals());
async function ownerToken() {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "journey-key" })
    .setIssuer(e.ACCESS_ISSUER)
    .setAudience(e.ACCESS_AUD)
    .setSubject(e.OWNER_SUB)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key);
}
const call = (path: string, init: RequestInit = {}) =>
  app.fetch(
    new Request(`${e.PUBLIC_ORIGIN}${path}`, init),
    e,
    createExecutionContext(),
  );
function network() {
  let sends = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      if (u.hostname === "journey.cloudflareaccess.com")
        return Response.json({ keys: [jwk] });
      if (u.hostname !== "api.z-api.io")
        throw new Error("Unexpected external network");
      if (u.pathname.endsWith("/status"))
        return Response.json({ connected: true });
      if (u.pathname.endsWith("/device"))
        return Response.json({ phone: e.CONNECTED_PHONE });
      if (u.pathname.endsWith("/groups"))
        return Response.json([
          { phone: "group-j", name: "Equipe", isGroup: true },
        ]);
      if (u.pathname.endsWith("/group-invitation-metadata"))
        return Response.json({
          phone: "123456@g.us",
          subject: "Grupo do convite",
          participants: [],
        });
      if (u.pathname.endsWith("/accept-invite-group")) {
        expect(init?.method).toBe("GET");
        sends++;
        return Response.json({ success: true });
      }
      if (u.pathname.includes("group-metadata/"))
        return Response.json({
          phone: "123456@g.us",
          subject: "Equipe administração",
          participants: [],
        });
      if (u.pathname.includes("group-invitation-link/"))
        return Response.json({
          phone: "123456@g.us",
          invitationLink: "https://chat.whatsapp.com/PRIVATEinvite",
        });
      if (u.pathname.endsWith("/update-group-name")) {
        sends++;
        expect(JSON.parse(String(init?.body))).toEqual({
          groupId: "123456@g.us",
          groupName: "Equipe nova",
        });
        return Response.json({ value: true });
      }
      if (u.pathname.endsWith("/send-text")) {
        sends++;
        return Response.json({
          messageId: "outgoing-j",
          zaapId: "separate-id",
        });
      }
      throw new Error("Unexpected Z-API operation");
    }),
  );
  return () => sends;
}
async function bootstrap() {
  const registered = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Synthetic MCP",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id } = (await registered.json()) as { client_id: string };
  const verifier = "v".repeat(43);
  const hash = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...hash))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const query = new URLSearchParams({
    client_id,
    redirect_uri: "https://client.example/callback",
    response_type: "code",
    scope: "mcp offline_access",
    state: "state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${e.PUBLIC_ORIGIN}/mcp`,
  });
  const owner = await ownerToken();
  const page = await call(`/authorize?${query}`, {
    headers: { "Cf-Access-Jwt-Assertion": owner },
  });
  expect(page.status).toBe(200);
  const nonce = (await page.text()).match(/name="nonce" value="([^"]+)"/)![1]!;
  const consent = await call("/authorize", {
    method: "POST",
    headers: {
      "Cf-Access-Jwt-Assertion": owner,
      origin: e.PUBLIC_ORIGIN,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ nonce }),
  });
  expect(consent.status).toBe(302);
  const code = new URL(consent.headers.get("location")!).searchParams.get(
    "code",
  )!;
  const token = await call("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
      resource: `${e.PUBLIC_ORIGIN}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}
function result(value: unknown): any {
  const content = (value as { content: Array<{ type: string; text?: string }> })
    .content;
  return JSON.parse(content.find((x) => x.type === "text")!.text!);
}
describe("jornada HTTP e SDK MCP reais em runtime local", () => {
  it("nega webhook inválido e MCP sem token; segredo não aparece no diagnóstico público", async () => {
    expect(
      (
        await call("/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const response = await call("/webhook/gen-j/wrong", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
    const health = await call("/health");
    expect(health.status).toBe(200);
    const body = await health.text();
    expect(body).not.toContain("PRIVATE");
    expect(body).not.toContain(e.OWNER_SUB);
  });
  it("grupo → captura → consulta autoria → proposta → aprovação humana → envio → status", async () => {
    const sends = network();
    const token = await bootstrap();
    const client = new Client({ name: "synthetic-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${e.PUBLIC_ORIGIN}/mcp`),
      {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (input, init) =>
          app.fetch(new Request(input, init), e, createExecutionContext()),
      },
    );
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain("consultar_mensagens");
    expect(names).toContain("preparar_envio");
    expect(names).not.toContain("aprovar_envio");
    expect(names).not.toContain("executar_sql");
    const directory = result(
      await client.callTool({
        name: "sincronizar_diretorio",
        arguments: { kind: "group" },
      }),
    );
    const chat = directory.items[0]!;
    const policy = result(
      await client.callTool({
        name: "propor_captura",
        arguments: { chatId: chat.id, enabled: true },
      }),
    );
    const owner = await ownerToken();
    const policyPage = await call(`/confirm/policy/${policy.id}`, {
      headers: { "Cf-Access-Jwt-Assertion": owner },
    });
    expect(policyPage.status).toBe(200);
    const policyNonce = (await policyPage.text()).match(
      /name="nonce" value="([^"]+)"/,
    )![1]!;
    const policyApplied = await call(`/confirm/policy/${policy.id}`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": owner,
        origin: e.PUBLIC_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce: policyNonce }),
    });
    expect(policyApplied.status).toBe(200);
    const body = {
      instanceId: e.ZAPI_INSTANCE_ID,
      connectedPhone: e.CONNECTED_PHONE,
      type: "ReceivedCallback",
      phone: "group-j",
      isGroup: true,
      participantLid: "participant-lid",
      senderName: "Ana",
      messageId: "incoming-j",
      fromMe: false,
      momment: 1234,
      text: { message: "Combinado para amanhã" },
    };
    const webhook = await call(`/webhook/gen-j/${e.WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(webhook.status).toBe(200);
    const messages = result(
      await client.callTool({
        name: "consultar_mensagens",
        arguments: { chatId: chat.id },
      }),
    );
    expect(messages.items[0]).toMatchObject({
      text: "Combinado para amanhã",
      authorName: "Ana",
    });
    const prepared = result(
      await client.callTool({
        name: "preparar_envio",
        arguments: { chatId: chat.id, kind: "text", text: "Confirmado" },
      }),
    );
    expect(prepared.status).toBe("proposed");
    expect(
      (
        await client.callTool({
          name: "executar_envio",
          arguments: { id: prepared.id },
        })
      ).isError,
    ).toBe(true);
    expect(sends()).toBe(0);
    const confirmation = await call(`/confirm/send/${prepared.id}`, {
      headers: { "Cf-Access-Jwt-Assertion": owner },
    });
    expect(confirmation.status).toBe(200);
    const nonce = (await confirmation.text()).match(
      /name="nonce" value="([^"]+)"/,
    )![1]!;
    const approved = await call(`/confirm/send/${prepared.id}`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": owner,
        origin: e.PUBLIC_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce }),
    });
    expect(approved.status).toBe(200);
    const sent = result(
      await client.callTool({
        name: "executar_envio",
        arguments: { id: prepared.id },
      }),
    );
    expect(sent.status).toBe("accepted");
    expect(sends()).toBe(1);
    const status = await call(`/webhook/gen-j/${e.WEBHOOK_SECRET}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId: e.ZAPI_INSTANCE_ID,
        phoneDevice: e.CONNECTED_PHONE,
        type: "MessageStatusCallback",
        phone: "group-j",
        isGroup: true,
        status: "READ",
        ids: ["outgoing-j"],
      }),
    });
    expect(status.status).toBe(200);
    expect(
      result(
        await client.callTool({
          name: "consultar_envio",
          arguments: { id: prepared.id },
        }),
      ).status,
    ).toBe("read");
    const all = result(
      await client.callTool({
        name: "consultar_mensagens",
        arguments: { chatId: chat.id },
      }),
    );
    expect(all.items).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain("PRIVATE");
    expect(JSON.stringify(all)).not.toContain("group-j");
    const pdf = new TextEncoder().encode("%PDF-1.4\nArquivo sintético\n%%EOF");
    const form = new FormData();
    form.set(
      "file",
      new File([pdf], "ensaio.pdf", { type: "application/pdf" }),
    );
    const upload = await call(`/upload/${chat.id}`, {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": owner,
        origin: e.PUBLIC_ORIGIN,
        Accept: "application/json",
      },
      body: form,
    });
    expect(upload.status).toBe(200);
    const uploaded = (await upload.json()) as { id: string };
    expect(
      (
        await call(`/media/${uploaded.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
    const download = await call(`/media/${uploaded.id}`, {
      headers: { "Cf-Access-Jwt-Assertion": owner },
    });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(pdf);
    const resource = await client.callTool({
      name: "obter_midia",
      arguments: { id: uploaded.id },
    });
    expect(resource.isError).not.toBe(true);
    expect(
      (resource.content as Array<{ type: string }>).some(
        (c) => c.type === "resource",
      ),
    ).toBe(true);
    await client.close();
  });
  it("administração exige confirmação Access exata; convite só aparece na página privada", async () => {
    const effects = network();
    const token = await bootstrap();
    const client = new Client({
      name: "synthetic-group-client",
      version: "1.0.0",
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${e.PUBLIC_ORIGIN}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: async (input, init) =>
          app.fetch(new Request(input, init), e, createExecutionContext()),
      }),
    );
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("preparar_acao_grupo");
    expect(tools).not.toContain("aprovar_acao_grupo");
    const group = (
      await upsertDirectoryPage(
        e,
        { epoch: e.INSTALLATION_EPOCH, generation: e.CONNECTION_GENERATION },
        {
          items: [
            {
              externalId: "123456@g.us",
              kind: "group",
              name: "Equipe administração",
            },
          ],
          complete: true,
        },
      )
    ).items[0]!;
    const prepared = result(
      await client.callTool({
        name: "preparar_acao_grupo",
        arguments: {
          acao: { operation: "name", chatId: group.id, name: "Equipe nova" },
        },
      }),
    );
    expect(prepared.status).toBe("proposed");
    expect(
      (
        await client.callTool({
          name: "executar_acao_grupo",
          arguments: { id: prepared.id },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call(`/confirm/group/${prepared.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
    expect(effects()).toBe(0);
    const owner = await ownerToken();
    const page = await call(`/confirm/group/${prepared.id}`, {
      headers: { "Cf-Access-Jwt-Assertion": owner },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Equipe nova");
    expect(html).not.toContain("123456@g.us");
    expect(effects()).toBe(0);
    const nonce = html.match(/name="nonce" value="([^"]+)"/)![1]!;
    const init = {
      method: "POST",
      headers: {
        "Cf-Access-Jwt-Assertion": owner,
        origin: e.PUBLIC_ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ nonce }),
    };
    expect((await call(`/confirm/group/${prepared.id}`, init)).status).toBe(
      200,
    );
    expect([403, 409]).toContain(
      (await call(`/confirm/group/${prepared.id}`, init)).status,
    );
    const executed = result(
      await client.callTool({
        name: "executar_acao_grupo",
        arguments: { id: prepared.id },
      }),
    );
    expect(executed.status).toBe("accepted");
    await client.callTool({
      name: "executar_acao_grupo",
      arguments: { id: prepared.id },
    });
    expect(effects()).toBe(1);
    const invite = result(
      await client.callTool({
        name: "obter_convite_grupo",
        arguments: { chatId: group.id },
      }),
    );
    expect(invite.browserUrl).toBe(
      `${e.PUBLIC_ORIGIN}/groups/${group.id}/invite`,
    );
    expect(JSON.stringify(invite)).not.toContain("PRIVATEinvite");
    expect(
      (
        await call(`/groups/${group.id}/invite`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(403);
    const privatePage = await call(`/groups/${group.id}/invite`, {
      headers: { "Cf-Access-Jwt-Assertion": owner },
    });
    expect(privatePage.status).toBe(200);
    expect(privatePage.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await privatePage.text()).toContain(
      "https://chat.whatsapp.com/PRIVATEinvite",
    );
    const joining = result(
      await client.callTool({
        name: "preparar_acao_grupo",
        arguments: {
          acao: {
            operation: "accept_invite",
            inviteURL: "https://chat.whatsapp.com/PRIVATEinvite",
          },
        },
      }),
    );
    expect(joining.status).toBe("proposed");
    expect(JSON.stringify(joining)).toContain("Grupo do convite");
    expect(JSON.stringify(joining)).not.toContain("PRIVATEinvite");
    const joinPage = await call(`/confirm/group/${joining.id}`, {
      headers: { "Cf-Access-Jwt-Assertion": owner },
    });
    const joinHtml = await joinPage.text();
    expect(joinHtml).toContain("Grupo do convite");
    expect(effects()).toBe(1);
    const joinNonce = joinHtml.match(/name="nonce" value="([^"]+)"/)![1]!;
    expect(
      (
        await call(`/confirm/group/${joining.id}`, {
          ...init,
          body: new URLSearchParams({ nonce: joinNonce }),
        })
      ).status,
    ).toBe(200);
    expect(
      result(
        await client.callTool({
          name: "executar_acao_grupo",
          arguments: { id: joining.id },
        }),
      ).status,
    ).toBe("accepted");
    await client.callTool({
      name: "executar_acao_grupo",
      arguments: { id: joining.id },
    });
    expect(effects()).toBe(2);
    await client.close();
  });
});
it("MCP chat confirmation sends a frozen proposal without visiting the browser page", async () => {
  const effects = network(),
    token = await bootstrap();
  const client = new Client({ name: "synthetic-chat-client", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${e.PUBLIC_ORIGIN}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) =>
        app.fetch(new Request(input, init), e, createExecutionContext()),
    }),
  );
  const page = await upsertDirectoryPage(
    e,
    { epoch: e.INSTALLATION_EPOCH, generation: e.CONNECTION_GENERATION },
    {
      items: [
        { externalId: "group-j", kind: "group", name: "Equipe sintética" },
      ],
      complete: true,
    },
  );
  const a = result(
    await client.callTool({
      name: "preparar_envio",
      arguments: {
        chatId: page.items[0]!.id,
        kind: "text",
        text: "Ensaio sintético autorizado",
      },
    }),
  );
  expect(a.confirmationMode).toBe("chat");
  expect(a.confirmationUrl).toBeUndefined();
  expect(effects()).toBe(0);
  const denied = result(
    await client.callTool({
      name: "executar_envio",
      arguments: {
        id: a.id,
        confirmation: { confirmed: true, hash: "b".repeat(64) },
      },
    }),
  );
  expect(denied.error).toBe("confirmation_mismatch");
  expect(effects()).toBe(0);
  const sent = result(
    await client.callTool({
      name: "executar_envio",
      arguments: { id: a.id, confirmation: { confirmed: true, hash: a.hash } },
    }),
  );
  expect(sent.status).toBe("accepted");
  expect(effects()).toBe(1);
  await client.callTool({
    name: "executar_envio",
    arguments: { id: a.id, confirmation: { confirmed: true, hash: a.hash } },
  });
  expect(effects()).toBe(1);
  await client.close();
});
it("human upload returns a readable page and GPT retrieves metadata without asking for codes", async () => {
  network();
  const token = await bootstrap(),
    owner = await ownerToken();
  const page = await upsertDirectoryPage(
    e,
    { epoch: e.INSTALLATION_EPOCH, generation: e.CONNECTION_GENERATION },
    {
      items: [
        { externalId: "human-upload", kind: "group", name: "Equipe <x>" },
      ],
      complete: true,
    },
  );
  const chat = page.items[0]!;
  const headers = {
    "Cf-Access-Jwt-Assertion": owner,
    origin: e.PUBLIC_ORIGIN,
    Accept: "text/html",
  };
  const get = await call(`/upload/${chat.id}`, { headers });
  expect(get.headers.get("Content-Type")).toContain("text/html");
  expect(await get.text()).toContain("2 MB");
  const form = new FormData();
  form.set(
    "file",
    new File(
      [new TextEncoder().encode("%PDF-1.4\nSynthetic\n%%EOF")],
      "ensaio.pdf",
      { type: "application/pdf" },
    ),
  );
  const upload = await call(`/upload/${chat.id}`, {
    method: "POST",
    headers,
    body: form,
  });
  expect(upload.status).toBe(200);
  expect(upload.headers.get("Content-Type")).toContain("text/html");
  const html = await upload.text();
  expect(html).toContain("Arquivo guardado");
  expect(html).not.toContain("sha256");
  const client = new Client({ name: "synthetic-human-upload", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${e.PUBLIC_ORIGIN}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) =>
        app.fetch(new Request(input, init), e, createExecutionContext()),
    }),
  );
  const files = result(
    await client.callTool({
      name: "adicionar_arquivo",
      arguments: { chatId: chat.id },
    }),
  );
  expect(files.recentUploads).toHaveLength(1);
  expect(files.recentUploads[0].filename).toBe("ensaio.pdf");
  expect(files.recentUploads[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(files)).not.toContain("original/");
  const missing = await call("/media/missing", { headers });
  expect(missing.status).toBe(404);
  expect(missing.headers.get("Content-Type")).toContain("text/html");
  const mcp = await call("/mcp", { headers: { Accept: "text/html" } });
  expect(mcp.status).toBe(401);
  expect(mcp.headers.get("WWW-Authenticate")).toContain("Bearer");
  const oauth = await call("/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html",
    },
    body: "grant_type=authorization_code&code=invalid",
  });
  expect(oauth.headers.get("Content-Type")).toContain("application/json");
  const statusError = await call("/setup/status", {
    headers: { Accept: "text/html" },
  });
  expect(statusError.status).toBe(403);
  expect(statusError.headers.get("Content-Type")).toContain("application/json");
  const uploadError = await call(`/upload/${chat.id}`, {
    method: "POST",
    headers: { ...headers, Accept: "application/json" },
    body: new FormData(),
  });
  expect(uploadError.status).toBe(400);
  expect(uploadError.headers.get("Content-Type")).toContain("application/json");
  const deniedUpload = await call(`/upload/${chat.id}`, {
    headers: { Accept: "application/json" },
  });
  expect(deniedUpload.status).toBe(403);
  expect(deniedUpload.headers.get("Content-Type")).toContain(
    "application/json",
  );
  await client.close();
});
