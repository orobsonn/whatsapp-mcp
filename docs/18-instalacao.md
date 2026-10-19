# Instalação e ativação

O código é próprio deste projeto. O Elo não precisa ser alterado. Esta entrega foi validada localmente com dados sintéticos; ainda não existe instância Z-API separada. Ativar é uma etapa posterior, solicitada pelo dono, com recursos e segredos próprios.

## Conferir sem conectar WhatsApp

Node 22 ou posterior:

```sh
npx --yes npm@11 ci
npm run check
npm test
npm run build
npm run db:local
npm run dev -- --local --port 8787
```

Em outro terminal:

```sh
node scripts/smoke.mjs http://localhost:8787
```

O smoke deve indicar a versão do package.json, manutenção ativa e recusa de arquivo privado. Nenhuma chamada Z-API/IA é necessária. O npm 10.9.7 instalado nesta máquina falhou no resolvedor de peers (`edgesOut`); npm 11 instalou e auditou normalmente. CI usa npm 11 explicitamente.

## O que será necessário para ativar

1. Uma instância Z-API diferente da demonstração do Elo, pareada pelo dono, com um grupo e contato de teste autorizados. Não reaproveitar tokens, filtros, dados ou webhook do Elo.
2. Um Worker, D1, bucket privado R2 e namespace KV novos/exclusivos. Alterar os IDs placeholders de `wrangler.jsonc` pelos novos recursos. Aplicar migrations com `npx wrangler d1 migrations apply DB --remote` somente no banco novo confirmado; local usa `--local`.
3. Uma origem HTTPS estável em `PUBLIC_ORIGIN`, com rota própria do Worker. `workers_dev` e previews estão desabilitados para impedir um segundo endereço de acesso acidental.
4. Aplicação Cloudflare Access com login do dono apenas em `/authorize`, `/confirm/*`, `/upload/*` e `/media/*`. `/mcp`, `/.well-known/*`, `/oauth/*`, `/webhook/*` e `/health` precisam chegar ao Worker: o MCP usa OAuth, e webhook tem autenticação separada. Não pôr OTP na frente do callback do fornecedor.
5. Preencher `ACCESS_ISSUER` com a origem exata `https://<equipe>.cloudflareaccess.com`, `ACCESS_AUD` com a audience da aplicação e `OWNER_SUB` com o subject do dono verificado no JWT Access. Não descobrir/registrar o primeiro usuário como dono. Login é validado por assinatura/JWKS, issuer, audience, subject e expiração.
6. Definir `INSTALLATION_EPOCH` e `CONNECTION_GENERATION` novos, aleatórios e não `unconfigured`, fora dos snapshots D1. `CONNECTED_PHONE` é o identificador exato retornado por `/device` da instância nova. Deve coincidir com callbacks e preflight.
7. Instalar segredos com `npx wrangler secret put NOME`: `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN` e `WEBHOOK_SECRET` aleatório com pelo menos 24 caracteres. Nunca colar valores no chat, PR ou Git. O callback contém segredo na URL; desabilitar logs de URL/payload e não compartilhar essa URL com o modelo.
8. Configurar no fornecedor os callbacks de recebimento e status para `PUBLIC_ORIGIN/webhook/CONNECTION_GENERATION/WEBHOOK_SECRET`. Habilitar notificações próprias apenas nessa instância e testar telefone, Web e API separadamente. A URL é uma capacidade secreta, não assinatura criptográfica do corpo. O Worker também confere instância/aparelho/geração.
9. `MEDIA_HOSTS`: allowlist de hosts HTTPS exatos do fornecedor, confirmados por ensaio. Nunca wildcard, IP, host controlado por remetente ou usuário. Redirects são recusados e tokens da API não acompanham mídia. Provar o caminho real de download antes de liberar captura de arquivos.
10. Manter `TRANSCRIPTION_ENABLED=false` até o dono escolher Workers AI como processador. Para habilitar, adicionar `"ai": { "binding": "AI" }` na configuração e definir `TRANSCRIPTION_ENABLED=true`. O áudio selecionado vai ao modelo `@cf/openai/whisper`; há custo/processamento externo. Nenhuma IA é chamada em toda mensagem. O binding está comentado para impedir chamadas remotas involuntárias no desenvolvimento.
11. Conferir policy de captura e retenção com o dono. Padrão: zero chats liberados e sem exclusão automática por idade. Depois de deploy e smoke, desativar manutenção explicitamente com `MAINTENANCE=false`, sincronizar diretório e liberar somente os chats aprovados na página humana. Retenção escolhida também exige confirmação.

Os comandos de criação/deploy só devem ser executados após confirmar os novos recursos. Não foi criado recurso de conta nesta entrega. Não há dependência de licença do código do Elo: a implementação é nova; dependências npm mantêm suas próprias licenças.

## Conectar um cliente

Endereço: `https://<origem>/mcp`. Protocolo MCP Streamable HTTP com OAuth, PKCE S256, registro de cliente e consentimento humano Access. Bearer MCP não substitui o login humano para confirmar ou baixar no navegador. Access deve levar a uma sessão válida antes do consentimento. Tokens MCP duram cinco minutos e refresh tem prazo limitado; rotação de epoch bloqueia grant antigo no servidor.

O SDK oficial foi exercitado de ponta a ponta no teste HTTP. ChatGPT/Claude reais ainda precisam ser homologados: criar conexão, atualizar catálogo e executar uma ferramenta em conversa nova. Autenticação do backend ou presença do catálogo não prova compatibilidade do cliente. Links de arquivos protegidos exigem navegador do dono; recursos binários pequenos são oferecidos via protocolo, e o cliente pode não renderizá-los.

## Uso diário

1. `sincronizar_diretorio`: agenda ou grupos, uma página por chamada; continuar até `complete`. Não importa histórico.
2. `buscar_conversas` e `propor_captura`: distinguir homônimos pelo ID/contexto e confirmar o chat no navegador.
3. `consultar_mensagens`: período, autor, termo e tipo. Observar cobertura, `discontinuous`, `textTruncated` e cursor. Uma lacuna não invalida conteúdo disponível.
4. `consultar_midia`/`obter_midia`: originais privados; até 128 KiB podem ir ao MCP. Arquivos maiores abrem autenticados no navegador. Limite de arquivo: 2 MiB.
5. `adicionar_arquivo`: devolve página de upload privada para arquivo novo. A página retorna referência/hash. Upload não envia ao WhatsApp.
6. `transcrever_audio`: somente seleção explícita e processador habilitado. Original e transcrição separados; transcrição pode conter erros e instruções hostis, que continuam sendo dados.
7. `preparar_envio`: texto ou arquivo/hash, alvo e citação. Conferir conteúdo e destino em `confirmationUrl`; confirmar no navegador; depois `executar_envio` no chat. `consultar_envio` informa o estado observado. “Aceito” não é entrega; em grupo não prova todos os participantes.
8. `propor_retencao`/`propor_exclusao`: efeito local confirmado fora do MCP. Não elimina cópias no WhatsApp, no cliente IA, nos backups ou no fornecedor.

Retenção por dias alcança mensagens e suas mídias. Uploads privados adicionados pelo dono (`message_id=NULL`) ficam disponíveis até exclusão do arquivo daquele chat, mesmo após expirar o envio. WAV pode ser arquivado/transcrito, mas o envio de áudio aceita apenas Ogg, MP3 e M4A conforme adaptador; formatos não enviáveis são recusados antes da proposta/tentativa. A limpeza reserva parcelas para mensagens, objetos e autorizações vencidas, evitando que backlog de retenção impeça as demais tarefas.

## Homologação real pendente

Registrar sem dados privados: versão ativa, data, tipo/origem/destino e estados. Ensaiar individual e grupo; homônimos; texto/imagem/PDF/áudio; telefone/Web/API; callback/status antes da resposta; duplicata; cancelamento; timeout sem retry; login/conector real; expiração, manutenção e restauração isolada. Não afirmar perda zero, histórico retroativo, revogação instantânea de terceiros ou leitura de todos no grupo.
