import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import app from "../src/index";
import { createMcpServer } from "../src/mcp";
import { generateAudio } from "../src/tts";
import { currentFence } from "../src/core";
import { upsertDirectoryPage } from "../src/directory";
import type { Env } from "../src/env";
import { mp3 } from "./fixtures/audio";
const e: Env = {
  ...env,
  PUBLIC_ORIGIN: "https://tts.example",
  ACCESS_ISSUER: "https://tts.cloudflareaccess.com",
  ACCESS_AUD: "tts-aud",
  OWNER_SUB: "owner-tts",
  INSTALLATION_EPOCH: "ep-preview",
  CONNECTION_GENERATION: "gen-preview",
  MAINTENANCE: "false",
  TTS_ENABLED: "true",
  FISH_API_KEY: "synthetic",
  FISH_VOICE_ID: "test-voice",
  FISH_VOICE_NAME: "Minha voz <script>bad()</script>",
  FISH_TTS_MODEL: "s2.1-pro",
};
let key: CryptoKey, jwk: Record<string, unknown>, chatId: string;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "tts-jwk", alg: "RS256" };
});
beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM tts_generations; DELETE FROM media_derivatives; DELETE FROM media_jobs; DELETE FROM actions; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM directory_syncs; DELETE FROM chats",
  );
  chatId = (
    await upsertDirectoryPage(e, currentFence(e), {
      items: [{ externalId: "preview", kind: "individual", name: "Prévia" }],
      complete: true,
    })
  ).items[0]!.id;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      expect(String(url)).toBe(`${e.ACCESS_ISSUER}/cdn-cgi/access/certs`);
      return Response.json({ keys: [jwk] });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
async function token(sub = e.OWNER_SUB, expires = "5m") {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "tts-jwk" })
    .setIssuer(e.ACCESS_ISSUER)
    .setAudience(e.ACCESS_AUD)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(key);
}
const call = (path: string, headers: HeadersInit = {}, settings = e) =>
  app.fetch(
    new Request(`${e.PUBLIC_ORIGIN}${path}`, { headers }),
    settings,
    createExecutionContext(),
  );
const generate = () =>
  generateAudio(
    e,
    { chatId, text: "Olá <img src=x onerror=bad()>" },
    async () =>
      new Response(mp3, { headers: { "content-type": "audio/mpeg" } }),
  );
it("prévia escapa conteúdo e permite reprodução somente na mesma origem autenticada", async () => {
  const generated = await generate(),
    cookie = `CF_Authorization=${await token()}`;
  const page = await call(`/audio/${generated.id}`, { cookie });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain(
    "media-src 'self'",
  );
  expect(page.headers.get("cache-control")).toBe("no-store");
  const html = await page.text();
  expect(html).toContain("&lt;img");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain(
    `<audio controls preload="none" src="/audio/${generated.id}/file"`,
  );
  expect(html).toContain("Gerar não envia WhatsApp");
  expect(html).toContain("não precisa confirmar novamente");
  expect(html).not.toContain("Bearer");
  expect(html).not.toContain("?token");
  const audio = await call(`/audio/${generated.id}/file`, { cookie });
  expect(audio.status).toBe(200);
  expect(audio.headers.get("content-disposition")).toContain("inline");
  expect(audio.headers.get("content-type")).toBe("audio/mpeg");
  expect(new Uint8Array(await audio.arrayBuffer())).toEqual(mp3);
  const partial = await call(`/audio/${generated.id}/file`, {
    cookie,
    range: "bytes=2-8",
  });
  expect(partial.status).toBe(206);
  expect(partial.headers.get("content-range")).toBe(`bytes 2-8/${mp3.length}`);
  expect(new Uint8Array(await partial.arrayBuffer())).toEqual(mp3.slice(2, 9));
  expect(
    (
      await call(`/audio/${generated.id}/file`, {
        cookie,
        range: `bytes=${mp3.length}-`,
      })
    ).status,
  ).toBe(416);
});
it("HTML e bytes recusam falta de login, bearer MCP, outro dono, cookie vencido, epoch/conexão antiga e manutenção", async () => {
  const g = await generate();
  for (const path of [`/audio/${g.id}`, `/audio/${g.id}/file`]) {
    for (const headers of <HeadersInit[]>[
      {},
      { authorization: "Bearer mcp-token" },
      { cookie: `CF_Authorization=${await token("wrong")}` },
      { cookie: `CF_Authorization=${await token(e.OWNER_SUB, "-1s")}` },
    ])
      expect((await call(path, headers)).status).toBe(403);
    const cookie = `CF_Authorization=${await token()}`;
    for (const overrides of [
      { INSTALLATION_EPOCH: "different" },
      { CONNECTION_GENERATION: "different" },
      { MAINTENANCE: "true" },
    ])
      expect(
        (await call(path, { cookie }, { ...e, ...overrides })).status,
      ).toBeGreaterThanOrEqual(400);
  }
});
it("não reproduz arquivo alterado ou apagado", async () => {
  const g = await generate(),
    cookie = `CF_Authorization=${await token()}`;
  const m = await env.DB.prepare("SELECT object_key FROM media WHERE id=?")
    .bind(g.media!.id)
    .first<{ object_key: string }>();
  await env.MEDIA.put(m!.object_key, new Uint8Array([1, 2, 3]));
  expect((await call(`/audio/${g.id}/file`, { cookie })).status).toBe(409);
  await env.DB.prepare(
    "UPDATE media SET deleted_at=1,state='deleted' WHERE id=?",
  )
    .bind(g.media!.id)
    .run();
  expect((await call(`/audio/${g.id}`, { cookie })).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT text,voice_name FROM tts_generations WHERE id=?",
    )
      .bind(g.id)
      .first(),
  ).toEqual({ text: null, voice_name: null });
});
it("MCP expõe orientação sem configuração e rejeita parâmetros de segredo/voz/url", async () => {
  const server = createMcpServer({ ...e, TTS_ENABLED: "false" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tts-test", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    const list = await client.listTools();
    expect(
      list.tools.find((t) => t.name === "gerar_audio")?.annotations
        ?.openWorldHint,
    ).toBe(true);
    for (const name of ["gerar_audio", "preparar_envio", "executar_envio"]) {
      const description = list.tools.find((t) => t.name === name)!.description!;
      expect(description).toContain("pedido de envio");
      expect(description).not.toMatch(/NOVA autorização|após a revisão/);
    }
    const result = await client.callTool({
      name: "gerar_audio",
      arguments: { chatId, text: "Olá" },
    });
    expect(JSON.stringify(result)).toContain("FISH_API_KEY");
    expect(JSON.stringify(result)).toContain("indisponível");
    const bad = await client.callTool({
      name: "gerar_audio",
      arguments: {
        chatId,
        text: "Olá",
        url: "https://evil.example",
        voiceId: "other",
        apiKey: "bad",
      },
    });
    expect(bad.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
});
