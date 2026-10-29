# Retomada explícita da revisão diária

Robson pediu em29/10: disparar uma revisão diária agora e conferir o resultado. A janela diária real28/10 já existe (0,3679], mas seu recibo SDK original está definitivamente failed. Repetir o disparo original devolve esse recibo, sem novo trabalho.

Revisão adversarial antes do código restringiu a solução a uma continuação administrativa revision1→revision2, na mesma sessão e janela. Não é recuperação automática genérica. Config privada estrita NATIVE_CURATOR_RESUME_REQUEST liga runId ao previousSubmissionId original. O operador audita antes os turnIds da submission e os recibos financeiros: neste predecessor específico1 turn/0 recibos de modelo/0 ferramentas. Failed sozinho não é essa prova.

O host confere run diário/escopo/identidade atual/grant e recibo originais; observa settlement pela API pública Flue, com UID antes/depois e prazo externo. Só failed/aborted confirmados podem iniciar a revisão2. Config ausente/alterada, pausa/hold, contexto tombstoned ou autorização mudada impedem transporte. Conteúdo/modelo não cria essa autorização. Não há MCP, endpoint, namespace, schema ou infraestrutura novos.

A revisão2 tem identidade de entrega determinística própria. Replay procura o registro2 antes de observar o predecessor; pending/dispatching/uncertain reutilizam a mesma taskRef/idempotencyKey. A configuração não seleciona receipt2 como predecessor e não permite revisão3. ReconcileReady e status preservam operações/contabilidade anteriores; finish não é antecipado. O recibo1 e sua outbox0051 permanecem históricos e explicitamente filtrados revision1.

Aceite: observar o novo SDK terminal, a cobertura atual, custos e aviso no Telegram separadamente. Completed do SDK não comprova cobertura. Manter a config até o novo settlement e removê-la depois, preservando o schedule03:00 America/Fortaleza, modoapproval e autonomiaOFF. Não mudar clock nem criar sample para fingir a revisão solicitada.

8 testes RED demonstraram a funcionalidade ausente; os casos dirigidos de retomada, replay, ACK incerto, predecessor inconclusivo/UID diferente, grant/pausa/retirada, concorrência e fim contábil acompanharam a implementação. Suite combinada121/121, TypeScript e buildOwn passaram. Revisão adversarial final do diff sem Critical/Important. A prova real permanece pendente até o disparo observado.
