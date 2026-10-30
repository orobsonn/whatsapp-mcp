# Recuperação da captura sem esgotamento definitivo

30/10/2026. Ao acompanhar a legenda indisponível, a leitura do D1 real demonstrou entradas antigas cujo resultado de materialização estava `blocked/attempts=3`. A admissão nativa continuava revisitando esses itens, mas o gate de materialização impedia a quarta tentativa mesmo se o Source voltasse a responder. Isso ocupava a fila de recuperação sem possibilidade de progresso.

O código `3779c74` remove o teto vitalício, mantém cada tentativa no recibo original e agenda novas falhas com backoff exponencial até uma hora. O intervalo é pacing de leitura, não perda de acesso ao acervo. O prazo é conferido antes de chamar Source e no CAS; o cron não seleciona materializações ainda em espera. Não houve alteração do lote operacional nem prioridade artificial para um caso de aceite.

Uma entrada bloqueada que recupera conteúdo também precisa conferir atividade atual antes de ser admitida. Resposta manual ou entrada posterior comprovada deixa a tarefa `superseded`; falha da prova permanece indisponibilidade, sem inferência por suposição.

Quatro regressões dirigidas passaram: recuperação na quarta tentativa, zero leitura antes do prazo, recuperação após resposta manual sem dispatch e cron sem ocupar slot com item em backoff. Typecheck e build Own passaram. Revisão adversarial não encontrou Critical/Important restante no delta. Não se executou outra suíte local completa.

Publicado no Own em100% na versão `10dc3ffe-d952-4064-9a2a-e886f53019e0`, com bindings/runtime/schedule preservados e autonomia desligada. O readback real do D1 encontrou recibos na quarta tentativa com intervalo de8.000ms, demonstrando que o veto antigo não continuava ativo. Outras duas projeções terminaram `applied`; isso não significa que toda a fila ou a legenda observada já foram recuperadas. A legenda continuava na revisão1 nessa conferência.

Nenhum custo ou resultado incerto foi apagado. Não houve criação de mensagem de teste, envio WhatsApp, alteração de política de captura ou contratação. Os metadados completos e contagens pessoais ficam no diretório privado. A prova de imagem real e o limite da recuperação de sua legenda permanecem na evidência185.
