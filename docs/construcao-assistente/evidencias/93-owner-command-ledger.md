# #93 — comandos internos do dono

Entrega sintética local em 2026-10-25. Não prova OAuth/MCP nem operação real.

- Paths: `assistant/control.ts`, `assistant/migrations/0012_owner_commands.sql`, `tests/assistant-control.test.ts`.
- `OwnerControl(db, scope, principal, clock?).execute(command)` admite somente principal owner fornecido pelo host, separado do JSON estrito. O adapter autenticado e o binding privado pertencem ao #46.
- Comandos: `project.put`, `mandate.put`, `mandate.revoke`, `fup.put`, `fup.pause`, `fup.cancel`. `expectedVersion: 0` cria; versões positivas exigem CAS atual. Resultado é recibo de intenção em sombra, nunca confirmação de ação externa.
- Hash efetivo e resultado original persistem no mesmo D1.batch da mutação. Cada statement depende do token único admitido sob referências/versões atuais; o próprio update não invalida o gate. Replay retorna o resultado original; conflito de hash recusa. Sem REPLACE.
- Revisões de projeto ficam em tabela auxiliar, preservando o schema publicado; backfill e replay não substituem revisões existentes.
- Pausa/cancelamento/reagendamento de FUP cancela ocorrências vivas e jobs pending/processing anteriores no mesmo batch. Ledgers, recibos e verdade de jobs já concluídos permanecem. Não cria jobs nem envios.
- `captureWorkFence(db, scope, {id, kind:'follow_up'}, now?)` retorna fence ou null. Null sempre nega esse FUP, inclusive job órfão sem ocorrência. `workGuard(fence, now?)` produz predicado SQL/binds para admissão/publicação atômicas. Valida FUP latest/estado, vínculo exato, fonte atual, missão ativa quando ligada e mandato latest/ativo/vigente quando presente.
- FUP sem data fica awaiting_approval por padrão. Um fence de avaliação não transforma espera por aprovação nem ausência de mandato em delegação. Lease, política/ACL completa do pack e origem remota são guards adicionais dos consumidores #36/#44/#49.

TDD no D1 local: RED com 12 falhas de funcionalidade; GREEN 13 casos. Contraprovas adicionais RED para agendamento sem data e backfill ausente; GREEN 19/19. Revisão independente acrescentou contraprovas RED para job com fonte/revisão diferentes do FUP; o join agora exige ambas iguais e current_version não nula. GREEN final 21/21. `npm run check` passou. Cobertura: principal/payload, escopo, CAS concorrente, replay/restart/ACK perdido, retirada antes da admissão, política/projeto obsoletos, mandato revogado/expirado, rollback transacional, cancelamento preservando ledger/recibo, snapshots mutáveis, limites e WorkFence.

Limites: sem endpoint público, ferramentas MCP, vínculo de identidade de provedor novo, lifecycle de correção/exclusão de fontes ou journal inventado. As consultas do #46 precisam mostrar journal indisponível até integração do #45. Nenhuma chamada de IA, WhatsApp ou Calendar; nenhum deploy. O root revisou a implementação, exigiu as duas contraprovas adicionais e repetiu os 21 testes com sucesso; CI global verifica o commit integrado. Código, migração e testes somam 373 linhas; o restante do diff atualiza a rastreabilidade das entregas e dependências.
