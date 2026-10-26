# #55 — export, retirada e restore lógico

Este procedimento é engenharia da assistente em sombra. A implementação não executou restore, purga ou ativação em Cloudflare real. A homologação do transporte privado, dos bindings e do piloto continua separada dos testes locais.

## Limites do procedimento

O export autenticado `assistant.export` de A lista dados vivos com cursor. Ele **não é um snapshot** e não é aceito como artefato de restore. `snapshot.*` produz páginas de um bundle canônico sob quiescência e só finaliza com recibo da autoridade privada, fora do D1 restaurável.

O restore é **lógico**, em uma geração externamente nova no **mesmo D1 vivo**. Não substitui o banco, não desfaz migrações, não certifica rollback físico e não restaura um dump operacional antigo. O schema/afinidade precisam ser os mesmos. Mudança física de banco exige outro procedimento com prova do financeiro e dos tombstones; indisponibilidade não significa inventário vazio.

O bundle guarda fontes, versões e atribuição, pessoas/identidades, projetos e suas revisões, políticas/mandatos e histórico de missões/FUP. Jobs, episódios, latches de execução, recibos de modelo/mídia, índice semântico, Telegram e OAuth não são importados. Missões/FUP correntes ficam pausados; mandatos ativos viram rascunhos. Políticas, provas de origem e identidades ficam em quarentena até revalidação atual e, quando cabível, afirmação explícita do dono. Texto, IDs e metadados podem conter dados pessoais: este procedimento não os anonimiza.

Os registros financeiros de #37 são exportados para a instalação inteira, todas as gerações e períodos. O importer **não escreve contas nem reservas a partir do bundle**: verifica as linhas contra o ledger vivo. História ausente/incompleta bloqueia o orçamento; não cria cap novo nem assume custo zero. Liquidação tardia continua permitida e preserva custo conhecido/certeza anterior. Uma conta UTC da nova geração só pode existir por provisionamento explícito, fora do restore e respeitando o teto já autorizado do piloto.

Chaves de objetos são referências. O bundle não copia bytes R2, objetos do arquivo original, snapshots Cloudflare, Telegram ou cópias de terceiros. A purga B distingue bloqueio lógico, closure D1 corrente, R2 e demais cópias pendentes. Nenhum relatório aqui certifica apagar esses serviços externos ou reconstruir o RAG.

## Artefato selado e limites de trabalho

`snapshot.begin/page/advance/seal` congela INSERT/UPDATE/DELETE das 21 tabelas canônicas. Inbox e recibos de transporte continuam recebendo metadados; retirada do owner continua admissível e invalida o candidato. O financeiro não congela. Counters D1 e rechecagem impedem selar se ele ou uma retirada mudarem durante a produção. `snapshot.cancel` libera somente o próprio gate.

Cada página tem no máximo 50 partes, com chunks de 24 KiB; nenhum corpo intermediário de backup é persistido em D1. São persistidos apenas cursor, contagens, hashes e recibos de página. O codec aceita até 64 MiB decodificados e 100.000 linhas; esses são limites de formato, **não benchmark de 100.000 linhas em uma RPC**. Inventário financeiro processa até duas páginas de 128 linhas por comando; mirror de retiradas processa oito fontes; cadeia de recibos final processa 128 linhas. As etapas têm cursores duráveis e retomam após reinício/ACK perdido. Testes locais passaram de uma página com 300 reservas financeiras e dez retiradas.

O verificador offline confere bytes/chunks, namespaces, contagens, hash do financeiro, cadeia e raiz de membership. Seu resultado é `integrity_verified`, `authority=unchecked`. Hash recalculável não é autorização. O servidor exige o recibo nominal no DO privado e prova de membership de cada linha, incluindo o par fonte/versão corrente, antes de escrever.

## Operador privado

Pré-requisitos: Node 22+, dependências do repositório, configuração privada instalada de #56 e arquivo privado de afinidade `assistant.affinity.secrets.json`. As credenciais Cloudflare pertencem ao operador local; a sessão anterior e OAuth do Codex não são credenciais desse transporte. A presença de arquivos não comprova acesso: validar a conta/serviço correto antes de usar comandos remotos. Não imprimir valores de segredos.

O script gera temporariamente um Worker **local**, em `127.0.0.1`/porta aleatória. Ele possui somente o binding remoto nominal `OwnerAssistant` do serviço fixo `personal-assistant-shadow`, na conta pessoal fixada pela instalação. Não há binding D1/R2, SQL, actor, URL ou bucket escolhido por comando. Token efêmero fica em `.dev.vars` 0600 sob diretório privado, TTL de 15 minutos e nunca em vars imprimíveis. O transporte nega Origin/browser/CORS e só aceita a allowlist tipada. Request/response têm limite e timeout; falha após tentativa é incerta, não convite para outro operationId.

O processo e os arquivos efêmeros são removidos em `finally`; SIGINT/SIGTERM encerram o filho. Operation IDs e progresso de CLI ficam no diretório privado persistido para reconciliar a mesma operação. Não apagar esses recibos depois de timeout. O script não faz deploy, migração, ativação implícita, chamada de modelo ou limpeza de OAuth.

Os caminhos abaixo são exemplos de arquivos privados, sem credenciais literais:

```sh
node scripts/assistant-retention.mjs --help
node scripts/assistant-retention.mjs verify --bundle /tmp/assistant-private/canonical.jsonl

node scripts/assistant-retention.mjs snapshot \
  --installed /tmp/assistant-private/assistant.wrangler.jsonc \
  --affinity /tmp/assistant-private/assistant.affinity.secrets.json \
  --state /tmp/assistant-private/snapshot-op \
  --bundle /tmp/assistant-private/canonical.jsonl

node scripts/assistant-retention.mjs restore \
  --installed /tmp/assistant-private/assistant.wrangler.jsonc \
  --affinity /tmp/assistant-private/assistant.affinity.secrets.json \
  --state /tmp/assistant-private/restore-op \
  --bundle /tmp/assistant-private/canonical.jsonl
```

`snapshot` e `restore` fazem somente a operação nomeada, retomando recibos/cursor. O primeiro usa recibo externo ao reutilizar bundle já completo. O segundo para em `inactive_complete`, `budget_blocked` ou dependência explícita. Ele nunca chama `release` nem `activate-generation`. Para um candidato de snapshot interrompido, existe `cancel-snapshot` com os mesmos quatro argumentos; para um restore existem `status`, `pause`, `resume`, `release` e `catchup`.

`RETENTION_RESTORE_GENERATION` vem da configuração privada do host e precisa ser nova. O comando não aceita geração arbitrária. O DO reserva a geração uma única vez para a mesma identidade de operação. Incompatibilidade de schema é detectada antes de congelar escritores; falha anterior ao ticket reutiliza o token do gate original. Outra operação não assume seu gate.

## Da quiescência à revalidação

`restore.finish` prova todos os membros, financeiro vivo, retiradas locais/externas e ausência de withdrawal/access pendente. Só então grava selo de geração inativa. Nenhuma semântica/modelo é chamada. Uma retirada legítima ocorre primeiro como barreira local; logo, mesmo um lookup externo antigo devolvido antes da retirada não passa pelos counters e guard SQL finais. A API de comandos não expõe `authority.record` cru.

`release` exige o mesmo ticket, selo e gate; repete guards atômicos e deixa um **hold durável de execução**. Cancela jobs pendentes/processando e conserva recibos/financeiro. Escritores canônicos são liberados para captura e reproof. Antes de terminar, `pause` oferece a mesma liberação segura; `resume` recongela pela operação original e reinicia somente os passes de validação. Retiradas atuais continuam negadas durante falhas e retomadas.

`catchup` usa `CaptureMaterializer` e `receiveCapture` reais para observar inbox vivo e reencaminhar até oito metadados por chamada para o target, com cursor durável. Não importa o inbox do snapshot, não injeta corpos recebidos na CLI e não cria jobs. Enquanto o import está incompleto, observa somente retiradas do namespace vivo; não antecipa criação de IDs no target. Coverage é do metadata vivo disponível no D1 e do reader atual; não promete recuperar histórico que o arquivo não possui.

Uma fonte WhatsApp restaurada permanece ilegível mesmo se um catchup de texto inalterado conservar sua revisão. `restore.reprove_source` observa a origem nominal atual, compara hash/watermark/epoch/política, repete fence/check remotos e só limpa a quarentena da fonte na mutação SQL protegida. A política precisa de revisão fresca do dono depois da disponibilidade atual. O fluxo não força edição real nem revision bump artificial para contornar o bloqueio.

Identidade exige `restore.bind_identity`: provider/endereço exatos, personId opaco escolhido explicitamente pelo dono, prova atualmente legível e authorId coerente, CAS da tupla anterior ou `expected.absent=true`. `CommandLedger` guarda request hash, token e recibo original. O resultado se atribui a `owner_assertion_after_restore`, **não** autenticação comprovada pelo texto, nome, LID convertido ou `fromMe`. Mandatos/políticas restaurados não se tornam autorização por esse vínculo; nova revisão explícita continua necessária.

`reprove-source` e `bind-identity` recebem `--input` com comando JSON tipado em arquivo 0600; o operationId precisa ser o mesmo recibo de `restore-op`. Esses comandos não aceitam SQL, actor ou geração. O próprio bundle fornece IDs/proveniência para revisão; não transformar dados dele em consentimento.

## Ativação explícita separada

`restore.activate_generation` / CLI `activate-generation --input PRIVATE_TYPED_COMMAND` existe para remover o hold **somente mediante nova ação explícita e autenticada do dono**, depois da configuração/deploy externo apontar para a geração target. Não foi executado em ambiente real nesta entrega.

Guards: geração atual do host igual ao target; modo sombra; `RETENTION_GENERATION_SEAL` exato do recibo final e session liberada; autoridade disponível; inbox sem pendências e epochs atuais; nenhuma quarentena sobre prova/identidade/política corrente ou mandato ativo; nenhuma fonte ativa sob retirada; conta UTC corrente da geração já provisionada e não bloqueada, com período/cap esperados explicitamente pelo comando. O inventário financeiro atual é paginado e guardado por revision CAS, sem exigir que liquidações tardias sejam iguais ao hash antigo do finish.

O batch do `CommandLedger` cancela todos os jobs já pendentes/processando antes de remover o hold. Um marcador de geração ativa é atualizado por CAS contra a geração anterior do ticket externo. Jobs/reservas novos de geração antiga e callbacks antigos do runtime são recusados. Recibos e settlement financeiro antigo continuam preservados. Missões/FUP pausados não são retomados e flags de rotinas/OAuth permanecem iguais. Apenas jobs novos, de intenções permitidas atuais, podem ser admitidos depois. Este comando não substitui consentimento de canais ou a homologação real do piloto.

O selo externo é configuração de host, não um segredo derivável tratado como autorização. Não alterá-lo nem reconfigurar conta para contornar estado bloqueado. Rotação de OAuth/credential generation continua explícita; restore não a faz.

## Verificação local e gates restantes

```sh
npm run check
node --test scripts/assistant-retention.check.mjs scripts/assistant-retention-operator.check.mjs
npm test -- tests/assistant-retention-snapshot.test.ts tests/assistant-retention-restore.test.ts
```

Ver evidências em [55-C](evidencias/55-retencao-restore.md), [55-B](evidencias/55-retencao-purga.md) e [55-A](evidencias/55-retencao-export-autoridade.md). São dados sintéticos e serviços locais reais D1/Workers, com authority/reader externos controlados. Não provam Cloudflare real, credenciais transferidas, qualidade de Cognee, escala máxima do formato ou recuperação física. Integração #53/#54/#56, revisão adversarial final, suíte nativa/geral, CI e homologação do operador/piloto são gates próprios; não declarar a assistente pronta com esses gates pendentes.
