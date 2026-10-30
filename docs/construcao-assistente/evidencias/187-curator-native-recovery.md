# Recuperação nativa da curadoria

## Defeito observado

A continuação real da revisão diária releu fontes disponíveis e deixou trabalho apresentado, ainda sem avaliação. Duas gerações DeepSeek terminaram com recibos completos, totalizando74.762microUSD calculados. Os resultados das três consultas seguintes de mídia foram persistidos como pendentes. O SDK encerrou a execução com `submission_retry_exhausted`, tentativa1 de1. Isso comprova que a nossa configuração impediu recuperação; a causa original da interrupção não foi confirmada.

A execução encerrada não foi reiniciada nem seus recibos modificados. O seletor temporário foi removido após o encerramento.

## Correção delimitada

O perfil nativo `conversation-runtime` passa a herdar a política de recuperação do SDK Flue instalado: até10tentativas, incluindo a inicial. O prazo operacional também continua sendo o padrão do SDK. Os perfis legados não foram alterados.

Uma nova geração legítima pode ter custo adicional. Cada chamada continua exigindo reserva e recibo, preservando os custos incertos. A recuperação não autoriza envio: propostas e efeitos externos mantêm suas chaves, reconciliação e aprovação humana. Autonomia continua desligada.

Revisão adversarial explícita aprovou essa remoção pontual. Typecheck passou e build Own concluiu. Não foi criada bateria adicional de testes. A correção foi publicada no Own em100% na versão `124cb1b2-8548-439a-b34a-93cfab20b21f`, com confirmação da versão ativa, bindings, modo aprovação e agendamento preservados. A conclusão da próxima continuação real ainda precisa de evidência; este documento não declara a revisão diária concluída.

## Demora observada na continuação

A continuação seguinte foi admitida e o SDK confirmou a política nativa de10tentativas. Os diagnósticos de leitura de anexos registraram várias conferências completas do contexto, cada uma de vários segundos. A análise de código também encontrou uma duplicação dentro de `MediaContext.fresh`. Porém, os retornos pendentes observados saíram antes desse método: nele não está a causa comprovada da demora dessas chamadas. As camadas anteriores continuam conferindo o contexto. Isso não atribui toda a duração ao modelo nem confirma a causa da interrupção anterior.

O ajuste remove somente a primeira conferência. A releitura da fonte, o RPC de origem, a conferência completa posterior e o SQL final permanecem. Não há cache de autorização, remoção de proteção na construção das capacidades ou mudança do orçamento. O outro caller de produção, legado, não injeta esse callback e conserva seu comportamento.

A regressão de leitura pública de mídia em cache falhou antes da correção e passou depois: uma conferência global após cada prova da fonte, sem nova inferência. Mais três casos dirigidos passaram, incluindo retirada da fonte ou contexto dentro do último await da autorização de gasto. Typecheck e build Own passaram; revisão adversarial do diff não encontrou Critical/Important. Nenhum ganho de latência em produção foi anunciado: remover essa duplicação beneficia as etapas que alcançam `fresh`, sem explicar os retornos que saíram antes dele.

## Retorno de anexo pendente e leitura indisponível

A continuação consultou arquivos distintos. A leitura agregada dos recibos, sem os corpos, confirmou14resultados `available/derived_media_observations` e11`media_attachment_pending` nessa conferência. A amostra anterior dos últimos retornos não representava todos os arquivos; as interpretações disponíveis alcançaram o caminho completo de percepção, enquanto os retornos pendentes saíram antes de `fresh`. Em dois casos conferidos sem leitura dos corpos, o Source tinha imagem pronta, objeto, hash e versões/tipo compatíveis; o Own também tinha o arquivo na mesma conversa e namespace. Esses metadados não comprovam o resultado do snapshot remoto executado antes, nem permitem atribuir a falha a um timeout.

O retorno antigo reunia observação indisponível, tipo não suportado, anexo ausente e projeção ausente. A correção distingue essas situações no caminho existente: falha do snapshot devolve `caption_snapshot_unavailable` com motivo normalizado; tipo não suportado é explícito; ausência do anexo e da projeção permanecem pendências diferentes. Não há nova rota, alteração de prazo, relaxamento de autorização ou inferência adicional para diagnosticar.

Os dois casos dirigidos, com e sem legenda, reproduziram prova inicial válida seguida de falha independente da observação: antes eram anunciados como anexo pendente; depois retornaram indisponibilidade com `reader_timeout`, sem segunda chamada de modelo. Ambos passaram após a correção, assim como typecheck/build e revisão adversarial. Isso comprova o contrato do diagnóstico; não comprova que os casos reais tiveram esse motivo. A publicação dos dois ajustes foi feita na versão Own `48ef7c69-0437-4a43-a896-ad8ae77c65ae`, código `ddbbc8c`, preservando todos os bindings, o seletor exato da continuação vigente, a mesma identidade/submissão, o modo aprovação e o agendamento. A revisão adversarial aprovou publicar durante a execução, considerando possível interrupção/recuperação e custo adicional dentro dos controles existentes. Não se removeu o seletor nem se criou outra revisão para observar o resultado. Publicação não prova conclusão da curadoria nem desaparecimento da falha; acompanhar o mesmo recibo e os diagnósticos posteriores.

## Autorização da percepção e verificação do histórico

A conferência completa do histórico não é necessária em cada etapa interna de uma interpretação que recebe apenas o próprio arquivo e um prompt fixo. O callback interno passa a conferir identidade, autoridade, coorte/eventos admitidos e regra da tarefa por `assertTaskAuthority`. A fonte do arquivo, sua origem e o guard SQL continuam atuais em cada etapa. `assertTaskCurrent` mantém a conferência completa e chama a mesma verificação de autoridade extraída, sem alteração nos demais usos.

A entrada e a saída da capacidade de mídia continuam com prova completa; exposição, próxima geração que usa histórico e efeitos também mantêm suas provas. A retirada de outra fonte durante a percepção pode tornar seu resultado inutilizável e conservar o custo já ocorrido, mas não permite devolver observações para uso em histórico inválido. A própria imagem continua autorizada antes de envio ao modelo. Não há cache, prazo de validade artificial ou permissão concedida pelo modelo.

No teste isolado dessa capacidade, a leitura completa exigia11conferências globais; com a separação conserva as2externas e faz as verificações internas da tarefa e arquivo. As camadas externas da ferramenta ainda têm suas próprias verificações: não se anunciou que toda a ferramenta em produção faz apenas2. Quatro casos dirigidos passaram, incluindo autoridade/coorte adulteradas, regra da tarefa revogada, tombstone e falha de prova completa posterior sem liberar o resultado. Typecheck/build passaram e a revisão adversarial do diff não encontrou Critical/Important. Ganho de duração em produção ainda não medido.

Após a publicação anterior, a mesma submissão da curadoria foi observada em `running`, tentativa2/10, com o prazo original preservado. Os seis resultados ordinários interrompidos ficaram registrados como desconhecidos pelo SDK, sem conversão em sucesso. Isso comprova recuperação da mesma submissão, sem criar nova revisão ou reabrir recibos. A revisão diária e o resumo ainda precisam de confirmação de término.
