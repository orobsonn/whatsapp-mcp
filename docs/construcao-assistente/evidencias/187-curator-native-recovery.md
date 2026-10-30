# Recuperação nativa da curadoria

## Defeito observado

A continuação real da revisão diária releu fontes disponíveis e deixou trabalho apresentado, ainda sem avaliação. Duas gerações DeepSeek terminaram com recibos completos, totalizando74.762microUSD calculados. Os resultados das três consultas seguintes de mídia foram persistidos como pendentes. O SDK encerrou a execução com `submission_retry_exhausted`, tentativa1 de1. Isso comprova que a nossa configuração impediu recuperação; a causa original da interrupção não foi confirmada.

A execução encerrada não foi reiniciada nem seus recibos modificados. O seletor temporário foi removido após o encerramento.

## Correção delimitada

O perfil nativo `conversation-runtime` passa a herdar a política de recuperação do SDK Flue instalado: até10tentativas, incluindo a inicial. O prazo operacional também continua sendo o padrão do SDK. Os perfis legados não foram alterados.

Uma nova geração legítima pode ter custo adicional. Cada chamada continua exigindo reserva e recibo, preservando os custos incertos. A recuperação não autoriza envio: propostas e efeitos externos mantêm suas chaves, reconciliação e aprovação humana. Autonomia continua desligada.

Revisão adversarial explícita aprovou essa remoção pontual. Typecheck passou e build Own concluiu. Não foi criada bateria adicional de testes. A publicação e a conclusão da próxima continuação real ainda precisam de evidência; este documento não declara a revisão diária concluída.
