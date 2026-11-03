import {z} from 'zod';
import {approvedSendScope} from './approved-send-contract';
const label=z.string().min(1).max(256),hash=z.string().regex(/^[a-f0-9]{64}$/);
/** Closed WhatsApp MCP catalogue; this is not a generic HTTP/API capability. */
export const OWNER_TOOL_NAMES = [
'diagnosticar_captura','diagnosticar','buscar_conversas','sincronizar_diretorio','resolver_destinatario','consultar_mensagens','exportar_conversa','consultar_midia','adicionar_arquivo','obter_midia','transcrever_audio','gerar_audio','consultar_audio_gerado','preparar_envio','executar_envio','consultar_envio','cancelar_envio','propor_captura','propor_retencao','aplicar_politica','propor_exclusao','capacidades_grupos','consultar_grupo','consultar_grupo_por_convite','obter_convite_grupo','listar_chats_grupo','consultar_chat_grupo','listar_comunidades','consultar_comunidade','preparar_acao_grupo','executar_acao_grupo','consultar_acao_grupo','cancelar_acao_grupo','assistente_telegram','assistente_telegram_revisar','assistente_fonte','assistente_memoria','assistente_controlar','assistente_avaliar','assistente_consultar'
] as const;
export const ownerToolName=z.enum(OWNER_TOOL_NAMES);
const context={secret:z.string().min(32).max(256),scope:approvedSendScope,sessionId:label,taskRef:label};
export const ownerToolCatalogInput=z.object({...context,name:ownerToolName.optional(),after:label.optional(),limit:z.number().int().min(1).max(20).default(20)}).strict();
export const ownerToolExecuteInput=z.object({...context,tool:ownerToolName,input:z.unknown()}).strict();
export const ownerToolAuthorizationRequest=z.object({secret:context.secret,sessionId:label,taskRef:label,tool:z.union([ownerToolName,z.literal('__catalog__')]),inputHash:hash}).strict();
export type OwnerToolAuthorizationRequest=z.infer<typeof ownerToolAuthorizationRequest>;
export type OwnerToolAuthorization={authorized:false}|{authorized:true;expiresAt:number};
export interface OwnerToolRPC {
 ownerToolCatalog(input:z.input<typeof ownerToolCatalogInput>):Promise<unknown>;
 ownerToolExecute(input:z.infer<typeof ownerToolExecuteInput>):Promise<unknown>;
}
