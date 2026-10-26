# #112 — recuperação da preparação e admissão semântica na VPS

Data: 26/10/2026. Base preservada: `96e94ce534ea773c969641d9260c685d051b0a6f` (`codex/assistant-semantic-context`). Evidência local sintética; não substitui a bateria cloud exigida por #112.

## Contraprovas e correções

1. Manutenção recusava `prepare`, gravava `semantic_prepare_blocked` sem ticket e impedia nova preparação para sempre. O mesmo run/alias e a prova reconstruída atual agora podem repetir apenas a preparação de metadados. A escrita SQL exige ausência de ticket e o estado exato de recusa da preparação. Não há wake, reserva ou modelo nessa etapa. ACK perdido reencontra exatamente o ticket original.
2. Submit frio marcava `attempting` antes de detectar que o índice não podia executar. Agora o submit adquire exclusão antes do primeiro await, verifica ACL/prova e gates operacionais, e repete os gates na transação imediatamente antes da CAS. Container frio, ativo persistente, manutenção, quarentena e índice alterado recusam sem consumir o ticket. `run` recebe o mesmo proprietário, sem liberar/reentrar; só esse proprietário libera. A promise física de busca que ultrapassa o prazo conserva a exclusão até terminar.
3. Uma recusa do submit persistida no D1 só volta a pending se lookup do mesmo ticket atual provar estritamente `not_submitted` com o operationId esperado e a prova local continuar válida. `attempting`, operationId diferente e `blocked` genérico nunca autorizam retry.

RED observável na implementação antiga: `prepare` chamado uma vez em vez de duas; submit frio passou a `attempting` sem busca; lifecycle entrou durante await de preflight; gates de quarentena/active/frio alterados na CAS consumiram o ticket; recusa no D1 permaneceu presa. A primeira execução teve 8 falhas e 59 sucessos: sete falhas desses contratos e um timeout de 5 segundos no caso existente de 64 fontes com D1. Esse caso recebeu prazo explícito de 30 segundos, preservando todos os asserts.

GREEN: 71/71 casos dirigidos Engine + RetrievalRuns semânticos, 56,19s, incluindo negativos para attempting/operationId diferente/blocked genérico. `npm run check` e `git diff --check` aprovados. A identidade canônica do ticket também é preservada quando o chamador reordena campos; contraprova dirigida adicional aprovada (1/1, 11,42s). A integração com #121 terá sua própria execução pelo coordenador.

## Revisão e fronteira

Direção revisada adversarialmente pelo coordenador antes da implementação: preservar alias/hash/prova, recuperar ACK pelo mesmo ticket, impedir interleaving de lifecycle, checar gates ao último ponto antes da CAS e reter exclusão após timeout físico. O código continua sujeito à revisão final e integração com #121, cuja manutenção/checkpoint usa a implementação mais recente da main.

Nenhuma chamada paga, novo recurso cloud, deploy, envio WhatsApp, escrita Calendar ou alteração no Elo. Custo incremental de inferência desta correção: US$0; não altera o histórico financeiro existente. #112 permanece aberta até qualidade e recuperação cloud integradas, CI e release correspondentes.

## Contraprova da revisão final: recusa concorrente e recibo completo

O revisor independente `review_release` encontrou um bloqueio adicional: A já está `attempting`; B recebe `busy` e persiste `blocked/semantic_blocked`; A termina a busca, mas o WHERE antigo não permitia reconciliar esse estado com o recibo completo. RED reproduzido com o request de A retido por uma promise: uma busca concluída, resultado ainda `pending` (1 falha, 33 casos omitidos, 7,10s).

A correção permite somente `blocked/semantic_blocked` → `complete` já validado, com operationId e indexRevision do ticket, `ticket_json` exato na atualização e `proofGuard` SQL vigente. Não altera estado do ticket nem executa novo submit. Recusa tardia não pode rebaixar recibo já completo. Casos dirigidos incluem concorrência real, reconciliação após restart usando recibo já existente e rejeição de recibos com operationId/revisão errados.

GREEN adicional: 4/4 dirigidos (13,12s), TypeScript aprovado. Revisão independente do patch aprovada por `review_release`; integração e CI permanecem responsabilidade do coordenador. Custo incremental de inferência continua US$0.

## Operação compartilhada entre aliases e recuperação cloud

O laboratório preservado foi acessado por uma credencial local válida, sem recuperar os segredos do Worker. O código privado do probe foi recuperado do sourcemap, adaptado para Linux e mantido fora do Git. A credencial do probe foi rotacionada, com valor privado0600; a chave do modelo não foi lida nem alterada. O checkpoint9 `03339ec2219f47481f972ae8b4f4400be439fa79d18ddad1de2dcd2b10a0cc03`,9 fontes/5.439.701bytes, foi restaurado exatamente. Upload de código preservou D1, namespace/classe DO, digest da imagem, migration tag e bindings; versão ativa100% e hash do bundle foram conferidos. Sem outro executor com o novo segredo; não pode haver writer legado ignorando o protocolo após o seal.

O diagnóstico identificou outro risco antes de qualquer nova inferência: o run original recuperado de recusa no prepare e outro alias antigo `attempting` sem recibo compartilhavam a mesma operationId. O CAS só por alias não impedia que um deles executasse novamente a operação do outro. Dois testes RED comprovaram nova execução indevida pelo segundo alias e pela API direta `Engine.search` após restauração do mesmo índice. Nenhuma dessas chamadas foi executada com modelo real.

Agora um latch monotônico `search-operation:<operationId>` é gravado na mesma transação que a passagem do ticket a `attempting`. Busca direta também respeita o latch. Uma migração única e selada inventaria metadados legados: tickets `attempting` e registros `access` sem recibo completo preservam a operação como incerta. São no máximo256 entradas por prefixo; excesso ou ausência do adapter de inventário bloqueiam a migração, sem inferência. O limite se aplica à migração legada, não às novas consultas após o seal. Trata-se de metadados no EngineStore existente, sem novo ledger financeiro e sem mudança da fórmula de identidade.

Lookup de ticket prepared com operação já admitida retorna `engine_operation_uncertain`, nunca `not_submitted`. Nenhum latch é sobrescrito: presença usa `!==undefined`, e marcador inválido, inclusive `null`, `false` ou `0`, bloqueia. Um recibo completo exato pode ser compartilhado após autorização/prova atuais; isso não admite novo efeito. Tickets antigos incertos não são reabertos, apagados ou rekeyed. A única preparação recuperada que colidiu com operação antiga permanece sem execução nova.

Validação local: os2 RED originais falharam antes da correção; **90/90** casos Engine/semântica passaram em72,06s. A revisão independente de `semantic_bugs` exigiu tratamento explícito de marcadores falsy; **3/3** contraprovas adicionais passaram em13,73s, sem permit ou request. **15/15** testes workerd/DO SQLite passaram em5,21s:11 anteriores e4 novos que cobrem migração/restart/bypass direto, rollback versus commit com ACK perdido, concorrência entre aliases e cache completo sem segundo efeito. Os adapters em memória agora serializam também get/put externos à transação, evitando perda artificial de escrita durante snapshots concorrentes; a injeção de morte mira a CAS efetiva, sem depender da posição de uma leitura de metadados.

TypeScript e diff check aprovados. A revisão independente aprovou o protocolo e as contraprovas; CI e corpus cloud completos continuam pendentes. Ledger cloud antes do ensaio permanece48405microUSD globais (US$0,048405), incluindo40000microUSD incertos. Novas chamadas de modelo deste executor até este ponto:0. Restauros usam Container e não equivalem a custo computacional zero; a fatura final é separada do ledger de tokens.
