# Estimativa após a escolha da DeepSeek

Atualização em30/10/2026 da estimativa162. É uma projeção por cenário, não medição de uso estacionário, cobrança reconciliada ou garantia de caber em R$100/mês. A troca foi solicitada pelo dono; não houve contratação de infraestrutura nem alteração do teto global de testes de US$10.

## Conversas

Hipótese de comparação, mantendo o cenário anterior:100 entradas/dia, duas chamadas por entrada,500 tokens de saída por chamada e30 dias. Isso representa6.000 chamadas; ferramentas que exigirem mais turnos aumentam essa quantidade. Histórico e resultados de ferramentas contam na entrada. As quantidades abaixo não limitam o contexto do produto.

| Entrada média por chamada | Mês fora de pico | Mês em pico |
|---|---:|---:|
|5mil tokens|US$6,30|US$12,60|
|15mil tokens|US$15,30|US$30,60|
|30mil tokens|US$28,80|US$57,60|

Sem desconto de cache. Tarifas oficiais por milhão: entrada não cacheada US$0,15–0,30; saída US$0,60–1,20. [Tabela consultada em30/10](https://api-docs.deepseek.com/quick_start/pricing/). A contabilização do piloto conserva o valor de pico sem cache; não transforma esse limite conservador em fatura efetiva.

Sensibilidade cambial, não cotação: no cenário intermediário, um dólar entre R$5 e R$6 corresponderia a R$76,50–183,60 mensais de conversas. O orçamento de referência ainda precisa incluir curadoria e infraestrutura, além dos R$100 da Z-API informados pelo dono. O cenário intermediário não garante os R$100 disponíveis para IA+infra. Cache pode reduzir o custo, mas sua taxa efetiva precisa ser observada no novo fornecedor.

## Curadoria e infraestrutura

A rotina continua às03:00 America/Fortaleza,06:00UTC. Pela tabela consultada, esse horário é de pico nos dias úteis ordinários; a tarifa de pico é a referência conservadora. Não se alterou o horário escolhido pelo dono por causa do preço.

Os ensaios anteriores incluem backlog, retomadas e pesquisas intensas do operador. Seus gastos não foram apagados nem multiplicados por30 como custo de um dia normal. A observação privada por canal mantém conversas WhatsApp, interação do dono e curadoria separadas; ela é anterior à primeira inferência verificada com DeepSeek e não comprova consumo desse fornecedor.

O serviço de conhecimento permanece na infraestrutura existente. O custo incremental e o rateio dessa infraestrutura continuam sem conciliação; não declarar custo zero nem adicionar compra silenciosa. Uso fora da inferência nativa permanece identificado separadamente, em vez de ser confundido com o preço do Flash. O critério A14 pede controle das chamadas e preservação de reservas/incertezas; não exige uma fatura mensal conciliada para concluir a versão.

## Estado

Seleção e secret de DeepSeek publicados, credencial/saldo/modelo confirmados por leituras não pagas. Na primeira conferência ainda não existiam recibos de inferência; a observação posterior confirmou chamadas reais completas nos canais Telegram e WhatsApp, sem recibo DeepSeek incerto nessa janela. A leitura visual real também foi concluída, conforme evidência185. Não confundir os recibos antigos de outro modelo com consumo DeepSeek.

O uso observado do dono incluiu pesquisas extensas no repositório e histórico, com entrada muito maior que a do WhatsApp nessa amostra. Seus totais e os consumos por canal ficaram registrados privadamente; não foram multiplicados por30 para simular um mês normal. A contabilização conserva o preço de pico sem cache, enquanto os dados de cache do SDK não são fatura conciliada. A curadoria observada nessa janela ainda usava o modelo anterior; não há base para anunciar custo diário medido da curadoria com DeepSeek. Infraestrutura continua sem rateio conciliado. Essas são limitações da projeção mensal, sem adicionar requisito de esperar uma fatura futura.

A estimativa não autoriza ampliar limites, ativar respostas autônomas nem trocar modelos de embeddings. A leitura visual usa a autorização e a estimativa específica da evidência185; não há fallback silencioso.
