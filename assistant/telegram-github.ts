import type { AssistantEnv } from "./env";
import { sourceTextHash, type SourceScope } from "./sources";
import { configuredGitHub, configuredGitHubRepositories } from "./connectors/configured-github";
import { githubQuery, githubReadFailure } from "./connectors/github";
import { ConnectorAccess, type OwnerReadBoundary } from "./connectors/read-only";
import type { ReplyDependency } from "./telegram-owner-replies";
import { telegramExcerpt, telegramText } from "./telegram-format";

type FileResult = { kind: "file"; state: "available"; origin: "github"; repository: string; commit: string; path: string; blobSha: string; fileHash: string; fileBytes: number; excerpt: string; excerptHash: string; truncated: boolean; execution: "unconfirmed"; deployment: "not_observed" };
type DirectoryResult = { kind: "directory"; state: "available"; origin: "github"; repository: string; commit: string; path: string; items: { path: string; type: string }[]; complete: boolean; execution: "unconfirmed"; deployment: "not_observed" };
export type GitHubObservation = { kind: "github"; query: ReturnType<typeof githubQuery.parse>; result: FileResult | DirectoryResult };
type Result = { state: "available"; text: string; dependencies: ReplyDependency[]; observation: GitHubObservation } | { state: "clarify" | "unavailable"; text: string };
type Selection = { action: "read" | "list" | null; repository: string | null; path: string | null };
const unavailable = (): Result => ({ state: "unavailable", text: "⚠️ <b>Não consegui consultar o GitHub</b>\n\nConfira o repositório e o caminho do arquivo. A consulta continua somente para leitura." });
const rateLimited = (): Result => ({ state: "unavailable", text: "⏳ <b>O GitHub atingiu o limite de consultas</b>\n\nNão consegui ler esse arquivo agora. Você pode tentar novamente mais tarde." });
function explicitRepositories(text: string, path: string | null) {
  const names = new Set<string>(); let otherURL = false, ref = false;
  let remainder = text.replace(/https?:\/\/[^\s<>()]+/gi, value => {
    try {
      const url = new URL(value.replace(/[.,;!?]+$/, "")), parts = url.pathname.split("/").filter(Boolean);
      if (url.hostname.toLowerCase() !== "github.com" || parts.length < 2) otherURL = true;
      else { names.add((parts[0] + "/" + parts[1]).toLowerCase()); if (parts[2] === "blob" || parts[2] === "tree") ref = true; }
    } catch { otherURL = true; }
    return "";
  });
  // A literal file path is distinct from an owner/repository qualifier. The
  // model cannot hide an explicit repository URL inside its path selection.
  const filePhrase = path && ["arquivo ", "path ", "caminho "].some(prefix => ["", "`", '"', "“"].some(quote => remainder.toLowerCase().includes(prefix + quote + path.toLowerCase())));
  if (path && (filePhrase || names.size)) remainder = remainder.replace(path, "");
  for (const match of remainder.matchAll(/\b([A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100})\b/g)) names.add(match[1].toLowerCase());
  return { names: [...names], otherURL, ref };
}

export async function readTelegramGitHub(env: AssistantEnv, scope: SourceScope, selected: Selection, ownerText: string, boundary: OwnerReadBoundary): Promise<Result> {
  // Do not replace an explicitly requested ref with a different default ref.
  if (/\b(?:commit|branch|tag|sha|vers[aã]o)\b/i.test(ownerText)) return { state: "clarify", text: "📦 <b>Qual referência você quer consultar?</b>\n\nNeste diálogo consulto a branch padrão do repositório. Ainda preciso esclarecer pedidos com commit, tag ou outra branch." };
  let stage: "admission" | "resolve" | "contents" | "presentation" = "admission";
  try {
    await boundary.check(); if (!env.DB) return unavailable();
    const repositories = configuredGitHubRepositories(env), explicit = explicitRepositories(ownerText, selected.path);
    if (explicit.otherURL || explicit.ref || explicit.names.length > 1) return { state: "clarify", text: "📦 <b>Confirma o repositório?</b>\n\nPreciso de um único repositório autorizado, sem referência a outra branch ou tag." };
    let matches = selected.repository === null ? repositories : repositories.filter(r => [r.id, r.repo, r.owner + "/" + r.repo].some(value => value.toLowerCase() === selected.repository!.toLowerCase()));
    if (explicit.names.length) {
      const authoritative = repositories.filter(r => (r.owner + "/" + r.repo).toLowerCase() === explicit.names[0]);
      if (!authoritative.length) return unavailable();
      if (selected.repository !== null && (matches.length !== 1 || matches[0].id !== authoritative[0].id)) return { state: "clarify", text: "📦 <b>Confirma o repositório?</b>\n\nO nome indicado no pedido está diferente da seleção. Diga qual repositório você quer ler." };
      matches = authoritative;
    }
    if (!matches.length) return unavailable();
    if (matches.length !== 1) return { state: "clarify", text: "📦 <b>Qual repositório?</b>\n\nDiga o nome ou o identificador dono/repositório que você quer consultar." };
    if (!selected.action) return { state: "clarify", text: "📄 <b>O que você quer ler?</b>\n\nVocê pode pedir um arquivo, como o README, ou listar os arquivos do repositório." };
    const repository = matches[0], query = githubQuery.parse({ kind: selected.action === "list" ? "github.list" : "github.read", repository: repository.id, commit: "0".repeat(40), path: selected.path ?? "", ...(selected.action === "list" ? { limit: 10 } : {}) });
    const access = new ConnectorAccess(env.DB!, scope), source = await access.admit({ kind: "owner" }, repository);
    if (!source) return unavailable();
    const configured = configuredGitHub(env, scope, { ...boundary, check: async () => {
      await boundary.check(); if (!await access.current({ kind: "owner" }, source)) throw Error("github_authorization_changed");
    } });
    if (configured.state !== "ready") return unavailable();
    stage = "resolve";
    const commit = await configured.resolveDefault(repository.id); await configured.check();
    if (!await access.current({ kind: "owner" }, source)) return unavailable();
    stage = "contents";
    const pinned = { ...query, commit }, raw = await configured.reader.execute({ kind: "owner" }, pinned) as Record<string, any>;
    await configured.check(); if (raw.state !== "available") return raw.reason === "github_rate_limited" ? rateLimited() : unavailable();
    if (!await access.current({ kind: "owner" }, source)) return unavailable();
    stage = "presentation";
    const label = telegramText(repository.owner + "/" + repository.repo, 200), footer = `\n\n📦 ${label}\n🔎 <i>commit consultado: <code>${commit.slice(0, 12)}</code></i>`;
    let text: string, result: FileResult | DirectoryResult;
    if (pinned.kind === "github.read") {
      if (typeof raw.text !== "string") return unavailable();
      const excerpt = telegramExcerpt(raw.text, 2400);
      result = { kind: "file", state: "available", origin: "github", repository: repository.id, commit, path: pinned.path, blobSha: raw.blobSha, fileHash: raw.hash,
        fileBytes: new TextEncoder().encode(raw.text).length, excerpt: excerpt.text, excerptHash: await sourceTextHash(excerpt.text), truncated: excerpt.truncated, execution: "unconfirmed", deployment: "not_observed" };
      text = `📄 <b>${telegramText(pinned.path, 200)}</b>\n\n${excerpt.html}${excerpt.truncated ? "\n\n<i>Trecho inicial do arquivo; há mais conteúdo.</i>" : ""}${footer}`;
    } else {
      result = { kind: "directory", state: "available", origin: "github", repository: repository.id, commit, path: pinned.path, items: raw.items.map((item: any) => ({ path: item.path, type: item.type })), complete: raw.coverage.complete, execution: "unconfirmed", deployment: "not_observed" };
      text = "📦 <b>ARQUIVOS DO REPOSITÓRIO</b>\n\n" + result.items.map(item => `${item.type === "dir" ? "📁" : "📄"} ${telegramText(item.path, 180)}`).join("\n\n");
      if (!result.items.length) text += "Nenhum item nesse diretório.";
      if (!result.complete) text += `\n\n<i>Mostrei ${result.items.length} itens deste diretório; o recorte não está completo.</i>`;
      text += footer;
    }
    const observation: GitHubObservation = { kind: "github", query: pinned, result };
    if (new TextEncoder().encode(JSON.stringify(observation)).length > 20000 || text.length > 3900) return unavailable();
    return { state: "available", text, dependencies: [{ source }], observation };
  } catch (error) { githubReadFailure(stage, error); return error instanceof Error && error.message === "github_rate_limited" ? rateLimited() : unavailable(); }
}
