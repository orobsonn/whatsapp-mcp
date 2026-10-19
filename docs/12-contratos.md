# Contratos internos da implementação

19/10/2026. Fundação issue #1. Apenas fixtures sintéticas; nenhuma instância, deploy ou dado do Elo. Estes contratos descrevem código local, não homologação Z-API.

## Fundação

`Env` em `src/env.ts`: DB, MEDIA, OAUTH_KV, AI e configuração runtime; segredos ZAPI/WEBHOOK opcionais até ativação. Configuração padrão em manutenção e sem owner/geração válidos. O binding AI está comentado em Wrangler porque a versão atual só oferece binding remoto: testes declaram Miniflare explicitamente e não carregam bindings remotos.

`core.ts`: AppError(code,status), errorResponse(err) sanitizado, json, LIMITS, sha256, constantTimeEqual/safeEqual, readBounded(Request|Response|stream|null,max) → Uint8Array, currentFence/env, assertFence e assertActive. `Fence` contém epoch e generation externos; nenhum valor do banco substitui o ambiente corrente. Date/timestamp usa milissegundos Unix.

`store.ts`: getChat(env,id,fence?) devolve ChatRow interno com external_id; getChatExternal é backend-only. `chatView` é projeção sem endereço externo.

`directory.ts`: upsertDirectoryPage(env,fence,{items:[{externalId,kind,name}],cursor?,complete}) → {items:ChatView[],nextCursor?,complete}. No máximo 100 por página, não remove ausentes e não libera captura. listChats(env,{term?,kind?,limit?,cursor?}) limita e vincula cursor a filtros/epoch/geração. setCapture(env,chatId,enabled,fence) é função interna: a rota humana deve exigir confirmação autenticada; não expor como execução direta MCP.

`capture.ts`: NormalizedEvent possui chatExternalId, externalId, authorExternalId?, authorName?, fromMe, kind(text/image/pdf/audio/unavailable), text?, timestamp, revision?, deleted?, viewOnce?, temporary?, unavailableReason?, media?{url,mime?,filename?,durationSeconds?}. ingestEvent(env,fence,event) → {captured,messageId?}; chat precisa existir e captura estar habilitada. Namespace epoch+generation+chat externo+ID externo; autor não se confunde com chat. Callback recebido registra mensagem, mídia e trabalho D1 antes de retornar. URLs só no banco backend; nenhuma URL de transporte em MessageView; links que fazem parte do texto da conversa continuam como conteúdo.

`normalizeZapiEvent(unknown)` normaliza ReceivedCallback, mas quem chama valida autenticação, instanceId e connectedPhone antes de ingestão. Suporte desconhecido produz unavailable; não execute campos de texto. Nomes de autores são devolvidos por authorName e a direção própria usa Você. Revisão normalizada usa timestamp do evento de edição (não contador confiável do fornecedor). `ingestStatus(env,fence,{externalId,chatExternalId?,status:accepted/sent/delivered/read,failure?})` mantém progresso monotônico e falha separada. Sem correlação única deixa pending; pendência com conversa exata concilia na ingestão do corpo. Pendência sem conversa concilia apenas quando há um único candidato no batch; se ambígua permanece pendente.

`queryMessages(env,{chatId,from?,to?,authorId?,kind?,term?,cursor?,limit?})` → {items:MessageView[],nextCursor?,coverage}. Máximo 50 e 32 mil caracteres por página, busca literal e cursor vinculado ao filtro. Coverage informa captureSince, captureEnabled, historicalImport:false, unavailable e pendingMedia. Mensagem apagada permanece tombstone, versões textuais são eliminadas e mídia/derivados/trabalhos anteriores ficam inválidos. Bytes privados órfãos serão limpos pelo módulo operacional.

## Schema compartilhado (migration 0001)

- chats(id,epoch,generation,external_id,kind,name,capture_enabled,capture_since,created_at,updated_at); participants(id,epoch,generation,external_id,name).
- messages(id,chat_id,epoch,generation,external_id,author_id,from_me,kind,text,timestamp,received_at,version,status_rank,failure,deleted_at,unavailable_reason). Status rank 0=received, 1=accepted, 2=sent, 3=delivered, 4=read. Não é recibo individual de cada membro de grupo.
- actions(id,epoch,generation,chat_id,envelope_json,hash,status,expires_at,approved_at,attempted_at,provider_message_id,provider_zaap_id,last_error,created_at). Sem enum SQL: módulo actions governa estados e claim.
- media(id,chat_id?,message_id?,version,message_version,epoch,generation,kind,mime?,size?,sha256?,object_key?,state,source_url?,filename?,duration_seconds?,deleted_at?,created_at). Message_id pode ser NULL para upload; objeto publicado exige versão/hash/fence atuais. Estados de captura iniciais pending/deleted.
- media_jobs(id,media_id,message_version,epoch,generation,kind,status,lease_until?,attempts,next_attempt_at,error?). Kind download/transcribe. Unique(media_id,kind,message_version); capture cria download/pending.
- media_derivatives(id,media_id,media_version,epoch,generation,kind,text?,object_key?,state,created_at).
- policies(key,value_json,epoch,updated_at). Auth mantém sua própria migration para nonces e grants.

D1.batch é a unidade atômica local; nenhuma transação envolve rede/R2/AI. MEDIA é privado, leitura deve consultar D1 atual antes de transmitir. Workers anteriores a uma mudança de configuração precisam ser retirados de tráfego; o valor externo protege restore sem confiar no banco restaurado.

## Fontes consultadas

[Exemplos de recebimento Z-API](https://developer.z-api.io/webhooks/on-message-received-examples) e [status](https://developer.z-api.io/webhooks/on-whatsapp-message-status-changes); contratos usados apenas para parser e fixtures, sem callback real. Plugin atual validado pelos tipos instalados @cloudflare/vitest-plugin 1.4.5: cloudflareTest, readD1Migrations, applyD1Migrations.

## Limites de prova

O fornecedor documenta isEdit, momment, image/audio.viewOnce e exemplos de messageExpirationSeconds. Não foi localizado contrato oficial de callback de exclusão nos exemplos/índice consultados; deleted do evento normalizado tem testes sintéticos de tombstone, mas isDeleted/DeletedCallback são reconhecimento defensivo e não capacidade comprovada do fornecedor. Não alegar sincronização de exclusão WhatsApp sem ensaio específico. Dois eventos de edição com o mesmo timestamp não oferecem uma ordem externa comprovada.

Verificação issue1: npm test -- tests/archive.test.ts apresentou RED inicial com 7 falhas (incluindo captura liberada indevidamente e diretório vazio); GREEN7. A ampliação para autoria e status antes do corpo apresentou RED3; GREEN9. Última execução direcionada: 9/9, workerd + D1 real local, exit0. O plugin emite deprecation warning punycode da dependência. Primeiro teste com Wrangler/AI remote:false falhou antes da suíte e tentou leitura autenticada de accounts/memberships; não criou recurso. Configuração de teste passou a declarar Miniflare offline, sem Wrangler nem binding AI remoto.

Verificação integrada após `global_fetch_strictly_public`: `npm test` 4 arquivos/38 testes passando; `npm run check` exit0; `npm run build` dry-run exit0 com placeholders, sem upload/deploy. O build ainda contém stub de entrada 503 nesta fatia; não comprova integração HTTP das próximas issues. `worker-configuration.d.ts` é augmentation local escrito, não saída alegadamente gerada por Wrangler.
