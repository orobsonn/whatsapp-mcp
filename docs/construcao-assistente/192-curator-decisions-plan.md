# Curadoria por passagem e diário de decisões

Pedido aprovado pelo dono em 31/10/2026: contexto novo por passagem, continuidade da mesma sessão na retomada, infraestrutura de decision log e resumos úteis no Telegram. Sem auditor automático ou benchmark nesta entrega.

## Desenho e revisão adversarial

- Principal privado por dono/passagem; vínculo imutável de identidade/sessão antes de registro. Legado continua retomável pela sessão histórica. Grafo compartilhado não muda.
- Diário específico pequeno, vinculado à fonte/versionamento e passagem. Resumo, categoria e motivo breves declarados pelo modelo; efeito confirmado pelas operações existentes. Não copia originais, contexto integral ou raciocínio interno.
- Propostas de aprendizado registradas antes da escrita externa. Falha posterior conserva operação para reconciliação; confirmação não depende de o modelo copiar o identificador corretamente.
- Ack e diário compartilham a transação e os guards de acesso/versão. Retirada limpa textos derivados. Consultas, turnos e custos continuam em seus rastros existentes, correlacionados pela sessão/tarefa.
- Telegram: cobertura, exemplos limitados do que guardou/não guardou, motivos e referência curta; pendências técnicas separadas de solicitação humana concreta. Histórico sem motivo é explicitamente desconhecido. Sem chamada adicional ao modelo.
- Adversário apontou que grantRef varia por principal: reconciliador deve filtrar dono/vínculo/origem atuais e validar cada grant, sem perder proteção contra autorizações antigas antes do LIMIT.

## Plano de execução

- [x] Sessões: teste focado de dois dias/replay, vinculação CAS, política e reconciliação; implementar sem invalidar legado.
- [x] Diário: migração, ack transacional, registro da intenção de escrita e metadados; teste de recusa/retirada/reconciliação.
- [x] Resumo: exemplos escapados/limitados, causas operacionais e ação humana explícita; adaptar teste de envio único.
- [ ] Verificar tipos, testes afetados, suíte e builds; revisão independente do delta; release por marco e deploy direto já autorizado, com leitura de versão/migração e smoke.

## Evidência da implementação

Três testes novos: duas passagens/sessões com replay, diário com recusa e retirada, e ajuda com pergunta explícita. Testes existentes adaptados para resumo concreto e duas operações reais na mesma evidência. Não foi criada bateria semântica, auditor ou plataforma adicional.

A revisão independente encontrou perda de operações adicionais da mesma fonte; corrigida agregação dos intentos/recibos e proteção contra uma confirmação concorrente substituir IDs já confirmados. Resumos mostram até três exemplos por grupo e assumem esse limite explicitamente.

O histórico de cada passagem continua retido sob os mecanismos existentes; contexto fresco não promete exclusão automática do histórico. O diário é autorrelato semântico associado a efeitos comprovados, não nota de qualidade. Consultas/turnos/custos permanecem nos rastros existentes da sessão. `decisions` oferece leitura privada paginada para a infraestrutura; não foi criado painel ou auditor.
