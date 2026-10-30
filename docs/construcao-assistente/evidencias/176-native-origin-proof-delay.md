# Consulta de fontes com demora transitória

30/10/2026. Na revisão3 da diária, a IA respondeu e seus tokens foram contabilizados. A verificação posterior do contexto falhou na primeira página: `reader_rpc / reader_timeout`,5065ms,62fontes iniciadas e nenhuma concluída nessa passagem. Outras verificações completas de579fontes em12páginas levaram9–18s. Não se comprovou revogação nem falha da compactação nessa tentativa. A diária e os itens sem avaliação permaneceram pendentes.

## Correção delimitada

O mesmo RPC de prova por página passa a aguardar até15s, em vez de5s. Não há retry de leitura, inferência ou envio. Um cancelamento explícito encerra imediatamente a espera; timer e listener são removidos. Fontes, escopo e política continuam conferidos antes/depois, com o protocolo completo. Resposta inválida, retirada ou indisponível continua recusando uso. Não há cache de autorização nem redução do acervo consultável.

Revisão adversarial recomendou esta alternativa ao retry de RPC não cancelável, que duplicaria trabalho ainda em andamento. O limite90s do transporte da IA permanece; latência acumulada na validação posterior é risco residual a observar, sem ampliação por hipótese.

## Verificação

Três casos dirigidos falharam antes da mudança: resposta válida em6s recusada, página encerrada antes de15s e cancelamento preso ao prazo. Após a mudança passaram os23casos de `assistant-origin-proof-page` e `assistant-origin-checks`, incluindo atraso6s, página pendurada/retorno tardio, cancelamento imediato, retirada posterior, identidade inválida e paginação completa. Usaram dados sintéticos, sem inferência paga. Publicação e retomada reais ainda devem ser medidas; teste local não conclui a diária.
