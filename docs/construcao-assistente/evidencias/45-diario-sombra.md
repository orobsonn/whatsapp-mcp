# #45 — diário de decisões em sombra

Prova local em 26/10/2026, sobre a base `f601dd4`/v0.32.0, com dados sintéticos, D1/workerd e Flue 2.3.0/Pi 1.1.0 reais. O adapter de modelo é determinístico; não houve modelo pago, credenciais novas, deploy, WhatsApp ou Calendar real. Migração própria: `assistant/migrations/0017_shadow_decisions.sql`.

## Comportamento implementado

Todo job Flue exige sujeito nominal do host no request imutável e no binding do episódio: evento capturado com epoch/generation/chat/sequence/metadataHash, pedido do dono com âncora owner_note e requestKey, ou ocorrência/version de FUP. A admissão exige o cabeçalho correspondente; ausência ou vínculo conflitante bloqueia a execução. Captura confere o inbox e seu replay canônico exatos. Redelivery preserva a observação coalesced original; um novo evento da mesma fonte não herda a decisão anterior.

Publicação passa obrigatoriamente pelo diário no controller e no CAS da fila. O INSERT condicionado pelo mesmo plano precede a publicação na MESMA D1.batch. O CAS exige entrada com request, episódio, binding, proposta e nonce correspondentes. INSERT de zero linhas não publica; erro transacional desfaz a publicação inteira. Perda de ACK depois do commit recupera a referência original, sem inferência nem submissão nova. Recibo de modelo permanece observação computada e não é exibido como publicação concluída sozinho.

O readmodel parte do inbox, conserva pendências, gaps e eventos sem job/replay, e acrescenta falhas/incertezas/tentativas do diário. Replay ignored/withdrawn e operação de captura continuam metadados explícitos, sem serem convertidos em silêncio calculado. Jobs Flue sem vínculo ou com request malformado ficam visíveis como falha de integração. Uma linha corrompida não derruba a página inteira.

A lista é exclusiva do dono, só contém metadados, usa páginas 20/50, aplica filtros antes de LIMIT e vincula cursor a namespace/filtros. Seu fim significa fim daquela página da live view; não certifica acervo completo nem frescor remoto. O detalhe valida schemas/hashes e o sujeito original, revalida o pacote INTEIRO, âncora, ACL/identidade/mandato, busca, conversa e intenção FUP. Fontes remotas exigem OriginGuard disponível, até duas verificações concorrentes e deadline total. O batch local final usa um novo clock depois dos awaits. Detalhe serializado é limitado a 32KiB; stale/unavailable não libera proposta/quotes.

Freshness não exige lease de executor ainda vivo. Proposta settled com base/permissões atuais continua current depois do prazo de execução. Cancelamento ou mudança real de FUP/mandato invalida a proposta. Attestations exigem episódio ativo e job processing com lease nominal vigente: consultas de autorização ou publicações repetidas não podem trocar o nonce de uma publicação settled.

## Critérios e contraprovas

| Critério | Prova controlada |
|---|---|
| 10.191 — decisão/falha visível | Evento capturado1 produz proposta; evento2 da mesma fonte produz model_uncertain; evento3 continua not_evaluated. Corpus distingue proposta, silêncio calculado, contexto pendente, falha, cancelamento, uncertain e job sem vínculo. 1050 eventos são paginados sem duplicatas, com negativos no meio e filtros antes de LIMIT; EXPLAIN confirma busca por namespace e índice de captura. |
| 10.192 — fontes/versões | Diário registra refs do pacote inteiro, hashes e receipts limitados; detalhe confere proposta/binding/request/subject. Correção de fonte não citada suprime a proposta sem reinferência. Corrupção de hash, nonce ou sujeito não libera corpo nem falsifica atribuição. |
| 10.193 — zero mutação observada/FUP | Publicação de FUP preserva snapshots integrais de follow_ups, occurrences e source_versions. Episódio Flue nativo preserva fontes observadas; estado de execução pertence ao job/episódio/diário. |
| 10.194 — freshness | Settled permanece current depois do deadline; fonte alterada, FUP cancelado, mandato que expira durante awaits e mutação local durante consulta remota invalidam o corpo. Origem remota válida permanece legível; retirada, indisponibilidade e leitor pendurado retornam unavailable dentro do deadline total. |
| 10.195 — zero saída | OutboundService do fixture real recusa toda conexão externa e confirma zero chamadas. Nenhum sender, Calendar writer ou capacidade operacional é conectado ao diário. Modelo sintético não chama transporte pago. |

Atomicidade adicional: INSERT0, rollback real do D1 no meio do batch, ACK de commit perdido, queue.publish direto sem diário, ausência de cabeçalho e duas publicações/leituras posteriores não contornam o registro. Flue/workerd nativo publica, perde o ACK da publicação, reinicia frio e recupera o mesmo decisionId com uma entrada e uma chamada sintética de modelo. Statements nativos recusam mais de 100 bindings.

## Revisão independente

A revisão adversarial reproduziu três problemas antes da correção: autorização de episódio settled girava o nonce e apagava a prova de commit; timeout de read aparecia como pending no diário; JSON malformado de um job derrubava a lista. As quatro contraprovas independentes passaram após o delta, e os três casos foram incorporados aos testes versionados. A correção condiciona as attestations ao estado/lease atuais, persiste uncertain com reason fixo e protege a extração JSON por linha. O revisor independente reexecutou as quatro contraprovas e os 24 testes versionados, revisou o delta final e aceitou os três fixes sem blocker remanescente no escopo.

## Verificação e reprodução

- `npx vitest run tests/assistant-decisions.test.ts`: 24 testes passaram em Workers/D1.
- `npm run check`: passou.
- `npm test`: 714 testes em 46 arquivos passaram, na árvore final após os três fixes da revisão.
- `npm run test:assistant-runtime`: 41 testes em 2 arquivos passaram, com build oficial da assistente, workerd/Flue, reinício frio e zero tráfego externo.
- `npm run build` e `npm run build:assistant`: passaram; o segundo também é executado antes dos testes nativos.
- `git diff --check`: passou.

O aviso conhecido do bundler sobre `use agent` permanece; os testes verificam as classes geradas e o runtime nativo. Logs de RED/GREEN locais são auxiliares; a prova reproduzível está nos testes versionados.

## Limites preservados

Esta entrega implementa rastreabilidade e publicação em sombra. A cobertura contínua de TODO evento elegível pelo bootstrap/scheduler e o corpus de piloto continuam gates de #53/#56/#57; uma listagem completa de pendências não é prova de processamento contínuo. Integração MCP/Telegram, qualidade semântica de modelo comercial, purga dos corpos derivados (#55), CI/merge e release pertencem aos seus gates próprios. Não foi validado nem ativado piloto cloud nesta entrega local.
