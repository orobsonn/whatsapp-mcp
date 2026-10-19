/** Closed Z-API transport. No provider-controlled URL or error text is returned to callers. */
export interface ZapiEnv {
  ZAPI_INSTANCE_ID?: string;
  ZAPI_TOKEN?: string;
  ZAPI_CLIENT_TOKEN?: string;
  CONNECTED_PHONE?: string;
}

export interface ZapiSendEnvelope {
  destination: string;
  kind: "text" | "image" | "pdf" | "audio";
  text?: string;
  caption?: string;
  fileName?: string;
  mime?: string;
  bytes?: Uint8Array;
  replyTo?: string;
}

export interface ZapiSendIds {
  messageId?: string;
  zaapId?: string;
  id?: string;
}
export interface ZapiContact {
  phone: string;
  name?: string;
  short?: string;
  vname?: string;
  notify?: string;
}
export interface ZapiGroup {
  phone: string;
  name?: string;
  isGroup?: boolean;
}

export class ZapiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZapiError";
  }
}

/** An effectful request may have reached the provider, including a GET mutation. */
export class ProviderUncertainError extends ZapiError {
  constructor() {
    super(
      "Resultado da operação incerto; concilie com o provedor antes de nova tentativa.",
    );
    this.name = "ProviderUncertainError";
  }
}

const MAX_RESPONSE = 256 * 1024;
const MAX_MEDIA = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const SEND_MIMES = {
  image: ["image/png", "image/jpeg", "image/webp"],
  pdf: ["application/pdf"],
  audio: ["audio/mpeg", "audio/ogg", "audio/mp4"],
} as const;
export function supportsSendMedia(
  kind: "image" | "pdf" | "audio",
  mime: string,
): boolean {
  return (SEND_MIMES[kind] as readonly string[]).includes(mime);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ZapiError("Resposta Z-API inválida.");
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function optionalString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!nonempty(value)) throw new ZapiError("Resposta Z-API inválida.");
  return value;
}
function exactAddress(value: unknown): string {
  if (!nonempty(value) || value.length > 256 || /[\x00-\x1f\x7f]/.test(value))
    throw new ZapiError("Destino inválido.");
  return value;
}
function pageArgs(page: number, pageSize: number): string {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  )
    throw new ZapiError("Página inválida.");
  return `?page=${page}&pageSize=${pageSize}`;
}
function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 12_288) {
    chunks.push(
      btoa(String.fromCharCode(...bytes.subarray(offset, offset + 12_288))),
    );
  }
  return chunks.join("");
}
function media(
  bytes: unknown,
  mime: unknown,
  allowed: readonly string[],
): string {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length === 0 ||
    bytes.length > MAX_MEDIA ||
    typeof mime !== "string" ||
    !allowed.includes(mime)
  )
    throw new ZapiError("Mídia inválida.");
  return `data:${mime};base64,${base64(bytes)}`;
}
function sendBody(envelope: ZapiSendEnvelope): {
  endpoint: string;
  body: Record<string, string>;
} {
  const phone = exactAddress(envelope.destination);
  const body: Record<string, string> = { phone };
  if (envelope.replyTo !== undefined) {
    if (
      !nonempty(envelope.replyTo) ||
      envelope.replyTo.length > 256 ||
      /[\x00-\x1f\x7f]/.test(envelope.replyTo)
    )
      throw new ZapiError("Citação inválida.");
    if (envelope.kind === "audio")
      throw new ZapiError("Citação de áudio não documentada.");
    body.messageId = envelope.replyTo;
  }
  if (envelope.kind === "text") {
    if (
      !nonempty(envelope.text) ||
      !envelope.text.trim() ||
      envelope.text.length > 8000
    )
      throw new ZapiError("Texto inválido.");
    body.message = envelope.text;
    return { endpoint: "send-text", body };
  }
  if (envelope.caption !== undefined) {
    if (typeof envelope.caption !== "string" || envelope.caption.length > 8000)
      throw new ZapiError("Legenda inválida.");
    if (envelope.kind === "audio")
      throw new ZapiError("Legenda de áudio não documentada.");
    body.caption = envelope.caption;
  }
  if (envelope.kind === "image") {
    body.image = media(envelope.bytes, envelope.mime, SEND_MIMES.image);
    return { endpoint: "send-image", body };
  }
  if (envelope.kind === "pdf") {
    if (
      typeof envelope.fileName !== "string" ||
      !/^[^/\\\x00-\x1f\x7f]{1,128}\.pdf$/i.test(envelope.fileName) ||
      envelope.fileName === "..pdf"
    )
      throw new ZapiError("Nome de arquivo inválido.");
    body.document = media(envelope.bytes, envelope.mime, SEND_MIMES.pdf);
    body.fileName = envelope.fileName;
    return { endpoint: "send-document/pdf", body };
  }
  if (envelope.kind === "audio") {
    body.audio = media(envelope.bytes, envelope.mime, SEND_MIMES.audio);
    return { endpoint: "send-audio", body };
  }
  throw new ZapiError("Tipo de envio inválido.");
}

export class ZapiClient {
  constructor(
    private readonly env: ZapiEnv,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private url(endpoint: string): string {
    const {
      ZAPI_INSTANCE_ID: instance,
      ZAPI_TOKEN: token,
      ZAPI_CLIENT_TOKEN: clientToken,
    } = this.env;
    if (!nonempty(instance) || !nonempty(token) || !nonempty(clientToken))
      throw new ZapiError("Z-API não configurada.");
    return `https://api.z-api.io/instances/${encodeURIComponent(instance)}/token/${encodeURIComponent(token)}/${endpoint}`;
  }

  protected async request(
    endpoint: string,
    body?: Record<string, unknown>,
    options: { method: "GET" | "POST"; effect: boolean } = {
      method: body === undefined ? "GET" : "POST",
      effect: body !== undefined,
    },
  ): Promise<unknown> {
    const url = this.url(endpoint);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const isSend = options.effect;
    try {
      const response = await this.fetcher(url, {
        method: options.method,
        headers: {
          "Client-Token": this.env.ZAPI_CLIENT_TOKEN!,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400)
        throw isSend
          ? new ProviderUncertainError()
          : new ZapiError("Redirecionamento Z-API recusado.");
      if (!response.ok)
        throw isSend && response.status >= 500
          ? new ProviderUncertainError()
          : new ZapiError(`Falha Z-API HTTP ${response.status}.`);
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && Number(contentLength) > MAX_RESPONSE)
        throw isSend
          ? new ProviderUncertainError()
          : new ZapiError("Resposta Z-API excede limite.");
      if (!response.body)
        throw isSend
          ? new ProviderUncertainError()
          : new ZapiError("Resposta Z-API vazia.");
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_RESPONSE) {
          await reader.cancel();
          throw isSend
            ? new ProviderUncertainError()
            : new ZapiError("Resposta Z-API excede limite.");
        }
        parts.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      try {
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            bytes,
          ),
        );
      } catch {
        throw isSend
          ? new ProviderUncertainError()
          : new ZapiError("Resposta Z-API inválida.");
      }
    } catch (error) {
      if (error instanceof ZapiError) throw error;
      throw isSend
        ? new ProviderUncertainError()
        : new ZapiError("Falha de rede Z-API.");
    } finally {
      clearTimeout(timer);
    }
  }

  async status(): Promise<{ connected: boolean; phone?: string }> {
    const status = object(await this.request("status"));
    if (typeof status.connected !== "boolean")
      throw new ZapiError("Resposta Z-API inválida.");
    if (!status.connected) return { connected: false };
    const device = object(await this.request("device"));
    if (!nonempty(device.phone))
      throw new ZapiError("Identidade do aparelho indisponível.");
    return { connected: true, phone: device.phone };
  }

  async listContacts(page: number, pageSize: number): Promise<ZapiContact[]> {
    const suffix = pageArgs(page, pageSize);
    const data = await this.request(`contacts${suffix}`);
    if (!Array.isArray(data) || data.length > pageSize)
      throw new ZapiError("Resposta Z-API inválida.");
    return data.map((item) => {
      const row = object(item);
      if (!nonempty(row.phone)) throw new ZapiError("Resposta Z-API inválida.");
      return {
        phone: row.phone,
        ...Object.fromEntries(
          ["name", "short", "vname", "notify"]
            .map((key) => [key, optionalString(row, key)])
            .filter(([, value]) => value !== undefined),
        ),
      };
    });
  }

  async listGroups(page: number, pageSize: number): Promise<ZapiGroup[]> {
    const suffix = pageArgs(page, pageSize);
    const data = await this.request(`groups${suffix}`);
    if (!Array.isArray(data) || data.length > pageSize)
      throw new ZapiError("Resposta Z-API inválida.");
    return data.map((item) => {
      const row = object(item);
      if (
        !nonempty(row.phone) ||
        (row.isGroup !== undefined && row.isGroup !== true)
      )
        throw new ZapiError("Resposta Z-API inválida.");
      const name = optionalString(row, "name");
      return {
        phone: row.phone,
        ...(name === undefined ? {} : { name }),
        ...(row.isGroup === true ? { isGroup: true } : {}),
      };
    });
  }

  async send(envelope: ZapiSendEnvelope): Promise<ZapiSendIds> {
    const { endpoint, body } = sendBody(envelope);
    const data = await this.request(endpoint, body);
    try {
      const row = object(data);
      const result = {
        messageId: optionalString(row, "messageId"),
        zaapId: optionalString(row, "zaapId"),
        id: optionalString(row, "id"),
      };
      if (!result.messageId && !result.zaapId && !result.id)
        throw new ZapiError("Resposta Z-API inválida.");
      return Object.fromEntries(
        Object.entries(result).filter(([, value]) => value !== undefined),
      );
    } catch {
      throw new ProviderUncertainError();
    }
  }
}
