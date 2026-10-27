# Calendar próprio — consentimento e consultas reais

## Consentimento e instalação

Em27/10/2026, o dono confirmou explicitamente acesso somente leitura do app próprio Assistente Pessoal Sombra, inicialmente apenas à agenda principal, sem criar/alterar eventos. Como o controle de navegador deixou de estar disponível nesta sessão, o executor preparou nova tentativa e o próprio dono concluiu a tela Google. O script existente `calendar-oauth.mjs` validou state/PKCE/callback, trocou o código uma vez e gravou o ambiente privado0600. A tentativa anterior expirou antes do consentimento e foi preservada; não foi reutilizada.

O projeto/client Google são próprios, com Calendar API habilitada e scope `calendar.events.readonly`. Não foram usadas credenciais do conector Google do chat ou do Elo. A autorização canônica real foi registrada por MCP em projeto próprio e notaowner_note privada atual. A allowlist do Worker contém somente `calendarId=primary`, versão1 e fence dessa nota/projeto; IDs, credenciais e destinatário real não são publicados.

Um único `wrangler secret bulk` recebeu ACK para os sete secrets OAuth e a configuração de agenda. A captura imediatamente anterior dos metadados falhou; o comando de secrets foi executado mesmo assim. Não se apresenta essa tentativa como snapshot válido. A recuperação somente leitura comparou os29 bindings já existentes ao último snapshot completo, verificou os oito novos secrets, os três módulos por SHA256, cron, subdomínio e demais configurações contra a baseline previamente verificada. Tudo permaneceu compatível; nenhuma segunda mutação foi feita para contornar o erro. Recibos privados registram esse limite.

O Worker permanece em sombra/pausado, sem resumos automáticos. O access token inicial não é salvo pelo bootstrap: a primeira leitura real bem-sucedida implica refresh pelo broker recém-configurado. Não houve leitura de contador remoto de refresh; cache, concorrência, rotação, reinício frio e expiração continuam comprovados pelos testes integrados, sem atribuir a eles uma execução Google real.

## Observações pelo cliente autenticado

- `calendar.availability`, com offset, intervalo e `America/Fortaleza` explícitos, retornou `available/conflict_observed`, uma página, uma agenda concluída e cobertura completa desse recorte. Somente intervalos ocupados foram expostos; títulos, descrições e participantes de eventos não apareceram.
- `calendar.propose`, em outro recorte controlado e com destinatário próprio informado explicitamente, retornou `no_conflict_observed`, instantes UTC e locais coerentes, `recipientsOrigin=authenticated_owner_input`, `execution=unconfirmed` e `reservation=not_created`. Nenhum evento ou convite foi criado.
- `coverage.complete` cobre apenas a agenda principal configurada. Não prova disponibilidade em todas as agendas da conta. O snapshot do provedor continua `not_atomic`, e `no_conflict_observed` não é reserva.

Corpos/horários ocupados, e-mail, tokens, configuração privada e IDs de fontes reais permanecem fora do Git. A evidência pública conserva invariantes booleanos e categorias de resultado.

## Matriz de aceite #51

| Critério | Evidência e limite |
| --- | --- |
| 13.251 — fuso/intervalo explícitos | Duas chamadas reais pelo MCP com offset e fuso validado; proposta conserva UTC/local. DST e milissegundos têm contraprovas integradas na implementação entregue. |
| 13.252 — parcial não prova disponibilidade | Testes workerd/D1 cobrem agenda ausente, erro, paginação/ciclo/limite, all-day e resposta incompleta, mantendo `unknown` quando não há conflito. As chamadas reais tiveram cobertura completa somente deprimary; não se afirma falha real Google induzida. |
| 13.253 — detalhes privados não vazam | Respostas reais não contiveram título/descrição/participantes dos eventos. GET usa fields restritos; testes verificam omissão de detalhes e negação por ator/fonte/revisão. |
| 13.254 — proposta com destinatário/horário | Chamada real retornou destinatário do input autenticado, UTC/local/fuso explícitos e `reservation=not_created`. O destinatário não veio de evento privado e não recebeu convite. |
| 13.255 — sem escrita Calendar | Leitor constrói apenas GET fixo sem body, parser estrito não aceita método/URL arbitrários, MCP não oferece escrita e grant concedido é readonly. Contraprovas inspecionam método/corpo e recusam campos extras; não foi tentado POST mutante contra agenda real. O POST OAuth de refresh é para o endpoint de token, não escrita no Calendar. |

As contraprovas de Calendar22/OAuth19 e o wrapper DO nativo fazem parte da CI integrada existente; a v0.47.0 passou1350 gerais/65 nativos mais os operadores Node/OAuth no commit `e672cd8`. A CI própria da nova versão é gate obrigatório antes de tag/release e encerramento #51. Revisão adversarial independente aceitou a combinação de fronteiras com estes limites.

## Limite operacional Google e pendências

O app continua **External / Testing**. A política Google atribui validade de7dias ao refresh token emitido nesse modo para scopes Calendar, exigindo nova autorização ou configuração de publicação adequada para piloto mais longo. Não se mudou o app paraProduction, não se prometeu token permanente e não se homologou continuidade de14dias. Referência: [Google — expiração de refresh tokens](https://developers.google.com/identity/protocols/oauth2#expiration).

#48 e a homologação integral do piloto continuam pendentes de proposta atual legítima e callbacks reais. O pedido posterior do dono para limpar tópicos duplicados removeu somente os quatro da revisão revogada e o tópico dos desafios desta retomada: cinco ACKs Bot API, sem repetição; quatro IDs atuais/revisão3 preservados. Linhas D1 históricas foram mantidas, sem fabricar que uma criação anterior nunca existiu.

Nenhuma nova inferência paga da assistente, WhatsApp automático ou escrita Calendar. Reservas e tentativas incertas históricas preservadas; custos de infraestrutura não conciliados.
