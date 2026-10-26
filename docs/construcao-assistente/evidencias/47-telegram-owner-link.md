# #47 — vínculo Telegram e inbox privado

Data: 25/10/2026. Implementação local com fixtures sintéticas. Sem Bot API, token de bot, deploy, webhook configurado na nuvem, envio ou identidade real vinculada nesta entrega.

## Fronteira implementada

`assistente_telegram` aparece somente com props validadas por `requireMcpOwner`. O binding nomeado `OwnerAssistant.telegramLink` valida a afinidade inteira do host em cada chamada. Os quatro comandos têm schemas fechados; papel, principal, namespace e IDs de candidato não são parâmetros de autoridade.

`begin` emite A; A recebido em chat privado humano fixa o candidato, sem autoridade ativa. `confirm` pelo MCP emite B vinculado ao candidato, tentativa, revisão, afinidade e expiração originais. Somente o mesmo par privado conclui B. HMAC gera 43 caracteres base64url; somente hashes persistem, e o replay recupera a mesma capability. Rotação do segredo recusa regeneração diferente sob recibo antigo. O ledger de comandos existente protege begin/confirm/revoke, sem capability bruta no recibo D1.

O receiver aceita apenas `POST /webhooks/telegram`. Segredo dedicado no header é comparado antes de ler corpo ou D1. Corpo limitado a 64 KiB em streaming; texto limitado a 16 KiB UTF8; cópia síncrona e estrutura limitada antes de awaits. Encaminhamentos, bots, grupos/canais, edição, business e callbacks não viram comandos. O handler retorna códigos fechados; indisponibilidade/ACK ambíguo permite retry do mesmo update por HTTP 503.

`0018_telegram_owner_link.sql` contém vínculo, tentativas e updates. O batch que admite um update também faz o CAS de claim/ativação; uma falha SQL final reverte tudo. Dedupe usa namespace/bot/update_id e payload hash estável, sem highwater mark, e sobrevive à revogação e relink. Sender desconhecido sem capability válida não cria linha. A mensagem normal do par ativo entra somente como inbox pendente; #47 não executa comando/IA.

Revogar pelo MCP incrementa revisão, invalida tentativas e cancela inbox pendente no mesmo batch. `TelegramLinkFence` e `telegramLinkGuard` são o contrato para #48 incluir revisão, afinidade e par no próprio statement que admite o futuro comando/efeito; pré-leitura não autoriza consumo posterior.

Na ativação, `activation_cut=max(date do B,floor(hostNow/1000))` é persistido no mesmo CAS. A admissão normal exige data posterior ao corte e não futura. Mensagem inédita antiga, do mesmo segundo ambíguo e futura recebem recibos duráveis distintos sem texto/comando. Isso impede que mensagem anterior à revogação seja promovida por um relink posterior do mesmo chat.

## Verificação local

- RED inicial: módulos ausentes; RED de integração: método RPC/rota ainda ausentes; RED de endurecimento: formato malformado escapava com erro genérico. GREEN após implementação.
- `npm run check`: passou.
- `npm test -- tests/assistant-telegram-auth.test.ts tests/assistant-mcp.test.ts`: 28 testes passaram.
- `npx vitest run --config assistant/flue-test.config.ts tests/assistant-owner-binding-runtime.test.ts`: 1 teste passou. Bundle oficial, transporte real entre dois Workers Miniflare, D1 persistente e restart; zero rede externa. Inclui rejeição de afinidade/extras e replay begin idêntico após restart.
- `npm run build`: dry-run passou; não publicou.
- O teste de binding também executa `npm run build:assistant` e passou.
- `npm test`: 48 arquivos / 748 testes passaram (112,67 s).

Contraprovas exercitadas: A sozinho sem autoridade; B de outro user/chat; duas candidaturas concorrentes; dedupe concorrente e fora de ordem; hash conflitante; pre-relink inédito, igualdade de segundo e futuro; replays de ativação/inbox/revogação; ACK perdido em begin/confirm/ativação/revogação/negação; restart; segredo rotacionado; tentativa substituída/expirada; revoke vencendo corrida contra ativação/inbox; rollback do batch de ativação; fence revogado; ausência de segredo/capability em tabelas de pareamento e recibos; header errado sem leitura; cap sem Content-Length; formatos não suportados e IDs numéricos inseguros.

Avisos locais conhecidos: depreciação `punycode`, sourcemaps ausentes no SDK MCP instalado e diagnóstico interno workerd `broken.inputGateBroken` sem falha de teste (exit 0, todos os 748 passaram). Não representam homologação remota.

## Tamanho e pendências reais

A implementação de auth/CAS, a migração, o receiver e as integrações formam uma única fronteira inseparável. O diff excede o alvo de 400 linhas sobretudo pelos testes de corrida, replay, rollback e integração, preservados por serem contraprovas de autenticação. Não foi criado framework, scheduler, DO ou issue adicional.

Homologação cloud depende da coordenação: configurar somente o segredo webhook e username do bot no Worker assistente, aplicar migrações, conectar a capability MCP nomeada e executar begin → A privado → confirm → B no mesmo chat → status → inbox → replay → revoke. Token do bot continua fora do Worker/D1/Git nesta #47. Nenhum resultado local demonstra vínculo real, webhook operacional ou comando executado; processamento e tópicos ficam para #48.

## Correção da revisão adversarial — rotação do segredo

A revisão encontrou P1: a recepção de A/B comparava somente a capability recebida com o hash persistido; após rotação, uma capability emitida sob o segredo anterior ainda admitia um update novo. Duas contraprovas incorporadas falharam antes da correção: A retornou `pairing_claimed` e B retornou `linked` quando ambos deveriam retornar `denied`.

O guard agora rederiva a capability da tentativa sob o segredo atual e exige que seu hash corresponda ao recebido e ao persistido antes de qualquer batch mutador. Desafios antigos são negados sem update/claim/ativação. Replay de update já processado continua recuperando seu recibo original, sem mutação.

Após o guard: `npm run check` passou; Telegram+MCP passaram com 30 testes; binding real/restart passou com 1 teste e novo `build:assistant`. A suíte completa anterior de 748 testes é evidência do commit anterior; não foi repetida nesta correção pontual, por instrução do coordenador, que validará o commit integrado em CI.
