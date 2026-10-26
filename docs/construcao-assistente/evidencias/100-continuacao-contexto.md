# #100 — Continuação persistente do contexto canônico

O limite antigo de uma página foi substituído por passos persistentes. Cada página avalia até 64 fontes já autorizadas pela mesma SQL de `SourceAccess`; o manifesto guarda referências, fingerprints de autorização, escores e fences, sem copiar os originais. O resultado só entrega originais atuais depois da conferência final do inventário autorizado, das origens selecionadas e da conversa aplicável.

## Invariantes entregues

- Um `runToken` fixa o principal fornecido pelo host, namespace operacional, configuração, consulta e finalidade. `purpose` é configuração do host: `automation` por padrão; `owner_read` aceita apenas o perfil dono e não é uma autorização para automação. A autenticação na entrada MCP pertence à #46; este controlador interno não a substitui.
- Cada passo fixa IDs/fingerprints antes da avaliação. Admissão, contadores e snapshot de página são persistidos juntos. A aplicação da página, avanço do checkpoint e recibo imutável ficam no mesmo `D1.batch`, com CAS do passo, posse e lease.
- ACK perdido recupera o recibo original. Uma preparação já persistida conserva sua página, mesmo que o inventário se mova. Não recalcula outra página sob o mesmo `stepId`.
- A passagem a `ready` contém, na mesma mutação SQL, o `NOT EXISTS` de fontes atuais ainda não avaliadas. Inserção atrás da página, correção, grant, revoke, política, prova, mandato, expiração, extração, inbox, watermark ou pausa invalidam o manifesto quando aplicáveis.
- `SearchFence` fixa consulta/configuração/finalidade/checkpoint e o conjunto exato de ID, revisão, versão e hash dos originais escolhidos. O SQL guard usa um único parâmetro JSON, com SQL fixa; nenhum predicado é recebido do modelo.
- A geração nominal filtra conversas e inbox. Uma pausa de geração histórica não se mistura à conversa atual.
- `owner_read` usa uma fence interna de cobertura de materialização, distinta de `ConversationFence`. Exige origem disponível, tipo/política compatíveis, inbox aplicada e watermark suficiente. Pode ler durante pausa sem consumir nem avançar o cursor de decisões automáticas. A automação mantém a guarda de pausa #43.
- O consumidor deve executar `check` antes de inferência e publicação e compor `guard` na mutação local de publicação. Um recibo de passo é observação histórica; não representa autorização vigente. Não existe transação atômica entre o reader remoto e o D1.

## RED → GREEN e contraprovas

A suíte inicial encontrou as falhas esperadas antes do controlador. Um teste adicional reproduziu uma retomada que cobrava quatro avaliações com teto três. A correção conserva a página e persiste `waiting_context` quando o retry inteiro não cabe; a SQL também confere o saldo antes de transferir a posse.

A revisão independente reproduziu uma pausa antiga ocultando uma fonte de uma geração ativa. O teste falhou antes do filtro nominal e passou depois. A contraprova de leitura manual também falhou antes da finalidade separada: conversa pausada com mensagem nova pendente bloqueia; após `CaptureMaterializer.process` real local, a mensagem materializada entra na leitura manual, enquanto `evaluated_sequence=0`, `applied_sequence=0` e `paused=1` da automação permanecem.

Outros casos cobrem concorrência, perda de ACK na preparação e na conclusão, rollback de todo o batch final, conflito de chave/hash, reavaliação após correção/grant/revoke, fonte inserida atrás da página, inserção e mudança de relações entre leitura e batch final, prova retirada, mandato mais recente revogado, expiração pelo relógio, indisponibilidade real do reader sintético, watermark e pausa alterados sem mudar o corpo, inbox pendente antes de existir a conversa de origem, pacote adulterado e limite de bytes dos originais.

## Evidência de execução

- D1 real do workerd, dados inteiramente sintéticos: corpus com **1.105 fontes**, incluindo distratores privados e alvo tardio. A busca chega ao alvo e só informa inventário completo depois de percorrer o conjunto canônico autorizado. Nenhuma contagem privada ou ID proibido aparece no resultado.
- Página integral de **64 entradas** persistida e retomada após nova instância do controlador. Outra página de 64 com ator interlocutor executa a SQL completa, verifica máximo de parâmetros por statement `<=100` e guard final com **um bind**. Não há uma lista de 64 predicados independentes de autorização.
- Regressão dirigida `retrieval-runs + retrieval + sources + jobs`: **110/110** após a implementação final. Em seguida, duas contraprovas adicionais sem alteração de implementação: suíte `retrieval-runs` final **26/26**.
- `npm run check` e `git diff --check` passaram.
- Conferência final do integrador: **112/112** testes dirigidos passaram, incluindo as duas contraprovas finais; `check` passou no mesmo conteúdo. A revisão adversarial independente aprovou após repetir o caso de geração nominal e a leitura manual durante pausa.
- Nenhuma chamada paga, inferência real, segredo, rede externa, commit ou deploy foi executado pelo implementador nesta entrega.

O diff excede a referência de 400 linhas porque conserva juntos o controlador transacional, sua migração e as contraprovas de autorização/concorrência. Separar esses testes do mecanismo deixaria uma entrega sem seu critério verificável; a integração semântica e o episódio Flue permanecem em fronteiras próprias.

## Limites reais

Esta entrega continua o ranking lexical sobre os originais e os vínculos canônicos validados. A camada Cognee não recebe o corpus amplo: o resultado declara `engine: not_run_capacity`, com `index_capacity` e `index_missing`. O índice atual tem capacidade própria menor; esta prova não demonstra busca híbrida ou semântica sobre mil fontes, nem prova inexistência de fatos quando o índice não foi usado.

Os tetos **4.096 avaliações / 80 tentativas** incluem churn, reavaliação e recuperação de passo. São limites de segurança; não constituem uma homologação de latência, throughput ou tamanho ideal de inventário. O esgotamento produz `waiting_context`, sem truncar silenciosamente a cobertura. Originais selecionados continuam limitados a dez e 64 KiB; cada fonte tem limite de 32 KiB. RPCs de origem ficam nas páginas limitadas e nos originais selecionados, sem varrer remotamente todo o inventário.

Cobertura aqui significa o inventário canônico autorizado e materializado desta instância. Não promete todo o histórico remoto, resultados semânticos completos ou revogação atômica entre Workers. O caminho de episódio/publicação #44 ainda precisa integrar e repetir as fences no seu boundary.
