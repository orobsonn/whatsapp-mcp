# #39 — Cognee integrado no runtime Cloudflare

O Worker/DO isolado executou extração nova e busca no Container nativo, com API real. Duas fontes sintéticas novas produziram candidatos com seus IDs, versões e hashes, sem fontes faltantes na pergunta testada. **Isso comprova a ligação de execução; não mede precisão geral nem prontidão do piloto.** [Resultado estruturado](39-cloud-runtime.json), [imagem e testes Python](39-cognee-python.json).

## O que foi exercitado

- Imagem Linux amd64/Python3.12.13 e Cognee1.6.5 com dependências por hashes; execução sem internet no Container, apenas interceptação do host fixo `broker.internal`. Chave do provedor permanece no Worker; Python recebe placeholder. Nenhum token/canal WhatsApp/Telegram/Calendar nessa imagem.
- Host relê fontes canônicas, limita candidatos/bytes e confere autorização/origem antes da operação, em cada callback e no retorno. Recibo persistente se mantém separado do índice efêmero. Erro de cleanup põe host em quarentena; não concede novo permit ao processo anterior.
- Cloud real: primeira ingestão71,65s (inclui inicialização), segunda35,17s, busca5,31s. Primeira fonte:1chunk/12relações; segunda:1chunk/13relações. São relações com provenance permitida, não prova de que todos os fatos extraídos estão corretos. O mesmo operationId da primeira ingestão retornou o recibo salvo em1,20s.
-80 recibos de modelo concluídos, incluindo checagem mínima de conectividade, ingestões e busca. Encargo conservador por tokens:1810microUSD (**US$0,00181**), não fatura. Embeddings geram várias chamadas pequenas. Duas reservas anteriores incertas somamUS$0,04 e continuam preservadas; o total autorizado desta homologação éUS$0,30, dividido em gerações sem apagar ledger.
- Após inatividade/perda do Container, novas operações retornaram `index_lost`; não cobraram novamente nem anunciaram índice vazio como pronto. A busca posterior e parada explícita preservaram os80 recibos e1810microUSD. Snapshot/restore segue na#40 e reconstrução na#91.

## Falha real encontrada e corrigida

`redirect: error` era aceito pelo fetch simulado, mas o runtime Workers rejeita essa opção antes da rede. A checagem real mínima registrou falha imediata; a contraprova com `Request` real reproduziu o TypeError. O transporte agora usa `manual` e rejeita respostas não200;302 nunca segue Location, inclusive para destino externo. Nenhum timeout foi ampliado para esconder a falha. [Contrato oficial](https://developers.cloudflare.com/workers/runtime-apis/request/).

O diagnóstico contém somente etapa, resultado enumerado, status e duração. Não inclui corpo, chave, URL fornecida por terceiro, mensagem/stack de erro ou ID do provedor. Falsos usos/JSON, corpo excessivo, erro de rede e hooks que falham foram testados. A geração anterior permanece registrada como incerta; não foi reexecutada cegamente.

## Validação e limites

11 testes Python, incluindo Cognee/Ladybug/LanceDB reais com modelos controlados e contraprovas de provenance/filtragem.23 testes do host,14 de transporte,17 do broker e3 do probe. Check TypeScript e build isolado conferidos; CI deve passar no commit integrado. Revisão adversarial do host atacou cleanup, mutabilidade, callbacks expirados e recibos tardios; defeitos encontrados foram corrigidos antes desta execução.

O índice tem capacidade inicial limitada a128versões/256aliases. Recorte completo, qualidade da linguagem, retenção e operação contínua permanecem entregas próprias; não se promove uma amostra sintética a aprovação do produto. A integração envolve Python, Worker, DO e transporte juntos porque o aceite é sua fronteira autenticada de ponta a ponta; locks gerados fixam dependências e não são código de aplicação escrito manualmente. Snapshot/rebuild e montagem de contexto foram separados em issues para manter essas responsabilidades verificáveis.
