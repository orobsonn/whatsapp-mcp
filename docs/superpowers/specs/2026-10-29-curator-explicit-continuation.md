# Retomada explícita da revisão diária

A solicitação administrativa aponta uma diária existente e seu recibo anterior exato: NATIVE_CURATOR_RESUME_REQUEST contém runId e previousSubmissionId. Não cria janela/sample/clock nem recuperação automática genérica. O modelo e o conteúdo recebido não concedem essa autorização.

O host procura o predecessor pelo recibo exato na mesma diária, sessão, escopo e grant atuais. Calcula uma única próxima revisão. Antes da criação, a revisão máxima deve ser a do predecessor; para replay da próxima já criada, a máxima deve ser essa próxima. Qualquer revisão posterior invalida a configuração antiga. O número calculado deve ser inteiro seguro. Cron com a mesma configuração nunca incrementa a sequência.

Identidade atual, corpo original, fonte, janela, autorização, hash e recibo são conferidos. A primeira admissão observa settlement pela API pública Flue, com UID antes/depois e prazo externo. Somente failed/aborted confirmados permitem a próxima revisão. Config ausente/alterada, pausa/hold, contexto tombstoned e autorização mudada impedem transporte. Não há MCP/endpoint, namespace, schema ou infraestrutura novos.

Cada revisão tem taskRef/idempotencyKey determinística. Replay procura a próxima já persistida antes de observar o predecessor; pending/dispatching/uncertain reutilizam a mesma identidade. Outra retomada exige outra seleção administrativa explícita do recibo terminal mais recente. O claim/transporte nativos permanecem idempotentes. ReconcileReady e status conservam operações/contabilidade; finish não é antecipado. Recibos e avisos anteriores permanecem históricos; a outbox0051 original conserva seu filtro revision1.

Antes e depois de uma retomada, auditar todos os recibos financeiros da sessão, inclusive os turnos de compactação que não aparecem como mensagens canônicas. Failed não prova zero chamadas. A compactação usa os padrões do Flue; o host mantém o limite efetivo de saída8192 e o controle global de custo. Diagnósticos registram apenas estágio/status/enums conhecidos, nunca resposta privada ou prosa do provedor.

Aceite: observar SDKterminal, cobertura atual, custos e aviso Telegram separadamente. Completed não comprova cobertura. Manter a configuração até o settlement e removê-la depois, conservando schedule03:00 America/Fortaleza, modoapproval e autonomiaOFF. Uma tentativa bloqueada ou incerta não autoriza limpar reservas.

A entrega inicial29/10 implementou revision1→2 e fechou com SDKcompleted/cobertura parcial/resumo aceito na evidência173. Em30/10, a falha posterior exigiu remover a restrição arbitrária à revisão2; a atualização conserva a seleção explícita e impede incremento automático. Testes dirigidos cobrem replay/ACK perdido, predecessor concluído ou desconhecido, UID/grant/pausa/retirada, concorrência e seleção antiga. Evidências174 e175 distinguem protocolo controlado e comportamento real.
