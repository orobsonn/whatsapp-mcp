import { z } from "zod";
import { AppError } from "./core";
export type ConfirmationMode = "chat" | "page";
/** A client attestation, not independently verified evidence of human consent. */
export const chatConfirmationSchema = z
  .object({
    confirmed: z.literal(true),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ChatConfirmation = z.infer<typeof chatConfirmationSchema>;
const routineGroups = new Set([
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
]);
export function groupConfirmationMode(
  operation: Record<string, unknown>,
): ConfirmationMode {
  if (
    operation.operation === "chat_expiration" &&
    operation.chatExpiration === "OFF"
  )
    return "chat";
  return routineGroups.has(String(operation.operation)) ? "chat" : "page";
}
export function policyConfirmationMode(
  envelope: Record<string, unknown>,
): ConfirmationMode {
  if (envelope.kind === "capture" && typeof envelope.enabled === "boolean")
    return "chat";
  if (
    envelope.kind === "retention" &&
    (envelope.days === null ||
      (typeof envelope.days === "number" &&
        typeof envelope.previous === "number" &&
        envelope.days >= envelope.previous))
  )
    return "chat";
  return "page";
}
export function assertChatConfirmation(
  input: unknown,
  hash: string,
  mode: ConfirmationMode,
): asserts input is ChatConfirmation {
  if (mode !== "chat") throw new AppError("browser_confirmation_required", 403);
  const c = chatConfirmationSchema.safeParse(input);
  if (!c.success) throw new AppError("chat_confirmation_required", 403);
  if (c.data.hash !== hash) throw new AppError("confirmation_mismatch", 403);
}
export interface ConfirmationDisplay {
  title: string;
  button: string;
  fields: { label: string; value: string }[];
  warnings: string[];
}
const labels: Record<string, string> = {
  create: "Criar grupo",
  name: "Alterar nome do grupo",
  photo: "Alterar foto do grupo",
  description: "Alterar descrição",
  add_participants: "Adicionar participantes",
  remove_participants: "Remover participantes",
  promote_admins: "Tornar administrador",
  demote_admins: "Remover função de administrador",
  approve_participants: "Aprovar participantes",
  reject_participants: "Recusar participantes",
  leave: "Sair do grupo",
  settings: "Alterar permissões do grupo",
  reset_invite: "Renovar link de convite",
  accept_invite: "Entrar no grupo",
  mention_members: "Enviar mensagem com menções",
  mention_groups: "Mencionar grupos",
  mention_all: "Enviar mensagem para todos",
  chat_read: "Alterar marcação de leitura",
  chat_archive: "Arquivar ou desarquivar conversa",
  chat_pin: "Fixar ou desafixar conversa",
  chat_mute: "Alterar notificações",
  chat_clear: "Limpar conversa no WhatsApp",
  chat_delete: "Excluir conversa no WhatsApp",
  chat_expiration: "Alterar mensagens temporárias",
  link_groups: "Vincular grupos à comunidade",
  unlink_groups: "Desvincular grupos da comunidade",
};
export function readableConfirmation(
  purpose: string,
  value: unknown,
  context?: string,
): ConfirmationDisplay {
  const e = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const fields: ConfirmationDisplay["fields"] = [],
    warnings: string[] = [];
  const add = (label: string, v: unknown) => {
    if (typeof v === "string" && v) fields.push({ label, value: v });
  };
  let title = "Confirmar alteração";
  if (purpose === "group") {
    const o = (e.operation ?? {}) as Record<string, unknown>,
      key = String(o.operation);
    title = labels[key] ?? "Confirmar operação";
    const targets = Array.isArray(e.targets)
      ? (e.targets as { id: string; kind: string; name: string }[])
      : [];
    for (const [kind, label] of [
      ["group", "Grupo"],
      ["contact", "Pessoas"],
      ["member", "Participantes"],
      ["community", "Comunidade"],
    ])
      add(
        label!,
        targets
          .filter((t) => t.kind === kind)
          .map((t) => t.name)
          .join(", "),
      );
    add(key === "create" ? "Nome do novo grupo" : "Novo nome", o.name);
    add("Descrição", o.description);
    if (typeof o.text === "string")
      add(
        "Mensagem",
        o.text.replace(
          /@\{([^}]+)\}/g,
          (_, id) =>
            "@" + (targets.find((t) => t.id === id)?.name ?? "participante"),
        ),
      );
    if (o.autoInvite !== undefined)
      add(
        "Enviar convites privados automaticamente",
        o.autoInvite ? "Sim" : "Não",
      );
    if (o.enabled !== undefined) add("Ativar", o.enabled ? "Sim" : "Não");
    const durations: Record<string, string> = {
      OFF: "Desativadas",
      "24_HOURS": "24 horas",
      "7_DAYS": "7 dias",
      "90_DAYS": "90 dias",
    };
    if (typeof o.chatExpiration === "string")
      add("Mensagens temporárias", durations[o.chatExpiration]);
    for (const [key, label] of [
      ["adminOnlyMessage", "Somente administradores podem enviar mensagens"],
      ["adminOnlySettings", "Somente administradores podem editar o grupo"],
      ["requireAdminApproval", "Entrada depende de aprovação"],
      ["adminOnlyAddMember", "Somente administradores podem adicionar pessoas"],
    ])
      if (typeof o[key!] === "boolean") add(label!, o[key!] ? "Sim" : "Não");
    if (key === "remove_participants")
      warnings.push("As pessoas selecionadas perderão acesso ao grupo.");
    if (key === "leave")
      warnings.push(
        "Você sairá deste grupo e poderá precisar de um convite para voltar.",
      );
    if (["promote_admins", "demote_admins", "settings"].includes(key))
      warnings.push(
        "Esta mudança altera quem pode administrar ou participar das decisões do grupo.",
      );
    if (["chat_clear", "chat_delete"].includes(key))
      warnings.push(
        "Esta ação apaga conteúdo no WhatsApp. O arquivo salvo no MCP é separado.",
      );
    if (key === "chat_expiration" && o.chatExpiration !== "OFF")
      warnings.push("As mensagens poderão desaparecer após o prazo escolhido.");
    if (key === "link_groups" || key === "unlink_groups")
      warnings.push(
        "Esta mudança altera a associação dos grupos com a comunidade.",
      );
    if (o.autoInvite === true)
      warnings.push(
        "Quem não for adicionado poderá receber um convite privado.",
      );
    if (key === "mention_all")
      warnings.push(
        "A mensagem mencionará todos os participantes presentes no momento do envio.",
      );
    const invite = o.inviteTarget as
      | { name?: string; participantsCount?: number }
      | undefined;
    if (invite) {
      add("Grupo do convite", invite.name);
      if (invite.participantsCount !== undefined)
        add("Participantes atuais", String(invite.participantsCount));
    }
  } else if (purpose === "send") {
    title = "Enviar mensagem";
    add("Destino", context);
    add("Mensagem", e.text);
    add("Legenda", e.caption);
    add("Arquivo", e.fileName);
    if (e.kind && e.kind !== "text")
      add(
        "Tipo de arquivo",
        (
          { image: "Imagem", pdf: "PDF", audio: "Áudio" } as Record<
            string,
            string
          >
        )[String(e.kind)],
      );
    if (e.replyTo)
      add("Resposta", "Esta mensagem responde a uma mensagem selecionada.");
  } else if (e.kind === "capture") {
    title = e.enabled
      ? "Guardar mensagens desta conversa"
      : "Parar de guardar mensagens";
    add("Conversa", context);
    warnings.push(
      e.enabled
        ? "As novas mensagens desta conversa serão armazenadas no seu arquivo privado."
        : "As novas mensagens deixarão de ser armazenadas. O conteúdo já salvo permanece.",
    );
  } else if (e.kind === "delete") {
    title = "Excluir arquivo desta conversa";
    add("Conversa", context);
    warnings.push(
      "As mensagens e os arquivos salvos no MCP serão apagados e a captura será interrompida. Isso não apaga a conversa no WhatsApp.",
    );
  } else if (e.kind === "retention") {
    title = "Alterar prazo do arquivo";
    add(
      "Guardar por",
      e.days === null ? "Sem prazo definido" : `${e.days} dias`,
    );
    add(
      "Prazo anterior",
      e.previous === null ? "Sem prazo definido" : `${e.previous} dias`,
    );
    if (policyConfirmationMode(e) === "page")
      warnings.push(
        "O conteúdo mais antigo que o novo prazo poderá ser apagado do arquivo privado.",
      );
  }
  return { title, button: title, fields, warnings };
}
