# Contexto nativo: provas em lote com digest preservado

Data:29/10/2026. Código `38956b5`. Suplemento: `docs/superpowers/specs/2026-10-29-native-context-proof-batching.md`.

## Problema e comportamento

As19 conferências anteriores dos mesmos166 fences terminaram correntes em7515–32598ms. O caminho anterior repetia aproximadamente duas consultas Own e um RPC Source por origem a cada conferência. Essa é uma observação de custo estrutural; a causa da primeira rotina diária falhar permanece desconhecida.

A retenção agora pagina todas as exposições e pede provas hash-only de até64 origens por chamada. Esse é tamanho de trabalho, não limite do arquivo. O Source usa a consulta/projeção singular existente, normaliza estritamente e calcula SHA256 dos mesmos bytes anteriores. Após o hash, relê as projeções e o guard da configuração dinâmica no mesmo batch D1; não há await após a observação final. Captura/privacidade/mídia/conteúdo/conexão alterados não devolvem um hash anterior válido. Atividade nova sozinha continua separada de mudança de conteúdo.

O Own confere o acesso antes/depois, associa por identidade completa e rejeita respostas incompletas, duplicadas, extras ou com escopo incorreto. Falhas não iniciam o caminho singular; esse fallback existe apenas para adapters comprovadamente sem a capacidade. O predicado final sobre todas as dependências permanece vigente. Cancelamento impede nova página, publicação tardia e purga baseada somente no cancelamento.

Não foram criados MCP, sessão, infraestrutura ou poderes novos. O leitor singular conserva seu contrato. A comparação final detecta mudanças entre observações; não promete revogação remota instantânea depois do snapshot final.

## Validação dirigida e revisão

Quatro arquivos,118 casos passaram, além de TypeScript e builds Source/Own. Hashes golden de mensagem, mídia, derivado e conversa foram fixados antes da extração do normalizador. Os testes exercitam alterações durante o hash real de snapshot, distinguindo-o do digest usado para autenticar o pedido. Incluem rotação da conexão criptografada, captura/privacidade, texto/mídia, limites de bytes, respostas reordenadas/ausentes/duplicadas e130 fontes em três páginas.

A revisão adversarial encontrou um Important: itens bloqueados dentro de uma página válida perdiam seu diagnóstico. Três testes RED reproduziram a omissão, incluindo motivo privado. A correção emite ordinal e motivo pelo vocabulário fechado existente; nenhum conteúdo/ID/hash é registrado. A suite final118/118 passou depois da correção. Nenhum outro Critical/Important foi identificado na revisão; medições de produção são separadas dos testes.

## Publicação

Source publicado primeiro em `18406971-0872-430c-96d9-12f1149ad6f4`. A API confirmou `CaptureReader.readSnapshotProofs` entre os handlers ativos. Só então o Own foi publicado em `fac7b393-a441-466c-a6a8-5d30443ef176`. Os operadores compararam todos os bindings existentes, runtime/migração, schedules e subdomínio antes/depois. Nenhuma migração SQL foi necessária.

Readback Own confirmou modoapproval, curadoria e schedule diário ativos, rotinas não pausadas e configuração de sample ausente. A autonomia de envio não foi ativada. A publicação Source preservou a base ativa36064; não havia outro delta em src/migrations/configuração entre essa base de código e o HEAD anterior ao batching.

## Medição Cloudflare

Na captura limitada, os mesmos166 fences foram conferidos correntes em2694ms, com **4 RPCs de prova e zero checagens singulares**, em vez de166 RPCs. As quatro páginas correspondem à distribuição das exposições; não se promete ceil(166/64) como quantidade de chamadas. É uma amostra real, comparável às19 observações anteriores de7515–32598ms, não uma garantia de latência.

Outras18 verificações de3–4 fontes terminaram correntes entre760 e1127ms. Três invocações observadas terminaram ok, com CPU total de104/161/350ms e wall19515/8008/29770ms. Esses valores são da invocação inteira, não CPU/memória isoladas do lote nem custo total Source. Memória e linhas faturáveis não foram isoladas. Prova privada filtrada: `native-context-proof-batch-filtered-1793314763000.json`; o Tail foi encerrado e a captura bruta temporária removida.

A medição acompanhou o cron existente e não admitiu evento/submission/inferência para o benchmark. O censo nativo passou de209 recibos/835277 unidades para211/838624 durante a janela; não atribuir custo zero à janela inteira nem ocultar a atividade concorrente do bot. Os dois recibos adicionais foram ligados à mesma sessão WhatsApp; a submission real subsequente terminou settled sem erro e registrou propose_reply/silence. Não era uma submission de medição nem retomada do curador falho. Zero attempting/uncertain nessa tabela nos dois censos. Isso é o subconjunto nativo, não substitui o livro financeiro global.

D1.batch reduz viagens/RPCs; o Source lê aproximadamente duas vezes por referência para observar mudanças durante o hash. Não afirmar redução de linhas faturadas, CPU ou memória sem medição correspondente.

## Critérios separados ainda pendentes

A primeira diária continua failed e conserva3679 pendências. O aviso operacional aceito não comprova cobertura. Não houve reabertura/redispatch do recibo antigo para testar esta mudança. A validação do envio WhatsApp após clique humano em sugestão vigente e a release final também permanecem pendentes.
