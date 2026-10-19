# Transporte Z-API e ações recuperáveis

PRD: [PRD.md](../../PRD.md). Plano: [docs/09-plano-de-implementacao.md](../09-plano-de-implementacao.md).

## Entrega

Adaptador tipado, sincronização paginada e propostas imutáveis para texto/imagem/PDF/áudio individual/grupo.

## Aceitação

Host fixo e redirect recusado; claim único; autorização vinculada; timeout incerto sem retry; status conciliado; destino/arquivo/options congelados.

## Dependências

#1.

## Verificação

TDD nos comportamentos relevantes: observar RED, implementar mínimo, rodar suíte afetada, registrar comandos/resultado e revisão. Nenhum recurso real do Elo ou WhatsApp. Fechar só com evidência no commit entregue.
