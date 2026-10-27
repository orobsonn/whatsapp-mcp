# Homologação no cliente e Telegram — 27/10/2026

## Cliente MCP (#46)

A conexão Zap existente respondeu autenticada antes da atualização. A ação **Atualizar ferramentas** nas configurações do próprio Zap disponibilizou as sete ferramentas faltantes nesta mesma sessão: resolvedor individual e seis `assistente_*`. Não houve nova autorização OAuth nem mudança de permissões. O pacote privado continua1.0.5.

Pelas ferramentas reais do cliente foram observados: saúde da instalação em sombra/pausada; nota sintética privada criada e consultada; replay com mesmo recibo; correção de revisão1→2; correção antiga recusada; projeto criado/atualizado com CAS e versão antiga recusada; missão em rascunho e posterior cancelamento; mandato em rascunho e posterior revogação; FUP aguardando aprovação e depois cancelado; consulta do FUP com proveniência e fuso; leitura paginada do diário com `effects.mode=shadow/external=none`. Retirada da nota tornou a fonte indisponível sem desfazer os recibos. Nenhum texto recebido virou comando, mandato ativo, envio ou avaliação humana.

Uma exclusão sintética não pôde ser removida sem prova de conversa de origem disponível; a recusa foi preservada. O caso positivo de FUP usou outra fixture sintética identificada, criada para esse teste, sem referência a contato real. Projeto e políticas sintéticas permanecem como registros administrativos; missão/FUP cancelados, mandato revogado e nota retirada. Não se apresenta a listagem do diário como prova de frescor remoto integral.

## Configuração e vínculo Telegram (#47)

Credencial própria existente foi lida apenas do armazenamento privado local0600. `getMe` confirmou username exato, `is_bot=true` e suporte a tópicos privados. Inicialmente não havia webhook. Foram instalados somente três secrets no Worker próprio: token do bot, username e segredo de webhook dedicado. Readback comparou todos os26 bindings anteriores, módulos, horários e flags; permaneceram idênticos. Tokens, desafios e IDs pessoais não são publicados.

Antes da exposição, o bundle efetivamente instalado foi baixado e exercitado em workerd isolado:16 casos de ingresso passaram, zero rede externa. Hash SHA256 do módulo principal observado: `c0b494fdc4ed5bc05952f484a716a2502aa501e940a76c3e8f9f151f3818d5c7`. A inspeção confirmou `app.ts→index.ts`; o gerador Flue delega fetch ao app sem router implícito de agentes. `workers.dev` foi habilitado apenas no Worker assistente; previews continuam desabilitados. `/health` é público; `/internal/capture` conserva autenticação própria; demais caminhos continuam negados.

Nove casos públicos passaram: saúde com WhatsApp/Calendar writefalse; método/caminhos indevidos; webhook sem segredo/segredo errado; JSON inválido autenticado400; corpo autenticado acima de64KiB413; capture sem autorização403; caminhos de agentes403. `setWebhook` teve tentativa/ACK/readback privados, `max_connections=1`, updates message/callback_query e sem descarte de pendentes. Readback sem erro do provedor.

Com autorização expressa do dono para usar seu Chrome já autenticado, os dois desafios foram enviados ao mesmo chat privado do bot. O MCP observou `claimed`, emitiu B e depois confirmou `active/revision=1/affinityCurrent=true`. Isso prova vínculo real. Revogação/revínculo reais, callbacks e os demais gates da #47/#48 ainda não foram concluídos neste checkpoint.

## Falha real dos tópicos e correção (#48)

`topics.ensure` parou no preflight: quatro slotsprepared, IDsnull, contadores1 e depois2. Nenhuma criação de tópico foi admitida; não foram resetados contadores nem tentativas. O mesmo token/username respondeu corretamente ao `getMe` pelo Node, e os guards de retenção/geração estavam disponíveis. Isso sozinho não provaria a causa no Worker.

A regressão nova usa o **bundle oficial**, dois Workers/workerd, D1 migrado, Owner RPC, pareamento sintético pelo webhook e `fetch` nativo com saída interceptada exclusivamente para `getMe/createForumTopic`. O código anterior reproduziu os mesmos quatro slotsprepared. Extrair o transporte para variável local, como já feito nos clientes Z-API/conexão, fez passar: quatro IDsready, oito chamadas alternadas, segunda ensure sem nova rede. A alteração preserva effectCheck, prazo, AbortSignal, limites e erros sanitizados. Não há nova API pública ou segredo no teste.

Validação dirigida: novo nativo1/1; Telegram/auth/MCP72/72; `npm run check` e `git diff --check` passaram. Dois nativos anteriores de binding/scheduled também passaram na basev0.45.0, antes desta correção. Revisão adversarial independente não encontrou bloqueantes no diff; distinguiu a prova sintética do teste Bot API/MCP real. CI integrada do novo commit e homologação dos tópicos reais ainda são gates antes de publicar o runtime/fechar a #48.

## Atualização — correção integrada e quatro tópicos reais

O PR139 integrou `13d19981aabd42c23997c6d4d0fc847c530cc9a9` na main pelo commit `8ca9390e0b82882c013d73e80084aee8b0a0d80e`. A CI40494277416 passou com1350 testes gerais/65 nativos e todos os checks/builds/auditoria. O bundle de produção foi construído fora do Vitest; removendo somente comentários de proveniência/source-map e normalizando o nome do chunk, a única diferença funcional contra os módulos instalados foi a extração do fetcher. Os assets permaneceram equivalentes.

O endpoint oficial code-only `/content` recebeu uma tentativa e ACK. A primeira comparação detectou a anotação gerenciada pelo servidor `workers/triggered_by` mudando de secret para upload; não houve repetição do PUT. Recuperação somente leitura confirmou os três hashes novos e a preservação integral dos demais metadados,29 bindings, cinco namespaces, cron e exposição. Versão Owner observada `f4085d95-b133-4eb5-a6fa-7bc7a5c94f75`; SHA256 principal `e3adae2ee2923717f51cc8c9ed75275a124cae1610965f40e9899c7364a18601`.

Antes da terceira ensure, o MCP confirmou vínculoactive/revision1 e quatro slotsprepared/preflights2/IDsnull. A mesma operação prevista criou Geral, Resumos, Pendências e Missões e retornos: quatro slotsready, IDs persistidos e preflights3. Não houve reset/rekey, criação incerta repetida ou ativação de resumos automáticos. Callbacks reais continuam pendentes. A homologação cliente/cloud da #46 está observada; a release0.46.0 ainda depende da CI/tag do seu commit específico. Não se atribui a CI funcional ao novo commit de versão.

## Limites e custos atuais

Sem nova inferência paga, envio WhatsApp ou escrita Calendar. Rotinas permanecem shadow/paused; resumos Telegram automáticosfalse. O ledger histórico deUS$0,055310, incluindoUS$0,04 incertos, não foi alterado nem reinterpretado como fatura. Chamadas de infraestrutura/armazenamento seguem separadas. Google possui projeto/cliente próprios preparados e credencial local0600, mas ainda não há consentimento Calendar/refresh real configurado no Worker. Nenhuma issue é encerrada só por esta nota.
