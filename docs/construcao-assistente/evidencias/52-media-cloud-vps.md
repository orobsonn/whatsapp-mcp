# #52 — mídia sintética no serviço real, cache e retirada

26/10/2026. O Root concluiu um ensaio isolado de PNG, PDF textual e PDF escaneado
com leitores, parser e modelo reais na Cloudflare. Os arquivos eram sintéticos,
no fixture de captura separado; nenhum arquivo foi injetado no acervo pessoal.
Esta prova complementa o [contrato e testes locais](52-midia.md), sem declarar
#52 encerrada ou produto completo pronto para o piloto.

O [inventário público](52-media-cloud-vps.json) contém somente metadados,
booleans e hashes de 38 recibos/artefatos privados. Não contém extração bruta,
corpos, IDs de fontes/chats, nomes de pessoas reais, chaves ou contagens pessoais.
O autor desta documentação não fez chamadas remotas, leu credenciais ou executou
modelos; conferiu os arquivos locais produzidos pelo operador e os critérios da
issue. O teste real e a revisão de qualidade ocorreram antes desta documentação.

## Fronteira exercitada

A cadeia foi captura/R2 de fixture → leitores nominais → materialização canônica
→ SourceAccess/OriginGuard → MediaContext → parser PDF isolado/modelo → recibo e
artefato → leitura/replay → retirada. A D1 de mídia era nova e separada da D1,
DO, índice e ledger anteriores do laboratório. A chave existente do provedor
ficou no ambiente do laboratório; não houve transferência de plaintext pelo
operador nem inclusão de bearer Cloudflare no wrapper.

O harness privado congelado tem hash
`917198f3335e64589227f48b0de6e705fc180656f0d5b7bd676d40824408509c`.
Seu uso isolado não equivale ao bundle completo da Own executando Flue sem pausa.
A correção de scope foi integrada no código `6171513`, aprovado na
[CI 40415132411](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40415132411):
1277 gerais, 63 nativos, 4 OAuth, 9 quota e 33 instalação/operadores, tipos, builds e
zero vulnerabilidades na auditoria. Esta documentação não executou novas suítes.

## Três inferências e leituras sem repetição paga

| Caso controlado | Resultado observado | Liquidado no ledger |
| --- | --- | --- |
| PNG | Artefato com original/hash e procedência model_extraction; leitura recuperada após corrigir o scope. Nome literal permaneceu ambíguo. | 691 microUSD |
| PDF textual, duas páginas | Extração por página, negação/condição preservadas e distinção entre data antiga e proposta condicional. | 358 microUSD |
| PDF escaneado, duas páginas | Texto extraído de páginas de imagem, com cobertura e procedência de extração pelo modelo. | 3087 microUSD |

Os 26 passos fixos do journal têm ACK. Os três casos tiveram leitura positiva e
replay sem chamada nova ao provedor: counters financeiros, reservas, recibos e
artefatos permaneceram idênticos no before/after de cada replay. Cada original
conserva seu hash; o texto derivado tem hash e referência próprios, sem substituir
o original ou ganhar ACL/autoridade independente.

O PNG expôs um bug real antes desses resultados finais: a inferência já estava
complete/liquidada, mas a leitura retornava null. SourceAccess copiava campos
extras de OriginScope/BudgetScope para um fence nominal de instalação/geração.
O fix `f3aef6b` normaliza apenas esse scope; não relaxa comparação, ACL ou origem.
Os [quatro REDs/quatro GREENs locais](52-source-scope-local.json) e a CI integrada
são provas separadas. Na nuvem, o MESMO artefato pago foi relido, sem reinterpretar
PNG, novo recibo ou rekey. A observação null anterior foi preservada no histórico.

## Retirada e limites

O caso de PDF foi retirado primeiro no fixture remoto. A leitura já foi negada
ANTES de aplicar essa retirada ao canônico, demonstrando a rechecagem da origem.
Depois da materialização da retirada, o canônico também negou a leitura. Custos,
recibos e artefatos continuaram preservados. Isso não apaga cópia já enviada ao
provedor nem promete revogação instantânea distribuída.

O parser nominal real recusou uma entrada inválida sem inferência. Limites de
bytes, páginas, dimensões, schema/cobertura, deadline, uso desconhecido e ausência
de retry têm também contraprovas locais em `assistant-media.test.ts`; não foram
retestados por custo neste documento. PDF acima de quatro páginas e arquivo acima
de 2 MiB são recusados antes de reservar/chamar o modelo. Duração de áudio não é
inferida dos bytes por este adapter: ele reutiliza a transcrição já capturada e
mantém pendência quando ela não existe. Não foi exercitado ASR novo nesta nuvem.

O reader recebe referência nominal autorizada, não URL fornecida pelo modelo.
O payload de inferência é inline e tem destino fixo, sem tools/URL downloader.
Nada no texto extraído concede controle, identidade ou mandato.

## Qualidade e limites semânticos

O gold separado, preparado antes do modelo, manteve SHA-256
`3a9dfa18655f91d0a3872397795c7f87254cf96bb4b1cef7166dc1597e9405b9`.
Não foi corrigido depois da resposta nem incorporado ao prompt/nome do arquivo.
A revisão independente do ensaio conferiu negações, estrutura condicional e
instrução hostil citada permanecendo dados. Nos PDFs, a data antiga do dia 7 foi
distinguida da proposta para dia 11 dependente de teste, com cobertura das duas
páginas de cada documento.

O PNG teve ambiguidade literal Iara/lara. O critério interno de ator condicional
exato NÃO foi contado como aprovado. Esse nome não virou identidade comprovada,
relação canônica ou autorização de ação. Os demais acertos não autorizam chamar
o OCR de perfeito nem inferir qualidade universal a partir desses três arquivos.
Não houve ensaio de qualidade de áudio/ASR, CPU cloud sob todo PDF hostil ou
busca semântica universal nos derivados.

## Custos e verdade incerta preservada

Os três novos recibos estão completos/liquidados: 4136microUSD (US$0,004136), com
zero nova incerteza de inferência. O comprometimento global observado passou de
49053 para 53189 microUSD (US$0,053189), conservando 40000 microUSD incertos antigos.
Esses valores são do ledger conservador da aplicação, não fatura do provedor.
Não houve reset, aumento de teto para contornar unknown, nova chave de operação
ou segunda interpretação do PNG. Infraestrutura e fatura final são separadas.

Uma tentativa anterior de CONFIGURAÇÃO do fixture permaneceu registrada como
unknown. Readback mostrou o estado preservado; correção posterior de MIME teve
nova tentativa/ACK/readback próprios. Os dois registros permanecem no inventário.
`newUncertainMicroUsd=0` descreve as inferências novas, não apaga essa incerteza de
configuração nem os 40000 microUSD anteriores.

## Encerramento do ensaio

O laboratório voltou ao V5 exato, com seus sete bindings, mesmo DO/imagem,
checkpoint, inventário sintético, ledger 49053 e marker consumido preservados.
Foram removidos somente os quatro bindings novos de mídia e o secret novo de
captura. O fixture recuperou seus três overrides anteriores e reteve as três
credenciais novas conhecidas; nenhuma chave antiga desconhecida foi inventada.
A D1 nova, originais, recibos, artefatos e custos do ensaio foram retidos.

Os operadores/proxy locais foram encerrados e credenciais temporárias removidas.
O registro de stop exige observar recibos separadamente; ele sozinho não prova
quitação financeira. A prova de quitação aqui é o resumo final com os três
recibos complete e incerteza nova zero, separado do stop. Nada foi apagado para
fabricar estado limpo. Não houve WhatsApp, escrita Calendar ou alteração do Elo.

## Critérios da issue e fronteiras de prova

| Critério #52 | Evidência e alcance |
| --- | --- |
| ac-13.261 | PNG/PDF textual/scan reais geraram artefatos com original/hash e model_extraction; leitura/replay positivos. Nome exato do PNG permaneceu ambíguo. |
| ac-13.262 | Parser remoto recusa entrada inválida antes de inferência; bytes/páginas/dimensões e caps/deadline têm contraprovas locais. Não é ensaio universal de CPU nem nova aferição de duração/ASR. |
| ac-13.263 | Null de leitura, parsing/timeout/ACK e configuração incerta permanecem distinguíveis; correção leu o mesmo recibo pago. Os negativos de erro e pendência são também testes locais. |
| ac-13.264 | Teste local reutiliza transcript materializado com negação sem criar controle. O ensaio cloud confirmou negação/condição/injeção inerte em imagem/PDF; não foi prova de ASR/áudio real. Identidade/versão/mandato continuam gates externos ao conteúdo. |
| ac-13.265 | Reader nominal e payload inline não aceitam URL arbitrária; teste local confere endpoint fixo, ausência de tools/file_url e recusa de redirect. O wrapper não acrescenta downloader genérico. |

Restam CI/integração/release da entrega documental e aceite final do coordenador,
além de canais, produto integrado e homologação do piloto. Esta prova isolada
não habilitou processamento contínuo de mídia, resumos ou ações reais.
