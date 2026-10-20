# Conectar uma instância Z-API pela página privada

Implementação em 19/10/2026. Decisão do dono: informar as três credenciais no navegador privado e depois conectar o MCP ao GPT. Esta página faz a primeira conexão; não troca uma conexão ativa. Testes locais usam somente dados sintéticos. A confirmação real depende das credenciais inseridas pelo dono e da leitura do fornecedor.

## Fluxo do dono

1. Abra `/setup` no endereço desta instalação e entre com a identidade autorizada no Cloudflare Access.
2. Use uma instância dedicada a este projeto. Marque a declaração de exclusividade. Instância de Elo ou de outra integração não pode ser reaproveitada por esta página.
3. Cole ID da instância, token da instância e Client-Token. Esses valores seguem por HTTPS ao backend; a página não os reapresenta.
4. Aguarde a conferência do aparelho, callbacks e releitura. O estado ativo só aparece após essas verificações. Se ficar pendente, reabra a página e retome a mesma tentativa; não informe credenciais diferentes.
5. Após ativo, siga a orientação de conectar `/mcp` ao GPT. O link opcional `GPT_PLUGIN_URL` só aparece quando configurado. Conexão ativa no backend não prova, por si só, execução no cliente GPT.

Credenciais não devem ser enviadas por chat. A página não pareia um aparelho desconectado, não emite QR code e não substitui uma instância ativa. Callback de outra integração ou resposta incompleta do fornecedor bloqueia a tentativa antes de qualquer alteração de webhook.

## Configuração da instalação

`RUNTIME_CONFIG=database` seleciona a conexão cifrada em D1. `ENCRYPTION_KEY` é um segredo Worker em Base64 padrão com exatamente 32 bytes (44 caracteres, incluindo `=` final). Não versionar esse segredo. `PUBLIC_ORIGIN`, `INSTALLATION_EPOCH` e a identidade fixa do dono são provisionados separadamente. O servidor não aprende o dono a partir do primeiro visitante.

O segredo protege credenciais, telefone, geração e segredo do webhook por AES-GCM, com IV aleatório por gravação e AAD incluindo origem pública e epoch da instalação. Restaurar ciphertext em outra origem/epoch ou perder a chave fecha o runtime. Não há fallback às antigas credenciais ENV. `RUNTIME_CONFIG=static` só é aceito junto com `DEVELOPMENT=true`, para os testes/desenvolvimento explícitos.

`MAINTENANCE` continua sendo a chave operacional global. Setup verifica a mesma assinatura Access, issuer, audience e subject fixos mesmo durante manutenção, através de uma exceção limitada a essas rotas. MCP, consentimento OAuth e confirmação de ações mantêm suas próprias restrições.

## Persistência e recuperação

A migração `0007_connection_setup.sql` cria `connection_state`, uma única linha por instalação. O INSERT condicional impede substituir conexão ativa ou pendente com outra proposta. O payload cifrado permanece idêntico durante retomadas. Tentativas usam claim condicional, versão e lease de 120 segundos, com pausa de 30 segundos após falha antes de permitir outra retomada humana. O lease é maior que a soma dos timeouts de rede de uma execução; cada chamada tem timeout de oito segundos e cada etapa revalida o claim antes de alterar o fornecedor.

Estado pendente nunca libera o runtime. Em timeout de um PUT, a página conserva a mesma tentativa e só repete os mesmos PUTs de configuração. Essas operações não enviam mensagens; são atualizações idempotentes dos mesmos valores. Não há retry automático. Diante de callback/telefone divergente, é necessária investigação operacional; a rotação limitada do Client-Token em conexão ativa está descrita abaixo; troca de instância e reset destrutivo não são oferecidos.

Se D1 falhar, o ciphertext for inválido, a chave estiver ausente ou o epoch divergir, o runtime limpa os campos de conexão e permanece em manutenção. Os retornos públicos da página/status não incluem telefone, credenciais, URLs de webhook nem conteúdo do fornecedor. Nenhuma entrada real deve ser usada em testes ou registrada no Git.

## Contrato do fornecedor

Fontes oficiais consultadas em 19/10/2026:

- [Dados da instância: GET /me](https://developer.z-api.io/instance/me).
- [Ao receber](https://developer.z-api.io/webhooks/on-message-received).
- [Ao receber mensagens enviadas por mim](https://developer.z-api.io/webhooks/on-message-received-and-delivery).
- [Status da mensagem](https://developer.z-api.io/webhooks/on-whatsapp-message-status-changes).
- [Notificar enviadas por mim](https://developer.z-api.io/webhooks/update-notify-sent-by-me).

GET `/status` deve retornar `connected: true`; GET `/device` deve apresentar telefone numérico exato. GET `/me` deve corresponder pelo `id` à instância autenticada. Os sete callbacks opcionais são `receivedCallbackUrl`, `messageStatusCallbackUrl`, `connectedCallbackUrl`, `deliveryCallbackUrl`, `disconnectedCallbackUrl`, `presenceChatCallbackUrl`, `initialDataCallbackUrl`, e a flag `receiveCallbackSentByMe`. A resposta real em 19/10 omitiu `connectedCallbackUrl` vazio; o painel confirmou todos os callbacks visíveis vazios. Callbacks conhecidos ausentes, nulos ou vazios são tratados como desconfigurados; qualquer outro tipo ou string longa bloqueia. A flag pode faltar no preflight; se presente, deve ser boolean. A exclusividade depende de o fornecedor representar fielmente callbacks preenchidos. Campo de callback não vazio só pode ser exatamente o callback privado persistido desta tentativa. A mesma regra se aplica na retomada.

Antes dos efeitos, o backend grava o payload completo e imutável. Em seguida usa quatro PUTs fechados: `update-webhook-received`, `update-webhook-received-delivery` e `update-webhook-message-status`, cada um com `{value: callbackPrivado}`, e `update-notify-sent-by-me` com `{notifySentByMe: true}`. O endpoint `received-delivery` recebe uma URL, não um boolean; o boolean é a operação separada de notificação.

Depois, relê `/me`: recebido e status devem ser exatamente o callback desta tentativa e `receiveCallbackSentByMe` deve ser `true`. Também relê `/status` e `/device` para confirmar o mesmo aparelho. Só então o CAS final altera `pending` para `active`. A documentação do fornecedor é evidência de capacidade documentada; o teste sintético é evidência do contrato local. Não há alegação de homologação real nesta entrega.

Transporte usa apenas host fixo `api.z-api.io`, paths fechados, redirect manual com recusa de 3xx e respostas limitadas a 64 KiB. Corpo e erros remotos nunca são copiados para resposta/log da aplicação.

## Proteção do formulário

`GET /setup` e `GET /setup/status` exigem Access do dono. POST exige mesma origem literal, formulário URL-encoded de até 8 KiB, campos fechados e sem duplicatas, nonce de uso único e revisão atual da conexão. O nonce é vinculado a dono, epoch, recurso e purpose `setup`; não guarda credenciais nem conteúdo do formulário. A migração preserva os nonces anteriores ao ampliar o CHECK de purpose. O limite de 512 bytes das confirmações humanas existentes permanece intacto.

O sucesso do POST devolve 303 para `/setup`, evitando reenvio de formulário ao atualizar a página. Erros só usam mensagens locais fixas. A página não inclui scripts de terceiros, analytics ou campos de senha preenchidos pelo servidor.


## Atualizar Client-Token (v0.5.1)

Pedido do dono em 20/10/2026: trocar o Client-Token já alterado na Z-API usando a configuração privada. Em `/setup`, com conexão ativa, preencher somente **Novo Client-Token** e clicar **Atualizar Client-Token**. O campo nunca é preenchido pelo servidor. Não enviar a chave pelo chat.

A ação humana exige Access do dono, mesma origem, nonce de uso único vinculado a revisão e campos estritos. A validação usa as credenciais de instância já cifradas e o novo Client-Token somente em GET `/status` e `/device`, com os timeouts/limites existentes. O aparelho deve estar conectado e seu telefone deve ser o mesmo da instalação. Não há chamadas de configuração de webhook.

O servidor cifra novamente o payload atual alterando apenas `clientToken`. Um UPDATE condicional exige epoch, estado ativo, tentativa, versão e cipher originais; sem retorno, informa conflito. Telefone, geração, segredo do webhook, OAuth e dados de chats não mudam. A configuração continua ativa durante a validação. Token rejeitado, redirecionamento, rede, resposta inválida, aparelho diferente ou concorrência não substituem a chave salva. Chamadas já em voo podem ainda usar a chave anterior; a troca não as reinicia.

Teste RED: 12 falhas comportamentais antes do campo e função existirem; GREEN: 43 testes em conexão/setup. Inclui validação sem PUT, preservação de cipher em falhas, concorrência, formulário vencido, origem, replay, campo extra e ausência de segredo no HTML/banco de nonces. Revisão adversarial exigiu CAS e preservação do namespace; implementados.


Publicação em 20/10/2026: PR #24 integrado em `cced026f`, versão 0.5.1. 219 testes em 17 arquivos, TypeScript, build, audit e CI aprovados. Worker `f2bddc02-3e8a-4751-b975-bae2fa198542` promovido a 100%; smoke confirmou 0.5.1 sem manutenção e acesso privado protegido. Formulário ativo e vazio conferido na página real. O dono ainda precisa inserir e salvar o novo Client-Token; o agente não leu nem alterou a credencial real nesta entrega.
