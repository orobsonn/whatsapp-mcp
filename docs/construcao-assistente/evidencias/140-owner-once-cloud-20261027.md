# #140 — execução Owner própria: publicação real e revisão Telegram em homologação

## Resultado atual — publicação real, 27/10 às19:57UTC

Estado posterior dos canais: a versão própria `1358e34e-6d0e-4a5d-a270-f8b200f8c76c` conserva o código49cb077 e acrescenta somente a allowlist GitHub pública, sem token. Foram conferidos38bindings (37anteriores preservados), cinco módulos, runtime/imagem/cron/pausa/exposição. README, duas páginas da raiz e recusa de repositório desconhecido foram observados pelo MCP. Calendar próprio voltou a responder somente leitura. A [auditoria dos canais](piloto-canais-proprios-20261027.md) conserva a falha inicial de listagem e seus limites. A nota administrativa criada depois dos cliques altera o catálogo: a decisão histórica agora retorna `freshness=stale`, sem invalidar os recibos da revisão feita quando estava atual e sem renovar sua autoridade.

Atualização posterior: os quatro callbacks foram registrados pelo navegador autenticado, duas revisões e duas aprovações simuladas, com quatro respostas confirmadas. Um único clique em botão já consumido, ainda dentro da validade e com decisão atual, produziu um POST correlacionado ao webhook e conservou integralmente os quatro recibos/estados, sem novo efeito. A [evidência #48](48-telegram-review.md) distingue essa prova comportamental do corpo de resposta não observado. As releases e o encerramento das issues continuam gates separados; nenhuma avaliação humana foi fabricada.

O commit `49cb0776309352608b2296b1f599e070d2fd08f7` passou na [CI40568801365](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40568801365):1.508gerais,66nativos,13OAuth, checksNode, tipos, dois builds e audit sem vulnerabilidades. A versão própria `1eaadf4c-ac76-4e53-8c33-29bdaf5adf62` foi promovida após comparação dos cinco módulos,37bindings e runtime completo, preservando imagem, cron, pausa e exposição.

A restauração real confirmou o checkpoint das duas notas técnicas, conservando epoch/revision/fontes e o financeiro integral. O operador temporário e seu token foram removidos. A regressão seguinte atravessou a busca semântica e executou Flue nativo, mas o modelo juntou trechos não contíguos com reticências em uma citação. O verificador recusou a proposta antes da publicação. O recibo pago ficou completo/liquidado, e o episódio/tentativa incertos foram conservados. Não se editou a resposta, removeu citação ou relaxou a validação para obter sucesso.

Após revisão adversarial, um único caso positivo foi definido antes da execução: pedir a frase literal das mesmas notas que distingue homologação técnica de avaliação humana de utilidade. Esse caso atravessou plano/admissão, restauração, busca, semântica obrigatória e Flue nativo, chegando ao diário normal com `phase=proposed`, `freshness=current`, origem/revisão/versão/hash conferidos e citação literal. O operador terminou normalmente e removeu seu processo/configuração local. Não houve proposta, recibo ou avaliação humana inseridos por SQL.

O MCP autenticado preparou e enviou uma notificação dessa decisão em cada um dos quatro tópicos privados existentes. Os quatro retornaram `sent`, com uma única tentativa de envio por notificação; o primeiro status relido confirmou quatro revisões ainda `pending`, e os cliques posteriores completaram a revisão técnica descrita acima. `sent` é o recibo observado, sem alegação de leitura humana. Revisão final e publicação das releases continuam gates; #140 e #48 permanecem abertas.

O censo20:05:35UTC confirmou61.701microUSD (US$0,061701) comprometidos nos ledgers conhecidos:40.000incertos históricos,3.000em duas reservas anteriores e3.391liquidados na instalação própria em167recibos. Não se apagou reserva, alterou período ou ampliou o teto para repetir tentativa. Infraestrutura e fatura permanecem separadas. Calendar próprio respondeu somente leitura; GitHub próprio ainda requer allowlist. Pausa/sombra e ausência de WhatsApp automático/Calendar write foram preservadas.

O resultado prova uma jornada técnica do corpus controlado de duas notas/964bytes, incluindo uma falha real de qualidade recusada. Não prova todo o acervo, recuperação geral entre projetos, benefício humano ou observação contínua. As seções seguintes conservam a cronologia e o estado conhecido em cada etapa.

## Causa reproduzida — ordenação do catálogo na composição SQL

A [CI40564265599](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40564265599) aprovou `c468372f95b0c6ac783734a61d85b34131a3383f`:1.502gerais,66nativos,13OAuth, checksNode, tipos, builds e audit sem vulnerabilidades. A versão própria `91dd095a-d8cc-482d-8894-b8018d5d24c4` preservou os cinco módulos,37bindings, imagem, cron, pausa e exposição.

Uma restauração explícita do checkpoint de duas notas confirmou os mesmos epoch/revision/fontes, processo ativo e ausência de busy/quarentena/manutenção/lost. A comparação integral de contas,163reservas liquidadas/recibos e uma reserva pendente conservou o mesmo SHA256, sem chamada paga nova. O operador temporário foi removido com ACK/404 e sua credencial foi apagada.

Um caso separado sobre os limites da avaliação técnica parou na busca. O diagnóstico capturou `predicate_no_row`,1.314ms: o preparo passou, não houve erro de compilação/batch e a condição final não admitiu recibo. Permaneceram163recibos completos/2.578microUSD liquidados e, agora, duas reservas de1.500microUSD. Não se repetiu a busca, liberou reserva ou reclassificou Root antigo. O tail remoto foi removido e seu processo local encerrado. A configuração de réplicas D1 foi conferida como desabilitada.

A contraprova local tornou os IDs das duas notas determinísticos. Uma fonte e duas fontes em ordem crescente passaram; duas inseridas na ordem inversa falharam tanto para chat quanto embeddings, com a mesma recusa anterior ao adapter. O SELECT correspondente ao INSERT retornou zero, embora ACL e guard Owner/cobertura isolados fossem verdadeiros. Isso excluiu conflito de recibo e reproduziu a falha sem rede/modelo real.

O catálogo ordenava os IDs na CTE, mas não a entrada do agregado JSON após os joins. A composição alterava sua ordem e invalidava a comparação integral de fingerprints. A correção acrescenta `ORDER BY s.id` no próprio `json_group_array`, preservando campos, joins, limite17, filtros e guards. A [documentação SQLite](https://www.sqlite.org/lang_aggfunc.html) define essa ordenação; uma consulta somente leitura no D1 próprio retornou `[[1],[2]]`, confirmando sintaxe e shape, sem escrita ou presunção de versão.

Os sete casos passaram após a correção, incluindo shape JSON/canonização, reuso de recibo completo sem novo adapter, retirada da âncora e alteração de suporte após prepare: esta última continua negada e conserva sua reserva. Passaram188casos dirigidos e tipos. Revisão final, CI exata, implantação e nova homologação cloud desse delta continuam gates separados. Manifestos anteriores que divergirem permanecem inválidos; nenhum fingerprint, recibo, busca ou prazo antigo será reescrito para recuperar autoridade.

#140/#48 continuam abertas. Ainda não há decisão/proposta, episódio ou notificação Telegram desse ensaio. WhatsApp automático e Calendar write continuam indisponíveis. As seções seguintes preservam a cronologia.

O censo19:23:34UTC confirmou60.888microUSD (US$0,060888) comprometidos nos ledgers conhecidos, incluindo40.000incertos históricos e3.000reservados nos dois casos. Infraestrutura/fatura permanecem separadas. A revisão final do delta não encontrou P1/P2; o gate seguinte é a CI do commit exato.

## Estado atual — checkpoint real e recusa semântica, 27/10 às18:47UTC

O delta `0d9fd49f5a34c223df33e9442261f230735af170` passou na [CI40556227822](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40556227822):1.492gerais,65nativos,13OAuth, checksNode, tipos, dois builds e audit sem vulnerabilidades. Foi implantado na versão própria `c50528a8-e83d-4390-a205-a291c4543250`, com cinco módulos conferidos e37bindings/imagem/cron/pausa/exposição preservados.

O rebuild existente em `replay_only` reconstruiu a primeira nota exclusivamente de recibos completos e confirmou checkpoint. Censo posterior permaneceu72recibos/72reservas liquidadas em1.252microUSD, sem chamada paga nova nesse rebuild. O operador temporário foi removido, com ACK e consulta404, e sua credencial local foi apagada. Não houve renovação do Root expirado.

Um segundo caso técnico distinto, identificado como registro do agente e sem avaliação humana, foi admitido com prazo próprio imutável. A sequência real restaurou o checkpoint anterior após parada, ingeriu a segunda nota e confirmou seu checkpoint antes de retornar `indexed`. Portanto, a correção de continuidade entreRPCs foi exercitada na instalação real. O corpus controlado contém duas notas técnicas/964bytes; isso não representa todo o arquivo pessoal.

A busca semântica seguinte recusou antes de publicar proposta: `semantic_uncertain`, seguido de `index_maintenance_required`. Há163recibos completos/163reservas liquidadas em2.578microUSD e uma reserva adicional de1.500microUSD, sem recibo correspondente observado. Essa reserva e a tentativa de busca permanecem preservadas, sem repetição, limpeza ou troca de chave para obter sucesso. Não existe episódio ou decisão deste caso, nem nova notificação Telegram.

O diagnóstico somente leitura confirmou `checkProof=true`, compilou o INSERT exato via `EXPLAIN` e observou os predicados de cobertura/RootSQL isolados e combinados verdadeiros no snapshot consultado. Isso descarta a hipótese de limite de binds/profundidade SQL para este caso. Não reconstitui a admissão original: o permit já foi revogado, o prazo expirou e a configuração completa não foi extraída de bindings secretos. Holds, gates, snapshots e restores atuais estavam vazios; não há timestamp de reserva nem prova histórica de ausência de hold transitório.

O próximo delta é diagnóstico, sem relaxar guards: códigos estáticos da etapa de recusa e tempo decorrido, sem conteúdo, SQL, identificadores ou erro bruto. A revisão adversarial também exige distinguir tempo/período de configuração Owner sem alterar a mensagem de erro ou a ordem das verificações. A causa da recusa permanece não comprovada; instrumentação local não equivale a correção homologada.

Esse delta passou localmente em111testes dirigidos e tipos. Os novos testes reproduziram primeiro a ausência dos códigos e a ambiguidade tempo/configuração; também verificam reserva conservada, zero chamada ao adapter e isolamento de falha do logger. A CI exata e a implantação continuam gates separados.

O censo18:47:07UTC registra59.388microUSD (US$0,059388) comprometidos nos ledgers conhecidos, incluindo40.000incertos históricos e1.500reservados no novo caso. Infraestrutura/fatura continuam separadas. #140/#48 permanecem abertas; faltam decisão atual e callbacks reais nos quatro tópicos privados. Os registros abaixo são cronológicos e conservam os resultados conhecidos em cada etapa.

27/10/2026. O código `335d6d3abc029f61e9b3be91ab52081f4f5ea541` passou na [CI40531323462](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40531323462) e foi implantado no Worker próprio. Os cinco módulos instalados foram comparados com o build; 37 bindings, cron e exposição foram preservados. O primeiro readback recusou uma mudança automática em `annotations.workers/triggered_by`; a reconciliação somente de leitura confirmou que era a única diferença de settings, sem repetir upload.

## Fronteira real observada

- O MCP autenticado criou um projeto e uma nota de homologação técnica, identificada como registro do agente. Não se atribuiu avaliação humana ao dono.
- O operador loopback chamou o serviço Owner realmente implantado. Consulta anterior ao plano confirmou afinidade e ausência da operação; plano e admissão retornaram sucesso para uma única nota de 471 bytes, mantendo pausa e sem tocar o backlog geral.
- O avanço de processamento retornou `uncertain/index/ingestion_unconfirmed`. O slot D1 permaneceu incerto; consulta posterior observou `index_maintenance_required`. Não houve nova tentativa, troca de chave/epoch/geração nem alteração de recibos para obter sucesso.
- A observação D1 dessa geração não encontrou reservas de modelo, recibos de modelo ou episódios. Isso não prova, por si só, ausência de ingestão física. A operação conserva o prazo original, que expirou sem publicação de decisão.

## Configuração encontrada e correção operacional

O mapa `resources.script_runtime.containers` estava ausente na versão do ensaio e também na versão anterior produzida pela atualização de secrets do Calendar. Uma versão histórica verificada conservava o alias `cognee`, apontando para a imagem imutável já utilizada. Conferir apenas settings/bindings não detectou essa lacuna. A aplicação nominal existia e sua listagem de instâncias estava vazia; isso também não substitui o mapa de imagens do runtime.

A restauração preservou o mesmo código e digest da imagem, sem tocar no estado do Core. O upload de versão foi inspecionado antes de promover100%: mesmos 37 bindings, mesmo etag de código e mapa de containers histórico exato. O readback após promoção confirmou os cinco módulos, cron e exposição. As falhas anteriores de upload multipart e de comparação da anotação da plataforma foram preservadas e reconciliadas; não se repetiu uma tentativa de modelo.

A configuração corrigida não reabre o slot incerto nem estende o grant. O diagnóstico é somente leitura: snapshot durável atômico de ticket/index/access/receipt/active, com ausência e corrupção distintas, vínculo ao mesmo Root e geração atual. O indicador de imagem descreve a configuração presente; a versão original continua sendo a prova histórica.

O commit `f0e32ad95161dad786e0311a396a04b03c7b3d74` passou na [CI40538028510](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40538028510):1.442gerais,13OAuth e65runtime, mais Node/tipos/builds/audit. Build fresco do SHA foi enviado como versão; módulos, runtime/containers e37bindings foram conferidos antes de promover100%. Cron/exposição permaneceram iguais; nenhuma escrita no Core foi feita pela publicação.

A inspeção real do mesmo Root expirado observou imagem atual configurada, active ausente, índice na mesma epoch com revisionempty/zero fontes/losttrue e ticket inicialuncertain, sem access ou receipt para aquela operação. O comprovante privado tem SHA256 `fa787f80df8d494ec7e9c7d63be1adee24054e0b0eed65080235dc0c935e6bf5`. A fonte335 examinada persiste access antes de habilitar o dispatch e não oferece remoção desses registros nas APIs auditadas; o namespace/histórico externo deste ensaio foram conferidos. Isso sustenta a conclusão limitada de falha anterior à habilitação de `/ingest`, sem reclassificar/gravar sucesso retroativo. A recuperação ainda exige [contrato próprio](../owner-once-recovery-design.md); a inspeção não concede nova execução.

## Recuperação e ingestão reais após CI69e

O commit `69e2f7e2208ebb0b46a8e4677c75247b15b01f15` passou na [CI40548158889](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40548158889):1.489gerais,13OAuth,65nativos, checksNode, tipos, builds e audit sem vulnerabilidades. O upload versionado foi comparado por módulos/runtime antes da promoção100%, preservando imagem,37bindings, cron, pausa e exposição. A inspeção do Root antigo produziu o mesmo comprovante anterior, sem alterar sua expiração ou estado.

A nova admissão de recuperação foi aceita pelo serviço real. A manutenção retornou `pending/recovery_reserved`, arquivando a falha anterior e conservando epoch/wire. O passo seguinte completou a ingestão da nota técnica de471bytes e retornou `pending/indexed`. Os72recibos de modelo e72reservas correspondentes ficaram completos/liquidados em1.252microUSD; o slot novo ficou completo e o antigo permaneceu incerto. Essa contagem representa as chamadas legítimas da única ingestão lógica, não72tentativas de ingestão.

O próximo passo recusou `compatible_checkpoint_required`: o índice canônico tinha fontes completas, mas o processo estava parado e nenhum checkpoint tinha sido criado. A API da instância observou running em17:48:29UTC e stopped em17:51:55UTC. Isso prova a parada, não sua causa precisa. A [API oficial](https://developers.cloudflare.com/containers/api/durable-object-container/#setinactivitytimeout) também esclarece que o timeout pertence à instância do DO e deve ser rearmado após seu reinício; o construtor anterior não fazia isso. Além dessa lacuna, retornar ao operador antes de checkpoint deixava a projeção exposta a pausas legítimas entreRPCs.

A correção local rearma60s somente quando o processo já está ativo, sem start, ingestão, modelo ou escrita de storage. O avanço usa lifecycle fresco e epoch/revision exatos do recibo, revalida o Root e confirma checkpoint antes de anunciar `indexed`. Perda de ACK mantém slot completo e retorna fasecheckpoint incerta; a continuação consulta o mesmo resultado. Os19casos de bootstrap passaram, incluindo perda de filesystem entreRPCs com restore e uma única decisão, e ACK perdido após checkpoint comprometido. Tipos passaram. Revisão final/CI/implantação desse delta continuam gates separados.

O prazo do Root recuperado permanece original; não se renova nem cria descendente para contorná-lo. A projeção poderá ser reparada pelo rebuild existente em `replay_only`: cache ausente recusa sem adapter/reserva nova. Nenhum rebuild real foi executado nesta etapa, nenhuma proposta foi publicada e não houve notificação Telegram.

O censo17:54:11UTC registrou56.562microUSD comprometidos globalmente,40.000incertos históricos e1.252novos liquidados. Infraestrutura permanece fora desse ledger. #140/#48 continuam abertas.

Antes da implantação69e, a revisão independente verificou CAS do predecessor, SHA256 bruto do ledger, unicidade de plano por linhagem, período/cap fixos e separação entre gate financeiro de criação e replay após gasto. Uma omissão nos scans globais do replay reservado foi corrigida antes da composição. Passaram120casos dirigidos; após o CAS de planos irmãos passaram14casos de recuperação e o integrado, além de tipos/build/6checks do operador. Essas provas sintéticas antecedem a CI e a ingestão real descritas acima; não demonstram por si só operação Telegram.

## Gates restantes e custos

#140 permanece aberta: ainda falta decisão cloud atual pelo diário normal. #48 continua dependente de notificação e callbacks reais nos tópicos privados. Nenhuma proposta, recibo de modelo ou assessment humano foi inserido por SQL. Não houve WhatsApp automático ou escrita Calendar.

O censo das bases próprias conhecidas anterior ao ensaio registrou 55.310microUSD comprometidos, incluindo40.000incertos; a geração própria continuou sem reservas de modelo na observação da falha. Conta/teto/histórico não foram reconfigurados. Infraestrutura e fatura permanecem separados do ledger de inferência. Não se declara prontidão integral ou qualidade longitudinal.
