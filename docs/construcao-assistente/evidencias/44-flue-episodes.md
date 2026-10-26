# #44 — episódios isolados no Flue

Implementação em sombra, com Flue 2.3.0/Pi 1.1.0 reais no bundle oficial Vite e workerd local. Somente dados sintéticos e adapter determinístico de modelo; nenhum provedor pago, deploy, WhatsApp ou Calendar real foi acionado. O ambiente padrão continua desativado: `FLUE_EPISODES_ENABLED=shadow` e orçamento configurado são pré-condições do host, não ativadas por esta entrega.

## Contrato entregue

O host prepara um episódio por job a partir do manifesto completo #100 e do contexto #42, sem usar a transcrição Flue como memória canônica. Perfil, finalidade, lease, fonte de invocação, manifesto, configuração, envelope e endereço nominal ficam vinculados no D1. Consultas manuais do dono usam finalidade explícita `owner_read` e uma fonte `owner_note` autenticada como âncora. Isso não concede processamento automático de uma conversa WhatsApp pausada. Interlocutores usam a própria fonte canônica como pergunta e não recebem o input privado do dono.

Cada callback reserva o teto do payload real antes de qualquer tentativa. A admissão do recibo de modelo compartilha a transação com o lease atual, as guardas de fonte/conversa e as atestações de Search/Work/Target. Cada plano gera um nonce novo; predicados profundos são executados em statements separados da MESMA `D1.batch`, e os statements seguintes exigem as provas exatas daquele plano. Isso respeita o limite de profundidade do D1 sem transformar um precheck assíncrono em autorização. O wrapper repete origem remota e guardas locais imediatamente antes do adapter e depois de liquidar custo, antes de liberar qualquer evento Pi.

O episódio mantém no máximo três slots persistentes, somente um callback ativo e um latch de incerteza independente do hash do próximo prompt. Budget esgotado comprovadamente antes da admissão persiste `blocked/budget_blocked`; falhas de tentativa ou ACK incerto conservam reserva/recibo e bloqueiam novos callbacks. Nenhum estado do Flue redefine orçamento, mandato ou paid truth.

Dispatch persiste o envelope e a chave nativa antes de chamar o handle público. Reconcile usa somente o mesmo endereço, perfil, envelope e chave, no máximo uma repetição de transporte. Recibo aceito não prova processamento nem proposta válida. Uma incerteza não é apagada por transporte reconciliado: perda antes do commit pode reconciliar uma submissão com zero modelo; perda depois da execução reconcilia a mesma submissão com exatamente um modelo. Payload alterado na chave existente recebe 409 no Flue real.

Saída aceita: JSON estrito `proposed|no_reply|waiting_context`, texto limitado e citações de originais admitidos com id/revisão/versão/hash/trecho literal. O host acrescenta `execution=unconfirmed`, cobertura e atribuição. Isso valida estrutura e atribuição, não a verdade semântica de todas as frases. Conteúdo recebido e propostas nunca são recibos de envio/ação. Ferramentas, task/filhos e delegação são negados pelo interceptor antes de executar; o provider não devolve tool calls nem deltas parciais.

## Critérios e contraprovas

| Critério | Prova controlada |
|---|---|
| 9.181 — isolamento | Flue real nos dois perfis: contraste positivo do segredo sintético no pack dono e ausência no payload interlocutor; contexto e input do dono não atravessam o perfil. |
| 9.182 — identidade estável | Cold restart com SQLite persistido recupera o mesmo recibo/SID/UID e mantém uma submissão/uma inferência; envelope alterado recebe 409. |
| 9.183 — correção/revogação | Correção de fonte, mudança entre precheck e batch, job cancelado e FUP cancelado bloqueiam callback/retorno/publicação. Chamada paga já concluída preserva custo e recibo, com zero texto liberado. |
| 9.184 — checkpoint canônico | Pack excessivo espera sem truncar ou gastar; um pedido posterior explícito e distinto reconstrói um episódio útil do checkpoint corrigido (versões 2) e gera proposta. Não há compaction automática nem criação de novo job para escapar de incerteza/teto. Mesmo-job recovery conserva o envelope original. |
| 9.185 — privilégios | Perfis sem tools/filhos; interceptor rejeita tool/task antes de `next`; provider recusa histórico de ferramentas e declarações inesperadas. Nenhuma ferramenta operacional é instalada. |
| 9.186 — latch | Concorrência de slots, teto, mudança de payload após incerteza, ACK perdido antes/depois de commit e rollback real do D1 não geram nova tentativa externa. |
| 9.187 — retorno guardado | Stream só emite após resposta integral e guarda final; cancelamento durante adapter conserva recibo/custo e emite somente erro fixo. FUP exige WorkFence e modo/ConversationFence do alvo além da âncora. |
| 9.188 — transporte | Dispatch/reconcile/read reais, reinício frio e perdas antes do commit/depois do modelo; aceito, processado e proposta publicável permanecem distintos. |

O D1 real também comprova publicação válida de FUP, bloqueio de alvo pausado, gate de publicação com zero linhas e orçamento esgotado sem reserva, recibo ou chamada. O fixture workerd recusa mais de 100 bindings por statement e qualquer conexão externa; o teste não substitui D1 por um mock.

## Porta para #45

`preparePublication(episodeId, reply, {publicationGate?})` retorna `{proposal, statements, publicationIndex, journalGuard}`. O diário deve inserir seu registro antes de `publicationIndex`, sob `journalGuard`, e exigir no `publicationGate` a presença do registro exato com nonce/proposalHash. Tudo deve executar na mesma batch. Um INSERT de zero linhas sozinho não aborta a transação; o gate inverso é obrigatório para impedir `shadow_completed` sem diário correspondente. Paid observations continuam preservadas quando a publicação é bloqueada.

Esta entrega não cria o diário, EventRef de captura, comando de dono ou vínculo inequívoco à sequência de evento. #45 adicionará o subject host explicitamente; não deve inferi-lo por `source_id`. As migrações 0015/0016/0017 permanecem fora do escopo.

## Limites

- Episódio de um turno, prazo de até 60 s no controller, contexto original limitado, três callbacks no máximo, duas tentativas totais de transporte. Pack que continua excessivo permanece `waiting_context`; não se promete resumidor ilimitado.
- #100 preserva inventário e lacunas; sua busca atual registra `engine:not_run_capacity`. A integração semântica/Cognee fica em #112 e permanece dependência anterior ao piloto. Não se amplia a busca para IDs fora do manifesto autorizado.
- Revalidação remota é uma observação repetida, não uma transação entre Workers; não se alega cancelamento retroativo de requisição já paga/em voo.
- Journal, Telegram/MCP, agenda, publicação externa e autorização de efeitos continuam nas entregas próprias. Este componente não constitui piloto pronto.

## Verificação local final

Em 25/10/2026, no worktree exclusivo da entrega:

- `npm run check`: passou.
- `npm test`: 669 testes, 44 arquivos, passaram (Workers/D1).
- `npm run test:assistant-runtime`: 39 testes, 2 arquivos, passaram; 32 de episódios e 7 da foundation, com bundle oficial, workerd, SQLite persistido, adapter sintético e zero tráfego externo.
- `npm run build:assistant`: passou. Permanece o aviso do bundler sobre a diretiva `use agent`; os testes verificam as classes geradas e a execução nativa resultante.
- `npm audit`: zero vulnerabilidades em todas as dependências.
- `git diff --check`: passou.

TDD e contraprovas registraram RED antes das correções para isolamento/admissão, resposta bufferizada, ACK/settlement, guard pós-callback, alvo FUP pausado e motivo de budget bloqueado. O limite SQL depth100 foi reproduzido no D1 real e corrigido pela composição transacional com nonces. A revisão independente aceitou nonces/FUP/publicação e a cadeia de overflow → correção → novo pedido → dispatch/read Flue real; não encontrou bloqueador restante no escopo revisado.

Reprodução: executar os comandos acima. Os fixtures e originais são sintéticos e versionados em `tests/assistant-episodes.test.ts`; logs transitórios locais não são dependência para reproduzir a prova. Não houve execução cloud ou validação de qualidade semântica de um modelo comercial.
