# Construção até piloto sombra

Goal ativo desde 25/10/2026. Issues #27–33 concluídas, com CI/revisão e releases v0.7.0–v0.13.0 publicadas. Nenhum deploy da assistente.

## Método

Padrão do claude-harness consultado no GitHub, commit b01a528f017c16188991977485af1e36fa5e922e. Form completo replicado nas issues; dependências com números reais conferidas antes de `harness:ready`. Projeto continua sem instalação do harness por instrução específica do dono.

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
- #34: ponte de metadados revisada; controle de acesso #35, reader restrito #69 e materialização atual #70 separados com aceites próprios.
- A captura existente tem opt-in próprio: cobertura de todos privados da assistente ainda precisa ser integrada em #43/#56, com exclusões e lacunas honestas.

## Regras de conclusão

Não confundir release com deploy, fixture com homologação real, recurso sem credencial com canal pronto, ou teste de laboratório com implementação. Fechar issue somente com critérios cumpridos e evidência no commit integrado. Impedimentos de credenciais/canal serão estados explícitos; seguir engenharia independente antes de envolver dono. Goal só termina quando produto estiver pronto para piloto sombra e não houver trabalho de engenharia necessário restante.
