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
