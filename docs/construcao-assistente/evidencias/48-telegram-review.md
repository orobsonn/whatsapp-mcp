# #48 — tópicos privados, notificações e revisão sombra

Construção na VPS em 26/10/2026, sobre a integração preservada `aaff4f3`. Esta entrega é código e teste sintético; não comprova vínculo, tópicos, entrega de Telegram nem homologação de cliente real.

## Contrato implementado

- Quatro tópicos (`Geral`, `Resumos`, `Pendências`, `Missões e retornos`) conservam os IDs retornados pelo provedor por geração, afinidade de captura e revisão do vínculo autenticado. Criação passa a `attempting` antes da chamada: resposta incerta não cria outro tópico ou alias automaticamente.
- A ferramenta autenticada `assistente_telegram_revisar` usa a mesma identidade e afinidade do MCP do dono. `topics.ensure` e `notification.dispatch` têm efeito **real no Telegram privado vinculado**; nunca enviam WhatsApp ou escrevem Calendar. O webhook autentica o segredo antes de ler o corpo e separa a fronteira estrita de callbacks do parser de mensagens de #47.
- Outbox idempotente fixa decisão/hash, destino privado, tópico e expiração. Antes da CAS são permitidas no máximo três verificações sem envio. Após `attempting`, falha/timeout/perda de ACK permanece reconciliável/incerta, sem reenvio cego. Estado agregado não promete entrega ou leitura.
- Botões de 45 bytes contêm HMAC opaco, com hashes no D1. Identidade do dono/chat/thread/message, revisão do vínculo, decisão/hash e expiração são conferidos. Rotação de qualquer credencial invalida botões e notificações preparadas; valores das credenciais ficam no Worker. Callbacks somente registram `reviewed`/`simulated`, sem autorizar outra ação ou encerrar FUP. Duplicatas recebem um recibo de duplicata, sem efeito novo.
- `DecisionJournal.admitReview` reutiliza os checks remotos e os guardas locais atuais. Uma batch insere uma atestação de uso único para a mesma decisão/hash/nonce/publicação comprometida; cada guarda local pode removê-la antes das ações. Cada ação exige a atestação e `TelegramLinkFence` atual. A atestação é removida na mesma transação, sem capability reutilizável, preservando os limites D1 de bindings/profundidade por statement.
- Bot API fixa, sem redirects, corpo limitado e prazo total de dez segundos mesmo quando fetch/stream ignora AbortSignal. Respostas físicas tardias não confirmam efeitos no banco após o prazo. Nenhum erro bruto, URL com token ou capability vai ao resultado da ferramenta. Status explicita a cobertura limitada das vinte notificações mostradas.

## Verificação e revisão

A direção foi revisada adversarialmente pelo coordenador antes da implementação. A revisão de código exigiu prazo físico cobrindo fetch+stream, exposição autenticada efetiva no MCP e indicação de truncamento; as três condições foram incorporadas, com contraprovas específicas.

Primeiro dirigido: 49/49 casos de Telegram e diário aprovados. A ampliação para autenticação de #47 e seis casos novos do diário teve quatro falhas no fixture por import ausente de `vi`; o fixture foi corrigido. Os seis casos do diário real passaram isoladamente (16,76s): dez fontes, mutação da fonte/nonce no início da batch, rollback, ACK perdido sem atestação reutilizável e retirada remota. TypeScript e diff-check aprovados. Conjunto final ampliado Telegram + autenticação + diário + MCP: **92/92 aprovados em 88,62s**, incluindo fetch/stream travados, ACK físico tardio sem reenvio e cobertura explicitamente truncada. A integração nativa será executada pelo coordenador no commit integrado.

Contraprovas cobrem callbacks com dono/chat/thread/message trocados, expiração, proposta alterada, vínculo revogado, fonte retirada na admissão, segredo rotacionado, callbacks mistos/inline/encaminhados, concorrência de dispatch, criação/envio incertos e transportes que ignoram cancelamento. O teste de binding nativo foi ampliado para a nova família, com afinidade estrangeira recusada e nenhum outbound permitido.

## Operação e limites

Migração aditiva `0021_telegram_review.sql`. Recursos próprios e segredos `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_INSTANCE` são configurados por canal privado; nenhum valor está no Git. Aplicar a migração antes de ativar callbacks. Webhook real deverá incluir `callback_query` em `allowed_updates`. O bot deve retornar o username esperado e `has_topics_enabled=true`; ausência de suporte fica como configuração pendente, sem criar fallback público/grupo.

A revalidação entre arquivo e Telegram não é uma transação distribuída: a origem remota é relida imediatamente antes da admissão local, mas uma revogação posterior pode ocorrer após a publicação. Não há promessa de revogação absoluta nem apagamento retroativo no Telegram. Instalação, vínculo humano, consentimento de notificações, quatro tópicos reais e callback no cliente continuam pendentes de #47/#56/#57. #48 não foi fechada por testes locais.

Fontes oficiais conferidas em 26/10/2026: [createForumTopic](https://core.telegram.org/bots/api#createforumtopic), [sendMessage](https://core.telegram.org/bots/api#sendmessage), [getMe / has_topics_enabled](https://core.telegram.org/bots/api#user), [CallbackQuery](https://core.telegram.org/bots/api#callbackquery), [setWebhook](https://core.telegram.org/bots/api#setwebhook). A documentação confirma capacidade; não é prova de operação deste bot.

Custo incremental de inferência: **US$0**. Nenhuma API real, recurso cloud novo, deploy, mensagem real, escrita Calendar ou alteração no Elo foi executada nestes testes. O histórico de custos anterior permanece intacto.
