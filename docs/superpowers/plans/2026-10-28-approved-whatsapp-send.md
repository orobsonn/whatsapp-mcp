# Approved WhatsApp Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Execute continuously within the user's authorization.

**Goal:** Analisar novas conversas e enviar exatamente a sugestão aprovada no Telegram.

**Architecture:** Reutilizar scheduler, Flue, Cognee, revisão autenticada e ações Source. Separar recibo humano do conteúdo do modelo; Source detém a tentativa única. Recorte de fontes é uma restrição adicional persistida no pedido de busca.

**Tech Stack:** TypeScript, Cloudflare Workers RPC, D1, Flue, Cognee, Telegram e Z-API existentes.

**Spec:** docs/construcao-assistente/ENVIO-APROVADO.md

## Global Constraints

- Sem envio autônomo, sem copiar credenciais para Own e sem tocar no Elo.
- Nenhum reset de orçamento/geração/recibos; preservar incerteza e histórico.
- Até três fontes textuais/8 KiB; somente mensagens recebidas posteriores ao início do piloto.
- Aprovação humana real sobre texto integral e destinatário exato; simulação antiga não autoriza.

## Review Focus

- ACK perdido ou callback repetido deve conservar a mesma ação e tentativa.
- Destino/conexão alterados durante consulta ao provedor devem falhar no claim final.
- Nova mensagem ou retirada deve invalidar proposta obsoleta.
- Backlog antigo e FUP global não podem escapar pelo scheduler despausado.
- Candidatos semânticos fora do manifesto devem ser recusados.

### Task 1: Source approved-send actuator

**Files:** src/assistant-approved-send.ts; src/approved-send-contract.ts; src/actions.ts; src/env.ts; src/index.ts; migrations/0034_assistant_approved_send.sql (usar próximo número livre); tests/assistant-approved-send.test.ts.

**Interfaces:** `prepare(input)` retorna ação/hash/destino/expiresAt; `execute(input)` consulta `OwnerAssistant.approvedSendAuthorization` e reutiliza a ação; `status(input)` retorna estado/IDs de provedor para reconciliação. Todos exigem segredo dedicado e afinidade explícita.

- [x] Testar idempotência do preparo, concorrência, alvo alterado e incerteza sem repetição; observar falhas antes de implementar.
- [x] Implementar mapping+action atômicos e guard SQL adicional na mesma CAS de executeAction.
- [x] Rodar testes dirigidos e tipos; registrar resultado.

### Task 2: Recorte proativo

**Files:** assistant/proactive-pilot.ts; assistant/scheduler.ts; assistant/access.ts; assistant/retrieval.ts; assistant/retrieval-runs.ts; src/assistant-source-reader.ts; testes dirigidos.

**Interfaces:** manifesto `sourceRefs` normalizado e persistido limita inventory; configuração host seleciona chats, watermark Source e revisão do piloto; `TELEGRAM_SUGGESTIONS_ENABLED` separa sugestões de resumo diário.

- [x] Testar backlog/conversa alheia/fromMe e manifesto imutável; observar falhas.
- [x] Aplicar recorte em descoberta, escolha de item, indexação e busca, preservando fences.
- [x] Manter FUP antigo e diário desligados; rodar regressões relevantes.

### Task 3: Revisão e envio Telegram

**Files:** assistant/telegram-approved-send.ts; assistant/telegram.ts; assistant/telegram-webhook.ts; assistant/mcp.ts; assistant/env.ts; assistant/installation.ts; migração Own; testes de callbacks.

**Interfaces:** `prepareDecision(decisionId)` prepara ação Source e revisão exata; novo callback aceita/descarta; `authorize(approvalId,actionId,hash)` revalida recibo humano, vínculo, proposta e expiração.

- [x] Testar dono/chat/thread/mensagem incorretos, simulação antiga, expiração, duplicata e revogação.
- [x] Mostrar destino/texto integrais e botões explícitos; persistir recibo humano em transação do diário e chamar Source.
- [x] Publicar resultado legível sem confundir accepted/delivered; tipos/builds e revisão independente final.

### Task 4: Homologação e release

- [x] Criar issue e PR do marco, CI do código entregue e revisão independente. `dfa622b`: CI40736247603; ensaio real ainda pendente.
- [x] Implantar preservando bindings/runtime/imagem, com piloto inicialmente pausado. Ativado no recorte de novas mensagens, com resposta autônoma desabilitada.
- [ ] Estabelecer cutoff na fronteira Source e testar conversa real selecionada até aprovação humana e consequência do provedor.
- [ ] Registrar custo/latência/cobertura/limites; publicar release minor e encerrar issue somente com aceite atendido.

### Task 5: Resposta do dono capturada por outro identificador

- [x] Confirmar por consulta autenticada do provedor o vínculo telefone/LID, sem nomes ou variantes numéricas como prova. Preservar avaliação humana do texto separada da autorização de envio.
- [x] Reproduzir e corrigir veto por atividade, inclusive depois da autorização, com políticas restritivas dos dois membros e bloqueio de prova contraditória. IDs, roteamento, histórico, recibos e custos permanecem preservados.
- [ ] Aplicar migração Source0017, implantar ambos os componentes e registrar uma vez a relação comprovada; conferir veto do gatilho real já respondido sem nova inferência/envio.
- [ ] Observar nova mensagem ainda não respondida até aprovação e consequência WhatsApp; não substituir essa prova por consulta SQL ou botão simulado.
