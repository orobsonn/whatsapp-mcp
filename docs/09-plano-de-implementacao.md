# Plano de implementação

Goal: entregar o PRD com validação local real de Workers/D1/R2 e cliente MCP sintético. Robson confirmou em 19/10: ainda não há instância separada; continuar sem ela. Ativação real não faz parte da conclusão deste ciclo.

Arquitetura: um Worker, um dono, banco D1, bucket privado R2 e KV exclusivo para OAuth. Nenhum harness instalado; nenhuma alteração no Elo. Fonte da lógica: claude-harness main 7634e3284dbe402f9229b18a13c658ace3afe3fd, v3.10.0.

## Sequência e áreas

1. `src/core.ts`, `src/store.ts`, `src/capture.ts`, `src/directory.ts`, `migrations/`: tipos, erros seguros, limites de corpo, arquivo e ingestão. Testes red de namespace, homônimos, status fora de ordem, replay, tombstone e paginação/isolamento → implementação → suíte D1. Foundation define schemas compartilhados antes de módulos dependentes.
2. `src/zapi.ts`, `src/actions.ts`: chamadas somente ao host fixo; schemas/timeout/redirect; proposta imutável e claim D1. Testes red de envelope/concorrência/expiração/alteração/timeout, contrato de grupo e arquivo → implementação → suíte afetada.
3. `src/media.ts`: upload limitado, download seguro com origem confiável, persistência privada imutável, original e transcrição sob demanda. Testes red de host/redirect/MIME/limite/hash/versão e exclusão durante processamento → implementação → testes R2 e rede controlada.
4. `src/auth.ts`, `src/pages.ts`: OAuth biblioteca, Access JWT owner binding, consentimento e confirmação humana. Testes red de identidade/origem/CSRF/expiry e de que MCP não confirma → implementação → fluxo HTTP local.
5. `src/mcp.ts`, `src/index.ts`: SDK oficial e schemas tipados, conectar módulos, diagnóstico e jornada. Testes red via cliente SDK em HTTP local, desde captura até proposta/confirmado/resultado, catálogo sem ferramentas arbitrárias → implementação → integração completa.
6. `src/operations.ts`, `scripts/`, `.github/`, README/manual e changelog: retenção/exclusão/export, manutenção, recuperação e instalação. Testes red para limpeza e invalidação; CI/typecheck/build/audit, revisão independente, corrigir achados, repetir apenas checks afetados; release por marco e fechar issues com evidência.

## Critérios globais

- TDD nos comportamentos acima; nenhum teste espelho para getter, texto de docs ou configuração trivial.
- Antes de fechar cada issue: revisar diff, executar comandos e registrar stdout/exit sanitizados em `docs/10-entrega.md`; relatório de subagente não substitui verificação.
- Rotas por complexidade do PRD: Luna/low mecânico; Sol/medium delimitado; Sol 6.1/high segurança; Astra/high adversarial final. Só dependências prontas podem ser executadas.
- Riscos prioritários: ressurreição de conteúdo apagado; ação duplicada após resposta perdida; saída R2 fora de escopo; aprovação induzida por prompt injection; grant antigo após restore/rotação. Cada área dona mantém teste de regressão.
- D1 e R2 não têm transação conjunta: objeto privado só é legível através de referência D1 válida, com chaves imutáveis; falha pode deixar órfão privado a limpar, nunca autorizar objeto inexistente ou errado.
- Rollback: nenhuma ação externa em testes; migrations apenas locais. Deploy exige recursos próprios, segredos fora do Git e ensaio específico. Restore inicia em manutenção e com novo epoch externo.

## Progresso

- [x] Ler todo o handoff e criar repositório público.
- [x] Consultar lógica do harness remoto sem instalar.
- [x] Escrever PRD e plano.
- [x] Revisão adversarial do desenho e incorporar correções.
- [x] Criar issues com critérios e dependências.
- [x] Implementar e verificar issues 1–6 localmente; revisão final/CI ainda em andamento.
- [x] Auditoria final sem bloqueadores e evidências locais.
- [x] CI remoto no HEAD do software aprovado; merge e seis issues fechadas.
- Publicação por marco: [v0.1.0](https://github.com/orobsonn/whatsapp-mcp/releases/tag/v0.1.0); o GitHub registra tag, CI e estado da release.
