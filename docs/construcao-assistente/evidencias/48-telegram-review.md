# #48 — tópicos privados, notificações e revisão sombra

## Homologação própria em27/10/2026

Os quatro botões foram exercitados pelo Chrome já autenticado, após o dono liberar o controle assistivo do macOS. A seleção conferiu bot, mensagem e texto técnico antes de cada clique. O servidor registrou duas revisões e duas aprovações simuladas, com quatro recibos distintos e `answer_state=answered`. Foram cliques do executor autorizado; não são avaliações humanas de utilidade.

Uma única repetição do botão já consumido foi feita enquanto sua expiração ainda era futura, vínculo/tópico/mensagem permaneciam iguais e o diário confirmava `freshness=current`. Um tail temporário, confirmado ativo antes do clique, observou o POST correlacionado ao webhook com HTTP200/outcomeok. A comparação integral dos quatro recibos e estados das quatro notificações, antes/depois do processamento, conservou o mesmo SHA256: sem quinto recibo, nova transição ou resposta ao callback. HTTP200 não revela o corpo `denied`: a prova real é comportamental, complementada pela condição de consumo e pelas contraprovas do código. O tail foi removido com confirmação, e seu processo local foi encerrado.

| Critério #48 | Prova e limite |
| --- | --- |
|14.221 — tópicos persistidos | Quatro IDs existentes relidos pelo MCP; uma notificação real por tópico, sem recriação. |
|14.222 — vínculo do callback | Quatro cliques reais no dono/chat/tópico/mensagem/proposta configurados; trocas de identidade/thread/message/hash/revisão/expiração são contraprovas da CI, sem induzir acesso alheio real. |
|14.223 — callback velho recusa | Botão consumido repetido uma vez, antes da expiração, com webhook correlacionado e recibos/estados integralmente iguais. Não se alega captura do corpo de resposta nem negativa por expiração real. |
|14.224 — tentativa limitada/incerto | Quatro envios reais com um preflight/tentativa cada; concorrência, timeout e ACK perdido sem reenvio têm contraprovas integradas. Não se induziu envio incerto real nem repetiu notificação. |

Aceites técnicos demonstrados nestas fronteiras; revisão final, CI do commit entregue, versão/tag/release e encerramento da issue continuam gates de publicação. A criação posterior de suporte administrativo GitHub altera o catálogo; a atualidade acima é a observada nos instantes de envio/revisão, sem renovar botões ou reescrever decisões históricas.

Permissão operacional residual: JavaScript por Eventos da Apple continua habilitado no Chrome utilizado, após a liberação de controle solicitada ao dono. As tentativas de desativação pela interface não foram confirmadas; não se declara essa preferência restaurada. O tail remoto e seu processo foram efetivamente removidos. Essa permissão do navegador não substitui autorização de envio, não cria avaliação humana e não é capacidade entregue ao Worker.

### Registro anterior ao controle do navegador

Vínculo autenticado/revisão3 e quatro tópicos persistidos foram relidos pelo cliente MCP. A [jornada Owner real](140-owner-once-cloud-20261027.md) publicou uma proposta atual com citação literal, sem inserir decisão porSQL. O cliente preparou quatro notificações com operações fixas e expiração de uma hora, uma por tópico; cada dispatch retornou `sent`. O status posterior confirmou quatro notificações enviadas com `review_state=pending`, sem truncamento e com um preflight por envio. Não houve recriação de tópico ou reenvio.

Ainda faltam os cliques reais dos botões, a recusa de clique já consumido e a conciliação dos respectivos recibos antes do aceite final. O Chrome aberto no bot foi localizado, mas recusou JavaScript por Eventos da Apple; o macOS também recusou controle assistivo. Essa indisponibilidade não foi substituída por callback fabricado. O dono foi informado do controle necessário para prosseguir pelo navegador. Os registros abaixo descrevem as provas anteriores e não constituem homologação dos cliques.

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
