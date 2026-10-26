# #55 — produtor selado, restore inativo e reproof (etapa C)

Engenharia local em 26/10/2026. Sem dado real, paid API, provisionamento/deploy Cloudflare, restore ou ativação real. Custo dos testes: **US$ 0**. Não é homologação do piloto. O [runbook](../55-retencao-restore.md) distingue o export vivo de A, o bundle produzido sob quiescência e o restore lógico.

## Gates executados

| Gate | Evidência |
| --- | --- |
| TypeScript | `npm run check` passou após o patch final |
| Producer + importer/reproof/activation, após revisão independente | **29/29** em 46,83 s: `npm test -- tests/assistant-retention-snapshot.test.ts tests/assistant-retention-restore.test.ts` |
| Financeiro vivo ausente, contraprova adicional | **1/1**, 12 ignorados, em 10,31 s: `npm test -- tests/assistant-retention-restore.test.ts -t 'missing live financial history'` |
| Codec + operador local | **11/11** em 0,88 s, com nova checagem do token fora de vars imprimíveis **5/5** em 0,66 s |
| CLI | `node scripts/assistant-retention.mjs --help` e `node --check scripts/assistant-retention.mjs` passaram; nenhuma conexão remota foi iniciada |
| Whitespace | `git diff --check` passou |

O histórico anterior foi 23/23 + uma contraprova financeira isolada; depois da revisão independente, os 29 casos passaram em uma única execução. Suite geral, nativa, build e CI da composição final são gates do coordenador. Authority/reader externos são controlados nos testes; D1, runtime Workers e transações são locais reais.

## Antes/depois e contraprovas

A primeira composição capturada teve **3 falhas reais**: `assistant_source_origins.source_id` do transporte era escolhido antes de `canonical_id`, fazendo o planner/importer buscar um header inexistente. A correção prioriza `canonical_id` nos dois, mantendo membership e hash. Depois, **21/21** passaram em 36,11 s. A primeira execução anterior, 13/14, também identificou uma contagem de fixture incorreta: são três membros retirados (fonte, versão e admission), não dois; a fixture foi corrigida sem relaxar a purga.

Revisão adversarial do root apontou a recuperação pré-ticket: se DO/mirror falhasse depois de adquirir o gate, uma tentativa nova gerava outro token e deixava o anterior preso. Contraprovas executadas provam agora: schema é conferido antes do gate; uma falha anterior ao ticket e ACK D1 perdido recuperam exatamente o token/operationId; alias diferente não assume a posse; pause/resume liberam e retomam o mesmo trabalho. Outra contraprova falha na nona gravação de retirement depois de uma página de oito, reinicia o controller e completa sem repetir as oito gravações concluídas.

O próprio patch fechou o interleaving pause→row batch: uma admissão efêmera no mesmo batch condiciona grants, escrita canônica, quarentenas e recibo. O teste pausa depois das consultas de validação e antes da transação; não nasce corpo, recibo ou grant residual. A operação original retoma e admite o membro. Nenhum receipt “imported” é inferido de batch sem corpo.

O teste de concorrência de privacy devolve o lookup externo antigo e faz **retirada legítima local-barrier-first** antes do fim do await. O final não publica a cópia antiga: counter/guard reiniciam o passe, mirror adota a retirada e closure B purga o target. O teste cobre a janela DO/D1 com o fluxo host legítimo. `authority.record` cru não é um comando público/CLI/modelo. Substituição física do D1 e host externo malicioso não são promessas desse teste.

A revisão independente identificou cinco bugs adicionais, todos reproduzidos contra `068ac5c` **antes** dos fixes: (1) prova A com watermark de fonte 1 e conversa 2 nunca vinculava identidade, RED em 9,12 s; (2) política que mudava de revisão 2 para exclusão 3 antes do batch ainda admitia vínculo, e (3) resposta antiga de A durante chegada de B podia regredir a conversa de 2 para 1, dois RED em 13,88 s; (4) missão que mudou fonte A→B associava o histórico A ao par B e falhava no importer, RED em 8,15 s; (5) pause A depois de perder o gate para restore B sobrescrevia hold/cancelava trabalho B, RED em 8,45 s.

O followup fixa separadamente watermark/referência/hash da fonte e watermark da conversa, inclui policy revision/kind/mode na admissão SQL final, torna o primer monotônico e escolhe a fonte no corpo de **cada** versão histórica. Pause agora adquire admissão efêmera no mesmo batch com pin de operação/token/target/generation/hash/state; sem ela nenhum efeito ocorre. Release transfere hold apenas sob seu guard atômico atual. Os cinco cenários passaram juntos **5/5** em 17,27 s; a regressão C completa passou **29/29** em 46,83 s. Isso não depende de forçar uma edição da fonte A nem converter LID/nomes.

## Resultados observados

- Um produtor real gera páginas verificáveis e recibo no core externo. Export vivo sem wrapper/recibo não passa. Chunks multibyte, alteração de bytes, namespace errado, página incompleta, inputs mutados durante await e caminhos de membership corrompidos são recusados. Merkle/fronteira são verificados com 13 folhas, inclusive montanhas que não são potência de dois.
- As 21 tabelas canônicas têm 63 triggers de freeze; o financeiro continua liquidando e invalida um candidato em movimento. Snapshot cancel libera o próprio gate. Perda de ACK da página e do selo reconcilia o recibo exato, sem novo operationId.
- Foram exercitados 80 sources/paginação real, 300 reservas incertas de geração/período antigo e dez retiradas. Financeiro usa duas páginas de 128 por comando; retiradas usam oito; chain de recibos usa 128. Cursores ficam em metadata D1, sem cache intermediário dos corpos do bundle. O limite de formato 64 MiB/100.000 linhas não é benchmark dessa escala nem uma RPC com 100.000 consultas.
- Import aceita somente nova geração reservada externamente no mesmo D1, grava fontes/versões por pares com membership, preserva atribuição e configura trabalho como pausado. Não importa jobs, episodes, latches, Telegram, OAuth, índice ou orçamento. A conta nova continua ausente até ação externa explícita.
- Fonte de identidade WhatsApp ativa no snapshot e retirada depois, tanto aplicada quanto pendente em inbox, nunca reabilita leitura de nota restrita. Pending withdrawal impede selo; pause/catchup real aplica a retirada; resume/mirror/purge eliminam o corpo antigo no target. Tombstones e custo permanecem.
- Fonte capturada com literal inalterado conserva revisão 1 depois de catchup e permanece ilegível pela quarentena. Fresh policy + `reprove_source` conferem reader/fence/SQL atual e liberam somente a prova. Identidade exige CAS exato e `CommandLedger`; replay retorna o recibo original, stale overwrite é recusado. O resultado é afirmação explícita do owner. Nota restrita só volta ao interlocutor depois de nova versão de mandato também explícita.
- Release libera writers e mantém hold, cancelando jobs anteriores. Settlement antigo desconhecido de teto 8 pode liquidar uso conhecido 3 depois, sem payload ou reserva nova. Budget ausente/incompleto retorna `budget_blocked`; a contraprova apaga somente o ledger **sintético da fixture** e confirma que nenhuma conta/reserva é importada/criada a partir do backup.
- Activation é um comando separado, não chamado por restore/release. Teste exige configuração externa já em G2/sombra/selo exato, conta UTC previamente criada e gates atuais. O batch cancela pendências antigas, grava marcador de geração atual e remove o hold. Job futuro G2 pode adquirir lease; jobs antigos G1/G2 seguem cancelados e nova reserva/callback G1 é recusado. Missão restaurada continua pausada. Q de política antiga 1 não bloqueia política atual 2 após reproof; nenhuma flag de rotina ou credential generation OAuth é alterada.
- O operador recusa token incorreto, origem browser, query, localhost genérico, expiry, SQL, URL/actor/extras antes de RPC. Falha de resposta do owner resulta `uncertain` na mesma operação sem retry automático. A config local tem um único binding remoto nominal OwnerAssistant; nenhum D1/R2/route nem token em vars imprimíveis. `verify` offline sempre mantém `authority=unchecked`.

## Composição e escopo de revisão

Etapas anteriores preservadas: A `f0404b0`, B `635368d`; o fix de marker falsy da autoridade, feito pelo root em `a257b7b`, está portado localmente em `7bbb6c2` apenas para compor esta árvore. O coordenador já possui o fix: não reaplicar esse commit inteiro sobre produto. C não altera migrações antigas; 0025 adiciona freeze, metadados de snapshot/restore, quarantine/hold e geração ativa. `AssistantExport`/purga reconhecem explicitamente esses contratos.

A base desta worktree antecede as integrações #53/#54/#56. Ao integrar, preservar o contrato mais novo de engine #112 e OAuth, schema22/23 e fixtures do produto; inserir os hooks de readiness na factory #53/#56. Metadata receiveCapture continua admitido durante quiescência/hold. Leitura atual/execução exigem o selo/marcador nos locais adequados; não usar um snapshot de diagnóstico como prova da instalação atual.

O volume excede o alvo de ~400 linhas: produtor/codec/membership, autoridade externa, freeze de todos os writers, import por grants, quarantine/reproof, financeiro vivo e selo não podem ser ligados separadamente sem abrir uma janela de restauração indevida. A/B foram commits separados; C é a composição de segurança que permanece inativa até os gates externos e de CI. A CLI não tem config de publicação. Revisão final do root e de agente independente permanece gate antes da integração.

## Pendências declaradas

Não houve homologação do binding OwnerAssistant remoto via operador, sessão Cloudflare local, instalação real dos novos campos privados, bootstrap real da autoridade ou restore em nova geração real. Não houve ativação real. A prova do bucket separado e recursos reais continua de #56; objetos R2 externos, arquivo original, Telegram, provider/snapshots/checkpoints e cópias externas não são apagados por esse bundle. A disponibilidade de referências a objetos não equivale a copiar seus bytes.

Não são provas desta etapa: qualidade de busca Cognee, custo/latência reais, escala máxima do formato, revalidação humana da identidade por conteúdo, consentimento de canais ou homologação do piloto. Não se habilitou WhatsApp automático nem Calendar write; o projeto Elo não foi acessado/modificado. Versão/changelog/tag/release e fechamento da issue cabem à composição final com CI aprovada, nunca a estas provas isoladas.
