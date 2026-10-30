# Recuperação nativa da curadoria

## Defeito observado

A continuação real da revisão diária releu fontes disponíveis e deixou trabalho apresentado, ainda sem avaliação. Duas gerações DeepSeek terminaram com recibos completos, totalizando74.762microUSD calculados. Os resultados das três consultas seguintes de mídia foram persistidos como pendentes. O SDK encerrou a execução com `submission_retry_exhausted`, tentativa1 de1. Isso comprova que a nossa configuração impediu recuperação; a causa original da interrupção não foi confirmada.

A execução encerrada não foi reiniciada nem seus recibos modificados. O seletor temporário foi removido após o encerramento.

## Correção delimitada

O perfil nativo `conversation-runtime` passa a herdar a política de recuperação do SDK Flue instalado: até10tentativas, incluindo a inicial. O prazo operacional também continua sendo o padrão do SDK. Os perfis legados não foram alterados.

Uma nova geração legítima pode ter custo adicional. Cada chamada continua exigindo reserva e recibo, preservando os custos incertos. A recuperação não autoriza envio: propostas e efeitos externos mantêm suas chaves, reconciliação e aprovação humana. Autonomia continua desligada.

Revisão adversarial explícita aprovou essa remoção pontual. Typecheck passou e build Own concluiu. Não foi criada bateria adicional de testes. A correção foi publicada no Own em100% na versão `124cb1b2-8548-439a-b34a-93cfab20b21f`, com confirmação da versão ativa, bindings, modo aprovação e agendamento preservados. A conclusão da próxima continuação real ainda precisa de evidência; este documento não declara a revisão diária concluída.

## Demora observada na continuação

A continuação seguinte foi admitida e o SDK confirmou a política nativa de10tentativas. A leitura de anexos expôs um amplificador local: `MediaContext.fresh` fazia a mesma conferência completa de autoridade antes e depois de reler a fonte. Como a conferência nativa percorre as dependências acumuladas, os diagnósticos registraram várias varreduras de segundos dentro de uma única operação de mídia. Isso não atribui toda a duração ao modelo nem confirma a causa da interrupção anterior.

O ajuste remove somente a primeira conferência. A releitura da fonte, o RPC de origem, a conferência completa posterior e o SQL final permanecem. Não há cache de autorização, remoção de proteção na construção das capacidades ou mudança do orçamento. O outro caller de produção, legado, não injeta esse callback e conserva seu comportamento.

A regressão de leitura pública de mídia em cache falhou antes da correção e passou depois: uma conferência global após cada prova da fonte, sem nova inferência. Mais três casos dirigidos passaram, incluindo retirada da fonte ou contexto dentro do último await da autorização de gasto. Typecheck e build Own passaram; revisão adversarial do diff não encontrou Critical/Important. O ajuste ainda não foi publicado na execução ativa, e nenhum ganho de latência em produção foi anunciado.

## Retorno de anexo pendente e leitura indisponível

A continuação consultou arquivos distintos e recebeu `media_attachment_pending`. Em dois casos conferidos sem leitura dos corpos, o Source tinha imagem pronta, objeto, hash e versões/tipo compatíveis; o Own também tinha o arquivo na mesma conversa e namespace. Esses metadados não comprovam o resultado do snapshot remoto executado antes, nem permitem atribuir a falha a um timeout.

O retorno antigo reunia observação indisponível, tipo não suportado, anexo ausente e projeção ausente. A correção distingue essas situações no caminho existente: falha do snapshot devolve `caption_snapshot_unavailable` com motivo normalizado; tipo não suportado é explícito; ausência do anexo e da projeção permanecem pendências diferentes. Não há nova rota, alteração de prazo, relaxamento de autorização ou inferência adicional para diagnosticar.

Os dois casos dirigidos, com e sem legenda, reproduziram prova inicial válida seguida de falha independente da observação: antes eram anunciados como anexo pendente; depois retornaram indisponibilidade com `reader_timeout`, sem segunda chamada de modelo. Ambos passaram após a correção, assim como typecheck/build e revisão adversarial. Isso comprova o contrato do diagnóstico; não comprova que os casos reais tiveram esse motivo. Este ajuste também aguarda o encerramento da execução ativa para publicação.
