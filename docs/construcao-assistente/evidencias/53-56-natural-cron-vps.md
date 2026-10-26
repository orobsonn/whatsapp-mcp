# #53/#56 — ciclos naturais em nuvem com processamento pausado

26/10/2026. Evidência parcial do Worker próprio, obtida pelo Root após instalar
`6171513cdc461b375b81b6804a3ea9d79aec07eb`. Não encerra #53/#56/#57 nem declara
prontidão do piloto. O autor deste documento leu somente os artefatos locais,
extraindo hashes e invariantes; não acessou Cloudflare, credenciais ou modelos.

## Incidente, contraprova e correção

O [handler do bundle oficial](53-official-scheduled-runtime.md) já havia sido
corrigido e instalado. O cron real executava, mas os ciclos do código `3bffd33`
terminavam `uncertain` na fase `capture`, com `routine_operation_uncertain`.
A observação privada anterior conserva esse resultado; não foi substituída.

A causa reproduzida era uma origem cuja conversa ainda tinha `kind=NULL`:
`Conversations.ensure` corretamente não criava um frame sem tipo observado,
mas a descoberta chamava o replay mesmo sem frame e interrompia o cursor.
O fix `5dceec9`, integrado em `6171513`, conserva a origem, pula somente o frame
indisponível e publica `conversation_kind_unobserved`. Não infere tipo, acesso
ou autorização de nome/conteúdo. Depois de observação real do tipo, a origem
pode voltar ao fluxo normal; erros de replay não relacionados continuam incertos.

A [contraprova local](57-capture-kind-local.json) registra RED causal no D1 real
e 4/4 GREEN em 27,88 s: retirada como primeiro evento, paginação/wrap com tipos
ainda desconhecidos e observação posterior, erro alheio conservado como incerto
e frame legado que não fornece o tipo ainda não observado. Essa prova local é
separada da observação real abaixo; nenhum modelo foi usado para corrigir o tipo.

## Atualização de código e readback

O Root executou um único PUT de código, precedido por journal durável e seguido
de ACK com versão fixada e leitura integral dos módulos/configuração. Versão
instalada: `06ac6ec5-72fe-4688-81bd-93bc89280c13`. Main `index.js` tem 3777621 bytes,
SHA-256 `034883896f96d7b93c33443db5f9076ee64f7d5ee9f46eda820e3802ade46b3c`;
os outros dois módulos mantêm seus hashes anteriores.

Foram preservados os 26 bindings, cinco namespaces e cinco markers de secrets,
imagem/tag/runtime, exports, workers.dev/previews desabilitados e cron existente
`* * * * *`. Não houve escrita de flags, agenda, secrets ou DDL nesta atualização.
Continuam `ROUTINES_ENABLED=shadow`, `ROUTINES_PAUSED=true`,
`MEDIA_CONTEXT_ENABLED=false` e `TELEGRAM_SUMMARIES_ENABLED=false`.
Markers confirmam presença/tipo e preservação dos bindings, sem expor valores.

A [CI 40415132411](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40415132411)
da base exata `6171513` passou com 1277 testes gerais, 63 nativos, 4 OAuth, 9 quota e 33
instalação/operadores, tipos, ambos builds e auditoria sem vulnerabilidades.
A revisão independente do helper conferiu baseline, preservação, tentativa única,
ACK/unknown e transporte restrito à Own. Nenhum rollback de dados foi executado.

## Observação natural e invariantes

Duas coletas privadas posteriores leram agregados D1, sem executar modelo ou RPC
de agendamento. Pelo menos três ciclos `completed` foram observados em janelas de
minutos distintos após a instalação/readback. Não houve chamada manual a tick,
proxy de `wrangler dev` ou operador local mantendo o scheduler em execução.
A execução pertence à agenda da plataforma; a VPS serviu apenas para observar.

| Invariante conferida nos artefatos | Resultado |
| --- | --- |
| Snapshot anterior contém `uncertain/capture` | true |
| ACK e readback apontam à versão/hash exatos de `6171513` | true |
| Settings, namespaces, runtime/imagem, cron e exposição anteriores preservados | true |
| Há ciclos completos em pelo menos três minutos distintos após o readback | true |
| Há uma revisão no período UTC, ausente na observação anterior e única nas duas coletas novas | true |
| Pausa continua visível e `conversation_kind_unobserved` permanece a lacuna global esperada | true |
| Cursor da origem, stream e inbox do receptor avançaram entre as coletas | true |
| Cursor da origem não está à frente da origem nem do receptor | true |
| Sete tabelas de efeitos pagos permanecem vazias nas duas coletas | true |
| Histórico financeiro de todas as gerações da Own permanece vazio nas duas coletas | true |
| Observador chamou modelo ou RPC de scheduler | false |
| Coleta entre bancos é uma transação atômica | false |

As sete tabelas verificadas são jobs, episódios, recibos de modelo/mídia, contas
e reservas de orçamento e notificações Telegram. O resumo acima não publica
corpos, IDs de fontes/chats, participantes, nem contagens de uso pessoal.
A revisão observada é um registro de metadados do período; não é um resumo de
conteúdo gerado por modelo ou uma mensagem entregue ao Telegram.

As leituras são sequenciais. Os invariantes expressam as observações registradas,
sem prometer atomicidade entre bancos, ausência futura de falhas ou atraso máximo.
Custo incremental de inferência da Own nesta etapa: US$0. Custos de infraestrutura
e outros ensaios isolados são contabilizados separadamente; nenhum histórico de
custo ou tentativa incerta foi zerado.

## Relação com os critérios e gates restantes

| Critério | Alcance desta evidência |
| --- | --- |
| #53 ac-14.271 | Ciclos naturais distintos mantêm uma revisão do período; disputa de dois cron no mesmo período tem prova controlada em [routines](53-routines.md). |
| #53 ac-14.272 | Não houve notificação nesta configuração desabilitada. Recuperação/deduplicação de atrasos é prova local; entrega Telegram contínua não foi exercitada aqui. |
| #53 ac-14.273 | A lacuna de tipo desconhecido permanece visível. Silêncios e FUPs bloqueados têm provas locais; não houve avaliação real sem pausa nem resumo generativo neste ensaio. |
| #53 ac-14.274 | Pausa e ausência de conta de inferência estão visíveis. Budget expirado é cenário controlado separado, sem configurar uma conta real para esta observação. |
| #56 ac-16.301/302 | Build/versão e configuração instalados foram relidos; usa recursos/migrações/secrets próprios já existentes. Isso não revalida todos os canais nem substitui health funcional de cada integração. |
| #56 ac-16.303 | Cron executou na plataforma sem depender de tick ou operador local do scheduler. Não é uma prova de modelo/Flue real sem pausa. |
| #56 ac-16.304 | O update ficou restrito ao código Own; não escreveu Source/MCP, rotas, domínio ou Access e não alterou Elo. Catálogo MCP autenticado continua gate independente de #46. |
| #56 ac-16.305 | Nenhuma migração foi aplicada ou desfeita. O [runbook](../operacao.md) continua distinguindo rollback de código de recuperação de dados. |

Permanecem separados: bootstrap/ingestão/busca e extração canônica reais sem
pausa, inferência/episódio Flue cloud integrado, canais próprios e revisão do dono,
limites/cobertura e homologação completa de #57. O avanço do cursor não prova
leitura/compreensão de todas as mensagens. Esta etapa confirma a continuidade
pausada que falhava na captura, sem converter os gates restantes em sucesso.

## Hashes dos recibos privados preservados

Caminhos relativos a `local/assistant-build/personal-shadow-stage/`; os arquivos
originais permanecem privados/ignorados. Somente seus hashes são publicados.

| Artefato | SHA-256 |
| --- | --- |
| `capture-observations/after-own-cron-3.private.json` | `0aeb73bbe3fdef5a4dbaaa8e4f686331a329ebc5deb3fe10e0d566b0330d528d` |
| `build-6171513-v1/build-receipt.private.json` | `ad978a852ce7f0a365f1ed7a39dacd80c96b3a1fa6e601530937d98991eb8687` |
| `own-bootstrap-6171513-v1/code-attempt.private.json` | `86df64ef3d85d8b00ece27641c88c9374b5d0a5a28d770836b464413af5064d8` |
| `own-bootstrap-6171513-v1/code-ack.private.json` | `19b0c41d2842ec00646839a5c0153150fab38e335ca33c3b537b07d00b9e13c9` |
| `own-bootstrap-6171513-v1/code-verified.private.json` | `68037f041256d032cc1d8f8be26625c13821fc6d3dfe781083850efb57bae6d8` |
| `capture-observations/after-617-cron-1.private.json` | `3b980b079ed238b8ae85e5dcacaa77870a4ec854c0a1ae1ae01406ada23e20f3` |
| `capture-observations/after-617-cron-2.private.json` | `0c1b1884a6cd09f964050d29d2ab2bf796b262eae103bd9d8eb20a5506bf373a` |
