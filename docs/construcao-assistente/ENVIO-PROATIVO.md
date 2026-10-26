# Iniciar conversas e enviar para vários destinatários

## Decisão do dono — 26/10/2026

O dono pediu que o MCP e a própria assistente consigam iniciar uma conversa no WhatsApp, inclusive com quem nunca houve conversa, e fazer disparos. A capacidade precisa contemplar destinatários já conhecidos e números novos, sem exigir que o dono abra a conversa antes no aplicativo.

Este requisito amplia o produto além de responder mensagens recebidas. A exclusão de campanhas no PRD inicial descreve o marco antigo; não cancela este pedido posterior. Não se infere uma plataforma de marketing, importação ilimitada de listas ou agendamento recorrente deste pedido.

O pedido autoriza desenvolver a capacidade. Não contém destinatários nem conteúdo de um envio real. A mudança do piloto sombra para envios reais permanece uma decisão de produto pendente; até essa definição, o Worker sombra continua sem credenciais Z-API, ferramenta de envio ou binding que alcance um executor de envios. Calendar continua sem escrita.

## Estado encontrado por inspeção

| Jornada | Estado observado | Lacuna |
| --- | --- | --- |
| Enviar pelo MCP para conversa conhecida | `prepareAction` resolve `chatId`; execução usa o endereço exato guardado e uma tentativa por ação. | Não prova entrega real nesta rodada. |
| Contato da agenda sem mensagens anteriores | `upsertDirectoryPage` cria o registro interno a partir da agenda; o preparo não exige uma mensagem anterior. | Falta regressão explícita desta jornada e homologação na fronteira do cliente/provedor. |
| Número explícito fora da agenda e do arquivo | Ferramenta de envio recebe `chatId`, sem resolução pública de telefone novo. | Resolver destinatário sem envio e sem inventar telefone, identidade ou histórico. |
| Vários destinatários | Ação atual tem um único destino e envelope. | Lote durável, autorização do conjunto e resultados individuais. |
| Assistente inicia contato por missão/FUP | Há intenção `future_contact`; decisões são propostas em sombra. | Intenção não equivale a executor nem a autorização para enviar. Precisa de mandato delimitado e integração com o mesmo contrato de destinatário/lote. |

As evidências são leitura de `src/actions.ts`, `src/directory.ts`, dos contratos de controle e do diário sombra; não são ensaios de WhatsApp. A documentação do fornecedor descreve `send-text` com telefone internacional e mensagem, sem campo obrigatório de conversa anterior: [contrato publicado Z-API](https://z-api-docs.vercel.app/message/send-message-text). Esse contrato não comprova que um número existe ou que uma tentativa foi entregue.

## Contrato de engenharia após revisão adversarial

1. Resolver um telefone internacional fornecido explicitamente pelo dono, ou uma identidade já comprovada, para referência interna estável. Não deduzir DDI, nono dígito ou telefone a partir de nome/LID. Resolver não envia, não salva automaticamente no celular e não cria mensagens fictícias. Respeitar geração/conexão. Não alterar captura, exceções, `capture_since` ou histórico ao resolver/enviar. Exclusão de arquivo ou de captura não equivale a autorização ou proibição de contato por inferência; uma política explícita de não contatar, se existente, prevalece e exige comando específico para ser alterada.
2. Reutilizar o envio individual tipado para texto e mídias suportadas. O pedido exato do dono pode autorizar conteúdo e destinatário sem nova confirmação. Ambiguidade de identidade/conteúdo não pode ser resolvida por aproximação silenciosa.
3. Um disparo a várias pessoas congela destinatários, conteúdo final por destinatário, hashes de mídia/citações, vínculo da conexão, autorização, modo e validade. Uma mudança posterior na busca, agenda ou grupo não aumenta o conjunto autorizado. Deduplicar por identidade/endereço comprovado, nunca apenas por nome. Resolver toda a lista antes da autorização; excesso ou incompletude não pode virar truncamento silencioso. Usar `operationId` por intenção/lote e unicidade por item/ocorrência: uma tentativa por ação isolada não impede duplicata se repetir o preparo criar outra ação.
4. Lote tem limite explícito, progresso consultável, ritmo limitado e pausa/cancelamento recuperáveis. Cada destinatário tem sua ação, tentativa e resultado. Reinício, concorrência ou repetição da chamada não reenviam itens aceitos ou incertos. Após awaits de aparelho/mídia, o claim transacional final confere lote em execução, versão, item pendente, autorização vigente, vínculo, destinatário/envelope e limites imediatamente antes do transporte. Cancelar impede novas tentativas; não promete recolher uma mensagem já aceita nem cancelar uma chamada em andamento. Itens em tentativa ou incertos continuam consumidos e reconciliáveis.
5. Separar proposto, autorizado, em tentativa, aceito pelo provedor, enviado, entregue, lido, falhou, cancelado e incerto. O resultado agregado não promete entrega/leitura de todos. Timeout após tentativa exige conciliação da mesma ação, sem reenvio automático ou chave nova.
6. A assistente pode preparar contato proativo a partir de missão/FUP mesmo sem mensagem recebida. Um mandato autenticado delimita destinatários, inclusive autorização para novos destinatários quando aplicável, finalidade, conteúdo/template e renderização permitidos, janela, frequência/máximo de ocorrências, validade e parada. Os mandatos atuais de acesso/avaliação e a intenção `future_contact` não são grants de envio. Mensagens recebidas, anexos, `confirmed:true` vindo de modelo e saídas do modelo são dados, não autorização. Mudança/revogação deve impedir a tentativa externa ainda não reivindicada, mesmo que o job já tenha começado; não reabre autorização consumida. Tentativa incerta conta no limite.
7. MCP e assistente usam os mesmos contratos de alvo, envelope, idempotência e resultado. No piloto sombra, a jornada produz proposta e recibo simulado, com modo explícito e `externalAttempted:false`, sem IDs ou estados de aceitação fictícios e sem alimentar o ledger de envios reais. Um futuro executor real fica fora do Worker sombra e exige ativação explícita e provas próprias, preservando a operação manual existente. A ativação não drena propostas antigas: modo/revisão de configuração integram o vínculo e um envio real exige autorização própria válida.

## Entregas e aceite

O roadmap deste requisito terá três fatias: destinatário sem conversa prévia no MCP, lote recuperável e contato proativo pela assistente. Cada fatia exige testes significativos, revisão adversarial, CI, versão/changelog/tag consistentes e release minor antes de fechar sua issue. Documentação ou ferramentas listadas não bastam para marcar a capacidade como homologada.

- [#126 — Destinatário sem histórico ou fora da agenda no MCP](https://github.com/orobsonn/whatsapp-mcp/issues/126).
- [#127 — Lote durável e resultados individuais no MCP](https://github.com/orobsonn/whatsapp-mcp/issues/127), depende de #126.
- [#128 — Contato proativo por comando/missão/FUP na assistente](https://github.com/orobsonn/whatsapp-mcp/issues/128), depende de #126 e #127.

São três issues adicionais ao plano original de 41 issues do piloto sombra. Sua inclusão no roadmap não significa que envio real foi habilitado, nem altera silenciosamente os critérios de fechamento de #46–57.

Os testes mínimos incluem contato sem histórico, telefone novo, alvo ambíguo/inválido/retirado, mudança de aparelho ou geração durante resolução, repetição/concorrência, lote com duplicatas e resultados mistos, timeout sem reenvio, pausa/cancelamento/reinício, mandato revogado e tentativa de instrução por mensagem recebida. As provas em sombra devem demonstrar ausência de tráfego ao provedor. Ensaios reais ficam identificados separadamente, com destinatários e conteúdo concretos autorizados pelo dono.

Revisão adversarial independente em 26/10: confirmou o caminho de agenda sem mensagens, a ausência de resolução pública de telefone novo e a inadequação de expor diretamente o endereço permissivo do transporte. A distinção entre exclusão de captura e proibição de contato foi incorporada. A revisão é de desenho e código existente; não constitui implementação ou homologação das três entregas.
