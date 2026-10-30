# P1 parcial — elegibilidade comum do conhecimento

A implementação adiciona finalidade `knowledge` em SourceAccess. A finalidade padrão do arquivo é preservada. O serviço novo de conhecimento deverá instanciar essa finalidade para bot, curador e MCP; esta fatia ainda não altera o roteamento do bot publicado.

- Individuais recebidas são elegíveis por padrão, com identidade de origem comprovada.
- Grupos exigem inclusão explícita; exclusão prevalece sobre inclusão.
- O mesmo predicado filtra leitura do original, inventário antes do ranking, guard e revalidação.
- Epoch/geração da origem, disponibilidade, tombstone e quarentena são respeitados.
- O comprovante de conhecimento guarda revisão da política: excluir e reincluir não revalida um trabalho antigo.
- A marca `sharingQuarantined` preserva leitura interna do dono, sem transformar autorização histórica restaurada em autorização atual de divulgação.
- Comprovantes `knowledge:owner` são distintos dos comprovantes do arquivo/legado. A publicação futura ainda depende de autoridade vigente própria.
- Parsing ou persistência que reordena propriedades não invalida um comprovante equivalente; campos alterados continuam negados.

## Verificação

55 casos dirigidos passaram, incluindo fontes e busca legadas, após reproduzir as falhas antes das correções. Tipos passaram. Revisão adversarial apontou e levou às correções de quarentena de divulgação, revisão da política e comparação independente da ordem de propriedades.

O mesmo SourceAccess de produção foi compilado no aplicativo isolado da Cloudflare, com D1 real e schema canônico, e exercitado por endpoint autenticado com dados sintéticos. Versão: `4b59dfe6-3f52-4453-bdb5-a0d22c3a9050`. Os 12 resultados foram positivos, incluindo comprovante após parsing pelo contrato real. Zero inferência paga; recibo integral privado.

## Dependências da próxima fatia

KnowledgeService deve construir a autoridade no host, conferir a instalação/epoch ativos a cada chamada e resolver evidências derivadas até originais autorizados. Uma linha de cache/índice não fabrica autorização via `fromRow`. Exclusão física/invalidação de contextos e intenções depende do registro de sessões e P5; não está entregue apenas por existir o filtro SQL.

O grafo nativo separado foi ensaiado na VPS: relação com duas fontes; leitura em novo processo; remoção da primeira mantém a relação, remoção da última a elimina; restore em outro diretório recupera as duas. Esse é um ensaio de APIs/proveniência, não ferramenta MCP publicada nem julgamento do modelo real.
