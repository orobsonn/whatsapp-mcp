# Orientação real do dono e validade do envio aprovado

Em30/10/2026 uma mensagem individual real foi admitida pela captura e executada pelo Flue. O agente buscou o arquivo autorizado, corrigiu uma chamada de agenda rejeitada por formato ISO e consultou a agenda com sucesso. Por faltar uma decisão pessoal, solicitou orientação no Telegram. O dono respondeu usando o vínculo da pergunta. O domínio registrou `resumed`, admitiu a continuação na mesma sessão WhatsApp e o agente chamou `propose_reply`; uma nova sugestão foi enviada ao Telegram. Isso comprova o caminho positivo de ajuda e retomada, sem confundir orientação com aprovação de envio.

O dono clicou em aprovar. O callback autenticado e a autoridade foram persistidos, mas a ação Source permaneceu `proposed`, sem aprovação Source, tentativa ou ID do provedor. A validação falhou antes do claim, sem enviar mensagem. A reconciliação somente consultou esse mesmo registro.

## Causa e correção

O Source capturava `Date.now()` antes de aguardar a autorização do Own. O Own emite uma prova curta ao terminar suas verificações. Após uma consulta lenta, a validade recém-emitida parecia exceder o limite futuro de10s calculado sobre o horário antigo. O mesmo código também podia aceitar uma prova já vencida durante a consulta.

A correção mede o horário imediatamente depois do retorno nos ramos nativo e legado. Conserva validade curta, limite futuro, igualdade da autoridade/hash/ação, prova de atividade/destino, SQL final de expiração e claim único Source. Revisão adversarial não apontou Critical/Important.

## Verificação

Seis cenários dirigidos: nativo/legado com RPC de13s e prova emitida ao final, prova vencida em trânsito e prova excessivamente futura. Antes da correção, quatro falharam e dois passaram, reproduzindo as duas falhas do contrato. Depois, os35testes dos dois arquivos de envio aprovado/nativo passaram; typecheck e build Source passaram.

## Publicação e consequência real

O Source foi publicado em100% na versão `35d1339e-6d84-4840-8003-53f3407ac6c9`, código `0d4556c`, preservando bindings, runtime, agendamento e configuração. Own não foi alterado e autonomia permanece desligada.

A execução anterior falhou antes da tentativa. Usando proxy local Wrangler para o binding RPC já existente, o operador conferiu que a mesma ação continuava `proposed` e vigente, e invocou `executeNative` com a autoridade humana já gravada. Não criou outra ação, não renovou prazo, não alterou texto/destino nem contornou as provas do Own. O Source aceitou uma tentativa em30/10 às23:26:18UTC, canal de aprovação `native_telegram_owner`, com ID do provedor e sem erro. O proxy foi encerrado. Isso foi uma retomada operacional após a correção, não um callback ininterrupto bem-sucedido desde a primeira tentativa.

A captura Source identificou uma única mensagem enviada com o ID do provedor e texto exatamente igual ao envelope aprovado. Na leitura registrada, o estado era aceito/enviado; entrega e leitura não foram comprovadas. O segundo clique real foi solicitado apenas para reconciliação e verificação de ausência de nova mensagem, ainda sem resultado nesta escrita.

Censo posterior:6.463.799microUSD nos ledgers conhecidos, incluindo796.754em reservas e381.277incertos preservados. A provisão externa separada de133.000leva o controle conservador a6.596.799, saldo3.403.201contra o teto histórico de10.000.000microUSD. Não é fatura nem estimativa mensal. Recibos privados preservam a correlação sem publicar conteúdo pessoal.
