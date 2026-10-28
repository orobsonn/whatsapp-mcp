# Respostas Owner Telegram — plano parcial da #144

> **For agentic workers:** executar inline com superpowers:executing-plans e TDD. Não encerra #144.

**Goal:** preparar e tentar uma resposta no chat/tópico do dono atual, com dependências verificáveis e sem reenviar após incerteza.

**Architecture:** completar a inbox e publicar a outbox no mesmo batch, por nonce vencedor. Uma outbox nominal separa texto/fontes de metadados de tentativa e revalida ACL, origem, vínculo, retenção e prazo antes de I/O; confirmação tardia apenas registra verdade histórica. Não usar decisão/resumo fictício para responder.

**Tech Stack:** TypeScript, D1/SQLite, Zod, TelegramBotApi, SourceAccess/OriginGuard e compactStatement existentes.

**Spec:** telegram-owner-inbox-design.md, complementar a telegram-owner-inbox-authority-plan.md.

## Global Constraints

- Somente bot privado do dono, mantendo chat/tópico exatos, inclusive ausência de tópico. Sem envio automático WhatsApp e sem escrita Calendar.
- Sem ativar consumidor, flags, modelo ou deploy nesta unidade; interpretação natural e Flue continuam obrigatórios depois.
- Uma tentativa por update; nenhum retry de estado attempting/uncertain, nem extensão de prazo. Expiração usa relógio SQL vigente.
- Texto entre1 e4000 unidades UTF16 e até12000 bytes; no máximo10 dependências, igual ao pack do runtime existente; JSON das dependências até32768 bytes.
- Dependências são todas as fontes lidas pelo host, não apenas citações escolhidas pelo modelo. Uma resposta sem fontes só pode transportar informação independente de fontes, como status/recibo; a próxima factory de execução é responsável por esta coleção.
- Tokens/nonce não vão para modelo, JSON de usuário ou export. Outbox operacional fica fora do snapshot restaurável.
- Não prometer revogação após o último check/antes do fornecedor como transação distribuída, nem apagar cópias do Telegram ao purgar D1.

## Review Focus

- Dependência que muda durante await: nenhuma conclusão parcial nem envio.
- ACK perdido/tardio depois de revogar, expirar ou purgar: preservar uma tentativa e registrar resultado conhecido sem restaurar texto.
- Limpar referências antes da pergunta: fixar seleção ou limpar pergunta primeiro no mesmo batch, para não perder a closure de purga.
- Ausência de tópico: payload/retorno precisam corresponder exatamente e manter conteúdo protegido, sem parse_mode.
- Export/purga/limite D1: corpo e provas não sobrevivem por cópia; metadados e latch não desaparecem nem excedem100 parâmetros por query.

## Unidade — outbox nominal

Files: assistant/telegram-owner-replies.ts, migrations/0029_telegram_owner_replies.sql, tests/assistant-telegram-owner-replies.test.ts; adaptar telegram-owner-inbox.ts, telegram.ts, retention.ts, retention-purge.ts e contratos de prova existentes.

- [ ] RED/GREEN: complete(turn, extension?:{guard;build(completedWitness)}) em TelegramOwnerInbox compõe o guard adicional no primeiro UPDATE e compartilha nonce com todo o batch. Falha de qualquer statement reverte conclusão/publicação. Metadado replyFence(turn) vem da WeakMap e não é autoridade isolada.
- [ ] RED/GREEN: TelegramOwnerReplies.prepare(turn,text,deps) valida/copia entrada antes de awaits, congela requestHash/fence/deps e usa SourceAccess.guard, mais OriginGuard.localGuard/checkOriginsWithin quando WhatsApp. Outra origem não aceita OriginFence. Preparar e completar inbox no mesmo batch; mesma request recupera só metadados, request diferente recusa.
- [ ] RED/GREEN: dispatch(updateId) faz latch prepared→attempting com nonce e guard corrente. Sender factory por tentativa injeta check no TelegramBotApi imediatamente antes de fetch, sem estado global mutável. Send reconhecido grava sent/messageId pelo mesmo nonce; qualquer incerteza impede nova tentativa.
- [ ] RED/GREEN: TelegramApi.send aceita thread number|null; null omite campo e exige retorno sem tópico. Conteúdo protegido, sem interpretação HTML/Markdown.
- [ ] RED/GREEN: SourcePurge limpa pergunta original antes de limpar deps no mesmo batch; retira corpo/provas das replies que dependem da fonte, preserva hashes/metadados e tentativa. prepared→cancelled, attempting→uncertain, sent preserva resultado; ACK tardio matching nonce pode registrar sent sem restaurar corpo.
- [ ] RED/GREEN: cleanup finito (8 rows) após prazo remove texto/provas/pergunta, sem retry e sem apagar latches. Export redige attempt_token; snapshot não restaura efeito.
- [ ] Testes focados, types e revisão adversarial do diff. Manter PR145 em rascunho; esperar o CI de3a5cb16 terminar antes de push que criaria nova execução.

## Revisão adversarial antes do código

owner_once_occam_review exigiu duas contraprovas P1 incorporadas: limpar primeiro as perguntas ou fixar replyPKs antes de zerar deps_json; e permitir settlement histórico pelo nonce exato após revogação/expiração/purga, inclusive uncertain, sem fresh guard nem restaurar conteúdo. O guard fresco continua obrigatório antes de I/O; uma corrida depois dessa admissão não é eliminada por um check HTTP.

## Implementação e contraprovas desta unidade

- Outbox nominal, conclusão/publicação atômicas, tentativa única e limpeza de corpos implementadas.15 testes iniciais passaram; o conjunto foi ampliado para concorrência, limites de texto e dez fontes com contadores e strings distintos.
- A revisão encontrou P2 real: o teste inicial de dez fontes repetia revision/version1 e policyRevision0. A contraprova com revisões501+i, versões201+i, políticas301+i e watermarks401+i falhou em statement_parameter_count. Não cortamos fontes nem reduzimos o aceite.
- Ruling: jsonStatement reutiliza o lexer existente, mas usa um único bind JSON e json_extract(?1,'$[índice host]'). A variante provisória com CTE foi removida: não é necessária para reutilizar ?1 e adicionava profundidade/colisão de nomes. compactStatement preserva o contrato legado de100 parâmetros. Valores não são interpolados; NUL/surrogates inválidos, tipos não suportados, múltiplas instruções, SQL acima de100000 bytes ou pacote acima de131072 bytes são recusados antes da admissão.
- A forma real de prepare/latch/check passou com dez fontes WhatsApp distintas, contadores variados, identificadores longos e texto de12000 bytes. Os testes negativos de revogação, retirada, expiração e retenção também usam a nova codificação.
- Probe adicional do guard completo:124 valores distintos, SQL37104 bytes e pacotes11997/42782 bytes, compilados em SQLite com limite explícito de profundidade100. No D1 próprio, duas consultas SELECT equivalentes, com namespace sintético e tabelas novas vazias representadas por CTEs, foram aceitas em6,54/6,42ms: zero linhas lidas/escritas. Isso comprova compilação/capacidade do guard no D1; não comprova efeito de envio nem latência com dados reais.
-118 testes de5 arquivos passaram no conjunto de fronteiras; o último caso de statement sem parâmetros foi corrigido separadamente por RED→GREEN, com20/20 testes do helper e types finais aprovados. O CI do novo commit ainda é obrigatório.
- O CI40603217156 de3a5cb16 (unidades1/2) passou integralmente:1542 gerais,13 OAuth,66 nativos, Node4/9/1/39, ambos builds e audit0. Esse resultado não é evidência de CI da unidade3.

Frescor de missões/políticas, cobertura de busca e observações Calendar/GitHub ainda exige contrato próprio no executor. Esta unidade só aceita provas de fontes owner_note/WhatsApp e respostas independentes de fontes. Não usar deps vazio como atalho para dados externos ou afirmações de inventário completo. O consumidor, a interpretação natural, a inferência Flue/orçamento e a homologação real continuam necessários para encerrar #144.
