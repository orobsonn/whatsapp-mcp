# Autoridade durável da inbox Telegram — plano parcial da #144

> **For agentic workers:** executar inline com superpowers:executing-plans e TDD. Esta unidade não conclui a #144.

**Goal:** admitir uma única execução por mensagem atual do dono, sem conceder autoridade após revogação, retenção ou expiração.

**Architecture:** duas sidecars operacionais guardam ativação e tentativa, sem texto nem provas de fontes. Um handle nominal em memória permite construir o guard na mesma admissão downstream. O relógio SQL vigente expira até um guard obtido antes de um await.

**Tech Stack:** TypeScript, Workers/D1, SQLite e Vitest existentes, sem novas dependências.

**Spec:** telegram-owner-inbox-design.md; esta é só a primeira unidade desse desenho ainda em evolução.

## Global Constraints

- Não ativar consumidor, cron, modelo, provider ou envio nesta unidade.
- WhatsApp sem envio automático; Calendar sem escrita. Nenhuma alteração no Elo.
- Manter registros anteriores, custos e recibos incertos. Não drenar backlog.
- Metadados novos entram no adaptador de retenção, export com tokens redigidos, fora do snapshot restaurável.
- A conclusão da #144 ainda exige executor natural, consultas/ensino/missões/políticas, outbox com retenção, Flue/orçamento e homologação real.

## Review Focus

- Mesmo update concorrente: uma execução; estados terminais não admitem reclaim.
- Mensagem velha entregue depois da ativação: corte de data da mensagem e do recebimento.
- Revogar/revincular ou mudar origem/thread/payload: guard antigo nega.
- Guard guardado durante await: prazo vence no relógio SQL, sem depender de sweep.
- Finish concorrente ou ACK perdido: original e sidecar mudam juntos ou nenhum muda; recibo não readmite execução.

## Unidade 1 — inbox/autoridade, sem efeitos externos

Files: criar assistant/telegram-owner-inbox.ts, assistant/migrations/0028_telegram_owner_inbox.sql e tests/assistant-telegram-owner-inbox.test.ts; adaptar assistant/retention.ts e assistant/retention-purge.ts.

- [ ] RED: teste comportamental com vínculo real via TelegramLink, ativação e duas mensagens em torno do corte; só mensagem posterior admite claim uma vez.
- [ ] GREEN: TelegramOwnerInbox(db, affinity, bot).activate() persiste corte imutável por revisão; claim(updateId) retorna handle nominal ou null. SQL deriva identidade do registro original e vínculo ativo.
- [ ] RED/GREEN: concorrência, duplicata com payload diferente, revogação entre await e admissão, revisão nova, escopo/origem/thread diferentes, hold de retenção e geração ativa diferente.
- [ ] RED/GREEN: guard(handle) inclui token e pins internos + texto original comparado, original pending, ativação, vínculo, retenção e prazo via relógio SQL. Handle JSON não concede autoridade.
- [ ] RED/GREEN: complete(handle) usa nonce vencedor fresco no mesmo batch para concluir sidecar e update. Falha no segundo statement reverte ambos. Retry após ACK perdido não cria trabalho.
- [ ] RED/GREEN: expire(updateId) marca uncertain sem remover/recriar tentativa. Testar o MESMO guard após prazo físico curto, antes de expire.
- [ ] RED/GREEN: export completo preserva metadados, redige token/update_token/finish_token antes de hash; purga de fonte não fica bloqueada por schema novo; canonical snapshot exclui sidecars.
- [ ] Verificar testes focados e types. Registrar resultados e commit parcial, sem release ou alegação de piloto pronto.

## Unidade 2 — admissão nos controllers existentes

Files: assistant/control.ts, assistant/sources.ts, assistant/retention-barrier.ts, assistant/command-ledger.ts; tests/assistant-telegram-owner-control.test.ts e tests/assistant-outgoing.test.ts.

- [x] RED: missão e fontes ainda eram alteradas após revogar Telegram no await anterior à admissão; APIs diretas também ignoravam a restrição. Nove contraprovas falharam pelo efeito indevido.
- [x] GREEN: callback host-only admission em OwnerControl/SourceController, composto com as precondições no ledger.admit; APIs diretas do SourceController com callback exigem execute/ledger, antes de preparação/acesso externo/escrita.
- [x] Testar witness exato de retirada inicialmente admitida: revogar durante retirement.withdraw e perder ACK final; concluir/reler o recibo sem outra revisão/barreira nem nova execução externa. Settlement histórico é exceção ao fresh guard; nunca readmite trabalho.
- [x] Exercitar FUP de iniciativa sombra com projeto, missão, mandato e guard Telegram sob limite de parâmetros D1. RED:107 parâmetros; GREEN: reutilizar compactStatement existente na admissão do CommandLedger, sem remover predicados.
- [ ] Verificação geral, types e revisão do diff completo. Unidades 1/2 não consomem mensagens em produção nem completam #144.

O limite de 100 parâmetros por query foi conferido na documentação oficial [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/). O teste aplica esse limite à fronteira de bind enquanto executa o controller e o banco reais.

## Resultados e rulings desta implementação parcial

- Activação/claim/guard/finish e fronteiras de retenção passaram inicialmente em57 testes focados (20 inbox + existentes de link/purga). Types passaram.
- Revisão encontrou P2 de texto lido depois do claim. Contraprova reproduziu adoção indevida da edição; correção retorna texto transitório pelo RETURNING do MESMO INSERT. Não há segunda consulta nem nova cópia persistida de corpo. Contraprova passou após correção.
- A primeira execução da suíte geral foi interrompida explicitamente para aplicar essa correção; não é evidência verde.
- A execução geral seguinte reportou três falhas locais e foi interrompida após34min: inbox/revogação, inbox/expiração e Source.change_audience. Os três casos passaram em reprodução focada, sem alteração de código; causa indeterminada. Esse resultado permanece pendente de confirmação na suíte completa de CI, não foi apagado nem tratado como sucesso.
- No estado atual,140 testes de7 arquivos nas fronteiras alteradas passaram, incluindo os33 testes novos de inbox/controle, os37 de iniciativa sombra e as suítes de fontes/controle/retenção. Types passaram; a CI do branch ainda precisa concluir a cobertura geral/native/OAuth/build/audit.
- Guard expira pelo relógio SQL vigente, mesmo quando construído antes de um await. Token do handle só fica em WeakMap privado, sem JSON como autoridade.
- Ruling: manter esta entrega no branch de trabalho, sem ativar o consumidor ou publicar release parcial. O aceite completo exige as unidades abaixo e prova real no bot.

## Próximas unidades obrigatórias

1. Fechar/atacar o contrato de execução natural sobre leitores/controllers e Flue/broker, com guard atual no mesmo batch de cada efeito. Não transmitir handles/tokens ao modelo nem converter perguntas em fatos.
2. Outbox finita de resposta própria e fechamento de purga/frescor de conteúdo e suas fontes, incluindo ACK perdido/tardio; não usar fake journal/summary.
3. Consumidor bounded para mensagem nova sob pausa global, sem backlog histórico; confirmar linguagem natural, ensino e controle com recibos reais no bot próprio.
4. Revisão de branch, CI exata, release minor consistente, deploy preservando bindings e homologação real. Só então fechar #144 e auditar novamente o objetivo completo.

## Revisão adversarial recebida

owner_once_occam_review considerou esta unidade adequada como avanço parcial e exigiu as contraprovas acima. As duas sidecars são somente metadados: o adaptador de retenção não pode ser reutilizado como justificativa para guardar texto/resposta/provas no futuro sem purga própria. Check antes de HTTP nunca elimina a corrida com revogação depois da admissão; esta unidade não faz HTTP.

Revisão fresca telegram_owner_authority_review examinou o diff contra42ff00e e os arquivos novos e não identificou P1/P2 concreto nas unidades1/2. Foi revisão estática, sem executar suíte; as três falhas da geral e a cobertura de runtime/provedor continuam pendentes. Isso não constitui aceite de #144.
