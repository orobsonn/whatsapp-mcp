# #54 — avaliação explícita do dono e saúde observada

Implementação controlada na VPS em 26/10/2026. Não declara o piloto homologado; depende da integração com #53 e de CI/validação do produto.

## Contratos

`Evaluation.sample` utiliza `DecisionJournal.list` real, com paginação/filtros vinculados ao namespace. Proposta, silêncio, contexto pendente, falha, incerteza, cancelamento e evento não avaliado permanecem estados distintos. A fração de proposta/silêncio tem denominador de **entradas desta página**, incluindo tentativas históricas, e não mede mensagens globais cobertas. Página vazia produz null/unknown, nunca 100%.

O MCP do dono oferece `assistente_avaliar`, separado das consultas tipadas `evaluation.sample`, `evaluation.metrics`, `evaluation.exposure` e `assistant.health`. A afinidade autenticada precede toda operação. Perfis Flue não recebem essa capacidade. Conteúdo recebido, `fromMe` e botões de aprovação simulada não produzem avaliações nem observações de ação humana.

Expor uma entrada grava horário do servidor e hash de metadados/proposta, sem guardar corpos ou citações. IDs/request keys podem conter dados pessoais: metadados não são anonimização. O registro indica `server_registered_exposure`: não comprova que alguém leu ou prestou atenção. Avaliar exige `basis:owner_report` e uma classificação explícita `correct/unsupported/missed_silence/unknown`, podendo incluir ação humana relatada e referência de fonte atual. São `owner_assessment_at_exposure`, nunca recibos do provedor nem verdade atual verificada. Não há envio, modelo, confirmação de compromisso ou encerramento de FUP.

O ledger de comandos #93 faz operação/hash/recibo e escrita no mesmo batch. Uma exposição aceita uma avaliação; correção exige nova exposição. Repetição preserva o recibo original e conflito recusa. Para estatísticas usa-se a avaliação mais recente por ID canônico da entrada, com desempate determinístico por horário/ID; múltiplas exposições não ampliam o denominador. Avaliações unknown ficam fora da fração de juízos conhecidos. Tempo entre exposição e avaliação é `elapsed_wall_not_active_review`, incluindo espera e interrupções.

Consultar uma exposição revalida a entrada pelo diário e marca stale quando proposta/fonte já mudou ou ficou indisponível. Evidência de ação humana passa novamente por ACL/origem e, quando retirada, retorna somente indisponibilidade. O juízo histórico permanece registrado. Estatísticas globais de rótulos são explicitamente `unchecked_historical`, com `currentCorrectness:unknown`; não fazem milhares de chamadas remotas nem anunciam que um rótulo antigo continua correto.

Custos vêm exclusivamente das reservas #37, em microUSD, para a instalação em **todas as gerações e períodos**. Settled soma actual_units; reserved e uncertain conservam ceiling_units separados. O comprometido soma esses valores sem zerar passado; não se deduz teto global somando caps nem se chama isso fatura. Latência usa somente publicações confirmadas com job/ledger/episódio/nonces coerentes: seeded_at → recorded_at, com denominador explícito. Duração de inferência não é medida por esses timestamps.

`assistantHealth` separa presença de configuração dos últimos eventos locais recebidos/aplicados/bloqueados, pausas, gaps e bloqueio de orçamento. Contas são da geração atual em todos os períodos, mas `currentPeriod` UTC e `currentAccountConfigured` distinguem conta antiga de orçamento configurado para hoje. Zero eventos mantém saúde desconhecida; idade da última recepção não prova falha quando não houve mensagens. Captura recebida não prova completude upstream; snapshot não é atômico. Saúde de cliente e homologação não são inferidas de flags. Estado específico do scheduler permanece pendência de integração #53.

## Validação e limites

Plano revisado adversarialmente pelo coordenador antes da implementação: manter avaliações históricas atribuídas, não contar labels stale como verdade atual, denominadores claros/zero desconhecido, reserva incerta preservada e configuração separada de saúde.

Testes dirigidos preparam diário obrigatório real, publicação de proposta/silêncio/contexto, falha e evento ainda não avaliado; cobrem paginação, juízos explícitos, idempotência/ACK perdido, retirada, denominador, custos entre gerações, latência, zero eventos e autenticação MCP. Execução aguardou a liberação do coordenador para não concorrer com suítes pesadas.

- RED de integração: desconectada temporariamente apenas a rota `evaluation.sample` do receiver, a contraprova autenticada real falhou: **1 falha/10 pulados**, esperado diário vazio observado, recebido pending_configuration. Rota restaurada em seguida; `/tmp/assistant-evaluation-red.log`.
- GREEN: **23/23 testes em dois arquivos**, 22,76s, incluindo 11 cenários Evaluation/D1 e 12 MCP existentes/novos; `/tmp/assistant-evaluation-green.log`. O denominador de latência também recusa nonce de publicação corrompido. Fonte retirada mantém avaliação histórica e suprime a evidência.
- TypeScript e diff-check aprovados após as correções de revisão. O primeiro check apontou somente pdf-lib ausente nas dependências da main; a worktree passou a utilizar as dependências completas já instaladas da composição de produto, sem reinstalação ou mudança de lockfile.
- Revisão adversarial final pelo coordenador sem blockers; incorporadas as condições de orçamento UTC atual e linguagem explícita sobre metadados potencialmente pessoais. Integração com #53, CI do commit final e homologação continuam pendentes antes de encerrar #54.

Migração aditiva `0023_evaluation.sql`: exposições e avaliações imutáveis, sem corpos. Exportação/retirada operacional dessas novas tabelas precisa ser coberta por #55. Nenhum dado real, credencial, chamada paga, deploy, WhatsApp ou escrita Calendar nesta entrega. Custo incremental de inferência real: US$0.
