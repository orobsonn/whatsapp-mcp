# #53 — preflight global antes do ciclo de vida do índice

Revisão de engenharia, dados sintéticos e D1/workerd local. Não é homologação de contêiner Cloudflare, canal ou modelo real.

## Defeito e contraprova

O Engine mantém um stamp corrente por ID, mas o servidor Cognee conserva cada versão física. Ingerir v2 sobre v1 e chamar checkpoint com apenas o stamp latest faz o servidor recusar `allstored != latest`. O controller de checkpoint já havia admitido `preparing`; sua recuperação encerra o processo e marca `rebuild_required`. Retirada também invalida um CP anterior: restaurá-lo antes de conferir suas fontes podia admitir a fase de restauração e falhar depois.

Duas contraprovas falharam antes da correção em **20,87 s**. A primeira observou o CP mudar de `confirmed` para `rebuild_required` após correção de uma mensagem. A segunda observou uma terceira versão física sendo acrescentada a um índice já inconsistente. O adapter conserva `Map<(id,version,hash),stamp>` físico e a regra estrita do servidor; não substitui esse comportamento por checkpoint sempre bem-sucedido.

## Fronteira indivisível

`CogneeContainer.indexPreflight({indexEpoch, indexRevision})` é uma capacidade interna de leitura do host. Ela reutiliza a leitura canônica owner, a validação de origem de `rebuildSource` e a prova física tipada de reconstrução. O índice é global: todos os seus stamps, até 128, são verificados com autoridade do owner. O pack do interlocutor/projeto não decide se uma fonte global foi retirada. Uma fonte privada ativa fora do contexto continua válida.

Cada passe global de verificação de origem tem fanout máximo de seis e prazo total de cinco segundos; há um passe inicial e outro após a prova física. Falha remota retorna indisponibilidade, sem afirmar retirada. Quando o processo está frio, o resultado cobre apenas metadados atuais; a chamada não acorda o contêiner. Quando está quente, `/verify-index` somente leitura confere o manifesto completo e os vetores. Depois desse TCP, as fontes, afinidade de origem, epoch, revisão e gates são revalidados. A prova de índice aberto é compartilhada com o controller de reconstrução, sem réplica relaxada do contrato Python.

A exclusão do Engine protege o preflight. Um prazo físico de 60 segundos limita a resposta; se TCP/body ignorar cancelamento, o lock permanece até a promise física terminar. Nenhum resultado tardio publica estado. O cancelamento lógico acompanha os awaits dos guards canônico e de origem: terminar uma leitura SQL depois do prazo não permite iniciar um reader RPC novo. A fila e os callbacks também comparam o horário atual ao limite absoluto; atraso no despacho do timer não estende o orçamento. O preflight não chama quiesce/create/restore/start, não emite permissões de modelo e não grava checkpoint, recibo ou orçamento. Active persistido diferente de ausência/null e gates inválidos recusam o caminho.

O scheduler usa essa fronteira antes de warm/restore, antes de admitir ingestão, após a ingestão e imediatamente antes de checkpoint. Revalida o dono do ciclo após as consultas; as guardas finais de fonte e epoch/revisão dos controllers continuam obrigatórias. **As mudanças do scheduler e do Core devem ser integradas juntas**. Binding antigo sem o método produz lacuna indisponível; não há fallback para chamar checkpoint sem preflight.

## Resultado visível e limites

`index_maintenance_required` ou `index_preflight_unavailable` ficam no item, no retorno do ciclo e no diagnóstico autenticado do owner. Health seleciona o coordenador pela afinidade completa; o item com lacuna atual é escolhido de modo determinístico por horário e ID. O resumo acumulado conserva seu horário de snapshot e inclui nome/contagem dessas duas lacunas. Relatórios antigos permanecem válidos sem esse campo opcional; não se anuncia contagem exclusiva do dia.

Esta correção **não executa reconstrução automática**, não inicia índice vazio e não reabre item, alias, tentativa, custo ou claim antigo. Índice inconsistente aguarda um plano explícito de manutenção do operador. Esse plano deve preservar as tentativas e contas, usar replay-only sem fallback pago e publicar um CP novo apenas após prova do conjunto exato. Um CP que já está em `rebuild_required` não é consertado resetando sua fase. A integração de um futuro comando/CLI de manutenção continua separada.

## Validação

As sete contraprovas/controles de correção, multiversão anterior, retirada fria, fonte privada fora do pack, origem indisponível, revogação durante verificação física e preflight sem efeitos passaram. O primeiro dirigido teve seis verdes e um erro de coluna no assert de fixture; esse assert foi corrigido, e o caso restante passou isoladamente em 19,86 s. O dirigido final executou rotinas, reconstrução e instalação sequencialmente: 63/64 passaram em 56,35 s, incluindo timeout físico, fanout, marcadores falsy e diagnóstico/resumo. O único assert antigo esperava a lacuna anterior `index_rebuild_required`; passou isoladamente após alinhar o nome novo em 27,74 s. TypeScript e whitespace passaram. A retomada em perfil de execução funcional rodou o arquivo de rotinas inteiro: **39/39** passaram em60,28s, incluindo o controle novo de deadline entre SQL e reader RPC. Após reduzir o fanout global para seis, **4/4** dirigidos passaram em26,89s: dois casos de fanout/deadline das rotinas e dois controles do helper de origens; o helper existente conserva seu próprio limite de oito.

A revisão final acrescentou uma contraprova de tempo decorrido sem despacho do timer: avançar Date.now em5.001ms durante a leitura SQL ainda retornava `verified` antes da correção (**RED**,19,75s). Com limite absoluto compartilhado pela fila e pelos guards, o mesmo caso passou **1/1** em19,34s, retornando indisponibilidade com zero reader RPC, verificação física, escrita ou modelo. Não se soma essas execuções como uma suíte completa no commit final; integração e CI exatas continuam com o coordenador.

Não houve chamada de provedor, deploy, mudança de recurso cloud ou custo pago nesta entrega. A evidência real de #112 pertence ao ledger e às evidências próprias daquele teste.
