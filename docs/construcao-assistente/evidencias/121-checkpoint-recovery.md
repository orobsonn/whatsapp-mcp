# #121 — recuperação explícita de checkpoint interrompido

Implementação local em 26/10/2026, sobre `f601dd4`/v0.32.0, rebaseado sobre a v0.33.0; a prova cloud compõe o código112. Nenhuma API paga, snapshot cloud, deploy, reset de ledger/orçamento, WhatsApp ou Calendar foi chamado por esta entrega. O caso cloud que motivou a issue é evidência do coordenador: candidato novo persistido, confirmação antiga e maintenance=true depois de interrupção. A recuperação cloud executada pelo coordenador está registrada abaixo.

## Correção

`restoreCheckpoint` continua uma operação explícita do host, sob exclusão de lifecycle. Um estado restoring pode reclamar e restaurar o candidato DURÁVEL exato. Preparing/restoring sem candidato conhecido permanece uncertain; confirmed antigo não é fallback. O candidato é validado por identidade da instalação/build/configuração, manifesto/hash, handle/ID, fontes e prazo. Estado legado sem checkpoint.index deriva seu alvo apenas do manifesto do candidato validado; não muda época nem cria snapshot/modelo.

O estado novo persiste o plano do índice antes de efeitos. Cada etapa do controller verifica owner/revision e, no adapter real, namespace/epoch/revision/fontes/maintenance antes e depois dos awaits. O adapter físico repete a guarda dentro de boot, inclusive depois do hash de configuração, readiness e esperas, e confirma que destroy realmente parou o processo antes de restore. Falha/limpeza também usa guards, em sequência; owner antigo não pode limpar o substituto.

`makeCheckpointStore` usa uma transação real do Durable Object para comparar revisão do checkpoint e o índice atual. Confirmação exige mesmo owner, estado restoring, candidato original e namespace/época/revisão/fontes correspondentes. Checkpoint confirmed, indexState/lost, maintenance, quarantine e active são publicados juntos ou sofrem rollback juntos. Rebuild que troca a época ou alteração do mesmo índice invalida o commit antigo.

`CogneeEngine.maintain` deixa de gravar index/quarantine/maintenance incondicionalmente e de chamar stop destrutivo no catch sem owner. Ele somente coordena exclusão e verifica o estado já publicado pelo store. Os efeitos físicos são registrados como promises subjacentes: um timeout da chamada não libera busy enquanto a operação continua viva. Quando a promise termina, a exclusão local pode ser liberada; o gate persistente continua fechado até recuperação validada.

ACK perdido após claim/candidate/commit é conciliado pela identidade/revisão/estado exatos persistidos, sem outra captura. ACK perdido antes do claim não inicia efeitos e permite nova recuperação explícita do mesmo candidato. Snapshot cujo ACK/handle se perdeu não é repetido.

## Contraprovas e fronteira da evidência

- RED original: sete casos de candidato interrompido, fallback indevido, owner suspenso, troca de owner depois de destroy/na limpeza e publicação antiga de maintain.
- RED físico: boot podia iniciar depois de perder owner durante hash; destroy retornava sem provar parada. Agora ambos negam, com spies nos efeitos reais do adapter.
- RED do store: commit com owner diferente foi aceito antes do predicado adicional. A confirmação agora também exige o candidato exato que estava no estado anterior.
- Contraprova da retenção de timeout: retirar somente o registro da promise faz o teste falhar porque lifecycle fica disponível cedo. Com a implementação restaurada, search/maintenance/rebuild continuam busy até a promise física terminar.
- Teste nativo usa DO SQLite/workerd real, persistência em disco e reinício frio; port de snapshot/modelo é sintético e recusa novas capturas. Candidato com 9 fontes/5.400.000 bytes substitui confirmação antiga2, mantendo o mesmo snapshot/id/manifesto e zero snapshot/modelo novo. Variação legacy não possui checkpoint.index. Outra variação reinicia phase=confirmed com maintenance=true e recupera o mesmo confirmed de 9 fontes.
- Transação nativa testa rollback injetado entre checkpoint/index/gates; epoch, revision, sources, namespace, owner ou candidate divergentes recusam sem escrita parcial. Claim e commit com ACK perdido se reconciliam; ACK perdido antes do claim conserva o estado original.
- Controller/engine testam concorrência, candidato inválido/expirado, fonte corrigida, limpeza/inspect de owner vencido e falhas de destroy/restore/inspect. Fixtures recusam rede externa e nenhuma capacidade de envio/agenda é conectada.

A configuração de testes inclui o novo teste nativo na suíte assistant-runtime e o exclui da suíte Workers padrão. Usa esbuild já presente no lockfile para empacotar somente o probe descartável; não adiciona dependência nem rota ao produto.

## Verificação

- `npm run check`: passou.
- `npm test`: 705/705 testes, 45 arquivos.
- `npm run test:assistant-runtime`: 49/49 testes, 3 arquivos, incluindo os 10 testes nativos então existentes e o build do runtime.
- `npm run build`: dry-run do Worker passou.
- Teste nativo final: 11/11, incluindo o caso adicional confirmed + maintenance=true.
- `git diff --check`: passou.

Revisão independente do coordenador leu controller, adapter físico, store transacional, maintain e contraprovas; não encontrou blocker. Sua execução independente confirmou core 69/69 e native 10/10 antes do caso adicional. O caso adicional mudou somente teste; o código de produção permaneceu congelado depois da revisão.

## Prova cloud do coordenador

O código121 integrado ao112 foi publicado no Worker sintético isolado, versão571d3a80-02a5-40a7-aa89-2f83100e9db0. A recuperação explícita levou14,87s e confirmou o MESMO candidate03339ec2… de5439701bytes, com as mesmas nove fontes e revisão do índice. O checkpoint antigo de duas fontes não foi usado. Não houve reset de geração, novo snapshot ou reingest.

Os recibos completos permaneceram228 e o custo comprometido do período permaneceu3692microUSD antes/depois; a recuperação não chamou modelo. A evidência curada está em121-checkpoint-cloud.json. O Container estava parado antes do deploy/restore, e o estado recuperado era o restoring legado sem checkpoint.index que motivou a issue. Esta é prova do serviço Cloudflare real naquele cenário sintético, não piloto de atendimento nem prova de histórico real.

O coordenador também integrou121+112, preservou EngineStore.transaction/tickets e executou98 testes dirigidos +check sem falhas. CI no commit de entrega e release minor continuam gates antes do fechamento.

## Limites

Não se promete cancelar uma operação remota já em andamento. A proteção é impedir outro lifecycle concorrente na mesma instância e impedir efeitos/commit posteriores de um owner antigo. Reinício real elimina a execução antiga; o estado persistido precisa ser recuperado explicitamente.

Recuperação não reconstrói nem rekeya operações/modelos incertos. Candidato sem handle ou inválido exige tratamento explícito/rebuild, conservando o bloqueio do estado interrompido; nunca troca silenciosamente para uma confirmação antiga. Os contratos de tickets/EngineStore adicionados por112 precisam ser preservados no merge; esta branch não os substitui.

## Retomada VPS — bloqueio da release v0.34.0

A falha do run CI40315100926 era uma disputa de prazo na contraprova do diário45: a fixture aplicava25ms também ao caso que precisa concluir a revalidação remota com escrita D1 antes de negar no batch local. O retorno unavailable continuava suprimindo a proposta; não havia prova de bypass. Revisão adversarial independente confirmou que stale deve continuar obrigatório no teste de política, enquanto indisponibilidade/timeout conservam unavailable.

A fixture agora usa o prazo normal4000ms para setup saudável e para a corrida de política. Os casos withdrawn/offline/hung conservam25ms na leitura negativa; o setup saudável não usa esse prazo artificial. A corrida também verifica que o callback executou e incrementou a revisão pelo número exato de mutações. Nenhum código de produção ou política de supressão foi alterado. Validação dirigida na VPS:24/24 testes do diário passaram antes do isolamento adicional do setup. CI do HEAD corrigido continua obrigatória antes de merge/tag/fechamento.

Verificação de acessos: GitHub autenticado após liberar rede; token do perfil Cloudflare pessoal inválido, login por dispositivo iniciado. Credenciais/probes privados do Mac ausentes e Docker não instalado. Nenhuma chamada de modelo paga nesta correção; ledger anterior e reservas incertas preservados.
