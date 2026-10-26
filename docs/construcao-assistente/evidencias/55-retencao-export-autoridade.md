# #55 — exportação e autoridade de retirada (etapa A)

Implementação local, sem deploy, dados reais, chamada paga ou ativação de retenção. A issue permanece aberta: purga, coleta de R2, restauração selada e homologação de recuperação ainda são etapas separadas.

## Contrato implementado

`AssistantExport.page` exige ator owner copiado antes da primeira leitura. O catálogo vem de `sqlite_master`, com nomes/colunas validados pelo host; o chamador não escolhe SQL nem tabela. Exporta todas as tabelas `assistant_*` da instalação/geração, incluindo corpos, metadados e estado operacional. As duas tabelas financeiras de #37 são exportadas em **todas** as gerações e períodos da instalação, conservando reservas incertas e custos liquidados. Não exporta o arquivo original de WhatsApp nem outros namespaces.

Cada página contém no máximo 50 partes de JSON UTF-8 em base64; cada parte tem até 24 KiB antes de base64 e o conjunto de partes até 96 KiB serializados. Registros grandes continuam na página seguinte com hash, tamanho e offset. Mudança ou desaparecimento do registro durante essa continuação falha explicitamente. IDs de linha negativos entram na listagem; IDs/números inteiros não representáveis com precisão falham. O cursor vincula namespace e esquema. É uma **listagem viva paginada**, sem promessa de snapshot transacional: atualizações ou inserções anteriores ao cursor entre páginas exigem um novo export/snapshot para prova de restauração.

O owner RPC `query(kind="assistant.export")` preserva a afinidade já autenticada. Não há ferramenta disponível ao modelo para exportação nem nova rota HTTP pública.

`RetentionAuthority` é um Durable Object privado e nominal, identificado por instalação e **independente da geração operacional**. Guarda apenas hashes de origem/identidade retirada, monotonicamente. Hashes de identificadores pessoais não são anonimização. Consulta indisponível ou estado parcial/corrompido nunca significa lista vazia. O wrapper confere a identidade real do DO. O core exige bootstrap paginado completo e digest exato antes de aceitar consultas/retiradas. Recibos exatos permitem reconciliar ACK perdido sem substituir páginas ou apagar retiradas.

O bootstrap usa manifesto do inventário D1 de todas as gerações da instalação, inclusive tombstones, sem ler corpos. `RETENTION_BOOTSTRAP_SEAL` é uma declaração de configuração privada do host sobre esse manifesto; o hash recalculável **não é segredo nem autorização**. O helper de bootstrap é host-only, sem RPC do owner/modelo para iniciá-lo. Releitura final detecta mudanças observadas; ela **não prova atomicidade distribuída** entre D1 e DO. O uso real exige quiescência/barreira de escrita validada na etapa de restauração. Não provisionamos binding nem selo neste patch.

Quando configurada/exigida, a autoridade é consultada antes de criar/corrigir notas; uma retirada é registrada externamente antes da mudança lógica em D1. Uma nova geração não pode recriar a mesma origem retirada por essas APIs. A leitura normal é bloqueada pelo status D1 após a retirada. Replay de comando já confirmado devolve o recibo original, inclusive após perda do ACK D1. Revisão obsoleta não registra nova retirada. Captura legada não ganhou dependência remota neste estágio. A proteção de **todas** as entradas de versões e de replay/restauração exige a barreira local fail-closed ainda pendente.

Uma retirada externa confirmada seguida de conflito/indisponibilidade em D1 conserva o tombstone externo e exige reconciliação; não há compensação que apague a retirada. Até essa reconciliação/barreira, não se deve declarar bloqueio global imediato de fonte que continua ativa em D1.

## Validação

`npm test -- tests/assistant-retention-authority.test.ts tests/assistant-retention.test.ts`: **19/19 passaram**, dois arquivos em sequência, 37,20 s. `npm run check` e `git diff --check` passaram. Testes com D1 local real e armazenamento transacional simulado do core da autoridade; não são teste nativo do wrapper DO nem prova de restauração.

O dirigido inicial reproduziu `export_schema_unsupported:assistant_capture_changes`: prefixo comum ao arquivo-fonte não define namespace da assistente. A correção exclui exclusivamente as duas tabelas de transporte do arquivo por nomes fixos do host, mantendo falha para qualquer outro esquema incompatível. A contraprova de BLOB 160 KiB encontrou `export_type_unsupported` porque D1 retorna byte arrays; a serialização binária foi corrigida e o caso passou. Uma fixture de tabela deliberadamente incompatível passou a removê-la em `finally`, preservando isolamento entre os casos. Nenhum resultado intermediário foi chamado de aprovação final.

A cobertura inclui 1.051 registros sem omissão/duplicação, texto multibyte grande, BLOB grande, cursor alterado, mutação entre partes, rowid negativo, financeiro de gerações antigas, isolamento de outra instalação, afinidade real do owner receiver, bootstrap parcial/corrompido, paginação de 260 hashes, reinício/concorrência/ACK perdido, retirada externa antes do D1, revisão obsoleta e indisponibilidade da autoridade. Custo pago: **US$ 0**; nenhuma API remota foi chamada.

## Pendências explícitas

- Purga ordenada das projeções, permissões e recibos, preservando fonte tombstone e todo financeiro; tratar callback tardio que já conheceu custo real.
- Migração aditiva 0024 para autorização nominal de purga de mídia e barreiras de referência R2. Nenhuma migração antiga foi alterada.
- Coleta de objeto R2 apenas no prefixo próprio, sem referência em qualquer namespace, com claim persistido antes de apagar. Nenhuma remoção externa foi executada.
- Restauração em geração externamente nova, modo sombra, whitelist canônica e trabalho pausado; sem reativar jobs, episódios, Telegram ou OAuth. Requer autoridade de retirada disponível e prova do histórico financeiro íntegro; ausência de prova bloqueia orçamento.
- CLI/selo de restauração e teste nativo do wrapper DO, provas de crash/restart/ACK perdido, composição com #53/#54 e piloto real.
- Cópias externas, mensagens Telegram e snapshots Cloudflare exigem procedimentos/API próprios; este patch não promete removê-los.
