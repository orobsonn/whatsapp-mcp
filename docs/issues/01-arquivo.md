# Fundação e arquivo de conversas

PRD: [PRD.md](../../PRD.md). Plano: [docs/09-plano-de-implementacao.md](../09-plano-de-implementacao.md).

## Entrega

Schema D1, tipos compartilhados, ingestão Z-API normalizada, agenda/grupos e consultas com cobertura.

## Aceitação

Namespace de conversa/participante; replay concorrente; status anterior ao corpo e monotônico; edição/tombstone; paginação limitada e isolamento.

## Dependências

Nenhuma.

## Verificação

TDD nos comportamentos relevantes: observar RED, implementar mínimo, rodar suíte afetada, registrar comandos/resultado e revisão. Nenhum recurso real do Elo ou WhatsApp. Fechar só com evidência no commit entregue.
