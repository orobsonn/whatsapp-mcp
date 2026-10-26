# Retomada da construção na VPS — 26/10/2026

Este é um ponto de passagem, não uma declaração de piloto pronto. O operador é Robson, gestor de produto; engenharia, testes, integração e recuperação são responsabilidade do agente. A nova sessão deve continuar o objetivo existente, sem refazer discovery ou pedir novamente autorizações já dadas.

## Objetivo e autorização

Construir e validar a assistente pessoal até estar pronta para piloto em modo sombra. Organizar pelas issues existentes do GitHub, seguir a lógica do `orobsonn/claude-harness` sem instalar o harness neste projeto, revisar adversarialmente mudanças relevantes e publicar uma release minor por issue efetivamente concluída. Não fechar issues por código local, CI isolada ou teste sintético se os critérios exigem integração real.

Robson autorizou implementação, recursos próprios, deploy e testes necessários. Autorizou até US$10 no total para testes pagos, com eficiência e modelos baratos capazes. Essa autorização não permite zerar reservas anteriores ou repetir tentativas incertas. Não há autorização para mensagens automáticas de WhatsApp nem escrita no Calendar durante a construção/piloto sombra. Não modificar o projeto Elo ou seus recursos.

Telegram privado com tópicos foi aprovado. É interface reativa de avisos, pendências, missões e retornos; GPT/Claude via MCP também ajudam a construir contexto por projeto. Atendimento privado do WhatsApp é padrão, com exclusões do dono; grupos têm modo próprio. Pausa interrompe atuação, mas não captura autorizada: o agente precisa recuperar mensagens que chegaram enquanto esteve parado. FUPs são compromissos persistentes, distintos dos jobs que os executam.

## Estado confirmado no momento da passagem

- 41 issues de construção (`harness:ready`), 27 fechadas e 14 abertas: #46–57, #112 e #121. A contagem é de issues, não percentual equivalente de esforço. Conferir estado vivo antes de relatar.
- Última release publicada: v0.33.0. `origin/main` estava em `a8baaa2704c7d6399075cbd0be8f90c813ca2be2`, contendo a implementação #121, mas ainda sem release v0.34.0.
- #45, diário obrigatório das decisões/silêncios/falhas, encerrada na v0.33.0.
- PR #119 é rascunho da busca semântica #112. PR #124 prepara v0.34.0 para #121 e permanece aberto: um dos dois checks falhou. Não contornar esse check.
- Falha observada no run `40315100926`: `tests/assistant-decisions.test.ts:353`, teste de alteração de política durante revalidação remota; esperado `stale`, recebido `unavailable`. Outro run passou. Investigar contrato e tempo limite, preservar a supressão do conteúdo, tornar o teste determinístico e só então concluir release/issue. Não tratar execução verde paralela como anulação automática da falha.

Leia primeiro `README.md`, `BRIEF.md`, `CONTEXT.md`, `docs/08-proxima-sessao.md` e os documentos desta pasta: `PRD.md`, `PLANO.md`, `REVISAO-PLANO.md`, `ANDAMENTO.md`. Este arquivo atualiza os trechos de andamento anteriores à passagem. Os corpos completos e critérios das issues no GitHub prevalecem sobre um resumo antigo.

## Branches com trabalho ainda não integrado

Todas as branches abaixo foram publicadas no remoto. Faça `git fetch origin` e confira os hashes antes de integrar. Não dê merge de todas indiscriminadamente: há bases diferentes e commits compartilhados.

| Branch | Ponto de código | Situação |
|---|---|---|
| `codex/assistant-owner-core` | `131a34414e8687c026f430f29a8e14e9f423fc81` antes do commit deste documento | #46: gateway MCP autenticado, comandos, leitura real do diário e guardas semânticas. Base v0.33 + #112. 786 testes gerais e 46 nativos passaram; falta homologação cloud/cliente. |
| `codex/assistant-telegram-link` | `9251a90f5e2ed0329231791fe86e57e89f755a29` | #47 implementada/revisada. Integrar apenas `d26437e920df037539f4a11b19e02fc05fac7155` e `9251a90f5e2ed0329231791fe86e57e89f755a29`; base antiga v0.31. Desafios duplos, rotação/revogação, dedupe. Migração 0018; homologação real pendente. |
| `codex/assistant-followups` | `c565684ffc3b2c3f30c3b7a4e92a4f7afb566d49` | #49 implementada em cima de `131a344`; 814 gerais, 47 nativos e 28 contraprovas independentes passaram; check/build verdes. Migração 0019. Falta integrar, CI e homologar. |
| `codex/assistant-media-context` | `5dc329bc73e470a3b73f88112a6efbf3a62660ea` | #52: extração de imagem/PDF com origem/ACL/versionamento e parser PDF em Worker separado. Base v0.32; 719 gerais/39 nativos e revisão independente passaram. Migração 0020 e dependência pdf-lib; preservar a versão atual do pacote ao integrar. Sem novas chamadas pagas de extração nesta rodada; qualidade/custos reais e limite de recursos cloud pendentes. |
| `codex/assistant-semantic-context` | `96e94ce534ea773c969641d9260c685d051b0a6f` | Branch de entrega #112/PR119. Base v0.33. Não inclui ainda #121 nem a correção dos dois bugs abaixo. |
| `codex/assistant-semantic-cloud-integration` | `655c01abb0c9271bbd0dfa1d22e6daf34d71cb8c` | Integração temporária efetivamente usada pelo probe cloud: #112 + ajuste de fixture do diário #45 + cherry-pick de #121. Não confundir com branch de entrega nem duplicar #121 já integrado na main. |
| `codex/release-0.34.0` | `0800d4b55b80ebe561e31b3519f5f69bda529e57` | PR124 em aberto. Resolver o check, concluir release v0.34 e só então fechar #121. |

Não confundir testes de ramos diferentes: os totais acima são evidências locais daqueles commits, não uma suíte única já integrada. Evidências detalhadas ficam em `docs/construcao-assistente/evidencias/` de cada branch. Preservar as migrações e executar a integração completa novamente.

Limpeza realizada nesta passagem: 64 branches locais e 58 remotas encerradas foram excluídas após conferir ancestralidade na main ou o HEAD exato de PR já integrado; oito referências remotas obsoletas foram podadas. Tags e worktrees foram preservados. Backup local verificável: `local/assistant-build/vps-handoff/branches-before-cleanup.bundle`, com plano/relatório no mesmo diretório. `codex/assistant-flue-episodes` permaneceu apenas local por não satisfazer a mesma prova de integração; não precisa ser usada como base nova. As branches da tabela estão preservadas no GitHub.

## Prioridade imediata: #112 e recuperação

#121 recuperou na Cloudflare o candidato exato do checkpoint 9, com nove fontes e 5.439.701 bytes, sem novo snapshot, recibo ou custo de modelo. Isso não encerrou #112. Depois da recuperação, um caso semântico real ficou pronto após restore explícito, com score lexical zero, fonte esperada em primeiro lugar e fonte privada ausente. Houve uma chamada de embedding, custo registrado de 1 microdólar. A bateria inteira ainda não passou.

Dois bugs foram reproduzidos localmente e analisados adversarialmente; ainda NÃO foram corrigidos:

1. `prepare` recusado durante manutenção salva `semantic_prepare_blocked`, sem ticket, e nunca prepara de novo após a manutenção terminar. Recuperar somente a preparação de metadados, mesmo alias/hash e prova atual; não gera modelo, orçamento ou wake. Recuperação de ACK perdido deve reencontrar exatamente o ticket original.
2. Submit com container frio muda ticket para `attempting` antes de descobrir que não pode executar, consumindo a tentativa sem busca. Checar busy/manutenção/quarentena/índice perdido/container ativo antes da CAS e manter exclusão desde antes dos awaits de preflight até o primeiro efeito, sem liberar/reentrar. Só o proprietário do lock libera. Revalidar ao último ponto antes da CAS. Morte física após CAS continua resultado incerto e NÃO permite retry.

O estado `blocked` sozinho não prova ausência de tentativa. Só recuperar uma recusa anterior à admissão quando a fase de preparação não tinha ticket, ou quando lookup do MESMO ticket provar estritamente `not_submitted`/prepared com a prova atual. Nunca resetar tickets `attempting`, inventar alias novo como retry ou usar contagem de custo zero como prova de ausência de efeito.

Não introduzir auto-start vazio no Engine. #53 deve orquestrar restore/warm do checkpoint exato antes da busca, fora da lease do episódio. Engine continua defendendo a API contra uso fora dessa ordem. Índice sujo/perdido exige recuperação correta, não start vazio ou fallback para snapshot antigo.

Contraprovas reproduzidas: prepare esperado 2 chamadas após fim da manutenção, atual 1; submit frio esperado ticket ainda prepared, atual attempting, zero buscas/reservas. Recriar testes a partir do contrato se o pacote privado de probes não tiver sido transportado. Não depender de `/tmp` do Mac para trabalhar na VPS.

## O que falta depois

1. Finalizar #121/release, corrigir os dois bugs e completar qualidade cloud de #112, incluindo correção de fonte, retirada, ACL, reinício, cache sem nova cobrança e ausência de fontes privadas. Salvar checkpoint da revisão atual antes de parar o container.
2. Integrar/homologar #46 e #47; implementar #48, tópicos/revisão do dono. Login do MCP e observação do usuário no Telegram não equivalem a autorização de controle.
3. Integrar/homologar #49 e #52. Na mídia, manter atribuição `model_extraction` e lacuna `media_semantic_unsearched` enquanto OCR não estiver no índice. Nunca reaplicar OCR/ASR por erro de ACK.
4. #50 GitHub somente leitura com repositório autorizado, versão fixa e paginação; #51 Calendar somente leitura/propostas. Conector desta conversa não vira credencial OAuth do Worker.
5. #53 rotinas persistentes, revisão diária, retomada, FUPs, lifecycle semântico; #54 métricas de qualidade, cobertura, custo, latência e silêncio incorreto.
6. #55 retenção/exportação/restauração, incluindo novos diários, transcrições, artefatos de mídia, caches e comandos; preservar verdade financeira agregada e fences de geração.
7. #56 instalação cloud sombra com recursos/bindings/migrações/ponte contínua/saúde; #57 homologação ponta a ponta, casos positivos/negativos e impedimento de envios reais.

## Recursos e orçamento de laboratório

Somente dados sintéticos foram usados nestes recursos. Não publicar probes de laboratório sem autenticação nem instalar bindings com segredos de envio na assistente sombra.

- Worker/Container: `assistant-build-check`; D1 `33766712-30c3-4570-991e-ddf250c52a2e`. Versão do último teste: `571d3a80-02a5-40a7-aa89-2f83100e9db0`, integração temporária `655c01a`. Container foi parado; pode dormir após 60s. Não há teste contínuo rodando ali.
- Namespace: instalação `build-check-20261025`, geração `build-g3`. Checkpoint 9 confirmado: `03339ec2219f47481f972ae8b4f4400be439fa79d18ddad1de2dcd2b10a0cc03`. Confirmar estado antes de usar: não assumir que o resumo é um lock.
- Captura de mídia isolada: Worker/D1/R2 `assistant-media-archive-check`, D1 `baa2a0c3-0d31-45ee-b559-835aa57a49ae`. Parser sem banco/segredo/rede: `assistant-media-pdf-check`, entrypoint `MediaPdfParser`, CPU configurada 100ms. Recursos provisionados; cadeia de mídia ainda não homologada cloud.
- Último saldo conhecido: 229 recibos completos; conta UTC26/build-g3 comprometida em 3.693 microUSD; outros períodos/gerações comprometem 44.712 microUSD, incluindo 40.000 incertos. Global comprometido: 48.405 microUSD (US$0,048405), dos quais US$0,04 são reserva incerta. Isso não é custo de Container nem fatura final.
- Cap local anterior: US$0,30 global. Elevação planejada a US$0,60 para uma reserva conservadora de mídia de US$0,53 ainda não aplicada. Se necessária, preservar histórico: nessa conta o novo cap seria 555.288 microUSD, não 600.000, descontando os 44.712 de outros períodos. Recalcular no ledger vivo antes de alterar. `InferenceBudget.configure` é insert-only; não apagar contas para trocar cap. Limite autorizado pelo dono continua US$10 total.
- Cotar API e Container com documentação oficial atual e apresentar estimativa por volume/horas ativas. Workers Paid já é pago pelo dono. Não confundir custo de tokens com ferramentas do Codex ou prometer mensalidade com amostra sintética.

## Acessos e arquivos que o clone não leva

A sessão nova não herda goal, histórico, agentes, login do GitHub/Cloudflare, variáveis, arquivos ignorados, `/tmp` nem Chrome do Mac. Começar por verificar `gh auth status`, credenciais de Cloudflare e disponibilidade de Node >=22.19, npm, Python e Docker; usar as dependências fixadas no lockfile. Continuar engenharia/testes locais mesmo quando um acesso cloud faltar.

Segredos do Mac estão fora do Git em `~/.config/assistente-validacao/credenciais.env` (0600) e em arquivos ignorados. Não buscar/imprimir/copiar indiscriminadamente credenciais. Provisionar somente os acessos necessários por meio local seguro na VPS; nenhum segredo no chat ou repositório público. Não copiar `.wrangler`, estado de sessão, D1, mensagens ou configuração do Elo.

Probes privados, fixtures sintéticas, drivers, relatório de limpeza e bundle de recuperação de branches ficam no Mac em `local/assistant-build/`. Eles NÃO vão no clone; podem ser transportados por canal privado com seleção explícita, sem arquivos `*-secrets.json`, `bridge-secret`, `probe-token`, `.env`, credenciais Docker ou estado de autenticação. Configurações de teste usam imports absolutos do Mac e precisam ser adaptadas aos caminhos Linux. Gold de avaliação não pode entrar no prompt nem no bundle do modelo.

O bot `@robson_assistente_sombra_bot` já existe e suporta tópicos privados. Ainda não há vínculo autenticado MCP, webhook de produto ou autorização de notificações. A observação da conta do dono foi apenas observação. No Mac, Chrome estava bloqueado e o MCP WhatsApp exigia reautenticação. Na VPS, registrar pendentes de interação: autenticação do MCP/WhatsApp, vínculo real do Telegram, OAuth que exigir consentimento e homologação no cliente. Não inventar aprovação nem paralisar as outras issues por isso.

Não precisa manter esta sessão local executando em paralelo com a VPS. Um único executor deve coordenar alterações/deploy/releases para evitar disputa de estado. O agente da VPS cria seu próprio goal com este mesmo objetivo; goal/histórico não são transferidos automaticamente.

## Regras para concluir

Revisão adversarial explícita antes de decisões técnicas relevantes. Modelos roteados por complexidade; tarefas mecânicas usam ferramentas, sem enxame de agentes. Se a VPS estiver limitada de RAM, limitar concorrência de processos/testes em vez de iniciar várias suítes completas juntas.

Reutilizar testes e evidências existentes, rodar checks apropriados no commit integrado, corrigir falhas e executar smoke na fronteira real exigida. Release só com package/changelog/tag em sincronia e CI aprovada no HEAD correto. Não produzir uma minor para esta passagem documental. Fechar cada issue somente depois da respectiva entrega. Entrega final ao dono: apenas o que mudou, resultado dos testes, custos estimados e pendências humanas separadas de engenharia. Piloto longitudinal, utilidade com conversas reais e comportamento social permanecem validações do piloto.
