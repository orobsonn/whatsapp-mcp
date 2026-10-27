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

## Limites e custos

Sem nova inferência paga, envio WhatsApp ou escrita Calendar. Rotinas permanecem shadow/paused; resumos Telegram automáticosfalse. O ledger histórico deUS$0,055310, incluindoUS$0,04 incertos, não foi alterado nem reinterpretado como fatura. Chamadas de infraestrutura/armazenamento seguem separadas. Google possui projeto/cliente próprios preparados e credencial local0600, mas ainda não há consentimento Calendar/refresh real configurado no Worker. Nenhuma issue é encerrada só por esta nota.
