# #55 — barreira local, purga e objetos (etapa B)

Engenharia local, sem execução de purga real, deploy, recurso Cloudflare, modelo pago ou ativação de restore. A issue continua aberta.

## Retirada recuperável

A migração **aditiva 0024** cria uma barreira monotônica por fonte e origem da instalação. Antes de qualquer await externo, um batch D1 admite o CAS original, grava `pending_withdraw`, muda a fonte para `withdrawn`, incrementa a revisão uma única vez e registra a mudança. `SourceAccess` bloqueia tanto essa fonte quanto uma cópia antiga da mesma origem/ID em outra geração; seus métodos de leitura, inventário e guard compartilham esse predicado. Prova de identidade que usa fonte retirada também é recusada. Triggers recusam versões novas, recriação da origem em outra geração, revival e substituição/remoção da barreira ou do tombstone.

Só depois desse bloqueio local o controller registra a autoridade DO de A. Se a chamada ou seu ACK falhar, a fonte permanece bloqueada. Reinício com o mesmo comando retoma pela identidade/revisão/hash originais da barreira, sem rekey ou nova revisão. O recibo público do owner só é gravado ao finalizar. O caminho legado sem autoridade faz retirada local e registra `not_configured`; isso não autoriza purga física. Tombstone de captura já retirado pode ser adotado para gravação externa sem reviver a fonte. A barreira não equivale a recall de uma requisição já admitida e enviada.

## Purga D1

`RetentionPurge.advance` exige owner copiado, fonte retirada e autoridade externa registrada. Sua coleção de referências é fixa pelos contratos TypeScript/SQL, com até 128 novas referências por consulta de expansão e uma quantidade fixa de consultas por chamada. Engloba missões/FUP, jobs, diário, episódios, contexto secundário em `binding.context.sources`, operações de modelo alcançadas por `episode_calls`, pesquisa, comandos atribuídos, mídia, relações e versões de origem. Faz expansão por operações compartilhadas até atingir ponto fixo. O adapter explícito de #53 trata itens/ingestões associados e pausa execução que perdeu item; metadados históricos de avaliação de #54 permanecem. Tabela desconhecida exige novo adapter e bloqueia a purga.

O batch final repete a coleção e só cria um grant se a contagem não mudou e os recibos com uso conhecido têm reserva financeira exata. Sem grant todas as remoções são no-op. O grant é consumido dentro do mesmo batch; permite apagar artefato de mídia somente se sua fonte está retirada. As projeções e recibos são removidos antes dos corpos originais e do ponteiro corrente. O tombstone e identificadores necessários à retirada ficam preservados; isso não é anonimização. O recibo nominal da purga reconcilia ACK D1 perdido.

As duas tabelas financeiras de #37 **nunca são apagadas**. Uso real conhecido é liquidado antes de remover o recibo de corpo; tentativa desconhecida conserva seu teto como incerta. Um callback de modelo/OCR que chega depois da purga detecta UPDATE zero, liquida seu uso conhecido em #37 e não recria payload/artefato. Essa liquidação não autoriza reinferência nem publica conteúdo obsoleto.

O recibo distingue `d1=purged` **apenas no closure da fonte no namespace corrente**, outras gerações pendentes, financeiro preservado, tombstone/metadados retidos, `r2=pending`, `externalIndex=pending` e cópias externas pendentes. Não certifica remoção do conteúdo em checkpoint/índice externo, snapshots Cloudflare, arquivo original, Telegram ou provedor de modelo.

## Coleta de objetos

`RetentionObjects` exige owner e usa somente o binding separado e fixo `ARTIFACTS`, com marcadores de instalação/geração do host e prefixo exato calculado. O chamador nunca escolhe bucket, URL, namespace ou binding do arquivo original. Marcadores comprovam afinidade da configuração declarada; R2Bucket não expõe seu ID real. Prova do binding/bucket real continua gate de provisionamento.

Um claim persistido só pode nascer quando **nenhuma** versão D1, de qualquer instalação/geração, aponta a chave. Triggers impedem a corrida inversa: após o claim nenhuma versão nova pode referenciar essa chave; UPDATE de versões já é imutável pelo contrato anterior. O claim não pode ser apagado/reposto. Só depois ocorre DELETE R2. ACK perdido mantém estado incerto e contador de tentativas; repetir DELETE é seguro porque a barreira persiste. Referência atual, inclusive fonte retirada ainda não purgada, conserva o objeto. Objetos e snapshots externos não entram nessa coleta.

## Validação

Gates locais dirigidos, executados em sequência: **15/15 B** final (16,67 s), **19/19 A** após barreira24 (23,95 s) e **1/1 OCR tardio** (12,18 s). TypeScript e diff check passaram. Testes usam D1/R2 locais reais e adapter externo sintético; o core durável da autoridade tem suas provas separadas em A. Não são prova de bucket Cloudflare real ou homologação do piloto.

A revisão adversarial própria e a revisão do root identificaram o mesmo bloqueio: unicidade global da origem e revisão da barreira de outra geração impediam retirar/purgar uma cópia antiga já existente. Cada fonte/geração mantém agora sua própria barreira e CAS, com índice de origem global para bloquear leituras e revival. A contraprova usa a origem em duas gerações com revisões diferentes (2 e 1), retira ambas e purga o corpo antigo sem resetar autoridade ou financeiro. Outro caso perde o ACK do batch final da purga e recupera o recibo exato já confirmado.

Contraprovas executadas contra cópias temporárias dos arquivos de broker/OCR em `f0404b0`, sem alterar o patch final: **3 falhas esperadas**. Modelo tardio conservava teto 8 em vez de liquidar uso conhecido 3; cache de contexto secundário retornava `complete` depois da purga durante o await de settlement; OCR tardio acessava `request_hash` de receipt nulo. No patch final, UPDATE zero conserva custo no ledger37 sem recriar corpo e uma última consulta conjunta de receipt/permit/guard recusa a cópia antiga do cache. As cópias temporárias foram removidas.

Outras contraprovas cobrem fonte/origem em geração antiga, escrita/revival durante DO pendente, revisão idempotente após reinício, ACK D1 perdido, projeções e operações secundárias, 132 jobs em páginas de expansão, financeiro ausente, esquema desconhecido, referência R2 em outra instalação após commit D1 com ACK perdido, rollback D1 que deixou objeto órfão, nova referência enquanto DELETE R2 aguarda, ACK R2 incerto e preservação do bucket original MEDIA. Custo pago dos testes: **US$ 0**, sem API remota.

Pendentes antes de fechamento: gates dirigidos/nativos/integrados, revisão adversarial, composição #53/#54 e etapa C de restauração selada em geração externamente nova e sombra. Nenhuma barreira em um D1 antigo restaurado pode ser presumida atual; C deve demonstrar autoridade externa e bloquear todas as entradas/replay antes de ativar.

## Revisão independente da composição

Revisão de `semantic_bugs` aprovou a barreira, closure de contexto secundário, financeiro e coleta R2, e encontrou falha de presença no core da autoridade: `null`, `false` e `0` sob uma chave retirada eram tratados como ausência, permitindo lookup com `blocked=[]` e sobrescrita. **3/3 RED** reproduziram isso. O core agora aceita apenas `true` ou ausência `undefined` em lookup, record e append de bootstrap; qualquer outro valor existente é corrupção e permanece sem sobrescrita. Guard de origem também recusa. **12/12** testes da autoridade passaram na composição em12,96s, incluindo as3 contraprovas; revisão independente aprovou a correção. A integração removeu uma declaração duplicada do binding ARTIFACTS trazida pelos dois ramos, preservando um único bucket com seus marcadores de afinidade. Gate completo no HEAD final continua necessário.

## Followup — história de missão e colisão de IDs

Após a revisão C, duas contraprovas **RED** em 10,99 s mostraram: missão M foi atribuída à fonte A na revisão 1 e à fonte B na revisão 2; purgar A conservava `mission_versions` revisão 1/objetivo atribuído a A. Outra prova usou project.id igual ao ID opaco de fonte/missão e perdeu indevidamente o recibo do projeto, porque o collector de comandos comparava somente `result.id`.

O fix acrescenta somente um tipo de referência fixo `mission_version`, chave composta `json_array(id,revision)`, coletado pelo `body_json.sourceId` histórico. Deleta essa versão e seu recibo **mission.*** exato por id/revision. Não amplia o closure da missão corrente B: M revisão 2, fonte B, FUP B e recibo B sobrevivem. O caminho existente de missão **corrente** atribuída a A continua removendo seu closure. Recibos source/mission/FUP são atribuídos pelo kind correspondente; a ligação por provenance FUP também confere o recibo FUP, sem fundir project/source/mission por ID.

Regressão **17/17 GREEN** em 15,86 s (`npm test -- tests/assistant-retention-purge.test.ts`), TypeScript e diff check passaram. A prova verifica também o ledger incerto histórico byte a byte inalterado. Não há nova migração, purga real, inferência ou acesso cloud. Custo adicional: **US$ 0**. O followup não é homologação do piloto e não fecha a issue sem composição/CI.
