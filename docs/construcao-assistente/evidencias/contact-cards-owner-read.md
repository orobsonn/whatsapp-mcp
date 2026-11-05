# Cartões compartilhados e consulta de transcrições

05/11/2026. Correção da consulta autenticada do dono, sem envio real.

## Diagnóstico

`ownerToolProvenance` calculava o digest de `snapshot.content` bruto. O leitor da origem e o materializador usam `observeSnapshot`, que normaliza o conteúdo pelo schema. Em transcrições com mídia, `media` e `mediaVersion` eram serializados em ordens diferentes. O mesmo conteúdo recebia hashes distintos e a publicação recusava a página com `owner_tool_source_not_current`.

O teste com D1 e reader reais reproduziu a divergência antes da alteração. A correção usa `observeSnapshot` também na proveniência. Nenhuma guarda foi removida: identidade da origem, versão, texto, acesso, contexto e comando autenticado continuam sendo conferidos. O teste integrado percorre reader, materialização, proveniência e exposição canônica ao agente do dono.

## Cartões

O [contrato oficial da Z-API](https://developer.z-api.io/webhooks/on-message-received-examples) entrega `contact.displayName`, `contact.phones` e `contact.vCard`. O capturador anterior ignorava esses campos e arquivava o evento como não suportado.

A projeção agora guarda texto JSON com `type=shared_contact`, `untrusted=true`, nome, números internacionais e `phoneExtractionComplete`. Isso reutiliza o arquivo, a busca, a paginação, as políticas e a proveniência existentes, sem migração. O remetente e o contato indicado continuam separados.

Somente strings em formato telefônico são aceitas. `phones` e `waid` são números internacionais documentados; `TEL` exige `+`, sem inferência de país, alteração de dígitos, extensões ou conversão de LID. Propriedades agrupadas e linhas dobradas são tratadas; números distintos são preservados. Entrada até 16 KiB, 256 linhas e vinte números. Excesso é indisponibilidade explícita; dados não interpretados impedem afirmar extração completa. Fotos, URLs, notas e demais campos do vCard não são guardados.

O número literal do cartão indicado pelo dono pode alimentar `resolver_destinatario`. O cartão isolado não é autorização, e JSON semelhante em texto recebido não ganha autoridade. Vários números ou extração incompleta exigem esclarecimento do destino. O teste percorre captura, consulta, proveniência, resolução e preparo, verificando o destinatário separado do remetente e ausência de tentativa de envio.

## Limites e revisão

A revisão adversarial confirmou o reparo do digest e identificou dois casos corrigidos com regressões: `contact:null` junto de texto válido e `item1.TEL` omitido da lista de números. Revisão final sem bloqueadores.

Eventos antigos armazenados como não suportados não conservam o payload original. Esta correção não inventa nem reconstrói o cartão a partir de um homônimo da agenda. Reentrega do callback original, quando disponível, continua sujeita às guardas existentes de captura, privacidade, versão e exclusão.

A rodada geral interrompida por repouso do Mac teve falhas de tempo; os 81 testes dos três arquivos afetados passaram na repetição. A base final inclui a correção de imagens/PDF da PR #165, para preservar a versão já publicada.

Validação final: 2.383 testes gerais aprovados sobre a base integrada de imagens/PDF; após incorporar a correção complementar de revisão de mensagens editadas, 132 testes focados de reader, host, cartões e ferramentas do dono aprovados. Tipos, build Source e smoke local de versão/acesso privado aprovados. Publicação de produção ainda pendente de coordenação com a manutenção concorrente.
