# Estimativa inicial de custos antes da curadoria recorrente

Data: 29/10/2026. Estimativa para orientar ativação; não representa fatura reconciliada nem garantia de enquadramento no orçamento.

O levantamento anterior do escopo atual encontrou 377 textos recebidos nos seis dias completos de 23 a 28/10: aproximadamente 63/dia. Incluindo os próprios textos do dono, a simulação usa 100 entradas/dia. Eventos de mídia e futuras mudanças de grupos podem alterar esse volume.

## Cenários de IA

Hipótese explícita: 100 entradas/dia, duas chamadas por entrada, 500 tokens de saída por chamada, 30 dias e nenhum desconto de cache. Preço Standard anunciado para GPT-6 Luna: US$0,10 por milhão de tokens de entrada e US$0,50 de saída. Contextos acima de 272 mil tokens e modalidades de processamento têm condições próprias; os cenários abaixo não as utilizam. [Documentação oficial consultada](https://developers.openai.com/api/docs/models/gpt-6-luna).

| Entrada média por chamada | IA mensal | Sensibilidade cambial R$5–6 por US$ |
|---|---:|---:|
| 5 mil tokens | US$4,50 | R$22,50–27 |
| 15 mil tokens | US$10,50 | R$52,50–63 |
| 30 mil tokens | US$19,50 | R$97,50–117 |

O câmbio é uma hipótese de sensibilidade, não cotação. Esta tabela exclui curadoria, transcrição, leitura de mídia, compactação, impostos, consumo Cloudflare e rateio da VPS existente. Também não promete que duas chamadas bastem: o ensaio GitHub usou várias ferramentas e a amostra de curadoria exigiu sete chamadas.

## Medição real já disponível

Uma amostra curta de preferências produziu cinco relações úteis e sete chamadas na sessão privada do curador. O ledger próprio registrou 8.313 microUSD (US$0,008313), com a tabela conservadora `upper-input025-output075-v1`. Essa tabela de reserva/contabilização é diferente do preço Standard do cenário acima; o valor não foi apresentado como cobrança reconciliada do fornecedor. Uma fonte curta não pode ser multiplicada como se representasse todo o arquivo diário.

O censo de 29/10 às 17:21 UTC somou 271.032 microUSD comprometidos nos ledgers conhecidos, incluindo reservas e 40.000 microUSD incertos. A estimativa superior anterior do contêiner, de US$0,133, permanece separada. Outros custos de infraestrutura não estão conciliados. O teto histórico de testes continua US$10 global; registros não foram resetados nem reprecificados.

## Decisão de ativação

A referência do dono é R$200/mês total, incluindo cerca de R$100 da Z-API e R$100 para IA/infra. O cenário intermediário deixa parte dessa verba para curadoria e infraestrutura; o cenário de contexto maior já a excede com IA sozinha. Falta medir uma passagem representativa do acervo e conciliar o custo da infraestrutura existente antes de prometer o total. A rotina diária às 03:00 continua desligada neste marco; o ensaio avulso não a habilita.
