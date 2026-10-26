# #46 — núcleo de comandos do dono (dados sintéticos locais)

O núcleo amplia os controladores existentes; a autenticação MCP, a afinidade do binding e consultas são entregues em arquivos separados. Nada nesta evidência comprova OAuth/RPC real, envio, execução externa ou atendimento ativo.

## RED → GREEN

- RED inicial: `npx vitest run tests/assistant-owner-core.test.ts`: 11 falhas e 1 passagem. `SourceController.execute` não existia, missão/política não eram comandos aceitos e a correção legada aceitava uma fonte WhatsApp.
- GREEN inicial dirigido: 53/53, nos arquivos `assistant-owner-core`, `assistant-sources` e `assistant-control`; `npm run check` passou.
- Contraprovas adicionais: ACK perdido na criação/correção/retirada/audiência e missão/política; concorrência e CAS; histórico e migração repetida; origens conflitantes, fonte retirada, namespace diferente e texto UTF-8 excedido. Total dirigido anterior à revisão: 59/59 (18 novos + 20 fontes + 21 controle), em workerd/D1 local. Sem chamada paga, provedor ou dados reais.
- Check final: `npm run check` passou após a correção do draft paralelo do gateway pelo integrador. `git diff --check` passou. Após formatação sem alteração de lógica, os 18 casos novos passaram novamente. A validação integrada de autenticação/RPC pertence à entrega do gateway.

## Contratos para o gateway

`sourceCommandSchema`, `SourceCommand` e `SourceCommandReceipt` são exportados por `assistant/sources.ts`. `SourceController.execute(input: unknown)` aceita somente:

- `source.create`: `operationId`, `input` com texto, origem lógica (`originKey`), atribuição, data e metadados opcionais; cria exclusivamente `owner_note`, audiência padrão `owner`. Não aceita `origin`, principal ou namespace.
- `source.correct`: `operationId`, `id`, `expectedRevision`, `text`, `occurredAt`.
- `source.change_audience`: `operationId`, `id`, `expectedRevision`, `audience`.
- `source.withdraw`: `operationId`, `id`, `expectedRevision`.

Todos devolvem `{operationId,kind,id,revision,version,shadow:true}` do recibo original. Uma segunda operação com o mesmo `originKey` e conteúdo/metadados originais aponta a revisão/versão **1/1**, mesmo depois de correção/retirada; payload diferente é recusado. O mesmo `operationId` com hash diferente é recusado no ledger compartilhado com os outros comandos.

`ownerCommandSchema`, `OwnerCommand` e `CommandReceipt` são exportados por `assistant/control.ts`. Projetos/mandatos/FUP mantêm `expectedVersion` e recibo `version`. Novos comandos:

- `mission.put`: `operationId,id,expectedRevision,objective,source:{id,revision}`, opcionais `project:{id,revision},stopCondition,state: draft|active,nextEvaluationAt`; padrão `draft`.
- `mission.set_state`: `operationId,id,expectedRevision,state: paused|resolved|cancelled`.
- `policy.put`: `operationId,id` (conversa), `expectedRevision,conversationKind: private|group`, opcionais `excluded,groupMode: ignore|observe|respond`; na criação, padrão `excluded:false,groupMode:ignore`. Em updates, `excluded` omitido preserva a flag atual em SQL. Para políticas efetivamente não excluídas, o tipo observado na origem nominal atual precisa coincidir; observação desconhecida bloqueia. Uma política legada com tipo incorreto pode ser reparada apenas quando essa observação comprova o tipo novo, sob CAS e histórico. Sem observação, só se conserva o tipo já existente; privado só aceita `ignore` no campo próprio de grupos.

`OwnerControlScope` preserva o namespace host da captura (`sourceEpoch,sourceGeneration`), obrigatório para `policy.put` e opcional para os comandos legados. Não recebe esse namespace no payload do comando. Observações de epochs/gerações antigos não decidem a política atual.

Missões/políticas retornam `revision`; tipos distinguem esse recibo dos recursos com `version`. Criar usa revisão esperada zero. Comandos não interpretam o texto citado como outra ação. Schemas são estritos e o principal é fornecido separadamente pelo adaptador autenticado.

## Atomicidade e isolamento

`assistant/command-ledger.ts` reutiliza `assistant_owner_commands` de #93. Um token novo é inserido sob as condições CAS atuais. Todas as mutações posteriores usam esse token no **mesmo** `D1.batch`; um concorrente que não inseriu seu token não repete mutações. O gate persiste depois de alterações feitas pelo próprio lote. Falha SQL reverte recibo, recurso, versão e auditoria; ACK perdido recupera o recibo original, sem refazer o efeito.

Criação de fonte resolve o ID vencedor dentro do lote para não gravar um ID candidato perdedor em corrida de aliases. Os métodos legados e comandos usam os mesmos builders SQL de criação/correção/retirada/audiência. Correção exige `origin='owner_note'` nos statements SQL, incluindo o caminho legado; retirada de captura permanece possível. Os métodos de criação legados continuam criando notas; materialização de captura mantém seu caminho confiável próprio em #70.

A migração aditiva `0016_owner_core.sql` registra snapshots imutáveis de metadados de missão/política, sem corpos de fontes. Backfill só registra a revisão existente, com data desconhecida zero; é idempotente e não fabrica o histórico anterior. UPDATE/REPLACE do histórico são recusados. Não existe API de exclusão neste núcleo; DELETE SQL não tem bloqueio incondicional, preservando a possibilidade de purge autenticada em #55. Não há promessa de retenção irrevogável de corpos/metadados.

Qualquer nova revisão de missão invalida trabalho vivo por `occurrence → FUP → mission`, com namespace em todos os vínculos. Não usa `source_id` como identidade da missão: a contraprova mantém o trabalho de uma segunda missão que usa a mesma fonte. Jobs/ocorrências terminados e ledger/recibos pagos são preservados. Pausar/cancelar continua funcionando depois de retirada da fonte. `workGuard` existente continua invalidando o fence antigo pela revisão/estado.

## Limites reais

- API interna, sem HTTP ou autenticação fabricada. O gateway deve validar principal/afinidade em cada RPC. Consulta de conteúdo WhatsApp deve combinar SourceAccess e OriginGuard atual, inclusive revogação remota ainda não materializada; este núcleo não retorna conteúdo de consulta.
- A validação de referências de comandos é local e transacional; não equivale a revalidar origem remota para uso de texto ou inferência. Os consumidores mantêm os fences próprios antes de callbacks e publicação.
- FUP sem mandato ou aguardando aprovação não ganha autorização por ser cadastrado. Nenhum comando agenda/envia ou encerra uma obrigação por inferência.
- O recibo recuperado descreve a operação original, não afirma que o recurso permanece ativo ou que houve efeito externo.
- O helper mínimo e o núcleo são uma fronteira de atomicidade; não há novo ledger financeiro, framework de provedores ou mudança no OAuth legado. Testes e SQL ficam juntos para permitir revisão dessa fronteira.

## Correções da revisão adversarial independente

A revisão encontrou dois P1s reais, reproduzidos em cinco REDs: um `expectedRevision` futuro podia aproveitar correção concorrente entre o SELECT e o batch e gravar um recibo com a versão anterior; políticas aceitavam `private` apesar de conversa `group` observada e depois impediam o reparo do tipo legado.

A admissão de fonte agora exige o `current_version` exato do snapshot usado para montar o recibo, além da revisão esperada. Os três casos de correção/audiência/retirada recusam a corrida, sem mutação ou recibo parcial; repetir após ler a versão nova retorna o recibo correto. A admissão de política compara no mesmo batch apenas a observação do epoch/generation configurado pelo host. Para política efetivamente não excluída, tipo NULL, divergente ou observação não disponível bloqueiam. Um sexto RED adicional provou o caso de kind preenchido com estado ainda desconhecido. Ausência de observação é diferente: permite cadastrar tipo explícito ou conservar tipo existente, mas não reparar um tipo diferente sem prova. O reparo autorizado atualiza `kind`, revisão e histórico juntos.

Os testes cobrem reparo legado, observação inserida entre preparação e admissão, E/G antigos contraditórios e origem não configurada. Regressão dirigida após as correções: 65/65 (24 novos + 20 fontes + 21 controle); check de tipos e diff limpo. Sem chamada paga, deploy ou alteração de gateway.

A revisão também removeu, antes de publicação, os dois triggers incondicionais BEFORE DELETE do histórico de missão/política. UPDATE/REPLACE seguem protegidos; teste local demonstra exclusão SQL possível sem expor operação de delete ao modelo ou à API. O fluxo autenticado de purge de #55 permanece fora deste escopo.

## Exclusão offline e flag preservada

Cinco novos REDs reproduziram a exclusão recusada em origem unknown/withdrawn, a desexclusão sem observação aceita e a flag omitida reativando uma política anteriormente excluída. `excluded` agora é opcional: criação omitida usa false; UPDATE omitido usa `COALESCE(?,excluded)` e mantém a decisão anterior. A exclusão efetiva é calculada dentro do CAS de admissão como `COALESCE(input,(SELECT excluded atual),0)`, sem pré-read da flag.

Somente exclusão efetiva 1 pode desviar a validação positiva de kind/acesso, permitindo revogação offline e reclassificação segura enquanto continua excluída. Namespace host E/G, revisão esperada, token único, recibo original e histórico permanecem obrigatórios. Remover uma exclusão com false exige observação nominal atual, matching e available; origem ausente, unknown, withdrawn ou divergente não serve. Política nova antes da primeira observação ainda admite tipo explícito. `groupMode:ignore` não equivale a excluir: em conversa privada, remover exclusão torna o modo attend e também exige prova atual.

A cobertura inclui flag omitida antes/depois da captura voltar, false offline negado, false matching/available permitido, repair enquanto excluído, manutenção de CAS/receipt e privado ignore≠excluded. O teste SQL de exclusão de histórico permanece separado da política de conversa; nenhuma API de purge foi adicionada.

Validação final deste delta: `npx vitest run tests/assistant-owner-core.test.ts tests/assistant-sources.test.ts tests/assistant-control.test.ts` — **71/71 GREEN** (30 novos/core + 20 fontes + 21 controle); `npm run check` GREEN; `git diff --check` limpo. Logs locais: `/tmp/assistant46-core-final-71.txt`, `/tmp/assistant46-core-final-71-check.txt`. Nenhuma alteração no gateway, deploy ou chamada paga.
