# OAuth do dono e confirmação humana

PRD: [PRD.md](../../PRD.md). Plano: [docs/09-plano-de-implementacao.md](../09-plano-de-implementacao.md).

## Entrega

MCP OAuth, validação Cloudflare Access, consentimento e confirmação vinculada em página autenticada.

## Aceitação

issuer/audience/subject; CSRF/origin; GET sem efeito; bearer MCP não aprova; epoch e manutenção; sem segredos em logs/saída.

## Dependências

#1, #2.

## Verificação

TDD nos comportamentos relevantes: observar RED, implementar mínimo, rodar suíte afetada, registrar comandos/resultado e revisão. Nenhum recurso real do Elo ou WhatsApp. Fechar só com evidência no commit entregue.
