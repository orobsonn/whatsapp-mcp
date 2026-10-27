# #140 — execução Owner própria: ingestão comprovada, checkpoint e publicação pendentes

27/10/2026. O código `335d6d3abc029f61e9b3be91ab52081f4f5ea541` passou na [CI40531323462](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40531323462) e foi implantado no Worker próprio. Os cinco módulos instalados foram comparados com o build; 37 bindings, cron e exposição foram preservados. O primeiro readback recusou uma mudança automática em `annotations.workers/triggered_by`; a reconciliação somente de leitura confirmou que era a única diferença de settings, sem repetir upload.

## Fronteira real observada

- O MCP autenticado criou um projeto e uma nota de homologação técnica, identificada como registro do agente. Não se atribuiu avaliação humana ao dono.
- O operador loopback chamou o serviço Owner realmente implantado. Consulta anterior ao plano confirmou afinidade e ausência da operação; plano e admissão retornaram sucesso para uma única nota de 471 bytes, mantendo pausa e sem tocar o backlog geral.
- O avanço de processamento retornou `uncertain/index/ingestion_unconfirmed`. O slot D1 permaneceu incerto; consulta posterior observou `index_maintenance_required`. Não houve nova tentativa, troca de chave/epoch/geração nem alteração de recibos para obter sucesso.
- A observação D1 dessa geração não encontrou reservas de modelo, recibos de modelo ou episódios. Isso não prova, por si só, ausência de ingestão física. A operação conserva o prazo original, que expirou sem publicação de decisão.

## Configuração encontrada e correção operacional

O mapa `resources.script_runtime.containers` estava ausente na versão do ensaio e também na versão anterior produzida pela atualização de secrets do Calendar. Uma versão histórica verificada conservava o alias `cognee`, apontando para a imagem imutável já utilizada. Conferir apenas settings/bindings não detectou essa lacuna. A aplicação nominal existia e sua listagem de instâncias estava vazia; isso também não substitui o mapa de imagens do runtime.

A restauração preservou o mesmo código e digest da imagem, sem tocar no estado do Core. O upload de versão foi inspecionado antes de promover100%: mesmos 37 bindings, mesmo etag de código e mapa de containers histórico exato. O readback após promoção confirmou os cinco módulos, cron e exposição. As falhas anteriores de upload multipart e de comparação da anotação da plataforma foram preservadas e reconciliadas; não se repetiu uma tentativa de modelo.

A configuração corrigida não reabre o slot incerto nem estende o grant. O diagnóstico é somente leitura: snapshot durável atômico de ticket/index/access/receipt/active, com ausência e corrupção distintas, vínculo ao mesmo Root e geração atual. O indicador de imagem descreve a configuração presente; a versão original continua sendo a prova histórica.

O commit `f0e32ad95161dad786e0311a396a04b03c7b3d74` passou na [CI40538028510](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40538028510):1.442gerais,13OAuth e65runtime, mais Node/tipos/builds/audit. Build fresco do SHA foi enviado como versão; módulos, runtime/containers e37bindings foram conferidos antes de promover100%. Cron/exposição permaneceram iguais; nenhuma escrita no Core foi feita pela publicação.

A inspeção real do mesmo Root expirado observou imagem atual configurada, active ausente, índice na mesma epoch com revisionempty/zero fontes/losttrue e ticket inicialuncertain, sem access ou receipt para aquela operação. O comprovante privado tem SHA256 `fa787f80df8d494ec7e9c7d63be1adee24054e0b0eed65080235dc0c935e6bf5`. A fonte335 examinada persiste access antes de habilitar o dispatch e não oferece remoção desses registros nas APIs auditadas; o namespace/histórico externo deste ensaio foram conferidos. Isso sustenta a conclusão limitada de falha anterior à habilitação de `/ingest`, sem reclassificar/gravar sucesso retroativo. A recuperação ainda exige [contrato próprio](../owner-once-recovery-design.md); a inspeção não concede nova execução.

## Recuperação e ingestão reais após CI69e

O commit `69e2f7e2208ebb0b46a8e4677c75247b15b01f15` passou na [CI40548158889](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40548158889):1.489gerais,13OAuth,65nativos, checksNode, tipos, builds e audit sem vulnerabilidades. O upload versionado foi comparado por módulos/runtime antes da promoção100%, preservando imagem,37bindings, cron, pausa e exposição. A inspeção do Root antigo produziu o mesmo comprovante anterior, sem alterar sua expiração ou estado.

A nova admissão de recuperação foi aceita pelo serviço real. A manutenção retornou `pending/recovery_reserved`, arquivando a falha anterior e conservando epoch/wire. O passo seguinte completou a ingestão da nota técnica de471bytes e retornou `pending/indexed`. Os72recibos de modelo e72reservas correspondentes ficaram completos/liquidados em1.252microUSD; o slot novo ficou completo e o antigo permaneceu incerto. Essa contagem representa as chamadas legítimas da única ingestão lógica, não72tentativas de ingestão.

O próximo passo recusou `compatible_checkpoint_required`: o índice canônico tinha fontes completas, mas o processo estava parado e nenhum checkpoint tinha sido criado. A API da instância observou running em17:48:29UTC e stopped em17:51:55UTC. Isso prova a parada, não sua causa precisa. A [API oficial](https://developers.cloudflare.com/containers/api/durable-object-container/#setinactivitytimeout) também esclarece que o timeout pertence à instância do DO e deve ser rearmado após seu reinício; o construtor anterior não fazia isso. Além dessa lacuna, retornar ao operador antes de checkpoint deixava a projeção exposta a pausas legítimas entreRPCs.

A correção local rearma60s somente quando o processo já está ativo, sem start, ingestão, modelo ou escrita de storage. O avanço usa lifecycle fresco e epoch/revision exatos do recibo, revalida o Root e confirma checkpoint antes de anunciar `indexed`. Perda de ACK mantém slot completo e retorna fasecheckpoint incerta; a continuação consulta o mesmo resultado. Os19casos de bootstrap passaram, incluindo perda de filesystem entreRPCs com restore e uma única decisão, e ACK perdido após checkpoint comprometido. Tipos passaram. Revisão final/CI/implantação desse delta continuam gates separados.

O prazo do Root recuperado permanece original; não se renova nem cria descendente para contorná-lo. A projeção poderá ser reparada pelo rebuild existente em `replay_only`: cache ausente recusa sem adapter/reserva nova. Nenhum rebuild real foi executado nesta etapa, nenhuma proposta foi publicada e não houve notificação Telegram.

O censo17:54:11UTC registrou56.562microUSD comprometidos globalmente,40.000incertos históricos e1.252novos liquidados. Infraestrutura permanece fora desse ledger. #140/#48 continuam abertas.

Antes da implantação69e, a revisão independente verificou CAS do predecessor, SHA256 bruto do ledger, unicidade de plano por linhagem, período/cap fixos e separação entre gate financeiro de criação e replay após gasto. Uma omissão nos scans globais do replay reservado foi corrigida antes da composição. Passaram120casos dirigidos; após o CAS de planos irmãos passaram14casos de recuperação e o integrado, além de tipos/build/6checks do operador. Essas provas sintéticas antecedem a CI e a ingestão real descritas acima; não demonstram por si só operação Telegram.

## Gates restantes e custos

#140 permanece aberta: ainda falta decisão cloud atual pelo diário normal. #48 continua dependente de notificação e callbacks reais nos tópicos privados. Nenhuma proposta, recibo de modelo ou assessment humano foi inserido por SQL. Não houve WhatsApp automático ou escrita Calendar.

O censo das bases próprias conhecidas anterior ao ensaio registrou 55.310microUSD comprometidos, incluindo40.000incertos; a geração própria continuou sem reservas de modelo na observação da falha. Conta/teto/histórico não foram reconfigurados. Infraestrutura e fatura permanecem separados do ledger de inferência. Não se declara prontidão integral ou qualidade longitudinal.
