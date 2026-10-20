# Captura opt-out — plano e limites

Pedido inicial de 20/10/2026: implementar e testar sem publicação. Aprovação posterior do dono: merge, deploy e ativação dos 1.424 legados; novas conversas capturam por padrão e desativações posteriores devem persistir.

## Decisões

- Padrão efetivo ligado quando não existe configuração global para a instalação/geração. Configuração global em `policies`, identificada por geração e epoch; escolhas por chat persistidas em `capture_settings` (`default`, `enabled`, `disabled`, `legacy_hold`) com revisão monotônica.
- `capture_enabled` continua como projeção materializada para os guards SQL já existentes. Triggers pequenas atualizam a projeção no cadastro, mudança de escolha e alteração global. Nenhuma consulta ao provedor por mensagem.
- Migração aditiva e idempotente: preservar todos os false antigos como `legacy_hold`, sem chamá-los de opt-out explícito; true antigo preserva habilitação (`enabled`), pois o produto anterior só ligava captura por escolha explícita. Não usar propostas expiradas/applied como prova: cleanup as remove e exclusão marca outras como applied para invalidá-las. Desbloquear legado requer diagnóstico e aprovação separados.
- Webhook pode cadastrar chat desconhecido somente com `isGroup` boolean confiável. ID existente nunca muda; ausência de tipo em chat já conhecido usa o tipo cadastrado. Não deduzir identidade por nome, LID ou sufixo.
- A mesma transação deve proteger mensagem, autor e mídia contra opt-out concorrente. Propostas congelam escolha/revisão, além do boolean efetivo. Exclusão mantém bloqueio explícito e tombstones.
- Métricas agregadas dos callbacks autenticados, sem conteúdo/nome/telefone. Lacunas com início conhecido, indicação de legado ambíguo e ausência de promessa retroativa. Banco indisponível pode impedir a própria métrica de falha; HTTP deve continuar indicar falha.

## Etapas de implementação

1. Testes RED para descoberta individual/grupo, defaults, exceções/reinício, idempotência e migração repetida.
2. Schema/política, guards de captura e propostas/exclusão; GREEN dos testes focados.
3. Webhook, métricas e projeções MCP; testes de concorrência, replay, identidade e lacunas.
4. Revisão adversarial, suíte completa, check e build dry-run. Entrega em branch para revisão, sem deploy/merge/release produtiva.

## Diagnóstico anterior a alterações em massa

Consulta remota agregada tentada em 20/10: Cloudflare recusou autorização (7403). Nenhum dado foi alterado. Alternativa somente leitura pelo MCP autenticado: 1.426 chats, 2 com captura ativa, 1.424 desativados; retenção indefinida. A divisão por tipo e a classificação individual continuam pendentes do preflight SQL. Nenhum conteúdo foi lido. O diagnóstico somente leitura e a estratégia conservadora devem ser conferidos antes da ativação; dados sintéticos não substituem esse preflight.

## Riscos aceitos e mitigação

Captura de mais conversas aumenta armazenamento e dados pessoais de terceiros. Não altera autenticação, retenção, visualização única/temporárias, transcrição opt-in nem acesso de IA por si só. Não envia ou lê no WhatsApp, não importa passado. O dono deve revisar finalidade, necessidade, retenção, participantes de grupos e eventual uso profissional antes de aprovar ativação. Autorização do dono para o software não é presumida como consentimento de todos os participantes.

Referências: [LGPD, arts.4,6,7,11,46](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm), [D1 SQL](https://developers.cloudflare.com/d1/sql-api/sql-statements/). Exceção de uso exclusivamente particular não deve ser presumida para conversas profissionais. Esta é uma fronteira de implementação, não uma conclusão jurídica de conformidade.

## Ativação futura — não executada

1. Restaurar acesso autorizado à conta Cloudflare. Rodar `npx wrangler d1 execute DB --remote --file scripts/capture-preflight.sql --json` **somente leitura**; conferir instalação/geração, divisão individual/grupo e retenção. Guardar apenas contagens no relatório público.
2. Mostrar ao dono o conjunto revisado e obter aprovação explícita para deploy/migração. Os 1.424 desativados observados não são 1.424 opt-outs comprovados. Não há autorização para reativá-los em bloco nesta entrega.
3. Planejar janela sem gravações de captura (manutenção), registrar versão/backup/recuperação e aplicar `0009_capture_optout.sql` pelo mecanismo de migrations. A migration cria schema, conserva os ativos e mantém todos os antigos desativados em revisão; não apaga histórico. Aplicar duas vezes via Wrangler não reaplica a migration; o SQL também possui marcador idempotente.
4. Publicar o código desta branch somente após aprovação. Ainda em manutenção, conferir invariantes e a política efetiva. Reabrir tráfego apenas na janela aprovada; novos chats então serão armazenados automaticamente.
5. Atualizar o catálogo do plugin existente e as instruções, preservando OAuth. Usar `diagnosticar_captura`: totais por tipo, padrão, habilitados/desabilitados explicitamente, legados e métricas.
6. Para cada legado revisado, `propor_captura(enabled=true)` + `aplicar_politica` mantém confirmação individual. Ativação em lote exige um manifesto revisado de IDs e nova autorização exata; não há ferramenta MCP genérica de escrita nem script que libere todos automaticamente.
7. Testar callback sintético no ambiente de homologação e, se aprovado, recebimento real em chat escolhido pelo dono. Não enviar mensagens de teste a grupos por conta própria. Conferir counters, autoria, timestamp, replay e opt-out; aceitação HTTP não prova todos os callbacks do WhatsApp.

Para voltar ao padrão global desligado, operador autorizado grava `false` na política `capture_default_enabled:<geração>` do epoch correto; somente `default` é afetado. Para herdar novamente em uma exceção revisada, atualizar modo para `default` e incrementar revisão; não apagar registros de `capture_settings`. Remover a política global significa padrão ligado e requer a mesma disciplina de autorização.

## Cobertura e privacidade

Os counters contam tentativas de callbacks autenticados, em dias UTC; `stored` conta IDs novos, `duplicates` inclui replay/edição/exclusão de ID existente. Retenção ou limpeza podem reduzir o histórico visível sem alterar essas contagens. Sem webhook, sem conexão ou com banco fora do ar não existe prova local de quantas mensagens foram perdidas. Lacunas por chat mostram início conhecido; legados têm início desconhecido e não ganham uma data inventada de captura retroativa.

Desativar cancela downloads recebidos ainda pendentes/em andamento. Não apaga mensagens/arquivos prontos anteriores nem uploads feitos explicitamente pelo dono. Reativar não retoma esses downloads cancelados automaticamente. Exclusão local mantém tombstones e bloqueio explícito; nada é apagado ou marcado lido no WhatsApp.

## Evidência desta entrega

- `npm test`:207testes passaram em17arquivos.
- `npm run check`: passou. `npm run build`: passou, exclusivamente `wrangler deploy --dry-run`.
- `npm audit --omit=dev --audit-level=high`: nenhuma vulnerabilidade de produção.
- RED: testes iniciais sem módulo; regressão de arquivamento de mídia após opt-out reproduzida antes do guard, depois corrigida. GREEN inclui indivíduos/grupos, mensagens próprias/recebidas, webhook antes da agenda, reinício lógico, replay, sync concorrente, legado, migração repetida, configuração global, métricas, download em voo e confirmações MCP.
- Revisão adversarial final sem bloqueador remanescente. Auth/retention/exclusão e suíte anterior continuam passando.
- Nenhuma migration remota, envio, marcação de leitura, alteração de webhook, publicação de plugin, deploy ou merge foi executado nesta tarefa.

## Arquivos alterados

| Parte | Arquivos |
|---|---|
| Schema e política | `migrations/0009_capture_optout.sql`, `src/capture-policy.ts` |
| Recebimento e diretório | `src/capture.ts`, `src/directory.ts`, `src/index.ts` |
| Confirmações, diagnóstico e retorno de envio | `src/operations.ts`, `src/actions.ts`, `src/mcp.ts` |
| Orientação ao dono | `src/setup-pages.ts`, `plugin/whatsapp-pessoal/skills/usar-whatsapp/SKILL.md` |
| Testes | `tests/capture-policy.test.ts`, `tests/actions.test.ts`, `tests/archive.test.ts`, `tests/directory.test.ts`, `tests/groups.test.ts`, `tests/journey.test.ts`, `tests/operations.test.ts` |
| Preflight e documentação | `scripts/capture-preflight.sql`, `README.md`, `CHANGELOG.md`, este documento |

## Publicação autorizada em 20/10/2026

Preflight remoto recuperado: 112 grupos (2 ativos) e 1.314 conversas individuais (0 ativas), total 1.426; 271 registros de mensagens. Nenhuma política global anterior. A aprovação posterior autoriza liberar somente `legacy_hold`, com instalação/geração e revisão conferidas; não sobrescrever `disabled`. Procedimento anterior acima registra o limite da etapa de preparação, já superado pela aprovação explícita.

## Resultado da ativação aprovada

- PR #23 integrado em `1b977d3`, CI aprovado no HEAD da entrega; versão 0.5.0.
- Recuperação D1 registrada privadamente antes da migration; `0009_capture_optout.sql` aplicada em manutenção e confirmada pelo controle de migrations.
- Manifesto privado conferiu exatamente 1.424 registros `legacy_hold`, mesma instalação/geração e revisão 0. Ativação limitada a esses registros; nenhuma escolha `disabled` sobrescrita. Política global explicitamente `true`.
- Antes: 112 grupos (2 ativos), 1.314 individuais (0 ativos). Depois: 112 grupos e 1.314 individuais ativos; 1.424 herdando padrão e 2 habilitados explicitamente; zero legados e zero desativações explícitas no momento da ativação.
- 273 registros de mensagens antes e depois da alteração; nenhuma exclusão. As 1.424 lacunas antigas foram encerradas, mantendo início desconhecido e ausência de recuperação retroativa.
- Worker ativo `39e385f3-cdf6-4d12-98b4-d246f8a29eb8`; `/health` versão 0.5.0, manutenção false, conexão configurada true. Smoke confirmou acesso privado protegido.
- `diagnosticar` autenticado pelo Zap retornou padrão ligado e todas as 1.426 conversas ativas. Sem envios ou leitura de conteúdo neste procedimento.
- Plugin Zap atualizado para 1.0.2 (`pluginrel_6ad7605a4db48191ace9a525d64d2336`); instruções relidas e vínculo App/OAuth preservado.
- Testes locais: 207 em 17 arquivos, TypeScript e build aprovados. Testes de opt-out/reinício/sync/concorrência executados com fixtures; nenhuma conversa real foi desligada para teste.

A configuração ativa não prova retroativamente callbacks que não chegaram. As métricas passam a contar somente callbacks autenticados recebidos pela versão instrumentada.
