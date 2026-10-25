# Assistente pessoal Implementation Plan

> Execução autorizada pelo dono até piloto sombra. Procedimento do claude-harness consultado e aplicado sem instalação. Engenharia pode ajustar mecanismos preservando critérios e registrar a razão.

**Goal:** entregar instalação integrada e verificável pronta para observação em sombra.
**Architecture:** Worker isolado, D1/R2 canônicos, projeção Cognee recuperável, Flue por episódio, controle autenticado e filas persistentes.
**Tech Stack:** TypeScript, Workers, D1, R2, Durable Objects, Flue, Cognee/Python Container.
**Spec:** [PRD](PRD.md), [revisão adversarial](REVISAO-PLANO.md).

## Global Constraints

Sem saída WhatsApp ou escrita Calendar pela assistente. Sem mudanças no Elo. Privados por padrão com exclusões; grupos por modo. Telegram privado com tópicos. Identidade nunca por nome. Memória não concede autorização. Uma minor por issue fechada. Contexto real e segredos ficam fora do Git. Antecessores precisam estar entregues antes de concluir dependente.

## Review Focus

- Derivado tardio/retirada: outbox, retomada e invalidação devem impedir resposta antiga.
- Capacidade indireta de envio: endpoint, tool e binding devem falhar sem alcançar provedor.
- Pausa/lease/reinício: autoria incerta não é ordem; resultado incerto não pode repetir efeito.
- Corpus maior que limite: cobertura incompleta explícita, sem falsa completude por LIMIT.
- Identidade/escopo/versão mudam durante IA: publicação deve falhar com estado stale.

## Ciclo por entrega

Ler issue e antecessores; definir interfaces locais; congelar testes de aceite; observar teste falhar; implementar; executar teste específico, check/suíte/build relevantes; revisão independente de risco/segurança; corrigir contraprova; PR e CI no commit; merge; release minor via PR, tag e GitHub Release; registrar evidências e fechar issue. Dividir novamente se diff exceder ~400 linhas sem inseparabilidade. Revisão nunca depende do dono escolher engenharia.

## Entregas ordenadas

- [x] [27 · Preservar correções publicadas de voz e conexão GPT na base de construção](https://github.com/orobsonn/whatsapp-mcp/issues/27) — requisito 1; antecedentes: nenhum.
- [x] [28 · Separar o runtime sombra das capacidades de envio](https://github.com/orobsonn/whatsapp-mcp/issues/28) — requisito 2; antecedentes: #27.
- [x] [29 · Persistir fontes, versões e mudanças canônicas](https://github.com/orobsonn/whatsapp-mcp/issues/29) — requisito 3; antecedentes: #28.
- [x] [30 · Persistir identidades comprovadas e políticas](https://github.com/orobsonn/whatsapp-mcp/issues/30) — requisito 3; antecedentes: #29.
- [x] [31 · Persistir trabalhos, missões e retornos separados](https://github.com/orobsonn/whatsapp-mcp/issues/31) — requisito 12; antecedentes: #29.
- [x] [32 · Registrar mudanças de captura na mesma transação](https://github.com/orobsonn/whatsapp-mcp/issues/32) — requisito 4; antecedentes: #27.
- [x] [33 · Propagar transcrição, retirada e acesso para o contexto](https://github.com/orobsonn/whatsapp-mcp/issues/33) — requisito 4; antecedentes: #32.
- [x] [34 · Entregar mudanças com autenticação e retomada](https://github.com/orobsonn/whatsapp-mcp/issues/34) — requisito 4; antecedentes: #28, #29, #32, #33.
- [x] [35 · Controlar acesso, correção e retirada canônicos](https://github.com/orobsonn/whatsapp-mcp/issues/35) — requisito 6; antecedentes: #29, #30.
- [ ] [36 · Executar fila persistente e recuperar o mesmo trabalho](https://github.com/orobsonn/whatsapp-mcp/issues/36) — requisito 5; antecedentes: #31, #34, #35.
- [ ] [37 · Reservar gasto antes de cada chamada de modelo](https://github.com/orobsonn/whatsapp-mcp/issues/37) — requisito 9; antecedentes: #36.
- [ ] [38 · Publicar afirmações e relações com suporte](https://github.com/orobsonn/whatsapp-mcp/issues/38) — requisito 6; antecedentes: #35.
- [ ] [39 · Executar ingestão e busca Cognee com contrato restrito](https://github.com/orobsonn/whatsapp-mcp/issues/39) — requisito 8; antecedentes: #35, #37.
- [ ] [40 · Recuperar motor após perda do Container](https://github.com/orobsonn/whatsapp-mcp/issues/40) — requisito 8; antecedentes: #39.
- [ ] [41 · Buscar texto, significado e relações com cobertura](https://github.com/orobsonn/whatsapp-mcp/issues/41) — requisito 7; antecedentes: #38, #39, #70.
- [ ] [42 · Selecionar recorte e apresentar linguagem sustentada](https://github.com/orobsonn/whatsapp-mcp/issues/42) — requisito 7; antecedentes: #41, #37.
- [ ] [43 · Agrupar mensagens e recuperar contexto após pausa](https://github.com/orobsonn/whatsapp-mcp/issues/43) — requisito 5; antecedentes: #34, #36, #35.
- [ ] [44 · Executar perfis dono e interlocutor isolados no Flue](https://github.com/orobsonn/whatsapp-mcp/issues/44) — requisito 9; antecedentes: #37, #42, #43.
- [ ] [45 · Registrar respostas, pendências e silêncios em sombra](https://github.com/orobsonn/whatsapp-mcp/issues/45) — requisito 10; antecedentes: #44.
- [ ] [46 · Ensinar contexto e dirigir assistente pelo MCP](https://github.com/orobsonn/whatsapp-mcp/issues/46) — requisito 11; antecedentes: #35, #38, #31.
- [ ] [47 · Vincular Telegram privado do dono](https://github.com/orobsonn/whatsapp-mcp/issues/47) — requisito 14; antecedentes: #28, #46.
- [ ] [48 · Organizar revisão nos quatro tópicos privados](https://github.com/orobsonn/whatsapp-mcp/issues/48) — requisito 14; antecedentes: #47, #45.
- [ ] [49 · Acompanhar missões e FUPs com vencimento](https://github.com/orobsonn/whatsapp-mcp/issues/49) — requisito 12; antecedentes: #31, #36, #46.
- [ ] [50 · Consultar fontes de projeto no GitHub](https://github.com/orobsonn/whatsapp-mcp/issues/50) — requisito 13; antecedentes: #35, #37, #46.
- [ ] [51 · Consultar disponibilidade e preparar proposta de agenda](https://github.com/orobsonn/whatsapp-mcp/issues/51) — requisito 13; antecedentes: #35, #37, #46.
- [ ] [52 · Integrar áudio, imagem e PDF ao contexto](https://github.com/orobsonn/whatsapp-mcp/issues/52) — requisito 13; antecedentes: #33, #37, #42.
- [ ] [53 · Revisar pendências, grupos e retornos sem nova mensagem](https://github.com/orobsonn/whatsapp-mcp/issues/53) — requisito 14; antecedentes: #48, #49, #45.
- [ ] [54 · Medir qualidade e cobertura para decidir próximo passo](https://github.com/orobsonn/whatsapp-mcp/issues/54) — requisito 15; antecedentes: #45, #53.
- [ ] [55 · Exportar, retirar e restaurar sem ressuscitar dados](https://github.com/orobsonn/whatsapp-mcp/issues/55) — requisito 16; antecedentes: #35, #40, #49.
- [ ] [56 · Instalar produto integrado na Cloudflare](https://github.com/orobsonn/whatsapp-mcp/issues/56) — requisito 16; antecedentes: #40, #44, #48, #50, #51, #52, #53, #55.
- [ ] [57 · Homologar ponta a ponta e entregar prontidão do piloto](https://github.com/orobsonn/whatsapp-mcp/issues/57) — requisito 16; antecedentes: #54, #56.

A sequência cobre componentes e integração. Releases intermediárias não significam prontidão do piloto; a última entrega exige fronteira real e explicita qualquer canal ainda sem vínculo.

## Separação da fronteira de origem (revisão durante implementação)

- [ ] [69 · Leitura nominal e limitada da origem](https://github.com/orobsonn/whatsapp-mcp/issues/69) — antecedentes #32/#33.
- [ ] [70 · Materialização e guard atual da origem](https://github.com/orobsonn/whatsapp-mcp/issues/70) — antecedentes #34/#35/#69; antecede #41.

#34 transporta somente metadados. #35 controla fontes canônicas; #69/#70 cobrem snapshot e materialização antes retirados de uma única entrega grande. TOCTOU entre bancos é tratado por rechecagem antes de IA/publicação, sem alegar transação distribuída. Nenhum requisito foi removido.

## Subchamadas do motor

- [ ] [79 · Broker específico de modelos do Cognee](https://github.com/orobsonn/whatsapp-mcp/issues/79) — depende de #37 e antecede #39. Chaves e recibos permanecem no Worker/D1; job novo com a mesma operação lógica não permite nova inferência.

Separação revisada adversarialmente: #79 controla subchamadas, #39 executa imagem/motor e #40 restaura checkpoints. Cada fronteira tem contraprovas próprias; não incorporar as três em um único diff.
