# Z-API: capacidade documentada e o que falta comprovar

Consulta documental: **18/10/2026**, apenas fontes públicas oficiais. Não usamos a instância, credenciais ou conversas do Elo nesta pesquisa. Z-API é referência conhecida; o transporte final do novo MCP ainda está aberto. URLs/formatos precisam ser relidos na implementação.

## Matriz de partida

| Capacidade | Contrato consultado | Estado para o projeto novo |
|---|---|---|
| Buscar grupos | `GET /groups`, paginação `page/pageSize`. [Grupos](https://developer.z-api.io/group/get-groups) | Documentado; ainda não testado aqui. Nome não é identidade e ausência em uma página não comprova inexistência. |
| Dados de grupo/participantes | Metadata do grupo. [Metadata](https://developer.z-api.io/group/metadata-group) | Documentado; minimizar projeção de participantes para a IA, validar papéis/permissões reais. |
| Listar chats | `GET /chats`, paginado. [Chats](https://developer.z-api.io/chats/get-chats) | Lista de chats não comprova acesso a todo o conteúdo anterior de cada conversa. |
| Agenda sem conversa | `GET /contacts?page=...&pageSize=...`. [Contatos](https://developer.z-api.io/contacts/get-contacts) | Comprovado no Elo, não nesta instalação: dez páginas/935 contatos. Revalidar escopo/formato ao construir. |
| Texto individual/grupo | `POST /send-text`. [Texto](https://developer.z-api.io/message/send-text) | Individual foi comprovado no Elo. Envio em grupo é só documentado nesta pesquisa. |
| Imagem com legenda | `POST /send-image`. [Imagem](https://developer.z-api.io/message/send-message-image) | Documentado para contato/grupo; validar bytes, tipo real, opções e origem do arquivo no ensaio. |
| PDF/documento | `POST /send-document/{extension}`. [Documento](https://developer.z-api.io/message/send-message-document) | Documentado para contato/grupo; não é ferramenta já existente no Elo. |
| Enviar áudio | `POST /send-audio`, exemplos com link/Base64. [Áudio](https://developer.z-api.io/message/send-message-audio) | Enviar mídia não é transcrever nem entender voz. Validar formatos e experiência de nota de voz. |
| Receber texto/grupo/mídia | Callback de recebimento e exemplos com campos de grupo, participantes e objetos de mídia. [Configuração](https://developer.z-api.io/webhooks/on-message-received), [exemplos](https://developer.z-api.io/webhooks/on-message-received-examples) | Identificar conversa/autor/arquivo e os formatos observados. Um schema de exemplo não é prova de captura real nem garantia de permanência do arquivo. |
| Mensagens próprias | Opção `notifySentByMe`. [Configuração](https://developer.z-api.io/webhooks/update-notify-sent-by-me) | Verificar cada origem: aparelho, Web e API. Não presumir que habilitar a opção comprova todas. |
| Marcar como lida | `POST /read-message`. [Ler mensagens](https://developer.z-api.io/message/read-message) | É alteração do estado de leitura, não busca do texto/histórico. Não chamar como efeito oculto de uma consulta. |
| Estado de entrega | Retorno de envio entra em fila; callbacks posteriores mudam estado. [Fluxo](https://developer.z-api.io/), [status](https://developer.z-api.io/webhooks/on-whatsapp-message-status-changes) | Separar aceito, enviado, entregue e lido; provar semântica por grupo/participante, não só individual. |

Os endpoints são descritos sem prefixo/credencial de instância. A IA não deve montar a URL da API nem receber o token para usá-los.

## Pontos que mudam o desenho

### Precisamos do nosso arquivo

A introdução informa que mensagens da fila não ficam armazenadas após o envio. Isso não equivale a um arquivo histórico recuperável para o MCP. A [página de expiração de arquivos](https://developer.z-api.io/tips/file-expiration) informa retenção de mídia de 30 dias e recomenda armazenamento próprio para conservar arquivos. Esse prazo do fornecedor não é a política de retenção do projeto, nem garantia de sucesso de qualquer download durante todo o período. Não guardar só uma URL temporária se o objetivo for arquivo durável.

### Não confundir recebido, enviado e status

Há configuração de webhook geral e uma específica para mensagens próprias. O levantamento anterior do Elo registrou precedência de URL; a [página específica](https://developer.z-api.io/webhooks/on-message-received-and-delivery) e a de [filtros](https://developer.z-api.io/webhooks/update-filters) precisam ser revalidadas. A ferramenta de leitura de documentação não recuperou essas duas páginas nesta rodada; não tratamos esse erro de acesso como ausência da função. Não modificar callback/filtro da demonstração para fazer esse ensaio.

### História anterior e replay são perguntas abertas

Não foi comprovado, nesta leitura, um contrato suficiente para importar todo o passado, recuperar todos os eventos perdidos ou usar um cursor de replay durável. O índice consultado inclui operações de chat e mensagens, mas isso não prova histórico consultável. Afirmar falta de comprovação é diferente de afirmar que a API nunca terá a função. Verificar na conta/plano/versão escolhidos antes de decidir transporte; pode ser requisito relevante para Robson.

### Receber mídia não fornece transcrição pronta

Os exemplos expõem referências/formatos de áudio e documento e campos de participantes. Não demonstram um transcritor contratado, conteúdo OCR, download seguro ou indexação pronta. Isso é trabalho adicional do MCP/backend e de um processador escolhido. Não inferir nome real do autor pelo nome do chat; não transformar participante de grupo em dono da instalação.

### O MCP nativo não cobre automaticamente tudo

A [página atual do MCP Z-API](https://developer.z-api.io/mcp/introduction) lista nove ferramentas: três de envio (texto/imagem/vídeo) e seis de grupo. Isso é catálogo documentado naquela data, não a totalidade da API REST nem prova de histórico/transcrição/PDF no MCP nativo. Um MCP próprio pode oferecer persistência, controle de dados e ferramentas diferentes sem implementar o protocolo WhatsApp do zero.

### Segurança e semântica a revalidar

`Client-Token` e credenciais de instância protegem requisições à API; não são prova de assinatura do webhook recebido. No Elo foi usada uma URL secreta mais validação de instância. Confirmar contrato técnico atual para autenticidade/retry; não inventar assinatura, ordem, entrega única ou replay. IDs `messageId` e `zaapId` não devem ser equiparados sem contrato. As mensagens recebidas não concedem autorização de envio.

## Fontes

Índice primário: [llms.txt](https://developer.z-api.io/llms.txt) e [índice de API](https://developer.z-api.io/_llms/pt-br/api-reference.txt). O segundo foi recuperado por HTTPS com validação normal após falha de acesso pela ferramenta de leitura; nenhum conteúdo de conta foi necessário. O material acima é síntese própria, sem copiar exemplos completos ou a documentação inteira.

Na próxima implementação, registrar formato efetivo de request/response, tamanho/latência, papel do grupo e origem de mensagem com fixture sintética + ensaio real autorizado. Não usar números da página comercial como garantia de throughput operacional.
