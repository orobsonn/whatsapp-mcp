# #112 — busca semântica no manifesto persistente

Data: 25–26/10/2026. Implementação local revisada e homologação cloud em andamento; não é piloto. O coordenador publicou o código no ambiente sintético isolado e executou a ingestão real abaixo. A prova de recuperação semântica ainda não terminou; a issue permanece aberta.

## Contrato entregue

`RetrievalRuns` conserva o inventário canônico completo e as guardas de #100. A opção de host `semantic: { mode, engine }` é fixa por instância e entra no requestHash; os modos são `required` e `lexical_fallback`. Instâncias legadas sem essa opção permanecem lexicais; isso não configura um piloto semântico.

Quando o inventário autorizado tem até 64 fontes, TODAS entram no pedido, inclusive score lexical zero. `CoverageProof` interno vincula escopo, run/token/checkpoint, ator, finalidade, configuração, manifesto e inputHash de ator/query/referências/limite. A prova é reconstruída do D1; não é aceita como autorização vinda de texto, modelo ou mensagem. A admissão SQL contém o inventário corrente com NOT EXISTS de omissões, SourceAccess, fingerprints e fences de conversa. A composição balanceada evita exceder depth100 do D1 com 64 conversas diferentes.

O motor continua sendo uma pista de ranking. A fusão `rrf-60-v1` soma `1/(60+posição)` da lane lexical/relações e da lane semântica; scores incompatíveis não são somados diretamente. Empates usam ID. Fontes sem score lexical podem entrar pela lane semântica, mas as restrições de entidades canônicas continuam obrigatórias. Originais literais são relidos e a seleção final é guardada junto com configuração, ticket e proveniência estrita do recibo. SearchFence/allowedPackHash fixam esses dados e a versão/hash/revisão de cada original.

Acima de 64 referências, a cobertura lexical/canônica continua global; a semântica declara `not_run_capacity` + `semantic_unsearched`. Não se pesquisa o primeiro prefixo. No modo required, falta/indisponibilidade/uncertainty mantém pending/waiting_context; fallback lexical explicitamente configurado conserva a lacuna no binding e na mensagem do episódio. Inventário vazio retorna no_matches, sem prepare/submit/modelo.

## Ticket, callbacks e recuperação

`CogneeEngine.prepare(alias, input)` usa a transação do EngineStore existente para fixar um ticket por alias/run. Não acorda container, reserva orçamento nem chama modelo. Um ACK perdido recupera o ticket original; outro requestHash conflita. O ticket fixa operationId, indexEpoch e indexRevision. Submit usa um único CAS prepared→attempting e nunca rekey/recompute automático. Após attempting, ausência de recibo não permite outra execução. Lookup consulta o recibo exato usando a autorização vigente do próprio ticket; uma prova antiga não concede autorização nem impede uma nova prova válida do mesmo pedido exato.

O Active/Grant interno carrega CoverageProof. Cada callback do container compõe o hook ModelAdmission existente de #44/#79 com a prova corrente, inclusive na recuperação de cache. A transação que admite o recibo do modelo repete a guarda D1. Mudança de inventário/grant atrás da busca impede o adapter; mudança durante uma inferência impede saída/publicação e conserva recibo e custo já verdadeiros. Estado do índice é conferido em submit, callback, retorno e lookup. Payloads rejeitados e razões arbitrárias nunca passam ao binding; outcomes têm limite de 64 KiB e tickets/metadados de prepare têm limite de 4 KiB.

Rechecks remotos de origem usam `checkOriginsWithin`: até oito em voo e deadline total fixo de cinco segundos por lote. Falha/timeout nega o lote inteiro; RPCs tardias não publicam e não iniciam novos checks. As guardas locais frescas continuam após as observações. O limite do trabalho longo do motor permanece 250 segundos; ele é separado dessa janela de revalidação.

## Integração de host

O scheduler de #53/#56 deve chamar `advanceSemantic(actor, runId)` como trabalho prévio persistente, fora da lease curta do episódio. `result()` prepara/consulta o ticket e retorna pending enquanto o recibo não estiver pronto; não executa submit longo. `ctx.waitUntil` pode iniciar o trabalho, mas não substitui ticks/recuperação persistente. O próximo tick observa o MESMO ticket; um attempting não é uma autorização de retry. Nenhum episódio Flue/modelo de resposta inicia antes de result ready.

O contrato estrito do episódio aceita `SearchFence.ranking` por `semanticRankingSchema`, compartilhado com RetrievalRuns. Não há `z.unknown()` para proveniência: ticket, configuração, recibo, candidatos, missing e estados de falha são whitelisted. Owner_read não pode emprestar prova/ticket para automation/interlocutor.

## Evidências locais

- D1/workerd real para inventário, provas, admissão/cache do broker, pack e publicação; EngineStore com adapter transacional serializável fiel (snapshot/commit/rollback), incluindo reconstrução, concorrência e perda de ACK.
- Fonte de sinônimo com score lexical zero entra no pack e mantém o original literal. Fixture comprova o caminho/contrato; não comprova qualidade semântica do Cognee real.
- Privado próximo não entra em allowedSources nem campos auxiliares; ator/finalidade/query/subconjunto alterados recusam a prova. Missing, duplicatas e campos extras não completam cobertura.
- Insert/grant/correção antes do callback; inserção na própria admissão SQL; mudança durante adapter; cache com nova guarda; índice alterado; SearchFence/proveniência adulterado; cap65; cap64 com 64 conversas e 64 origens.
- Deadline controlado com fake clock: máximo oito checks ativos, timeout em 5 s, nenhum submit/adapter, ticket idêntico; sucesso tardio não inicia checks restantes.
- Integração real EpisodeController: required com score0 e fallback lexical explícito percorrem admissão→publicação. Inserção atrás do inventário bloqueia recibo/nonce em ambos os modos. Recibos/custos pagos controlados permanecem verdadeiros.
- Revisão independente do coordenador identificou e levou à correção da propagação de outcome rejeitado, do scope WhatsApp com binding db e do schema estrito de ranking em #44. Não equivale à aprovação de piloto.

A execução final de check, suíte completa, suíte Flue e builds fica registrada no commit de entrega e no retorno ao coordenador. Migração aditiva: `0015_semantic_retrieval.sql`; `0014_retrieval_runs.sql` permanece intacta. Nenhum novo ledger financeiro, ingest automático, rebuild ou aumento de capacidade.

## Verificação independente e correção de persistência

Revisão adversarial independente: 60/60 em engine/semantic-runs/origin-checks e 36/36 em EpisodeController; sem bloqueador concreto. Suíte completa local anterior ao último ajuste: 721/721; Flue/workerd 43/43. O coordenador reproduziu uma referência WhatsApp válida negada apenas pela ordem das propriedades após persistência (RED), corrigiu OriginGuard.check para igualdade do conjunto exato de campos/valores e repetiu 52 testes de origem/materialização/semântica e check (GREEN). Campos extras, watermark alterado e retirada continuam negados. Re-review do delta e harness sintético sem novo bloqueador. CI no commit integrado ainda é gate de entrega.

## Homologação cloud parcial — 26/10

O Worker isolado executou o código112 real com Cognee1.6.5 em Container Cloudflare. Sete fontes novas (sinônimos, dois homônimos em projetos distintos, instrução citada e nota privada próxima) foram extraídas e indexadas: sete operações completas,149 novos recibos de modelo completos e3692microUSD registrados (US$0,003692). Orçamento e recibos anteriores foram conservados, inclusive reservas incertas; não houve reset.

Após a ingestão, um checkpoint salvou candidato durável com nove fontes no total e snapshot de5439701bytes. Uma publicação do Worker ocorreu enquanto essa operação estava em andamento; o RPC terminou com500 e o estado persistido ficou restoring, com o candidate novo e confirmed antigo preservados. O restore existente recusa essa fase permanentemente. Isso motivou a issue121, com revisão adversarial e recuperação cercada por owner/época, sem recriar snapshot ou inferência.

A consulta de sinônimo tinha score lexical0; result/advance permaneceram pending, semantic_unsearched, sem liberar fontes privadas nem registrar chamadas pagas adicionais. Esse resultado demonstra bloqueio honesto, NÃO recuperação semântica bem-sucedida. O Container foi parado após o diagnóstico para evitar custo ocioso. A busca do corpus (limite final de duas fontes), correção antes/depois de indexar e repetição sem custo continuam pendentes da recuperação121. Nenhuma dessas lacunas foi convertida em aceite.
