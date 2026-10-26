### Resumo + por quê
Executar perfis dono e interlocutor isolados no Flue. Parte da construção autorizada até piloto sombra, requisito 9 de `docs/construcao-assistente/PRD.md`.

### User journeys
#uj-9: o dono acompanha e dirige sua assistente com contexto verificável, estado persistente e efeitos limitados ao piloto.

### Critérios de aceite (testáveis e observáveis)
- #ac-9.181: Segredo do dono não aparece no input do atendimento.
- #ac-9.182: IDs estáveis por job.
- #ac-9.183: correção revoga episódio.
- #ac-9.184: excesso de contexto reconstrói com checkpoint canônico.
- #ac-9.185: filho privilegiado não pode ser criado.

- #ac-9.186: latch persistente por episódio bloqueia callbacks com payload novo após subcall incerta; paid truth permanece.
- #ac-9.187: stream é bufferizado até revalidar fonte/origem/conversa/workFence, sem delta antecipado; task e ferramentas inesperadas são negados antes de executar.
- #ac-9.188: dispatch aceito não comprova processamento; ACK perdido mantém identidade estável sem redispatch cego.

### Escopo
Pode: assistant/agent/ assistant/agent-runtime/ assistant/migrations/0013_episodes.sql assistant/queue.ts assistant/jobs.ts assistant/model-broker.ts assistant/app.ts assistant/env.ts tests/assistant-episodes.test.ts tests/assistant-jobs.test.ts tests/assistant-model-broker.test.ts. Configuração dedicada de teste/Vitest e fixtures existentes quando o guard de fila passar a depender da migração de episódios. O contrato de busca #100 será integrado, sem versionar stub dessa entrega. Documentação/evidências específicas da entrega, CHANGELOG e versionamento da release minor correspondente.
Não pode: modificar Elo; copiar dados/segredos reais; ativar envio WhatsApp ou escrita Calendar pela assistente; substituir testes integrados por resultados antigos do laboratório.

### Decisões já resolvidas (opcional)
Decisões travadas (do operador — respeitar): piloto sombra; Cloudflare pessoal; privados por padrão com exclusões; Telegram privado com tópicos; engenharia autônoma; uma release minor por issue concluída.
Suposições do modelo (atacáveis): decomposição e paths previstos, limites iniciais e mecanismo técnico do PRD. Rever se evidência exigir sem reduzir requisito.

### Dependências
```harness-deps
#100
#36
#79
#93
#96
#37
#42
#43
```

### Domínio sensível?
auth/sessão

### Prioridade
P1

### Tamanho estimado
M

### Verificação e entrega
Teste de efeito observável antes/depois da implementação, check/suíte/build e revisão independente proporcional ao risco (FULL para domínio sensível). Confirmar CI no commit entregue antes do merge/release. Alvo ~650 linhas de implementação autoral, testes e lock separados. A integração atômica de fila/broker/slots e o runtime real são inseparáveis para comprovar orçamento, isolamento e incerteza; se exigir decomposição maior, preservar todos os critérios em issues explícitas. Release minor após conclusão, tag no commit integrado, evidências e issue fechada somente com aceite cumprido.

Padrão consultado: orobsonn/claude-harness@b01a528f017c16188991977485af1e36fa5e922e, form `core/github/ISSUE_TEMPLATE/harness-task.yml`, skill/rule `creating-issues`. Uso da lógica sem instalar harness neste repositório.
