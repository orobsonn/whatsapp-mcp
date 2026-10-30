# Curadoria: janela real de 28/10 no runtime Cloudflare

Data: 29/10/2026. Worker próprio `bab6f307-1e0b-4a85-b6c1-98ec9c813231`, commit `959f29a`. Ensaio avulso; não avança o cursor diário nem ativa recorrência.

Operação `native-curator-civil-day-20261028-ack-page-v3`; execução `0df1c69d-361e-44d6-a83c-4d2e1780967e`; janela de alterações `(2180,3679]`, dia civil `2026-10-28`, America/Fortaleza. O SDK terminou como `completed`, às `2026-10-29T20:57:55.790Z`.

## Cobertura efetiva

| Estado persistido | Itens |
|---|---:|
| Conteúdo avaliado pela IA | 114 |
| Conteúdo indisponível para avaliação | 38 |
| Fora da política de acompanhamento | 1118 |
| Retirados | 226 |
| Substituídos por versão posterior | 3 |
| Pendentes/apresentados/indexando | 0 |
| Novas relações aprendidas nesta janela | 0 |

Total: 1499 alterações. Não significa 1499 conversas nem mensagens únicas. Os 38 indisponíveis são registros de mensagem/mídia de áudio, imagem e PDF cujo conteúdo não foi avaliado nesta passagem. Os ACKs de páginas 100 + 50 + 2 registraram 152 resultados sem recusa; **registrar um resultado indisponível não equivale a analisar o conteúdo**. O recibo final mantém cobertura `partial` e acervo `not_exhaustive`.

Aprendizado é julgamento do agente: não inventamos relações para preencher o ensaio. A gravação real de cinco preferências e a leitura compartilhada MCP/bot já possuem evidências anteriores independentes.

## Custos medidos e tentativas anteriores

Esta execução terminou com nove recibos de inferência `complete`, 851047 tokens de entrada e 2249 de saída; maior entrada por chamada: 103593 tokens. O ledger conservador registrou **214451 microUSD = US$0,214451**. Nenhum recibo dessa execução permaneceu `attempting` ou `uncertain`.

Isso é contabilização própria conservadora, não fatura reconciliada da OpenAI. Ao preço Standard anunciado na documentação consultada em 29/10, os tokens corresponderiam a US$0,0862292, sem desconto de cache; essa simulação não reprecifica o ledger.

As duas execuções anteriores continuam registradas: uma falhou pelo antigo prazo total de 120s e outra por orçamento diário esgotado. Seus custos e recibos não foram apagados ou somados como custo normal de uma passagem saudável. A alocação adicional de testes de 29/10 preservou o teto global histórico de US$10.

## Aviso final e correção posterior

`curator_finish` terminou com `notice.state=uncertain`; o registro próprio conserva essa incerteza. Não foi feito reenvio automático, nem o aviso foi declarado entregue. Os 86,288s da ferramenta não permitem concluir sozinhos quando começou o transporte.

O teste dirigido reproduziu duas falhas da composição anterior: revisão remota saudável acima de 10s impedia o aviso e cancelamento durante a revisão não chegava ao envio. A correção separa a revisão remota do prazo de transporte, propaga o cancelamento do SDK e conserva uma última verificação local de todas as fontes, eventos, dono, vínculo e hold. `TelegramBotApi` e seu contrato de 10s, resposta tardia e tentativa única continuam inalterados.

Amostra pequena posterior deve comprovar o aviso pelo caminho publicado, sem reexecutar esta janela somente para enviar uma notificação. Recorrência diária e envio WhatsApp aprovado permanecem critérios separados.
