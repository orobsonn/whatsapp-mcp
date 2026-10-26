# #51 — Calendar somente leitura e proposta local

Consultas `calendar.availability` e `calendar.propose` integram a família MCP do dono autenticado. O receiver exige afinidade de instalação/geração; a configuração `CALENDAR_READ_CALENDARS` contém `{id, calendarId, projectId, version, authorization:{sourceId,revision}}` para cada agenda autorizada, até5. O gateway usa exclusivamente o DO privado `CALENDAR_OAUTH`; secrets, cache cifrado, refresh e consentimento estão descritos em [OAuth durável](51-calendar-oauth.md). Nenhuma credencial é herdada dos conectores do chat ou de outro projeto. Access token estático não é fallback do produto. Consentimento/configuração própria e homologação permanecem pendentes se não fornecidos.

A permissão canônica usa SourceAccess como #50: nota owner_note privada na revisão/projeto configurados, projeto no namespace, guard antes da rede e batch D1 final coerente para TODOS os suportes após qualquer await de rede/hash. Retirada/correção/ACL invalida a consulta e suprime também propostas. Não há mutação no Calendar: o transporte constrói exclusivamente GET `https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events`, sem corpo, com redirect manual recusado. IDs vêm somente da allowlist do host. O modelo não fornece URL, método, token, nextLink nem escolhe omitir uma agenda para alegar disponibilidade global.

Consulta exige início/fim RFC3339 com offset e fuso validado por Intl, intervalo positivo até31dias. A API recebe timeMin/timeMax/timeZone, singleEvents, orderBy startTime e fields restritos a status/transparency/start/end/nextPageToken. Títulos, descrição, participantes e nomes/IDs reais das agendas não retornam nem entram nas propostas. Intervalos ocupados são normalizados por instante UTC e mesclados; offsets explícitos resolvem horas repetidas no DST sem inferir horário local ambíguo. Propostas preservam os instantes em ISO UTC, apresentam localStart/localEnd normalizados no fuso e usam destinatários fornecidos explicitamente na chamada autenticada; participantes de evento privado nunca são candidatos a destinatário.

Cada agenda percorre até3páginas de100eventos, dentro do prazo de leitura Calendar12s e dos limites de bytes por resposta. Até100 intervalos mesclados retornam; excesso marca busy_result_limit. Qualquer agenda falha, próxima página pendente/cíclica, evento all-day sem instante resolvido ou evento inválido mantém cobertura incompleta e availability unknown quando não há conflito observado. Chegar ao fim das páginas permite apenas no_conflict_observed, nunca promessa de agenda livre/reservada. Uma consulta multipágina/multiagenda não é snapshot atômico do provedor; snapshot not_atomic permanece explícito. O hash da observação vincula recorte/projeto/configuração/permissões; não é recibo de reserva.

`calendar.propose` gera apenas objeto local hipotético, com recipientsOrigin authenticated_owner_input, execution unconfirmed e reservation not_created. Não publica evento, não envia convite e não confirma compromisso real. Não há inferência/modelo nesta leitura e não se grava conteúdo de agenda como owner_note nem se anuncia indexação automática.

## Evidências controladas

- RED: sem a integração Calendar no receiver, a consulta RPC foi recusada;1 falha,12 pulados, antes de restaurar a implementação.
- GREEN inicial:13/13 testes D1/workerd. Contraprovas adicionais cobrem DST e saída com mais de100 intervalos, seguidas pela suíte dirigida final conjunta com #50:27/27 testes,2 arquivos,15,50s. `npm run check` também passou.
- Testes verificam endpoint/método/corpo/fields, offsets/fuso, detalhe privado omitido, agenda faltante, paginação com conflito tardio, limite/ciclo, all-day, resposta inválida/redirect, suporte retirado durante resposta, proposta com destinatários exatos, token ausente, principal não autorizado e receiver real.
- Nenhum Calendar real consultado/escrito, WhatsApp enviado ou modelo chamado. Custo incremental de modelo:US$0. Reservas/custos anteriores intactos.

Revisão adversarial prévia do coordenador exigiu falha fechada quando qualquer agenda autorizada for parcial, projeção privada, GET-only fixo e proposta sem reserva; incorporados. Revisão final independente, integração/CI, release minor e homologação OAuth própria continuam gates. Não fechar a issue nem declarar integração Calendar operacional por fixtures.

## Fonte oficial consultada

Google, [Events:list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list): método GET sem corpo; timeMin/timeMax RFC3339 com offset; paginação por nextPageToken, inclusive páginas vazias; escopos somente leitura e projeção parcial fields. A implementação evita freeBusy.query porque esse endpoint exige POST.

## Refinamento após revisão adversarial — fuso e milissegundos

`Events.list.timeZone` é fuso da resposta, não uma exigência de que timeMin/timeMax usem o mesmo offset. Consultas UTC e offsets diferentes continuam válidas. A proposta agora apresenta start/end em ISO UTC e localStart/localEnd normalizados por Intl no fuso escolhido, incluindo o offset real; isso desambigua DST sem apresentar um horário civil inexistente. A repetição02:30 em Europe/Berlin conserva as duas ocorrências pelos offsets+02/+01; um instante02:30+01 durante o avanço de março aparece corretamente03:30+02.

Google ignora milissegundos nos bounds. A consulta expande timeMin para o segundo anterior e timeMax para o seguinte quando fracionários, depois recorta conflitos no intervalo exato solicitado. Assim, evento no último meio segundo não é omitido com falsa ausência de conflito. Novas contraprovas de normalização e fracionamento foram escritas; execução está sob coordenação da suíte integrada para evitar concorrência pesada na VPS. Nenhuma chamada real/paga neste refinamento.

Validação final dos refinamentos: RED5/5 contraprovas falharam no módulo anteriorc485a7b (normalização civil/UTC e bound fracionário). Restaurado o módulo completo, Calendar22/22, GitHub12/12 e OAuth19/19 passaram numa única suíte D1/workerd:53/53,3 arquivos,15,73s. Nenhuma consulta externa ou chamada paga.
