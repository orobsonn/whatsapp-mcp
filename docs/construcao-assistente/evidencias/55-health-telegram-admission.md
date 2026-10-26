# #55 — diagnóstico e efeitos Telegram durante restore

Teste controlado local de 26/10/2026, sobre `7ae1666`, sem token real, rede ou
envio. O piloto e a homologação do transporte privado continuam separados.

## Problemas reproduzidos

Oito RED em 19,41s, dois arquivos filtrados:

- `assistant.health` recusava o diagnóstico pelo mesmo selo/geração que deveria
  ajudar a investigar; consultas comuns precisam continuar recusadas.
- Tópicos, notificações e ACKs Telegram podiam iniciar efeitos depois de um hold
  ou troca de geração ocorrer durante a inspeção/admissão.
- Um hold depois do latch ainda permitia criação/envio; recibos incertos não
  podem produzir novo envio quando a pausa termina.

## Correção e fronteiras

O ramo tipado `assistant.health` precede o guard de leitura. Afinidade do dono e
validação do comando permanecem obrigatórias; todas as outras queries mantêm o
guard. Source, control e retention repair não foram alterados.

`TelegramReview` inclui o guard de restore em seus próprios preflights e latches,
compondo o guard da rotina quando existente. Isso cobre factory OwnerRPC,
webhook e scheduler. Repete a conferência depois do latch e imediatamente antes
de criar tópico, enviar ou responder callback. Bloqueio posterior ao latch
preserva estado incerto, sem novo alias nem reenvio. Status e recibos já gravados
continuam consultáveis; callbacks duplicados continuam deduplicados.

O adapter de produção verifica configuração/selo e, por último, um snapshot SQL
com hold, geração e ownership atual da rotina. A revisão Root apontou a borda do
timeout nesse await: o adapter agora confere `expired`/AbortSignal antes de
iniciar fetch. A contraprova libera o guard só depois do deadline e comprova
zero fetch mesmo com transporte que ignora abort. Não se promete desfazer uma
requisição que já tenha começado.

## Validação

- 8/8 contraprovas GREEN em 20,40s.
- 23/23 dirigidos finais GREEN em 37,62s, arquivos `assistant-mcp`,
  `assistant-telegram`, `assistant-routines`: inclui factory real OwnerRPC com
  fetch sintético, deadline tardio, tópicos e callbacks positivos, ACK perdido,
  ausência de reenvio e resumos da rotina.
- `npm run check` e `git diff --check` aprovados. Revisão Root explícita da
  direção e do diff, com ajuste de deadline incorporado antes do GREEN final.

Filtro final:
`keeps owner health available|restore .*Telegram|restore hold (during|after)|owner RPC Telegram factory|late Telegram fetch|persists exactly four|keeps lost create ACK|bounds notification preflight|records callback action|fixed Bot API origin|bounds a hung|timed-out dispatch|checks binding affinity|publishes one typed metadata summary|keeps a summary uncertain|rejects summary admission`.

Custos pagos: US$0. Nenhuma credencial real, chamada Cloudflare, mensagem real,
envio WhatsApp, escrita Calendar ou deploy. Sem nova suíte completa local após
o GREEN final; integração/CI e piloto continuam gates próprios.
