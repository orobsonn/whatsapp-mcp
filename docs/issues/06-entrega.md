# Operação, recuperação e entrega verificável

PRD: [PRD.md](../../PRD.md). Plano: [docs/09-plano-de-implementacao.md](../09-plano-de-implementacao.md).

## Entrega

Retenção/exclusão/exportação local, manutenção, manual, CI, auditoria final e release por marco.

## Aceitação

Sem ressurreição após exclusão; derivados/objetos invalidados; restore com novo epoch; CI/check/build/audit no HEAD; evidências e pendências reais separadas.

## Dependências

#1, #2, #3, #4, #5.

## Verificação

TDD nos comportamentos relevantes: observar RED, implementar mínimo, rodar suíte afetada, registrar comandos/resultado e revisão. Nenhum recurso real do Elo ou WhatsApp. Fechar só com evidência no commit entregue.
