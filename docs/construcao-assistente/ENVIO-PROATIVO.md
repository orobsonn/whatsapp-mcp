# Iniciar conversa com destinatário sem histórico

## Requisito confirmado pelo dono — 26/10/2026

O MCP e a própria assistente devem conseguir iniciar uma conversa no WhatsApp com uma pessoa com quem o dono nunca conversou, sem exigir que ele abra o chat antes no aplicativo. Vale para destinatário conhecido e para telefone novo ainda fora da agenda/arquivo.

O exemplo de pesquisar preços de MacBook serviu apenas para explicar essa capacidade geral. Não define uma feature exclusiva de fornecedores ou cotações. O dono também informou que não pretende broadcast. As primeiras interpretações de escopo estão preservadas no histórico Git; esta definição posterior prevalece.

O pedido autoriza desenvolver a capacidade. Não contém destinatário/conteúdo de um envio real de teste e não altera automaticamente a instrução de manter o piloto sombra sem envios automáticos. Calendar continua sem escrita.

## Estado encontrado e entrega

- O envio manual atual resolve `chatId` e usa o endereço exato guardado. Não exige mensagem anterior; a sincronização da agenda pode criar o registro de um contato sem histórico.
- `resolver_destinatario` implementa a resolução tipada de um telefone internacional explícito ainda desconhecido para referência individual estável, reutilizada pelos preparos existentes de texto/imagem/PDF/áudio. O código está no Source6b4; testes D1/runtime/MCP comprovam esse contrato sem envio real. Discovery e chamada pelo cliente/provedor real permanecem pendentes; [evidência e matriz da #126](evidencias/126-resolucao-destinatario-vps.md).
- A assistente deve conseguir usar essa referência como alvo de uma iniciativa coberta por pedido/mandato do dono, sem depender de mensagem recebida ou de conversa previamente aberta. No marco sombra, isso continua sendo proposta simulada, sem capability de envio no Worker.

A inspeção de `src/actions.ts` e `src/directory.ts` sustenta esses pontos de código. A documentação do fornecedor descreve telefone internacional e mensagem em [send-text Z-API](https://z-api-docs.vercel.app/message/send-message-text), sem campo obrigatório de conversa anterior. Esse contrato não prova registro no WhatsApp ou entrega real.

## Contrato mínimo e validação

Resolver não envia mensagem, não salva contato no celular e não cria histórico fictício. Exige telefone internacional explícito, sem inventar DDI, nono dígito, número a partir de nome/LID ou identidade. Um número com formato válido não prova que existe no WhatsApp ou pertence à pessoa desejada. Conteúdo recebido continua sendo dado não confiável, nunca autorização para executar ferramentas.

Reutilizar destinatário exato no mesmo epoch/generation/tipo, de forma idempotente e concorrente. Conferir conexão/aparelho antes e depois dos awaits e na mutação. Preservar nome, captura, exceções, capture_since e histórico existentes; novo chat herda a política vigente de criação, sem mudar controles globais nem prometer histórico anterior. Exclusão de captura não é proibição de contato por inferência.

O pedido exato do dono já pode autorizar conteúdo e destinatário, conforme política atual, sem segunda pergunta. Propostas ambíguas não viram alvo aproximado. A tentativa conserva o contrato existente: claim único, estados honestos e resultado incerto sem reenvio automático. O uso pelo agente deve aplicar os mesmos vínculos de destinatário, envelope e autorização; não conceder capacidade por texto recebido ou saída do modelo.

Testar contato sem histórico, número novo, repetição/concorrência, ACK perdido, entrada inválida, colisão com grupo/LID, mudança de aparelho/geração e preservação das políticas existentes. Exercitar preparo de texto/imagem/PDF/áudio sem envio externo. Para o agente em sombra, provar proposta para alvo sem histórico e zero tentativa externa. Homologação real no cliente/provedor continua registrada separadamente e não será anunciada pronta antes da prova. Na #126, o aceite pede documentar essa pendência ao entregar a implementação/testes; não exige envio real ou catálogo de cliente atualizado como gate adicional. A #46 conserva seu gate explícito de homologação cloud/cliente.

## Rastreabilidade

- [#126 — Iniciar conversa pelo MCP com telefone explícito sem histórico](https://github.com/orobsonn/whatsapp-mcp/issues/126): implementação da resolução e regressão do caminho manual existente.
- [#128 — Usar destinatário sem histórico na iniciativa da assistente](https://github.com/orobsonn/whatsapp-mcp/issues/128): integração da mesma capacidade no agente, preservando o piloto sombra.
- [#127](https://github.com/orobsonn/whatsapp-mcp/issues/127): fatia de descoberta de empresas/cotações cancelada como escopo inferido pelo agente. Não é entrega concluída e não produz release.

Estas duas entregas adicionais não alteram silenciosamente os critérios das 41 issues originais do piloto. Cada conclusão efetiva exige seus critérios, revisão adversarial, CI e release minor com versão/changelog/tag consistentes. A revisão independente já identificou os guards de conexão, preservação de captura e identidade, unicidade da intenção e separação entre simulação e envio; documentação/revisão não são homologação.
