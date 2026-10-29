# Assistente autônoma e memória compartilhada — plano de implementação autorizado

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans somente após aprovação explícita deste desenho/plano. Checkboxes representam trabalho futuro, não executado.

**Goal:** entregar uma assistente que mantém continuidade Flue, consulta e constrói conhecimento relacionado no Cognee compartilhado pelo MCP existente, aprende durante interações e curadoria, e responde autonomamente sob autorização do dono.

**Architecture:** Flue conduz o loop nativo em sessões persistentes; um serviço de conhecimento expõe operações comuns aos agentes e ao MCP do assistente sobre o mesmo Cognee. Arquivo, controle de acesso, custos e ações permanecem com recibos duráveis; o executor Source conserva destino e tentativa única.

**Tech Stack:** TypeScript/Workers/D1/R2/DO, Flue2.3.0 e Cognee1.6.5 como bases inspecionadas, Ladybug/LanceDB/SQLite nativos, MCP/Z-API/Telegram/GitHub/Google próprios. Upgrade ou mudança de hospedagem exige ADR e compatibilidade comprovada; nenhum fornecedor/recurso novo foi contratado.

**Spec:** [desenho e decisões do dono](../specs/2026-10-28-assistente-autonoma-memoria-compartilhada-design.md).

## Global Constraints

- Estado deste documento: **implementação e testes autorizados pelo dono em 28/10/2026**, após sua devolutiva e pedido de novo goal. Começar por P0; não ativar respostas autônomas ou contratar infraestrutura sem autorização posterior.
- Preservar branch, episódios, custos, reservas, incertezas, recibos, pareamento e credenciais; não modificar/copy dados do Elo nem instalar harness.
- MCP de memória é extensão do MCP existente do assistente, com autoridade do dono fixada no servidor; não oferecer outro MCP para configurar nem outro grafo por cliente.
- Leitura global do acervo autorizado é decisão do dono; não reintroduzir restrição artificial de contexto à mesma conversa. Acesso aos dados e autorização para agir são controles diferentes.
- Flue tem identidade de sessão estável; entrega/tarefa/intenção de ação têm identidade separada. Grupo usa chatId do grupo, sem retarget a participante.
- Individuais recebidas entram na análise por padrão, exceto exclusões do dono; grupos só por inclusão explícita. Exclusão acompanha bots, curadoria e MCP, com invalidação dos derivados/contextos dependentes e preservação separada da captura.
- Grupos habilitados podem gerar resposta relevante sem menção; curadoria às 03:00 America/Fortaleza, resumo diário inicial e somente erros/ajuda após confirmação do dono. Qualidade sem deadline fixo.
- Referência mensal do dono: aproximadamente R$200 total, ~R$100 Z-API informado e ~R$100 IA/infra; estimar viabilidade antes de ativar.
- Agent pode aprender em qualquer run; curadoria diária complementa. Memória inferida não vira `owner_note`, política ou mandato.
- Sem tetos acumulados128/256, sem64 como universo máximo de pesquisa, semgrafo inteiro em RAM por busca. Lotes e páginas são limites ajustáveis de execução, acompanhados de cobertura.
- Teto dos testes pagos já autorizado: US$10 global, incluindo históricos incertos; custo recorrente de produção exige proposta concreta antes de ativação. Nenhum reset de ledger.
- GitHub somente leitura; Calendar dentro da autorização do dono. Ativação autônoma externa requer autorização operacional explícita, após validação funcional.
- Verificar também na infraestrutura real Cloudflare: bindings, persistência, chamadas de ferramentas e consequência no provedor. Testes locais não fecham aceite; usar ambiente de ensaio isolado antes do fluxo real Telegram/WhatsApp.
- Publicar release por marco concluído, com changelog/version/tag coerentes; não criar release por tarefa ou encerrar issue pela presença de código.

## Review Focus

- Rajada de mensagens, resposta manual e áudio tardio: sessão contínua reavalia a necessidade, sem responder a turno antigo nem cancelar a fila inteira.
- Curador e bot aprendem a mesma relação com operações diferentes: uma relação correta reúne evidências, sem duplicar nós/arestas nem ocultar conflitos.
- Fonte corrigida aparece em compaction e consulta antiga: novo turno não reutiliza esse conhecimento; retirada lógica e expurgo físico são comprovados separadamente.
- MCP recebe contexto do dono com pessoas homônimas ou instruções embutidas: origem é preservada, identidade não é inventada e conteúdo não amplia poderes.
- Timeout do provider, reinício do Cognee ou ACK perdido no envio: recibos persistem; nova leitura não fabrica sucesso ou nova tentativa paga/externa.

## Ordem e entregáveis

P0 valida compatibilidade e persistência. P1 entrega conhecimento compartilhado verificável. P2 entrega sessões/ferramentas nativas. P3 completa ajuda e conectores. P4 entrega curadoria. P5 integra modos de ação e migração. P6 faz aceite real e release. A ordem não exige terminar todo o catálogo antes de demonstrar valor: o primeiro percurso é MCP→relação→outra sessão→fonte original.

## Mapa dos componentes

| Componente | Reutilizar/modificar | Novos módulos focados propostos |
| --- | --- | --- |
| Runtime contínuo | `assistant/agent-runtime/*`, `telegram-dialogue-runtime.ts`, `scheduler.ts`, `conversations.ts` | `assistant/agent-runtime/conversation.ts`, `conversation-tools.ts` |
| Memória compartilhada | `cognee/backend.py`, `cognee/server.py`, `engine.ts`, `container.ts`, `checkpoints.ts` | `assistant/knowledge/contracts.ts`, `service.ts`, `tools.ts`; backend store conforme ADR |
| Interface MCP | `src/mcp.ts`, `assistant/mcp.ts`, `src/env.ts`, `assistant/env.ts` | schemas comuns em `assistant/knowledge/contracts.ts` |
| Identidade/proveniência | `models.ts`, `migrations/0002_identity_policy.sql`, `sources.ts`, `relations.ts`, `source-proof-contract.ts`, `origin-guard.ts` | resolução/projeção de entidades e conhecimento no módulo `knowledge`, sem segundo grafo |
| Ações e esclarecimentos | `telegram-approved-send.ts`, `telegram-owner-inbox.ts`, `src/assistant-approved-send.ts`, `src/actions.ts` | `assistant/agent-runtime/action-policy.ts`, `clarifications.ts` |
| Curadoria | `assistant/cloudflare.ts`, captura/materialização existentes | `assistant/knowledge/curator.ts` |
| Retenção/custo | `budget.ts`, `model-broker.ts`, `model-transport.ts`, `retention-*.ts` | adapter estreito de custos no runtime; manutenção de contexto Flue |

Arquivos de migração recebem o próximo número livre **na execução**, sem reordenar os existentes. Dependências/campos são adicionados de forma compatível. O plano não manda dividir arquivos sem relação com o comportamento alterado.

## P0 — Fechar as provas técnicas e o dimensionamento

**Arquivos de referência:** runtime/provider/install; `node_modules/@flue/runtime/docs/reference`; Cognee tag/pacote fixados; `cognee/backend.py`, `server.py`, `engine.ts`, `checkpoints.ts`, `retention-purge.ts`.

**Interfaces:** produz ADR único de runtime/provider, protocolo de conhecimento/proveniência e hospedagem/persistência. Consome decisões D01–D14 e relatório de volume capturado, não conteúdo pessoal público.

- [ ] Confirmar APIs do pacote realmente instalado e comparar com tag Cognee1.6.5. Registrar `remember/recall`, DataPoint/Edge, `get_edge_evidence_records`, `improve`, IDs e hooks Flue. Não assumir paridade automática da documentação atual.
- [ ] Ensaio delimitado, após aprovação: duas entradas na mesma instância Flue, uma ferramenta nativa entre chamadas, reinício, join e compaction. Comprovar o modelo configurado e preservação do protocolo de tool calls.
- [ ] Provar reserva de orçamento antes de qualquer transporte, cobrança/recibo normal e uncertain em timeout; incluir compaction e retries. Preferir provider nativo + interceptor comprovado. Se o interceptor não oferecer os dados necessários, wrapper estreito do provider, sem reconstruir o loop.
- [ ] Provar remoção/invalidação de histórico e resumos pelas APIs disponíveis. Definir identidade lógica + contextEpoch e como impedir leitura de instância antiga. Não usar `abort` como expurgo.
- [ ] Ensaio Cognee com dados sintéticos: fonte→entidades com IDs estáveis→aresta→evidence→original. Relação criada pelo agente é consultada por outra operação, corrigida e invalidada após retirada. Validar que enriquecimento sem evidence não vira fato afirmável.
- [ ] Auditar somente infraestrutura existente: serviço com volume persistente é hipótese preferida; comparar com Container existente + snapshots/journal. Demonstrar restore consistente das mutações de conhecimento, não só originais; registrar imagem, recuperação e custo. Incluir autenticação Own↔Cognee, dono/namespace fixo e TLS/rede privada, sem REST desprotegida. Fechar **uma** opção em ADR antes de P1.
- [ ] Medir volume/tamanho/distribuição reais e manter relatório privado. Ensaiar memória/CPU/disk/latências/custos com carga derivada disso, sem afirmar cobertura completa do WhatsApp. Propor lotes/custo operacional, medindo latência sem deadline fixo, com justificativa e apresentar ao dono antes de ativação.
- [ ] Revisar o ADR adversarialmente e ajustar spec/plano se alguma capacidade não se confirmar. Não migrar produção por tentativa de descobrir APIs.

**Verificação:** logs/recibos dos ensaios e leitura independente dos dados; orçamento preservado. Este marco pode reprovar uma escolha de provider/hospedagem sem descartar o produto. A aprovação do plano autoriza estudo técnico delimitado, não gasto acima do teto existente ou nova contratação.

## P1 — Operações de conhecimento e MCP existente

**Arquivos:** criar `assistant/knowledge/{contracts,service,tools}.ts`; modificar `assistant/mcp.ts`, `src/mcp.ts`, `src/env.ts`, `assistant/env.ts`, `sources.ts`, `source-proof-contract.ts`, backend/store Cognee conforme ADR. Testes novos focados: `tests/assistant-knowledge.test.ts`, `tests/assistant-knowledge-mcp.test.ts`; Python em `assistant/cognee/test_knowledge.py`.

**Interfaces propostas:**

- `KnowledgeService.query(ctx: KnowledgeContext, input: KnowledgeRead): Promise<KnowledgePage>`.
- `KnowledgeService.remember(ctx, input: KnowledgeWrite): Promise<KnowledgeReceipt>`.
- `KnowledgeService.correct(ctx, input: KnowledgeCorrection): Promise<KnowledgeReceipt>`.
- `KnowledgeService.status(ctx, operationId: string): Promise<KnowledgeReceipt>`.
- `KnowledgeService.forget(ctx, input: KnowledgeWithdrawal): Promise<KnowledgeReceipt>` — somente autoridade de retirada do dono/invalidação comprovada.
- `KnowledgeContext` é construído pelo host: instalação, dono, geração, origem autenticada e permissões. Campos não são argumentos livres do modelo.
- `KnowledgePage` inclui entidades/relações/caminhos/evidências, revisão, cursor e cobertura. `KnowledgeReceipt` distingue conhecimento aceito, indexação, consulta pronta e `uncertain`; este último só consulta/reconcilia a mesma operação, sem repeti-la cegamente.

- [ ] Testar o percurso escrito no spec A03–A06, com proprietário fixado e outro cliente lendo o mesmo conhecimento; observar o teste falhar antes de implementar.
- [ ] Implementar identidades estáveis, classificação declaração/inferência, origem `owner_report/agent_derived` distinta de nota do dono, temporalidade e suporte explícito a fontes atuais. Resolver suportes derivados até originais sem ciclos; texto do modelo não é evidência de si. Estender tipos que hoje só cobrem projeto/missão para pessoa/grupo/conversa/repositório sem inventar relações por nome.
- [ ] Explicitar autorização interna de leitura global do assistente em `access.ts`/RPC, sem conceder administração a terceiros. Aplicar individuais padrão, grupos opt-in e exclusões em análise, aprendizado, consulta e curadoria; separar esses controles da captura/arquivo e invalidar contextos derivados. Evidência independente autorizada pode permanecer. Pesquisa global não habilita resposta em grupo não autorizado.
- [ ] Persistir operação e conhecimento aceito de forma durável, com reconsulta idempotente. Grafo semântico fica no Cognee; D1/R2 guarda fonte/registro/revisão/proveniência e estado operacional necessários ao contrato.
- [ ] Implementar consulta nativa das entidades/arestas/evidências, owner/revogação antes do ranking e releitura dos originais selecionados. Remover montagem obrigatória de todos os sourceIDs em um payload; não usar pós-filtro de top-k como substituto de acesso.
- [ ] Substituir manifesto JSON e listas completas de fontes/operações por metadados persistentes consultáveis. Versionar mutações do grafo, inclusive nova aresta sem nova fonte. Retirar caps128/256/64 e varredura completa de grafo; medir operação sobre corpus acima dos tetos antigos.
- [ ] Reutilizar ingestão/proveniência nativa do Cognee. Configurar auto-improve explicitamente para não disparar curadoria completa a cada remember; diário faz enriquecimento escolhido e verificável.
- [x] Expor operações pelo **MCP atual** do assistente, usando a autenticação/RPC existentes. Não expor SQL, Cypher livre, URLs arbitrárias, escolha do dono, credenciais ou operações de infraestrutura. Fixar o mesmo espaço de conhecimento usado pelos bots.
- [ ] Cobrir correção concorrente, duas operações diferentes da mesma relação, nomes iguais de pessoas diferentes, payload repetido, prompt injection no texto e dado retirado. Provar fonte fornecida pelo GPT rotulada corretamente.
- [ ] Rodar testes dirigidos e tipos; registrar SHA/evidências. Commit funcional somente após prova do percurso, sem release própria por tarefa.

**Comandos previstos:** `npx vitest run tests/assistant-knowledge.test.ts tests/assistant-knowledge-mcp.test.ts`; testes Python nativos conforme comando compatível fechado no ADR; `npm run check`.

## P2 — Sessões Flue contínuas e ferramentas reais

**Arquivos:** criar `agent-runtime/{conversation,conversation-tools}.ts`; modificar `profiles.ts`, `driver.ts`, `install.ts`, `provider.ts`, `runtime.ts`, `agent/controller.ts`, `scheduler.ts`, `telegram-dialogue-runtime.ts`, ingresso/captura e orçamento. Testes: `tests/assistant-conversation-runtime.test.ts`, estender teste nativo `tests/assistant-flue-runtime.test.ts`.

**Interfaces:** `conversationAddress(scope, channel, principalOrChatId, contextEpoch): string`; `deliverConversation(event: VerifiedConversationEvent): Promise<ConversationDeliveryReceipt>`; `TaskContext` imutável por rodada/coorte; tools locais consomem `KnowledgeService` de P1. IDs de tarefa/intenção não substituem ID da sessão.

**Dependência de ativação:** P1–P4 podem ser demonstrados com dados sintéticos e em recursos de ensaio após aprovação. Nenhum conteúdo pessoal novo é persistido no transcript/compaction nem há nova ativação de produção antes de estarem funcionais a invalidação/retirada de P5 e a prova de P0. P5 não pode ser adiado como limpeza posterior ao uso real.

- [ ] Testar A01/A02: duas entregas continuam a mesma sessão; outra conversa usa sessão diferente; dono Telegram conserva memória entre tópicos; grupo mantém autores sem trocar destino.
- [ ] Registrar agentes/modelo/compaction nativos; dados estáveis em initialData, metadados de cada entrega via useDelivery/resolução autenticada. Preservar histórico legado sem reescrevê-lo como conversa nativa nova.
- [ ] Trocar o adapter textual fechado pelo caminho nativo definido em P0. Montar ferramentas estreitas de pesquisa/leitura/memória; instruções ensinam consultar, aprender, silenciar e reconhecer cobertura parcial. Não montar ferramentas administrativas completas do dono no contexto de terceiros.
- [ ] Entregar eventos de entrada, saída manual, correção e resultado de ação à sessão. Registrar proposed/discarded/approved/attempted/accepted/delivered de forma distinta. Source continua fonte do ocorrido.
- [ ] Tratar joins por rodada/coorte; resposta manual e entrada nova superam a intenção antiga. Reutilizar idempotência de entrega/operação; evitar uma fila global por todas as conversas.
- [ ] Remover o manifesto de três textos como teto de raciocínio. Texto maior é segmentado/referenciado; mídia usa derivados prontos e estados explícitos. Limites de tokens e bytes não viram falsa leitura de todo o documento.
- [ ] Rodar teste nativo real do Flue com modelo controlado e integração de custos; depois ensaio pago delimitado, já aprovado e contabilizado, comprovando ferramenta escolhida pelo modelo. Nada de semear resposta final e chamar de raciocínio.
- [ ] Verificar tipos/build assistant e registrar migração de namespaces/classes como futura operação controlada. Sem promover o novo runtime automaticamente.

**Comandos previstos:** teste dirigido de conversa; `npm run test:assistant-runtime -- -t 'persistent conversation'` após nome de caso adicionado; `npm run check`; `npm run build:assistant`.

## P3 — Ajuda, conectores e tarefas do dono

**Arquivos:** criar `agent-runtime/clarifications.ts`; reutilizar `telegram-owner-inbox.ts`, tópicos/replies, `connectors/*`, leitores GitHub/Calendar, `control.ts`, `followups.ts`. Testes: `tests/assistant-conversation-clarification.test.ts` e casos nos testes existentes dos conectores.

**Interfaces:** `askOwner(task: TaskContext, question): Promise<QuestionReceipt>`; `resumeQuestion(verifiedOwnerReply): Promise<ConversationDeliveryReceipt>`; wrappers de leitura reutilizam conectores existentes. Pergunta/tarefa/revisão/topicId permanecem correlacionados.

- [ ] Testar A09: falta de dado gera pergunta; resposta posterior do dono retoma exatamente a tarefa, inclusive outro tópico; novo evento exige reavaliação; “sim” sem vínculo não autoriza efeito antigo.
- [x] Conectar ferramentas GitHub de resolução, pesquisa e leitura no SHA pertinente, com credencial somente leitura já autorizada; resposta explica a pergunta, não apenas mostra trechos.
- [x] Reutilizar Calendar com títulos e consulta de disponibilidade. Mudanças seguem autorização própria; preservar limites atuais de eventos únicos próprios/sem convidados até ampliar explicitamente o escopo.
- [x] Reutilizar missões/retornos autorizados como eventos para a mesma sessão; materializar somente tarefas atuais, sem executar backlog/FUP legado por mudança de scheduler.
- [ ] Verificar áudio/transcrição, referência a imagem/PDF pendentes e falha externa: perguntar ou informar indisponibilidade quando necessário, sem fingir interpretação não executada.
- [ ] Testar divulgação apropriada de resultado privado sem encaminhamento automático das fontes. Registrar fontes usadas, não raciocínio interno.
- [ ] Rodar testes dirigidos correspondentes e tipos; registrar limites de produto restantes e correções.

## P4 — Curador diário complementar

**Arquivos:** criar `knowledge/curator.ts`; modificar `assistant/cloudflare.ts` e ingressos/estado do curador; testes `tests/assistant-knowledge-curator.test.ts`.

**Interfaces:** `CuratorWindow { fromSequence, toSequence, day, timezone }`; `runCurator(ctx, window): Promise<CuratorReceipt>` com analisado/pending/unavailable/learned/indexing separados. Sessão privada de curadoria do dono, mesmo KnowledgeService de P1.

- [ ] Testar A08/A17: horário03:00 America/Fortaleza, resumo inicial/transição confirmada para erros/ajuda, respeito às exclusões, dois dias, interrupção e retomada, mensagem tardia, edição, derivado liberado depois; mesmo conhecimento já aprendido pelo agente imediato não duplica.
- [ ] Ler incrementalmente o arquivo com janela civil America/Fortaleza e sequência monotônica; registrar pendências antes de avançar. Permitir completar relação nova sobre material já analisado, com origem conferida.
- [ ] Agente escolhe informações/conexões úteis e usa as mesmas ferramentas; configurar improve e evidência por estágio. Não considerar execução noop ou parcial como cobertura diária completa.
- [ ] Aplicar lotes/custos/prioridade fechados na medição; consultas interativas continuam atendidas. Curador não recebe ferramentas de envio ou escrita externa.
- [ ] Testar repetir o mesmo disparo e concorrer com remember do bot/MCP; uma relação reúne suportes e uma operação incerta é reconciliada.
- [x] Só após validar e apresentar custo recorrente, configurar para03:00 America/Fortaleza o disparo nativo da plataforma para a sessão curadora. Isso é parte da implementação futura, não uma automação Codex criada agora.

## P5 — Modos de ação e migração sem perda

**Arquivos:** criar `agent-runtime/action-policy.ts`; reutilizar `telegram-approved-send.ts`, `src/assistant-approved-send.ts`, `src/approved-send-contract.ts`, `src/actions.ts`, `conversation-activity.ts`, retenção e operações de instalação. Testes: `tests/assistant-autonomous-reply.test.ts` e regressões no actuator.

**Interfaces:** `authorizeReply(ctx, intent): Promise<ReplyAuthority>` com variantes sombra/aprovação/autônoma; `executeReply(intent, authority): Promise<ActionReceipt>`. Target e identidade vêm do host; prova autônoma referencia política/mandato vigente, revisão e intenção, não hash de texto fingindo clique.

- [ ] Testar mesma decisão inteligente nos três modos, mudando somente autorização dos efeitos. Fora do escopo ou sob revogação, ferramenta não executa e agente pede ajuda quando útil.
- [ ] Reutilizar preparação, hash, CAS, uma tentativa e reconciliação Source. Repetição de ferramenta ou novo texto da mesma intenção não gera ação extra; timeout não é autorização para retry.
- [ ] Verificar no claim final mudança de conversa, resposta manual, destino, credencial, fonte e política. Grupo sempre recebe no endereço do grupo, sem DM ao autor.
- [ ] Integrar correção/retirada Cognee e contextEpoch Flue, incluindo compaction e cópias antigas; distinguir impedimento de uso, purga física e retenção de recibos mínimos.
- [ ] Planejar backups/readbacks/migrações aditivas. Ativar primeiro o novo runtime para avaliação em sombra e depois aprovação real em escopo escolhido; preservar roteamento antigo para retorno operacional sem restaurar autoridade revogada.
- [ ] Manter autopreply desligado até autorização explícita de ativação com escopo apresentado. Autorização de consultar globalmente não equivale a habilitar resposta automática.

## P6 — Aceite integrado real, observação e release

**Arquivos:** evidências sanitizadas em `docs/construcao-assistente/evidencias/`; roteiro operacional, `CHANGELOG.md`, versões/lock e documentação de instalação, somente no marco concluído.

- [x] Provar primeiro MCP do assistente→gravação de conhecimento→consulta independente do grafo→outra sessão Flue utiliza relação e original. Usar casos sintéticos antes de fontes privadas necessárias ao ensaio humano.
- [ ] Provar mensagem real→busca escolhida pela IA→sugestão útil contextualizada→aprovação real→uma tentativa Source→consequência observada no provedor. Repetir botão sem duplicar e observar descarte/silêncio apropriados.
- [ ] Provar curadoria acrescentando relação legítima e GPT consultando o resultado. Corrigir/retirar uma fonte e repetir a pergunta na sessão com histórico anterior.
- [ ] Executar carga/recuperação da amostra dimensionada acima dos limites antigos, com crescimento de conhecimento, consultas durante escrita e restauração sem perda/recobrança não autorizada.
- [ ] Somente após autorização de ativação, validar um caso autônomo permitido e um caso que pede ajuda. Avaliar qualidade longitudinal com Robson; falha técnica não é silêncio deliberado.
- [ ] Após novo código estável, executar uma CI completa do SHA final, sem suítes pesadas simultâneas; repetir apenas por mudança/falha/questão não resolvida. Builds locais não comprovam publicação.
- [ ] Revisão final adversarial, readback do código/configuração ativos, custos e limitações; encerrar issues/release por marco efetivamente aceito. Sem declarar a solução pronta por testes unitários ou ausência de erros no health.

## Condições para sair do planejamento

O dono autorizou implementar e testar com as escolhas D01–D14. A execução começa por P0 e apresenta decisões técnicas concretas antes de alterar produção. Horário, avisos e prioridade de qualidade estão definidos; a viabilidade do custo recorrente ainda exige estimativa antes da ativação. Chaves de entidade, banco, provider e protocolo ficam sob responsabilidade de engenharia e revisão independente, sem exigir que Robson audite detalhes de baixo nível.

## Revisão do plano

Revisão adversarial independente sem P1 bloqueante documental; ajustes de autenticação, reconciliação incerta e retirada antes da persistência real foram incorporados. Builder-check independente confirmou coerência entre desenho e etapas e cobertura A01–A16; A17 e a devolutiva posterior têm revisão incremental. Isso não substitui as provas técnicas de P0 nem a validação do dono.
