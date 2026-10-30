# Consulta de fontes com demora transitória

30/10/2026. Na revisão3 da diária, a IA respondeu e seus tokens foram contabilizados. A verificação posterior do contexto falhou na primeira página: `reader_rpc / reader_timeout`,5065ms,62fontes iniciadas e nenhuma concluída nessa passagem. Outras verificações completas de579fontes em12páginas levaram9–18s. Não se comprovou revogação nem falha da compactação nessa tentativa. A diária e os itens sem avaliação permaneceram pendentes.

## Correção delimitada

O mesmo RPC de prova por página passa a aguardar até15s, em vez de5s. Não há retry de leitura, inferência ou envio. Um cancelamento explícito encerra imediatamente a espera; timer e listener são removidos. Fontes, escopo e política continuam conferidos antes/depois, com o protocolo completo. Resposta inválida, retirada ou indisponível continua recusando uso. Não há cache de autorização nem redução do acervo consultável.

Revisão adversarial recomendou esta alternativa ao retry de RPC não cancelável, que duplicaria trabalho ainda em andamento. O limite90s do transporte da IA permanece; latência acumulada na validação posterior é risco residual a observar, sem ampliação por hipótese.

## Verificação

Três casos dirigidos falharam antes da mudança: resposta válida em6s recusada, página encerrada antes de15s e cancelamento preso ao prazo. Após a mudança passaram os23casos de `assistant-origin-proof-page` e `assistant-origin-checks`, incluindo atraso6s, página pendurada/retorno tardio, cancelamento imediato, retirada posterior, identidade inválida e paginação completa. Usaram dados sintéticos, sem inferência paga. Publicação e retomada reais ainda devem ser medidas; teste local não conclui a diária.

## Retomada real e resultado

O código7028147 foi publicado no Ownc159d74e, com todos os bindings/horários preservados e seleção explícita do predecessor3. A revisão4 foi admitida11:33:41UTC, mesmo UID/sessão/janela. SDKsub_ik_a4b86e1d912857695ca689a8de53a037 terminou `completed` às11:43:15UTC. Os quatro novos recibos sãocomplete, total93838microUSD (US$0,093838), sem nova incerteza financeira. Diagnóstico filtrado do tail contém230verificações completas de contexto e nenhuma falha de modelo no intervalo observado; o arquivo bruto foi removido.

Os48itens antes apresentados passaram a41avaliações adicionais,6indisponíveis adicionais e1ainda apresentado. Totais atuais:114evaluated,1learned,1presented,131unavailable,355skipped_policy,7superseded,213withdrawn. A contabilidade terminoupartial/needs_help, não cobertura integral. Lacunas da captura permanecem separadas:1avaliada,204pendentes,1139fora da política. O resumo teve reciboaccepted no Telegram às11:41:37UTC; isso não prova leitura humana.

A seleção temporária foi removida no Own1fc9bfa5; agendamento diário, recursos e modoapproval preservados, autonomia desligada. CI41048648560 passou integralmente no código7028147. Esta prova resolve a interrupção específica por prazo de leitura; não fecha as demais pendências da issue146 nem transforma fontes indisponíveis em conteúdo avaliado.
