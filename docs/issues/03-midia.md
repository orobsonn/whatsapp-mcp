# Mídia privada e áudio sob demanda

PRD: [PRD.md](../../PRD.md). Plano: [docs/09-plano-de-implementacao.md](../09-plano-de-implementacao.md).

## Entrega

Upload/download privado bounded, hash, autorização por referência e transcrição opt-in com derivados separados.

## Aceitação

SSRF/redirect/MIME/tamanho recusados; R2 privado; fence por versão/geração/exclusão; áudio original preservado; sem processamento em massa.

## Dependências

#1.

## Verificação

TDD nos comportamentos relevantes: observar RED, implementar mínimo, rodar suíte afetada, registrar comandos/resultado e revisão. Nenhum recurso real do Elo ou WhatsApp. Fechar só com evidência no commit entregue.
