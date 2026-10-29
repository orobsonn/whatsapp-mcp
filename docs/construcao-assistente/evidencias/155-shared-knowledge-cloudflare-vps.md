# Conhecimento compartilhado: Cloudflare → VPS → Cognee

Data: 2026-10-29. Dados exclusivamente sintéticos; zero chamadas de modelo ou embeddings neste ensaio.

## Percurso real

Worker isolado `assistant-native-context-proof`, versão `ddaa7cfe-d8e5-48f6-9641-aa2bfcfdc93e`, executou `KnowledgeService` com D1 real e `HttpKnowledgePort`. A chamada HTTPS autenticada passou pelo túnel até o serviço Python na VPS existente, com Cognee 1.6.5 e grafo Ladybug persistente.

O serviço tem namespace fixo; a geração do acervo é independente da geração operacional. Recibos incluem instalação, geração operacional, cliente e ID original na identidade do transporte. O endereço recusa chamadas sem credencial (401); o health autenticado identifica o acervo esperado (200). Segredos permanecem fora do Git e das ferramentas do modelo.

Onze verificações passaram:

- Relação com duas premissas conjuntas gravada no grafo nativo.
- Outra chamada, com nova instância do serviço, recuperou a relação e as duas evidências.
- Outra operação acrescentou suporte independente à mesma relação.
- A consulta mostrou as duas alternativas de suporte.
- Retirada da fonte A confirmou o recibo nativo de limpeza.
- Só o grupo independente C continuou disponível; A+B deixou de aparecer.
- Correção da fonte C confirmou a nova versão e o recibo de limpeza da anterior.
- Sem suporte atual, a relação deixou de aparecer na consulta.
- Outra chamada recuperou o recibo da mesma correção.
- A mesma chave em outra geração operacional não acessou o recibo anterior.
- Namespace diferente foi recusado explicitamente.

O recibo integral permanece no diretório privado de operação, `native-context-cf-probe/cloudflare-knowledge-service-receipt.json`; identificador sintético do ensaio: `a3bfd100-c61e-4cd8-9b00-460ae6536096`.

## Falhas encontradas na fronteira real

Os primeiros ensaios falharam. Corrigimos o vínculo do `fetch` ao runtime e o uso de `redirect: error`, que não é implementado pelo Workers. O cliente agora usa `manual` e recusa 3xx sem seguir o destino. Testes em workerd reproduzem as duas incompatibilidades, além de recibos nativos com `origin/sourceKey`.

Grupos completos de suporte são paginados sem cortar premissas ou quotes. A página nativa tem orçamento técnico de 3 MiB, abaixo dos 4 MiB do transporte; o cursor retoma as alternativas seguintes, sem limitar o tamanho do acervo. O teste nativo percorreu oito alternativas grandes e recuperou integralmente seus IDs e quotes Unicode.

## MCP e limites da evidência

O código adiciona `assistente_memoria` ao MCP existente, sob a autenticação e afinidade já usadas pela assistente. Endpoint, credenciais, namespace e cliente são fixados pelo host. O anúncio exige configuração explícita após a capacidade Own estar pronta; não foi ativado no catálogo de produção neste marco. Dezoito casos dirigidos de MCP passaram, incluindo os quatro novos casos de memória.

Este ensaio comprova armazenamento, recuperação e retirada pela infraestrutura real. Não comprova julgamento de IA, escolha espontânea de ferramenta, curadoria diária, sessões pessoais em produção ou envio autônomo. O Worker principal e suas permissões de envio permaneceram inalterados. A integração de retenção dos novos registros ainda está em execução antes da migração de produção.

Custos: nenhuma inferência paga neste ensaio. Túnel e serviço usam a conta/VPS existentes, sem contratação nova. Isso não substitui conciliação de fatura nem a estimativa recorrente antes da ativação.
