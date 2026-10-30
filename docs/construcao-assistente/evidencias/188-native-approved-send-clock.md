# Orientação real do dono e validade do envio aprovado

Em30/10/2026 uma mensagem individual real foi admitida pela captura e executada pelo Flue. O agente buscou o arquivo autorizado, corrigiu uma chamada de agenda rejeitada por formato ISO e consultou a agenda com sucesso. Por faltar uma decisão pessoal, solicitou orientação no Telegram. O dono respondeu usando o vínculo da pergunta. O domínio registrou `resumed`, admitiu a continuação na mesma sessão WhatsApp e o agente chamou `propose_reply`; uma nova sugestão foi enviada ao Telegram. Isso comprova o caminho positivo de ajuda e retomada, sem confundir orientação com aprovação de envio.

O dono clicou em aprovar. O callback autenticado e a autoridade foram persistidos, mas a ação Source permaneceu `proposed`, sem aprovação Source, tentativa ou ID do provedor. A validação falhou antes do claim, sem enviar mensagem. A reconciliação somente consultou esse mesmo registro.

## Causa e correção

O Source capturava `Date.now()` antes de aguardar a autorização do Own. O Own emite uma prova curta ao terminar suas verificações. Após uma consulta lenta, a validade recém-emitida parecia exceder o limite futuro de10s calculado sobre o horário antigo. O mesmo código também podia aceitar uma prova já vencida durante a consulta.

A correção mede o horário imediatamente depois do retorno nos ramos nativo e legado. Conserva validade curta, limite futuro, igualdade da autoridade/hash/ação, prova de atividade/destino, SQL final de expiração e claim único Source. Revisão adversarial não apontou Critical/Important.

## Verificação

Seis cenários dirigidos: nativo/legado com RPC de13s e prova emitida ao final, prova vencida em trânsito e prova excessivamente futura. Antes da correção, quatro falharam e dois passaram, reproduzindo as duas falhas do contrato. Depois, os35testes dos dois arquivos de envio aprovado/nativo passaram; typecheck e build Source passaram.

Publicação e envio real ainda precisam de confirmação. Não renovar aprovação expirada, modificar prazo por SQL ou criar outro envio para contornar o resultado. Recibos privados preservam a correlação sem publicar conteúdo pessoal.
