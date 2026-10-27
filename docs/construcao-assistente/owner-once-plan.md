# Execução pontual Owner — plano27/10/2026

## Objetivo e autorização

Robson pediu executar um goal até validar integralmente o piloto. A engenharia é autônoma, com revisão adversarial; não há autorização para WhatsApp automático, escrita Calendar, reset financeiro ou fabricação de avaliação humana. A proposta abaixo é decisão de engenharia para obter uma decisão legítima da instalação própria e completar os callbacks da #48. Não substitui os demais contratos do PRD por um teste menor.

## Revisão adversarial e decisão

A janela de cron foi rejeitada: seleção global, extração paga antes do limite semântico e efeitos já admitidos que não são cancelados pela pausa. `fromMe` tampouco equivale a trabalho Owner em privadoattend. A admissão de bootstrap verificada atual está vinculada ao cron não pausado. Há também um ingest bruto no binding interno, mas ele não oferece a nova admissão Owner durável: não será usado como atalho. Não fingir ciclo ou mudar o ambiente para contornar isso.

Adicionar uma capability Owner nominal `owner_once.plan/advance/status`, com operador local loopback autenticado e uma admissão de bootstrap própria durável. A execução usa actorOwner/purposeowner_read fixos, âncoraowner_note e projeto explícito; reutiliza SourceAccess/OriginGuard, RetrievalRuns, Cognee, JobQueue.claimId, runtimeHost, Flue nativo e DecisionJournal. A pausa/cron globais não mudam. Nenhum SQL/URL/modelo/principal/flag arbitrário é aceito na capability.

O corpus inteiro do projeto, incluindo suportes usados, é vinculado por manifesto atual, até24originais e24.000bytesUTF-8, sujeito também ao limite de32KiB dos metadados transitórios. Esse limite pode bloquear projetos menores; não é prova de capacidade efetiva de24notas em qualquer catálogo. Esta capability inicial aceita notas textuaisOwner; outra origem no projeto bloqueia o plano, sem omitir/truncar o catálogo. Excesso, origem indisponível, alteração de versão/ACL, suporte retirado ou configuração diferente bloqueiam antes de novo efeito. O relatório diferencia owner_request real de eventos de captura: não chama nota de WhatsApp, teste controlado de observação contínua, nem proveniência estrutural de qualidade humana.

Uma segunda revisão de Occam escolheu dois recibos imutáveis no CommandLedger existente, em vez de nova tabela operacional. Plan guarda somente metadados/pins/digests/limites; admit guarda a autorização explícita do primeiro avanço. A pergunta fica no job_ledger, por enqueue deowner_request com maxAttempts1. Recibo, job e pergunta compartilham a admissão transacional: uma retirada/purge ou adição concorrente não pode deixar job órfão nem regravar pergunta após purge. Planejar não reclama, despacha ou autoriza bootstrap. Não mutar result_json para simular progresso: este deriva dos recibos de índice/busca/job/episódio/diário existentes. owner_commands permanece fora do snapshot canônico; namespaceOccupied e os guardas atuais impedem restaurar/recriar autoridade antiga. Exportação pelo MCP redige tokens internos antes de serializar/hash/chunks; os tokens duráveis não podem chegar ao modelo. Purge de qualquer original do manifesto coleta o job dependente, preservando somente o tombstone sem texto. Testes de purge/restore continuam obrigatórios, mesmo sem migração.

O fingerprint de SourceAccess.inventory NÃO é um hash opaco: contém nomes/objetivos privados. Portanto só digestsSHA256 e referências sem corpo entram no recibo. O pin estável preserva campos do original/ACL/projeto/conversa/origem/catálogo Owner e exclui somente relações e mídia derivadas, para não invalidar a própria ingestão admitida; RetrievalRuns conserva seus guards completos dos derivados usados. A igualdade transacional usa o fingerprint bruto exclusivamente em parâmetros transitórios do guard, depois de conferir o digest persistido. Não copiá-lo para result_json, logs, grant serializado ao modelo ou Git.

## Contrato e estados

- plan recebe operationId, sourceId/revisão esperada, projectId, pergunta Owner, prazo limitado e teto operacional. O prazo não ultrapassa a próxima meia-noiteUTC, e o período financeiro admitido é fixo. Confere nota privada atual, projeto, manifesto/custo/configuração/índice; salva recibo imutável com queryHash, nunca a pergunta/corpos privados no recibo. Replay do mesmo pedido recupera a mesma operação; outro conteúdo com mesmoID recusa.
- status lê estado/metadados limitados. Não inicia rede de modelo, bootstrap, fila ou nova tentativa.
- advance avança só a operação selecionada e um passo limitado. Seu recibo admit, distinto do plan, é inserido por CAS sob igualdade transacional do manifesto. Não confundir recibo admit já existente com novo latch: cada efeito usa o componente durável existente. Exige os mesmos pins, prazo e orçamento. Enqueue usaowner_request/runtimeflue e claimId, nunca claim global. Uma operação incerta só recupera recibo exato; não cria novo job/epoch/chave para repetir.
- bootstrap novo usa InitialIngestAdmission com discriminante Owner próprio, preso à operação/token/manifesto/fonte atual. O caminho de cron conserva suas condições. Estado não pristine não é apagado para fazer caber o ensaio; restauração usa apenas checkpoint compatível já verificado.
- publicação passa pelo diário normal do episódio. Sem inserir proposta, recibo de modelo ou rótulo humano porSQL. Silêncio legítimo também pode ser revisado no Telegram; não vira falso texto proposto.
- Um guard compartilhado confere conjunto atual igual ao manifesto, incluindo adição concorrente, revisões, ACL, projeto e bytes no mesmo batch de admissão. O grant atravessa as fronteiras tardias: bootstrap/ingest, broker semântico, JobQueue.runtimeGuard, callback Flue e publicação. IDs de operação não são autoridade por si; tokens internos não aparecem em status/modelo. Período/prazo/restore são revistos após awaits e antes de novos efeitos; expiração não cancela efeito físico já admitido nem libera retry.

## Fatia1 — plano/status e admissão inicial

Paths sensíveis: assistant/owner-once.ts, assistant/owner-once-guard.ts, assistant/mcp.ts, assistant/engine.ts, assistant/container.ts. Testes emtests/assistant-owner-once.test.ts e contraprovas atuais de bootstrap/retenção. Sem tabela/migração, dependência nova ou rota pública.

RED pelo entrypoint Owner existente: capability ausente/recusada para plano válido, sem falha de import/coleta. Negativos: afinidade/ator, nota/projeto estrangeiro, fonte retirada durante await/batch, catálogo25 e adição concorrente, bytesUTF-8>24k, orçamento ausente/bloqueado, prazo/configuração/diaUTC, replay conflitante. GREEN mínimo: plano/status duráveis; plan sozinho não pode bootstrap. Teste interno distingue admissão explícita do avanço; fonte/token/manifesto incorretos e discriminante trocado recusam, inclusive após reserva; cron pausado continua recusado. Purge de suporte remove o conteúdo pelos adapters existentes e invalida grant; restore não o ressuscita e tombstone/replay não reabre custo. `npm run check`, suíte dirigida e regressão de bootstrap; revisão independente antes da CI/PR.

## Fatia2 — avanço e operador

Implementar avanço no mesmo módulo e operador local autenticado, reutilizando scripts/assistant-operator-local.mjs. Integrar grant em assistant/retrieval-runs.ts, assistant/agent-runtime/runtime.ts e assistant/agent/controller.ts sem alterar a autoridade dos fluxos existentes. Expiração curta do operador, porta127.0.0.1, host/path/método fixos, recusa de Origin/Sec-Fetch, limite de corpo/resposta, token fora de argv/log público, resultados0600 e nenhum deploy do operador. Instalado Worker recebe somente o método nominal.

RED/GREEN: seleção exata não toca backlog; requisição repetida/concorrente faz um efeito; retirada entre awaits impede ingest/modelo/publicação; orçamento conserva reserved/uncertain; perda deACK e reinício recuperam a mesma operação sem retry; Flue oficial e publicação atual alcançam o diário. Testes nativos usam o bundle/DOs reais com transportes sintéticos identificados; não substituem chamada Google/Telegram/modelo real na nuvem.

## Operação real após CI

1. Reconciliar ledger atual das bases próprias conhecidas, preservandoUS$0,04incertos e teto globalUS$10. Configurar conta da geração atual de forma insert-only, com teto conservador pequeno para o ensaio; não trocar período/geração como retry.
2. Registrar projeto e notas Owner sintéticas explícitas pelo MCP; executar plano/status antes de qualquer modelo. Conferir corpus/índice/afinidade/retencão/custo. Sem copiar dados do Elo ou credenciais de outros conectores.
3. Avançar pelo operador uma única operação, com modelo econômico e recibos reais. Preservar tudo que ficar incerto; nenhuma nova operação para contornar a falha.
4. Consultar a decisão pelo MCP real e preparar uma notificação nos tópicos persistidos. Validar callbacks reais, recusa de callback velho e ausência de WhatsApp/Calendar externo. O dono pode fazer o clique quando o controle de navegador não estiver disponível; isso não autoriza fabricar avaliação de utilidade.
5. Auditoria por requisito do PRD e issues: correlacionar provas existentes de captura/naturalcron/recuperação/mídia/canais e a nova execução Owner, distinguindo qual fronteira foi de fato observada. Corrigir lacunas encontradas. Orçamento configurado não significa escala geral ou todo o backlog processado.

## Entrega e rollback

As duas fatias compõem um único marco; release minor após issue concluída, com revisão adversarial, CI no commit integrado exato, changelog/versão/tag/release consistentes. A #48 só fecha após os callbacks próprios. Globalgoal só conclui após auditoria integral, sem declarar qualidade longitudinal por fixtures.

Sem migração. Rollback de código não apaga recibos Owner, custos, tentativas, filas ou índices. A configuração principal permanece pausada, e o operador local termina/removerá sua credencial efêmera. Artefatos e notas retirados somente por APIs de retenção/autorização próprias, sem desfazer recibos.
