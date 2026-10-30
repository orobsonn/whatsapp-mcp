# Duas gravações concorrentes pelo MCP existente

Em30/10/2026, a ferramenta assistente_memoria desta conversa autenticada registrou uma fonte owner_report explicitamente fictícia e temporária. Uma relação preparatória forneceu referências canônicas para a pessoa e o projeto sintéticos. As duas operações seguintes usaram essas referências, sem inferir identidade por nome.

As chamadas remember foram iniciadas no mesmo instante pelo cliente e seus intervalos se sobrepuseram. Uma registrou a relação de revisão e a outra a de patrocínio, com quotes distintos do mesmo original autorizado. Ambas retornaram ready com IDs diferentes de relações/evidências. Isso demonstra concorrência das solicitações; não afirma que o backend dispensou sua serialização de escritas.

Consultas independentes pelos dois predicados recuperaram uma relação cada, com os mesmos IDs canônicos de pessoa/projeto, quotes e SourceRef esperados. Não houve perda de uma gravação pela outra. Os recibos atravessaram o MCP público do assistente e o serviço de conhecimento do dono; não foram inserções manuais de SQL nem um grafo alternativo local.

Ao fim, withdraw retirou a fonte de teste e confirmou a limpeza das três relações, incluindo a preparatória. Novas consultas aos três predicados retornaram zero relações elegíveis. Os recibos e tombstones de idempotência permanecem preservados; não se anunciou apagamento de todo metadado histórico. Nenhum envio, alteração de captura, contato real ou execução de FUP fez parte do ensaio.

Revisão adversarial dos recibos confirmou as duas operações simultâneas, os readbacks e a retirada. Esta prova fecha a lacuna de concorrência identificada na auditoria A13; crescimento, reinício e restauração continuam documentados separadamente na evidência177. Não houve chamada de modelo nesse ensaio de grafo. Origem agent_derived e classificação reported foram conservadas; os fatos fictícios não foram promovidos a informações reais sobre o dono.
