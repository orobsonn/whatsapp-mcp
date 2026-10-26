# #57 — bootstrap da primeira ingestão autorizada

Base `3bffd33d8bf86721ae21e26f5e7f187128401fc6`, árvore isolada
`codex/assistant-index-bootstrap`. Revisão adversarial explícita por agente
independente antes da implementação e após os testes. Nenhum recurso cloud,
credencial ou modelo pago foi usado nesta fatia.

## Falha

Scheduler.warm retorna index_uninitialized antes do laço de ingestão quando o
Core real não tem index. As fixtures semânticas existentes já semeiam index-e,
checkpoint e running:true. O Core suporta a primeira ingestão não vazia, porém
gera o epoch dentro de run, tarde demais para o journal D1 gravá-lo antes do RPC.

Não resolver criando índice/checkpoint fictício, chamando start vazio ou tomando
o epoch atual após ACK perdido. Rebuild também exige epoch anterior existente.

## Protocolo implementado

1. Um ticket interno InitialIngestTicket contém itemId,inputHash,
   indexEpoch,operationId. Scope vem do host. inputHash fixa a cópia integral de
   fonte/autor/actor/fence/origin e o wire normalizado existente. IDs/epoch/op são
   definidos uma vez pelo Core; o modelo não fornece nenhum deles.
2. reserveInitialIngest(input,{itemId,owner}) valida fonte não vazia/hash/ACL/
   origem/runtime e o ciclo D1 atual. Sob exclusão/transação DO, exige ausência
   estrita (`undefined`) de index/active/checkpoint/rebuild/maintenance/quarantine e de histórico
   access/receipt/search, além do processo físico parado. Persiste APENAS initial-ingest-v1 reservado, com epoch
   e operationId definitivos. Não cria index, não inicia Container, não concede
   permit, não chama modelo, não altera saldo. A mesma reserva/hash retorna o
   mesmo ticket; outra fonte/item/hash não substitui a primeira.
3. Scheduler persiste o epoch real em assistant_routine_ingestions, usando o
   journal preparado/attempting e o mesmo owned(cycle) SQL já existente. Um ACK
   perdido de reserva ainda sem efeito permite consultar a mesma reserva, não
   criar outro ID/epoch. ACK perdido de admissão/dispatch segue uncertain.
4. commitInitialIngest(input,ticket,{itemId,owner}) exige o ticket/pin intacto,
   reserva ainda reservada e o journal D1 attempting exato no ciclo/lease atual.
   A transação DO reivindica uma única tentativa. Só então a primeira ingestão
   normal cria seu index real e inicia a imagem para esse original validado.
   Não há API genérica start/init/SQL/URL nem substituição de estado perdido.
5. Reusar run('/ingest')/receipt/index/authorize/broker/budget existentes. Passar
   um check de admissão estreito até DirectContainerPort.start(check), usando a
   infraestrutura checked/boot já existente para revalidar antes/depois de awaits
   e antes do efeito físico após hash de configuração. Também revalidar antes
   de enviar /ingest; o modelo ainda exige o broker e seus fences normais.
6. A guard host consulta tabelas fixas: routine_state running,paused=0,owner/lease/
   active_item; item actor e inventory source ref exatos; ingestion attempting
   no epoch reservado; SourceAccess.guard; retentionExecutionGuard. Reserva não
   exige ingestion existente; commit exige. Nenhum SQL vem do ticket/modelo.
7. initialIngestReceipt(input,itemId,indexEpoch) só resolve o receipt existente pelo MESMO
   epoch/operationId/pin; nunca inicia/ingere/rekey. Attempting/uncertain sem
   receipt completo permanecem uncertain. A reserva é monotônica: não possui
   reset/delete/rekey. Falha física deixa quarantine/lost e requer recuperação
   explícita existente, sem interpretar index ausente como instalação nova.
8. Depois de receipt completo, scheduler usa preflight/checkpoint existentes com
   plano NÃO vazio exato. Só checkpoint confirmado permite busca/Flue. Primeiro
   tick admite no máximo uma ingestão nova, como hoje. Código normal de índice
   já existente e fallback de capacidade continuam com os mesmos gates.

## Contraprova e limites do teste

Teste integrado standalone: D1 real/migrações26, captura/materializador/rotinas/
SourceAccess/OriginGuard/CanonicalEngineGuard reais; armazenamento Core vazio
(sem index/checkpoint/histórico), Container parado e transporte controlado.
Fonte WA sintética atual/autorizada e conta fixa. Espera primeira ingestão real
com ticket/epoch/op duráveis e checkpoint não vazio; o tick seguinte alcança
busca/episódio sombra/diário, sem segundo start/ingest. Antes da implementação,
a contraprova falhou em `index_uninitialized`, sem ingestão/recibo/decisão
(1 RED, 21,73 s). O transporte físico do Container e o modelo do episódio são
controlados: isso prova o protocolo host, não a imagem, embedding ou o modelo
reais na Cloudflare. Não modifica a homologação pendente do piloto.

Contraprovas dirigidas: processo já em execução ou histórico bloqueiam reserva;
reserva não inicia o processo; ingestão normal B não ultrapassa reserva A;
concorrência tem um epoch/claim/efeito; actor/input/ticket alterados e lease
expirado bloqueiam commit; restore hold bloqueia o RPC; ACK perdido depois de
complete recupera o recibo original; unknown interno não tenta outra ingestão.
Dois testes de DirectContainerPort provam revogação e processo iniciado durante
o await de hash: nenhum start físico adicional.

A revisão também encontrou dois RED concretos (37,97 s total): marcadores
`null/false/0` eram tratados como ausência e substituídos por nova reserva, e a
ingestão normal passava pelo marcador corrompido. O fix faz parse estrito do
estado/ticket em todas as entradas, nega presença inválida sem substituir dados,
e exige ausência estrita de metadados para considerar o Core virgem. A transação
repete a verificação; corrupção nunca cria epoch novo.

Validação anterior a esse último endurecimento: 110/110 GREEN em bootstrap,
engine e routines (94,86 s), com D1 e migrações reais; `npm run check` GREEN.
Validação final, com o marcador estrito:

- `npm exec vitest run tests/assistant-index-bootstrap.integration.test.ts`:
  9/9 GREEN, 41,70 s (inclui os dois RED anteriores agora corrigidos).
- `npm exec vitest run tests/assistant-engine.test.ts tests/assistant-routines.test.ts -- --fileParallelism=false`:
  103/103 GREEN, 87,25 s; testes de boot físico também incluídos.
- `npm run check` e `git diff --check`: GREEN.

Os três arquivos totalizam 112 testes finais GREEN; foram executados
sequencialmente, com `fileParallelism:false`. Os avisos de sourcemaps ausentes
vêm do SDK MCP instalado; não alteraram os resultados. Custo pago desta fatia:
US$0. Não houve deploy, leitura de segredo, ingestão real ou chamada ao provedor.
A integração com os demais patches, CI oficial e comprovação em cloud ficam
com a revisão/integração do coordenador; #57 não é encerrada por esta fatia.

Foram executadas somente suites dirigidas, com slot serial coordenado. Nenhuma
suíte global, recurso cloud, chave ou mudança no bb23/Media52 nesta fatia.
