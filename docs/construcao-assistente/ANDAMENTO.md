# Construção até piloto sombra

Goal ativo desde 25/10/2026. Issues #27–45, #69, #70 e #79/#91/#93/#96/#100/#114 concluídas, com CI/revisão e releases v0.7.0–v0.33.0 publicadas. Extração, busca e recuperação do motor homologadas com dados sintéticos na Cloudflare; canais do produto ainda não ativados.

## Método

Padrão do claude-harness consultado no GitHub, commit b01a528f017c16188991977485af1e36fa5e922e; formulário reconferido em74d24df4341c25902f4b384a38af1730ce1df3ad em26/10. Form completo replicado nas issues; dependências com números reais conferidas antes de `harness:ready`. Projeto continua sem instalação do harness por instrução específica do dono.

Roteamento: inventário mecânico em Luna/low quando necessário; implementação pontual em Sol/medium (Terra não disponível no dispatcher); planejamento, segurança e adversarial em Sol/high. xhigh somente com ambiguidade sensível ou gate falho. Agentes recebem contexto curto, escopo e prova esperada. Implementação sequencial das dependências; paralelizar somente fronteiras independentes. Uma release minor por issue concluída, conforme pedido atual (substitui cadência global por marco).

## Base

Branch inicial `codex/gpt-connection-stability`, HEAD f5ff0f8, à frente de origin/main 4199916. Correções publicadas ainda não integradas na main serão preservadas. Branch de construção: `codex/assistente-shadow`.

`docs/assistente-pessoal/` já existia inteiro sem rastreamento. Não adicionar em massa ao Git; contém protótipos, artefatos e evidências locais. Publicar somente documentação curada e segura da construção.

## Plano e evidência

- PRD: `PRD.md`.
- Revisão adversarial: `REVISAO-PLANO.md` (10 pontos incorporados).
- Roadmap publicado: `PLANO.md` e `issues.json`; GitHub conserva os corpos completos.
- #27: PRs #58/#59, release v0.7.0, 266 testes da base, check/build/audit produção, migração 0011 conferida sem escrita.
- #28: runtime isolado, 11 testes, PRs #60/#61 e v0.8.0.
- #29: fontes/versões canônicas, 8 testes, PRs #62/#63 e v0.9.0.
- #30: identidade/políticas, 6 testes, PRs #64/#65 e v0.10.0.
- #31: missões/FUPs/jobs, 6 testes, PRs #66/#67 e v0.11.0.
- #32: outbox de mensagens, PRs #68/#71 e v0.12.0.
- #33: outbox de mídia/derivados, CAS D1 e ACK perdido com R2 preservado; PRs #72/#73 e v0.13.0, CI aprovada.
- #34: ponte de metadados, PRs #74/#75 e v0.14.0.
- #35: acesso a fontes e versões, PRs #76/#77 e v0.15.0.
- #69: reader restrito de captura, PRs #78/#80 e v0.16.0.
- #38: relações atribuídas com fontes atuais, PRs #81/#82 e v0.17.0.
- #36: fila com autorização atômica e recibos tardios; 36 testes, mais 20 de fontes; PRs #83/#84 e v0.18.0.
- #37: orçamento persistente, PRs #85/#86 e v0.19.0.
- #70: materialização canônica com cobertura e retiradas, PRs #87/#88 e v0.20.0.
- #79: broker de modelos e recibos, PRs #89/#90 e v0.21.0.
- #39: motor Cognee com extração e busca reais na Cloudflare; erro de redirect corrigido com contraprova do runtime. PRs #95/#97, v0.23.0. Recuperação do índice segue em #40/#91.
- #40: snapshot, destruição e duas restaurações no serviço real, sem chamadas adicionais; PRs #103/#104, v0.26.0.
- #91: reconstrução com recibos existentes passou localmente e na Cloudflare: duas fontes, novo checkpoint, destruição/restauração, 79 recibos e custo invariáveis; PRs #109/#110, v0.29.0.
- #43: replay/pause concluído após três contraprovas adversariais corrigidas; PRs #92/#94, v0.22.0.
- #41: recuperação autorizada e limitada por lote; PRs #98/#99, v0.24.0. Continuação para inventário maior na #100, obrigatória antes do piloto.
- #100: continuação persistente sobre 1.105 fontes sintéticas, 112 testes dirigidos e revisão adversarial concluída; PRs #111/#113, v0.30.0. Leitura manual durante pausa preserva os cursores automáticos. Esta prova não amplia a capacidade semântica do Cognee.
- #42: quatro casos novos com modelo real; originais preservados em 4/4, foco válido em 3/4 e fallback no outro; repetição sem chamadas novas. PRs #101/#102, v0.25.0.
- #93: comandos internos do dono, 21 testes D1, PRs #105/#106, v0.27.0; integração autenticada ainda pertence a #46.
- #96: Flue oficial em workerd, 7/7 testes, auditoria completa sem vulnerabilidades, PRs #107/#108 e v0.28.0; não equivale a integração do agente #44.
- #114: reader binário restrito de imagem/PDF, 21 casos novos e 683 testes locais; revisão independente sem achados, PRs #115/#116 e v0.31.0. Sem decoder/OCR nem binding cloud ativado.
- O código do arquivo usa captura opt-out; #56 deve conferir a instalação atual, integrar a ponte contínua e preservar exclusões/lacunas da assistente. Captura e atendimento são controles diferentes.

## Regras de conclusão

Não confundir release com deploy, fixture com homologação real, recurso sem credencial com canal pronto, ou teste de laboratório com implementação. Fechar issue somente com critérios cumpridos e evidência no commit integrado. Impedimentos de credenciais/canal serão estados explícitos; seguir engenharia independente antes de envolver dono. Goal só termina quando produto estiver pronto para piloto sombra e não houver trabalho de engenharia necessário restante.

## Integrações em construção

- #44: runtime Flue integrado e revisão adversarial concluídos; 39 testes Flue/workerd passaram novamente no commit integrado, incluindo reinício, ACK perdido, orçamento e pausa. PRs #117/#118 aprovados em CI; release v0.32.0 publicada e issue fechada. Diário obrigatório #45 foi entregue na v0.33.0; não é prova de canal ou inferência real nesta rodada.
- #45: diário obrigatório e publicação atômica, sujeitos nominais e negativos visíveis;714 testes gerais/41 nativos na entrega, contraprovas independentes4/4. PRs120/122 com CI aprovada, releasev0.33.0 publicada e issue fechada.
- #46: core e gateway locais com diário real integrado. Suite integrada112+45+46:786 testes gerais e46 nativos, check e65 dirigidos verdes; re-review independente35/35 sem bloqueador. Decisão semântica é legível sem chamar engine/modelo; modo divergente/ranking alterado suprime corpo. Binding cloud e cliente real seguem pendentes; issue aberta.
- #112: sete fontes novas ingeridas no Cognee Cloudflare,149 novos recibos completos eUS$0,003692 registrado. Recuperação por sinônimo ainda não comprovada: interrupção durante checkpoint deixou candidate durável e manutenção bloqueada. Issue121 trata retomada segura sem repetir snapshot/modelos; Container foi parado após diagnóstico. A issue112 permanece aberta.
- #121: correção nova de recuperação de checkpoint interrompido, com candidato exato, fences e confirmação conjunta; implementação/testes em andamento após revisão adversarial do plano.

- #47/#48: bot `@robson_assistente_sombra_bot` criado pelo Chrome autorizado; getMe confirmou identidade e tópicos privados ativos. Teste controlado enviado pela própria conta chegou a getUpdates com thread. Token somente em arquivo local0600 fora Git/D1; vínculo administrativo MCP e webhook ainda não configurados. A observação da conta do dono não ativa permissão no produto.
