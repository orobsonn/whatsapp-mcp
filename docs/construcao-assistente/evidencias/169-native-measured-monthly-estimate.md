# Projeção medida antes da curadoria diária

Data: 29/10/2026. Estimativa operacional, não cobrança reconciliada ou garantia de preço. Não contrata infraestrutura, não altera o teto global de testes de US$10 e não ativa respostas autônomas.

## Base observada

A passagem representativa do dia 28/10 terminou com nove inferências, 851047 tokens de entrada e 2249 de saída. Seu custo conservador no ledger é US$0,214451. Aos preços Standard anunciados para GPT-6 Luna (US$0,10/M entrada e US$0,50/M saída), os tokens representam US$0,0862292, antes de eventual cache. Trinta passagens semelhantes: **US$2,59/mês**, aproximadamente **R$13–16** usando R$5–6/US$ como sensibilidade, não cotação. O ledger não foi reprecificado.

As conversas nativas fora do curador acumularam 143 inferências completas: 88 WhatsApp e 55 Telegram, 1109339 tokens de entrada e 8654 de saída. Ao mesmo preço Standard, média observada de US$0,000806 por chamada. São ensaios reais, não amostra estatística de um mês; uma mensagem pode precisar de várias chamadas e contextos futuros podem crescer.

## Cenários ilustrativos para 30 dias

Mantendo a média por chamada observada e uma passagem diária semelhante à amostra:

| Inferências de conversas/dia | IA incluindo curadoria | IA + plano Workers inteiro de US$5 | Incluindo Z-API informada pelo dono (R$100) |
|---|---:|---:|---:|
| 100 | R$25–30 | R$50–60 | R$150–160 |
| 200 | R$37–45 | R$62–75 | R$162–175 |
| 500 | R$73–88 | R$98–118 | R$198–218 |

Os números 100/200/500 são cenários, **não limites de entradas, consultas ou memória**. O cenário de 500 já pode ultrapassar a referência total de R$200.

## O que essa tabela não cobre

- Leitura de imagens/PDFs, transcrição, impostos, câmbio efetivo e tarefas excepcionalmente longas.
- Cobranças adicionais de Durable Objects, CPU, armazenamento, D1, contêineres e rateio da VPS Cognee existente. O plano Workers de US$5 foi incluído integralmente por prudência na coluna, mas não engloba automaticamente esses itens.
- O primeiro processamento do histórico pode exceder um dia normal. A amostra reconheceu 38 conteúdos indisponíveis, cuja futura interpretação de mídia terá custo adicional.
- Crescimento da memória nativa, compactação e mudanças no volume/política de grupos. O custo não é constante por mensagem.

A consulta ao faturamento da conta foi recusada por falta de permissão Billing Read; isso não é prova de custo zero. Não solicitamos outra chave apenas para essa estimativa. O limite superior anterior de US$0,133 do contêiner segue separado e os demais rateios de infraestrutura não estão conciliados.

## Decisão operacional

A referência de R$100 para IA/infra é plausível nos cenários iniciais, com margem que depende da infraestrutura e das modalidades extras; não é teto garantido pela tabela. O piloto conserva os controles financeiros existentes e os registros incertos. Alertas/esgotamento precisam ficar visíveis, sem reset de ledger ou repetição automática de chamadas incertas. Ativar a curadoria não equivale a autorizar envio autônomo no WhatsApp.

Preferências já aprovadas: 03:00 America/Fortaleza; inicialmente resumo diário; avisos somente de erro/ajuda depois de confirmação posterior do dono. A mudança de configuração e a primeira execução diária devem ter prova própria; esta estimativa, isoladamente, não declara a rotina ativa.

Fontes oficiais consultadas em 29/10: [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/). Recibos da amostra: evidência 167.

## Primeira diária após a estimativa

A evidência173 registra a primeira diária com backlog:14 chamadas,2.537.682 tokens de entrada/7.946 de saída,US$0,640384 no ledger conservador e cobertura parcial(359avaliados,88indisponíveis,114capturaspendentes). Esse percurso inclui histórico anterior e ensaios e não representa custo estacionário de um dia normal. A projeção acima permanece condicionada ao cenário medido; não é promessa de fatura nem homologação do custo mensal. Não houve compra de infraestrutura ou aumento do teto globalUS10.
