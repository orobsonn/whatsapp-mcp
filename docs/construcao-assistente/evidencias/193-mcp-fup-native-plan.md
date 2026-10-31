# FUP MCP no agendador nativo — plano de implementação

> Execução: superpowers:writing-plans e superpowers:executing-plans. Implementação nesta sessão, com TDD e revisão adversarial final.

**Objetivo:** o cadastro autenticado de FUP com data pelo MCP deve produzir retorno privado ao dono no agendador já ativo.

**Arquitetura:** o service binding exclusivo `OwnerAssistant.control` deriva uma inscrição nominal do dono autenticado. A inscrição é gravada na mesma transação do FUP e seu recibo. Fonte é suporte revogável; a autoridade é a capability autenticada, nunca o conteúdo da nota. Sem novo motor, migração, payload de autoridade, adoção em massa ou envio WhatsApp.

**Stack:** TypeScript, Workers service bindings, D1, runtime Flue nativo existente.

## Invariantes e revisão

- Inscrição gerada no host, com tipo mission/follow_up correspondente ao comando; nunca parâmetro MCP.
- Vínculo Telegram, ativação, sessão existente, fonte atual e retenção conferidos e protegidos no mesmo ledger.
- Modo nativo ativo com pausa, vínculo ou sessão indisponível deve recusar antes de persistir; nenhum fallback silencioso.
- Replay não cria segunda inscrição. Versão nova invalida execução da antiga. Fonte retirada e vínculo alterado invalidam prazo pendente.
- Evento de prazo conversa somente com o dono, sem adquirir poderes de escrita administrativa ou envio a terceiros.

## Tarefa 1: cadastro e prova de execução privada

Arquivos: `assistant/mcp.ts`, novo `assistant/mcp-followup.ts`, `assistant/control.ts`, `assistant/followups.ts`, `assistant/control-errors.ts`, `assistant/agent-runtime/native-tasks.ts`, `tests/assistant-native-tasks.test.ts`.

- [x] Escrever teste via OwnerAssistant real: cadastro, binding, replay e prazo produzem evento privado na sessão existente; observar falha antes da correção.
- [x] Conferir recusa sem sessão/vínculo, pausa, corrida de vínculo/ativação/fonte/retenção, retirada posterior e reagendamento.
- [x] Derivar enrollment no host, mantendo os schemas públicos e os guards de eventos nativos atuais.
- [x] Gravar binding com o FUP na transação do ledger; expor inscrição na leitura individual.
- [x] Rodar testes de MCP, FUP e tarefas nativas, TypeScript e revisão adversarial do diff.

## Tarefa 2: entrega e prova operacional

- [x] Completar suítes e builds relevantes.
- [x] Conferir configuração privada de publicação contra bindings/variáveis atuais, preservar segredos e todos os recursos; sem migração.
- [x] Publicar somente os componentes modificados e validar código/configuração em produção.
- [x] Atualizar os dois registros existentes por revisão esperada; consultar inscrição nativa e ausência de duplicidade. Nenhum teste envia WhatsApp.
- [x] Registrar limites, release e evidências sem dados privados no Git.

Execução concluída em 31/10/2026. Evidências e fronteira de entrega em [192](192-mcp-fup-config-regression.md).
