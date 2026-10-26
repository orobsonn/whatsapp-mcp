# #112 — preservar busca semântica no callback do runtime

26/10/2026. Correção sobre a integração semântica/checkpoint preservada; não é homologação cloud nem encerramento da issue.

## Defeito e contrato

`runtimeHost` reconstruía `RetrievalRuns` sem a configuração semântica. Um episódio preparado com ranking persistido por #112 era recusado na preparação ou no callback reconstruído por `resolveRuntimeEpisode`: a configuração lexical não correspondia ao fence semântico.

O helper host-only `hostConfiguredSearch(env,purpose,clock?)` agora fixa namespace, origem, binding nominal `engineName` e modo em um único lugar. Com `COGNEE`, o padrão é `required`; `SEMANTIC_SEARCH_MODE` aceita somente `required` ou `lexical_fallback`. Modo explícito sem binding é erro de configuração. Ausência de ambos conserva o caminho lexical legado usado nas fixtures. `runtimeHost` utiliza esse helper. O gateway MCP/diário na branch de produto deverá utilizar o mesmo helper ao integrar.

Não inicia Container, não restaura índice vazio, não configura orçamento e não cria capacidade de envio. O scheduler continua responsável pelo restore/warm do checkpoint exato e pelo presearch fora da lease do episódio.

## RED/GREEN e limites

- Contraprova real em D1/workerd: fonte owner_note → inventário/ranking semântico persistido → job com subject45 → `runtimeHost.prepare`. Antes da alteração, **1 falha/1 sucesso**, com `episode_denied` na preparação; `/tmp/assistant-runtime-search-red.log`.
- Após a correção: **2/2 testes aprovados**, 10,59s; `/tmp/assistant-runtime-search-green.log`. A mesma prova passa por `resolveRuntimeEpisode` e seu `host.model`, broker/orçamento reais em D1, callback repetido usando cache, publicação e leitura `current` no diário obrigatório. O stub nominal Cognee registra um único prepare/submit; o transporte de modelo sintético registra uma única chamada e uma única reserva, apesar do callback repetido.
- A primeira tentativa de executar workerd foi recusada pelo sandbox ao abrir loopback, antes de testes. Uma execução intermediária após a correção falhou porque o adapter captura fetch na construção e o mock tinha sido instalado depois. Pode ter tentado transporte com chave literal sintética; não usou credencial real nem comprova qualidade/custo de modelo. A fixture final instala o transporte sintético antes de criar ambos os hosts.
- Configuração cobre modos inválidos, binding ausente, default required, fallback explícito e legado lexical. TypeScript e diff-check conferidos no commit entregue.

Nenhuma chamada paga autorizada, acesso a dados reais, reset de ledger cloud, envio WhatsApp ou escrita Calendar. Custo incremental de inferência real: US$0. O modelo e a qualidade Cognee são sintéticos; driver Flue nativo, cliente e homologação cloud permanecem gates da integração/#57.

A composição do produto também usa hostConfiguredSearch para obter origin/semantic no diário do gatewayMCP; o diário continua reconstruindo RetrievalRuns com a finalidade original do binding (owner_read ou automation), sem fixar uma leitura owner_read em decisões automáticas. A factory do Telegram deve seguir o mesmo contrato na integração48. Nenhuma alteração de cap ou lifecycle.
