# #54 — instrumentação integrada, avaliação humana e limites

27/10/2026. Consolidação documental sobre `6b4bd49822a2da27f67ccc77409969bf8d80ea40`, sem alteração de produção, versão ou changelog. A [CI exata40428641551](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40428641551) terminou com sucesso. A integração com o scheduler #53 está no código entregue; seus [ciclos naturais pausados](53-56-natural-cron-vps.md) têm prova própria. Isso não transforma metadados de captura em avaliação de qualidade.

O [JSON de evidência](54-avaliacao-integrada-vps.json) mantém o probe remoto de Evaluation/health como **pendente**, com resultados e hash ausentes. Não há amostra cloud ou avaliação humana nova alegada por este documento. O operador de leitura está em preparação pelo coordenador.

| Critério | Evidência disponível | Fronteira restante |
| --- | --- | --- |
| #ac-15.281 — resposta, pendência, silêncio e falha | `Evaluation.sample` pagina o DecisionJournal45 real; os [23 testes D1/MCP](54-avaliacao-saude.md) cobrem proposta, waiting_context, silêncio, falha, uncertain e não avaliado, com estados distintos. Integração validada pela CI6b4. | Ler sample no host publicado, sem criar entradas ou chamar modelo; registrar o que existir, inclusive vazio. Não é prova de cobertura global das mensagens. |
| #ac-15.282 — ação humana sem atribuição à IA | Exposição/assessment exigem comando Owner autenticado; teste usa **fixture explícita de `owner_report`**, não julgamento humano real. `fromMe`, ação simulada e leitura da proposta não criam fato humano. Evidência retirada fica indisponível e o juízo histórico não vira verdade atual. | Não inventar assessment para preencher dashboard. Comparações com ações humanas reais dependem do piloto; ausência de rótulos permanece unknown. |
| #ac-15.283 — custo, latência e revisão | Custo usa ledger37 em microUSD, todas as gerações/períodos da instalação, preservando reservas incertas. Latência tem denominador de publicações pareadas; exposição→assessment é tempo decorrido de parede, **não tempo ativo de revisão**. Testes cobrem custos entre gerações, nonce inválido e denominadores. | Probe remoto de metrics/health pendente; não declarar medição real de inferência/revisão onde não há pares. O ledger não é fatura do provedor nem novo teto global. |
| #ac-15.284 — zero eventos não vira100% | Fixtures vazias retornam null/unknown; denominadores e rótulos históricos são explícitos. Estatísticas `unchecked_historical` não afirmam `currentCorrectness`. | Confirmar o retorno observado do host sem fabricar eventos ou inferir que ausência de mensagens indica falha. |

## Validação existente e atribuição

A evidência local registra RED causal da rota `evaluation.sample`, GREEN23/23 em22,76s, TypeScript e revisão adversarial. A CI integrada atual é um gate separado dessas execuções históricas; não se executou nova suíte para esta documentação. Paginação, afinidade autenticada, idempotência/ACK perdido, retirada, custos, latência e zero eventos fazem parte dos testes existentes.

`owner_assessment_at_exposure` descreve um juízo explicitamente relatado pelo dono sobre uma exposição registrada no servidor. Não prova atenção, autenticação pelo conteúdo de uma mensagem, ação confirmada por provedor ou correção atual. Uma proposta/fonte alterada torna a exposição stale; histórico e evidência atualmente legível têm tratamentos distintos. Metadados/IDs não são anonimização.

## Probe e limites de entrega

- **Pendente:** somente leitura nominal de `assistant.health`, `evaluation.metrics` e `evaluation.sample` no host6b4; resultado privado e hashes serão acrescentados após execução. Nenhum valor default representa observação concluída.
- Instrumentação de comparação entregue é distinta de benefício, qualidade e tempo de revisão reais ao longo do piloto. Não é necessário inventar dados humanos para demonstrar o contrato.
- Telegram, consentimento Google e atualização do catálogo MCP do cliente continuam integrações/homologações próprias. Não tornam os Workers instalados indisponíveis e não são usados como provas de Evaluation.
- Esta fatia não habilita modelo, envio WhatsApp ou escrita Calendar e não altera Elo. Inferência adicional desta preparação documental: **US$0**; infraestrutura não foi faturada/estimada aqui.

Release minor, versão/tag/changelog e fechamento permanecem com o coordenador após os gates finais. Nenhuma prontidão integral do piloto é declarada.
