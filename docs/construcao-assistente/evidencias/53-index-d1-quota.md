# #53 — orçamento D1 do preflight global

Revisão em 26/10/2026 encontrou um bloqueio determinístico no índice já admitido de 128 fontes. A versão 6a99c9b fazia três checks de execução por fonte, cada um com cinco consultas D1; SourceAccess, ACLs e OriginGuard somavam outras consultas individuais. O preflight cold precisava 2319 chamadas D1 para owner_note ou 2831 para WhatsApp; warm com duas passagens precisava 4628/5652. O limite D1 documentado é 1000 queries por invocation em Paid.

A correção preserva 128 fontes, o prazo absoluto de 5s por passagem, até seis verificações remotas em voo e a segunda passagem após a prova física do Core. Schema legado continua sendo verificado separadamente. Os checks de geração ativa, selo externo/released, hold e quiescência agora usam um único snapshot SQL corrente, sem cache de autorização. O percurso global usa lotes de até 6: cada statement de SourceAccess, ACL e fence retém os mesmos predicados/parâmetros; apenas o transporte D1 usa batch. ACLs e execução são revalidadas depois das observações remotas. Fence inicial em batch usa o mesmo statement e mapper de fence individual; checks remotos antes/depois continuam intactos.

`scripts/assistant-index-budget.check.mjs` executa o método real indexPreflight, com storage/baseclass/DB/porta sintéticos. O mock aplica1000APIs D1 por invocation, contando batch como1, limita cada statement a100parâmetros e acompanha separadamente SQLs executados, RPCs de origem e subrequests totais. Warm verifica prova Core exata e repete todas as 128 fontes. Não é benchmark cloud nem homologação física.

|128 fontes|D1 APIs|SQL statements|RPCs CaptureReader|
|---|---:|---:|---:|
|owner_note cold|138|350|0|
|owner_note warm|272|696|0|
|WhatsApp cold|438|862|128|
|WhatsApp warm|872|1720|256|

Máximo observado 13 parâmetros por statement e 6 statements por batch. A soma de statements de um batch não é a contagem da quota API D1. SQL executado pelo Archive pertence à invocation remota, e não é agregado como queries D1 do Worker da assistente. A quota Workers Paid atual de subrequests é 10.000, distinta da quota D1: o maior caso sintético soma 1128 chamadas D1/RPC, sem inferência ou permit de modelo.

Contraprova controlada: o mesmo teste foi compilado com os quatro módulos exatos de 6a99c9b, sem alterar suas fontes ; 8/9 casos ficaram RED, incluindo os quatro percursos de quota. Com a correção, 9/9 Node passaram. Negativos cobrem hold durante RPC e durante verify, ACL alterada depois do RPC, origem retirada e fonte global fora do guest pack. O contador verifica o percurso real completo, não apenas indexedSourcesCurrent isolado. A equivalência D1 readMany/read cobre owner, guest restricted e o predicado corrente de quarentena; a política ANY-active de #55 permanece definida unicamente em SourceAccess.current e precisa acompanhar a composição com a revisão C.

Verificação dirigida na VPS: quatro arquivos (`assistant-routines`, `assistant-retention-restore`, `assistant-engine`, `assistant-semantic-runs`), 156/156 casos GREEN em 238,24s; TypeScript e diff aprovados. As fixtures de falha migraram para readMany e OriginGuard.check, preservando as mesmas asserções de seis RPCs em voo, zero trabalho tardio e prazo absoluto. Nenhum timeout foi aumentado nesta correção. A revisão adversarial independente não encontrou novo bloqueante; o gate CI no commit exato e a composição C/ACL continuam responsabilidade da integração.

Custos pagos destes testes: US$0; zero requisição de rede, modelo, Container ou escrita cloud. Migrações, capacidade/latência cloud e piloto integrado permanecem provas separadas.

Fontes primárias de limites verificadas pelo coordenador em26/10: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) e [mudança do limite Paid em11/02/2026](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/).

Composição do coordenador com C-ACL `b5236a0`: a correção de `current()` foi preservada após o batch. Duas contraprovas fortes adicionais usam `readMany` real: origem com q revisão1 depois de mudança de audiência para revisão2 permanece `[null]` até raw reader reproof; nota com autorização histórica revisão1 permanece `[null]` para guest após correção do corpo para revisão2. **2/2 GREEN** em19,02s no arquivo de restore (22 casos fora do filtro); nenhum teste pesado simultâneo. Tipos e9/9 Node de quota também passaram na composição. CI final permanece obrigatória.
