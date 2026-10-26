# #49 — vencimentos e procedência de FUPs

26/10/2026. Entrega local para revisão; sem deploy, inferência paga, envio, PR ou release. A continuidade do scheduler pertence a #53/#56/#57; a homologação cloud de #46 continua separada.

## Comportamento

O mesmo `OwnerControl` autenticado de #46 cria, reagenda, pausa e cancela FUPs e missões. `candidate:{batchKey,claimIndex}` apenas vincula evidência Relations atual: fonte/revisão/versão/hash, quote literal e autor observado são conferidos na admissão transacional. A autoridade permanece no comando do dono e `origin=owner_request`; quote, sugestão, fromMe e rascunho não produzem `external_request` ou `assistant_commitment`.

Migração aditiva `0019_fup_provenance.sql`: procedência por versão no mesmo batch do comando/recibo. Condições são dados atribuídos, nunca programa ou prova de satisfação. Candidato sem condição tem estado `unknown`; pedido direto sem condição tem `none_explicit`. Pause/cancel copiam a procedência; `fup.put` é substituição explícita versionada e conserva todas as versões anteriores para auditoria. Legados sem sidecar continuam utilizáveis com procedência `legacy_unavailable`; um recibo novo que exige a procedência impede tratar sidecar ausente como legado.

`dueAt/windowEnd` aceitam instante UTC numérico ou RFC3339 com offset e fuso IANA explícitos. Validação de calendário e round-trip no workerd recusam gaps DST, offset incompatível, datas normalizadas inválidas e `-00:00` desconhecido. Os dois offsets de um fold explícito são aceitos como instantes diferentes. Uma janela exige ambos os extremos; nenhum horário é inferido de texto relativo ou precisão de dia.

`FollowUps.admitDue({cursor?,limit<=20})` é host-only. Varre versões atuais vencidas com ordem estável, cria ocorrência determinística e reutiliza JobQueue/subject45. O INSERT do job repete versão, due, estado, missão, fonte e mandato atuais e impede outro job da mesma ocorrência mesmo com alias diferente. `awaiting_approval` nunca entra automaticamente. Condição sem data permanece sem timer; condição com data pode receber uma avaliação em sombra, sem assumir que foi satisfeita.

Antes de reconstruir fences, a recuperação busca job/ledger existentes e repara o seed45 a partir do request durável. ACK perdido, contexto novo, restart e uncertainty não criam nova chave/inferência. Estado órfão/bloqueado permanece explícito. O pedido inclui condição/status e instantes como dados; se ultrapassar os limites existentes de query #44, retorna `blocked/input_limit`, sem truncar. `recurrence_limit` não inventa cadência nem autoriza insistência.

`query:{kind:'follow_up',id}` no named receiver #46 distingue `obligationState` e `evaluationState`, prazo e próxima avaliação, e retorna procedência somente com pai/origem atuais. Fonte retirada ou origem indisponível suprime condição, quote e autor do detalhe. A publicação45 fecha somente job/episódio; FUP, ocorrência, missão e original permanecem intactos.

## Evidências

- RED inicial: core recusava RFC3339 e candidato; GREEN após o contrato. RED independente mostrou dois jobs para uma ocorrência com dedupe diferente; o gate SQL agora mantém um. RED de reconciliação mostrou ocorrência cancelada anunciada como admitida; as guardas atuais impedem isso.
- 28 testes novos no D1/workerd: DST, condição/atribuição, origem injetada, correção no batch, rollback, ACK perdido, concorrência, cancelamento/reagendamento/missão, uncertainty, sidecar ausente e paginação de 1.051 vencimentos com negativos e último válido. O plano SQL utiliza o índice due existente.
- Revisão adversarial independente encontrou dois REDs: retirada da captura durante a leitura da procedência ainda liberava condição/quote, e sidecar novo ausente era rotulado legado. O detalhe agora termina com origem e ACL atuais, depois de carregar a evidência; recibo novo sem sidecar retorna indisponível. As três contraprovas versionadas passaram (incluindo limite de input), assim como a suíte externa independente **28/28** (`/tmp/adversary49-green-final.txt`).
- Named service binding real: comando com horário/fuso e consulta de procedência atravessam dois Workers e sobrevivem ao restart com o mesmo recibo.
- Flue real local: OwnerControl → vencimento → ocorrência/job/subject45 → RetrievalRuns → EpisodeController → callback limitado → diário45. Uma chamada sintética; replay conserva a identidade; obrigação/missão/ocorrência não mudam. O transporte externo do ensaio nega qualquer rede real.
- Check e build/dry-run passaram. Suíte completa: **814/814 em 51 arquivos** (`/tmp/assistant49-review-full.log`). Suíte nativa Flue/binding: **47/47 em 3 arquivos** (`/tmp/assistant49-review-runtime.log`); ela também reconstrói o bundle oficial do assistente. Os logs conservam avisos de sourcemap/workerd do ambiente local.

Essas provas demonstram composição controlada local, não acompanhamento contínuo instalado, cliente real ou mensagens entregues. Revisão independente local aprovada; CI no commit integrado e homologação real continuam pendentes do coordenador antes de fechar a issue/release.
