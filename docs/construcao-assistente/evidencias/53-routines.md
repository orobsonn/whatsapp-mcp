# #53 — rotinas persistentes e pipeline real

Implementação na VPS sobre `76a1610`, em três fronteiras: lifecycle/claim nominal; coordenação/metadados/outbox; factory real/scheduled handler/testes. Não é declaração de piloto operacional ou homologação cloud.

## Pipeline e identidade

O handler `scheduled` usa `AssistantScheduler`, que instancia os controladores reais: `CaptureMaterializer.drain(10)/retry(2)`, `Conversations.replay(32)/retryGaps(4)` com cinco conversas por página e cursor persistente, FUPs com página de cinco, `SourceAccess`/`OriginGuard`, mídia limitada já existente, projeção Cognee, `RetrievalRuns`, `JobQueue.claimId`, `EpisodeController`, driver público Flue, diário e revisão Telegram. `jobs.ts` e seu provider sintético não são usados.

A produção fica inerte até `ROUTINES_ENABLED=shadow`; inferência exige ainda `FLUE_EPISODES_ENABLED=shadow`, chave privada e conta orçamentária existente. O runner nunca cria, apaga ou troca uma conta de orçamento para desbloquear execução. `ROUTINES_PAUSED=true` conserva captura/materialização, mas interrompe inferência/notificações. Mídia e resumos têm flags próprias, desligadas por padrão.

Cada item deriva seu ID do namespace e subject original estável. Ator, fonte/revisão/versão/hash, consulta e configuração ficam congelados em binding/hash próprio. As janelas UTC coordenam cron/revisão e nunca identificam chamadas de modelo. O `authorId` vindo do arquivo é opaco: usa realm `wa_archive:hash(sourceEpoch,sourceGeneration)`, nunca telefone/LID ou provider WhatsApp convencional. Nome e `fromMe` não provam identidade. Privado attend/grupo respond usam o autor opaco exato; observe usa revisão privada owner automation. Ausência de autor ou entrada inadequada fica `not_evaluated`, sem inventar peer.

Coalescência exige a mesma observação **canonical ID + revision + version + watermark**. Fontes distintas conservam itens distintos, mesmo na mesma conversa/janela. Gaps/fontes nulas nunca herdam outro item. Eventos extras da mesma observação conservam mapeamento explícito; o diário mantém seus estados `not_evaluated`/coalesced, sem fabricar silêncio ou inferência por callback. Uma conversa pendente pode ter descoberta de metadados, mas o fence ready é obrigatório antes de admitir job/episódio.

## Persistência, custos e recuperação

Migração aditiva `0022_routines.sql`: estado/ciclos, itens/eventos, ingestões, resultados FUP, snapshots cumulativos e outbox tipado de resumos. Run/step/checkpoint, ator/profile, job e episódio são duráveis antes dos respectivos efeitos. O runner reencontra episódios existentes e usa somente o mesmo dispatch/read/recibo; episódio expirado/incerto não recebe novo prepare, lease ou alias. `claimId` não rouba outro job e não renova um job processing expirado.

Semântica ocorre antes da lease do episódio. O runner inspeciona metadados de lifecycle sem acordar o Container; restore recebe ID/época/revisão exatos e revalida o plano dentro do DO. Índice sujo perdido não cai em snapshot antigo nem start vazio. Ingestão nova é limitada a uma por cron, com latch durável e consulta do recibo calculada pelo próprio Engine no mesmo epoch. Uma execução incerta não reinfere; recibos completos podem ser reconciliados. Até 64 referências autorizadas são fixadas antes da projeção; acima disso não ingere um prefixo para fingir cobertura. Checkpoint atual é confirmado antes da busca e fora da lease de episódio.

A exclusão do ciclo é persistida por namespace/afinidade. Expiração com item ativo vira incerteza; o próximo ciclo só reconcilia o mesmo item/recibo. Writes/efeitos usam o owner atual; os controladores existentes conservam seus latches, source fences e verdade financeira. A admissão final de Telegram incorpora também o owner guard do cron depois do preflight.

O resumo é um **snapshot cumulativo da geração atual**, explicitamente marcado com `reportingScope=current_generation_cumulative` e `snapshotAt`; não é contagem exclusiva das últimas 24 horas. Há no máximo um snapshot/aviso para a janela UTC atual. Ao despertar após atraso, não cria/entrega uma fila dos dias ausentes. Inclui todas as fases do diário, silêncios registrados, não avaliados, lacunas, pausas, retornos bloqueados e orçamento comprometido/incerto. Propostas não são declaradas atuais apenas por contagem de metadados.

O outbox de resumo é tipado e lê o snapshot canônico, sem criar owner_note/proposal falso. LinkFence, thread persistido, hash/afinidade/período e owner guard são conferidos na CAS anterior à Bot API. Envio real, quando habilitado, é só para o Telegram privado vinculado. Pós-admissão incerta nunca repete cegamente, e FUP não é encerrado pela simulação.

## Evidências

- Baseline dirigido inicial: 20/20 verdes em 37,48s. A previsão verbal de 22 casos estava errada; dois casos de ACK perdido foram adicionados depois. Esses 22 ainda não tinham sido executados quando o turno foi interrompido.
- Revisão adversarial root encontrou agrupamento indevido entre fontes distintas. Contraprovas RED: 2/2 falharam em 22,87s (item compartilhado entre canonical IDs distintos; ausência de mapeamentos honestos num chat com gap).
- Depois da correção, conjunto final: **24/24 verdes em 55,96s**, incluindo os dois ACKs perdidos, grupos observe/ignore, custos e retomada. `npm run check` e `git diff --check` aprovados.
- A fixture usa D1/workerd reais, captura autenticada e controladores concretos até o diário; somente o transporte do modelo/Flue é sintético. Restauração/cold-index usa adapter controlado para provar ordem e recusa de fallback, não homologação cloud do Container.

## Dependências e limites ainda explícitos

Instalação #56 deve configurar cron/bindings/segredos por canal privado e inicializar explicitamente a projeção de uma instalação nova; ausência de índice retorna `index_uninitialized`, sem bootstrap vazio automático. A integração deve preservar a correção global `search-operation` da #112 feita pelo coordenador depois da base desta branch; estes commits não substituem aquele Engine.

Cognee ingest não publica afirmações canônicas no D1: `canonical_relations_unpublished` permanece uma lacuna explícita até a entrega/controlador correspondente. OCR mantém `model_extraction` e cobertura `media_semantic_unsearched`; áudio usa derivado capturado, sem novo ASR. Lacunas/expiração/resultado incerto continuam observáveis, sem prometer processamento universal nem revogação atômica entre serviços.

#55 precisa incluir as oito tabelas da migração 0022 em exportação/retirada/restauração, preservando o fence externo de geração e os latches financeiros. #54 pode ler os metadados atuais do scheduler e os snapshots sem interpretá-los como prova de utilidade ou ação humana. Bindings nativos, CI, cloud, canal real e piloto longitudinal seguem com o coordenador antes de fechar a issue ou declarar prontidão.

Custo incremental de inferência destes testes: **US$0**. Nenhum deploy, chamada paga, mensagem real WhatsApp/Telegram, escrita Calendar ou alteração no Elo foi realizado pelo subagente.
