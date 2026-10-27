# Recuperação de bootstrap Owner — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admitir uma única execução nova após prova de falha anterior ao dispatch, preservando o Root expirado e seu histórico.

**Architecture:** Testemunha e manutenção nominal do Core, sob mutex e transação de storage. Novo plano/admit Owner carrega referência imutável à falha; a continuação usa a execução existente. Sem novo banco/tabela, provider ou geração.

**Tech Stack:** TypeScript, Zod, Workers/DO, D1, protocolos e orçamento existentes.

**Spec:** [owner-once-recovery-design.md](owner-once-recovery-design.md).

## Global Constraints

- Mesma instalação/geração/períodoUTC/conta/cap; teto globalUS$10 e incertezas anteriores preservados.
- Um Root anterior por linhagem, sem recuperação de recuperação; grant original permanece expirado.
- Wire mantém epoch/operationId; novo ticket vincula inputHash e autoridade novos.
- Manutenção só altera projeção vazia comprovada em transação; nenhum modelo/start/ingest nela.
- Sem WhatsApp automático, escrita Calendar, dados/segredos/código do Elo ou instalação do harness.

## Review Focus

- Um access ou receipt null também impede recuperação; não usar truthiness.
- ACK perdido após commit deve recuperar a mesma reserva; rollback não deixa arquivo/limpeza parciais.
- Quarentena em memória continua fechada após falha; mutex impede início/interleaving durante awaits.
- Guard de ausência de custo aplica-se à manutenção nova, sem bloquear suas leituras idempotentes depois de gasto legítimo.
- Corpo privado do job não pode reaparecer após purge nem atravessar resultado/arquivo Core.

### Task1 — testemunha e journal de manutenção

**Files:** criar `assistant/initial-recovery.ts`, `tests/assistant-initial-recovery.test.ts`; modificar `assistant/engine.ts`, `assistant/container.ts` e testes de bootstrap. Mover schemas iniciais para o novo módulo puro, preservando parse exato e import de tipos sem ciclo runtime.

**Interfaces:** `InitialRecoveryJournal(store,scope).witness(previousId)` retorna `{state:'available',indexEpoch,operationId,witnessHash}` ou recusa; `reserve({previousId,itemId,inputHash,operationId,witnessHash})` retorna ticket/created ou recusa. Store exige transaction/list e delete interno opcional; nenhuma RPC de key arbitrária. `CogneeEngine.reserveRecoveredInitialIngest(input,admission,recovery)` cerca o journal com mutex, processo parado e nova authority; `CogneeContainer` fornece o adapter fixo e a confirmação da imagem/geração. `EngineGuard.checkInitialRecovery` é a admissão específica na criação; replay do registro exato usa a autorização atual do novo Root sem reaplicar o gate financeiro/predecessor/pristine que a própria execução muda.

- [ ] RED: witness/reserve válidos ausentes; arquivo integral+nova reserva+mesmoepoch/opid esperados, zero efeito físico.
- [ ] GREEN mínimo: snapshot/validação, hash de witness produzido no host, uma transação de arquivo/consumo/remoções/ticket.
- [ ] Contraprovas: cada precondição da spec; corrupt/null/presença e cada prefixo global limit1; concorrência2Roots; rollback; ACK perdido; replayalterado; storesemdelete/list; mutex e quarentena em memória após falha e após replay de commit sem ACK.
- [ ] Rodar teste dirigido, tipos e revisão independente. Commit da unidade testável, sem habilitar operação até a composição.

### Task2 — nova admissão Owner e continuação

**Files:** criar `assistant/owner-once-recovery.ts`; modificar `assistant/owner-once-contract.ts`, `assistant/owner-once-guard.ts`, `assistant/owner-once.ts`, `assistant/owner-once-execution.ts`, `assistant/container.ts`; testes Owner/bootstrap/operador existentes.

**Interfaces:** comando `owner_once.recovery_plan` descrito na spec. `resolveOwnerRecoveryPlan(env,scope,command,now)` entrega campos de plano derivados do job anterior mais metadatarecovery `{previousId,previousPlanHash,previousJobHash,indexEpoch,operationId,witnessHash}` e `AccessGuard` atômico do predecessor. Nunca retorna a pergunta ao operador. `onceReceipt.recovery` opcional é estrita. `OnceExecution.ensureRecovery()` é chamado antes do gate normal quarantine/lost: lê a âncora, monta input sem expectedIndex, usa `reserveRecoveredInitialIngest`; createdtrue retorna pending, replay/reserva existente relê lifecycle e segue o bootstrap normal. Guard de manutenção valida Root novo, predecessor expirado sem recovery, job/ledger originais, testemunha e zero histórico pago na geração; guard comum continua próprio para a execução.

- [ ] RED pelo receptor Owner autenticado: plano de recuperação válido recusa hoje; replayidempotente e divergência esperados.
- [ ] GREEN: resolver predecessor/ledger e fonte atuais; SHA256 bruto de request_json (`sourceTextHash` tem a mesma codificação e limite32KiB), queryHash via bridgeHash, batch original plano/job/pergunta com guard predecessor request_hash/result_json + job pending/attempts0/lease_generation0/leaseNULL + ledger prepared/request_hash/request_json exatos, inventory/retention e zero histórico pago.
- [ ] Contraprovas: precursor ainda vivo, períodos/caps diferentes, recuperação de recuperação, custo/reserva existente, source/corpus corrigidos/retirados, actor/afinidade divergentes e purge/alteração do ledger/job/plano entre read/admissão. Testar o guard composto no D1 real, sem abreviar predicados por quotas.
- [ ] Fluxo integrado: falha boot original com zero dispatch; expire o grant original; novo Rootadmitido; manutenção sem start; reinícios/ACKperdidos; uma tentativa lógica de ingestão e uma proposta novas, original continua expirado/sem decisão. Contar recibos/reservas de todas as chamadas legítimas de modelo e provar ausência de duplicação. Forçar segundo descendente a recusar.
- [ ] Tipos, testes dirigidos/Node/bundle, revisão adversarial e CI no commit completo. Sem nova suíte pesada paralela ou repetição sem mudança/falha que a justifique.

### Task3 — execução própria, Telegram e entrega

**Files:** atualizar evidências140, plano original e ANDAMENTO; release/changelog/versão apenas no marco comprovado.

- [ ] Censo vivo das bases próprias e runtime containers/37bindings/cron/pausa; confirmar Root anterior, testemunha, mesmo período e cap600000microUSD sem reset.
- [ ] Build fresco do SHA com CIverde; uploadversão com bindings herdados e imagem preservada; inspecionar módulos/runtime antes de promover100%.
- [ ] Novo recovery_plan/admit legítimos e passos limitados; qualquer uncertain consulta o mesmo recibo. Não formar cadeia nem fabricar proposta.
- [ ] Diário MCP atual; notificação nos tópicos persistidos; callbacks reais pelo controle autorizado ou pelo dono quando a sessão não puder clicar. Sem assessment humano inventado.
- [ ] Matriz de aceite, custo, limites e revisão final. Fechar issues e publicar minor consistente somente após seus próprios gates; goal integral exige auditoria16PRD.
