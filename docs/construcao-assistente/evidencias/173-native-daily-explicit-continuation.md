# Revisão diária real: continuação explícita solicitada pelo dono

Data:29/10/2026. Pedido direto: disparar a revisão diária agora e conferir se deu certo. O disparo diário normal conservava o recibo original falhado; nenhuma janela/sample/clock foi inventada para substituí-lo.

## Auditoria e publicação

O predecessor `sub_ik_03102bd78053862c5137ac2bb84cb2da` da passagem diária `ce7b4a9a-5d16-4c32-80d4-5829b8228e5a`, dia28/10, janela(0,3679], foi reconsultado: SDKsettled com erroconversation_context_unavailable;1turnId observado,0 ferramentas e0 recibos de modelo no join independente D1 desses turnIds. A prova não foi inferida só do estadofailed.

A solução restrita está no suplemento `2026-10-29-curator-explicit-continuation.md`: mesmo run/janela/sessão, continuação2 fixa da revisão1, nenhuma cadeia3.8 RED iniciais;121 testes dirigidos combinados, tipos e buildOwn passaram. Revisão adversarial final sem Critical/Important. Código `c9918d6`, Own publicado `5adaec7c-9efe-4cd3-984a-d2186f8325eb`; todos os bindings/runtime/schedules/subdomínio comparados. Modoapproval e autonomiaOFF preservados. Nenhuma migração/infraestrutura nova.

Config privada one-off seleciona os IDs exatos do predecessor. Recibo e alerta originais permanecem históricos. O agendador reutiliza a entrega2 já persistida, inclusive se seu ACK fosse perdido, em vez de criar nova submissão a cada minuto. A config será removida após observar o novo SDK terminal e a cobertura, separadamente.

## Custo

Censo conhecido23:17UTC:1010169microUSD comprometidos, incluindo40000incertos preservados. Orçamento somente da conta de testes29/10 aumentado de1200000 para2000000microUSD, dentro do teto global históricoUS10, conservando reservas, incertezas e dias posteriores. Guard conservador também considerou188310microUSD de carry externo e133000 de limite computacional separado; não houve compra nem aumento do teto global. Prova privada `native-curator-resume-budget-1793315980632`.

## Disparo real e acompanhamento

A revisão2 foi efetivamente admitida: `sub_ik_be9a1e49a12d40730c8091e08045934c`, mesma sessão privada do curador. O SDK passou a running às23:21:50.965UTC e escolheu curator_next; a ferramenta concluiu sem erro. Às23:24:55UTC, contabilidade:100presented,347pending,2669skipped_policy,11superseded,552withdrawn. Presented ainda não comprova avaliação. O total permanece3679.

SDK terminal, cobertura final, operações de memória, custos e resumo Telegram continuam em acompanhamento. Não declarar a passagem concluída a partir da admissão, de uma ferramenta bem-sucedida ou do total de linhas classificadas.

## CI anterior

A CI8de15f7 falhou em dois casos do teste de quota por um fixture SQL defasado: a projeção de origem ganhou canonical_id e o fake ainda reconhecia o prefixoSELECT o.source_kind. O matcher/row foi atualizado; o mesmo script passou9/9, preservando todas as asserções de limite e revogação. Isso não alterou lógica ou orçamento de produção. A CI completa do novo SHA ainda deve concluir.
