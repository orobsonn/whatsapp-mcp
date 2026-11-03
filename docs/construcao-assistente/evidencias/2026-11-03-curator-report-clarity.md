# Relatório de curadoria e eventos sem projeção

O formato aprovado anteriormente não tinha sido implementado: v0.52.6 corrigiu download e áudio enviado, sem alterar apresentação. A revisão diária referente a 02/11 continuou usando o renderer antigo.

Consulta somente leitura de produção em 03/11 encontrou os mesmos 209 eventos pendentes no recibo consultado. São eventos, não arquivos ou mensagens únicas: 141 eventos de mensagem apontam para 137 mensagens distintas, todas atualmente sem corpo e com unsupported_or_missing_content; 61 eventos de mídia apontam para 33 mídias distintas, 28 com falha de download e cinco já prontas; sete eventos de conversa apontam para cinco conversas. Eventos de mensagem/mídia/conversa são unidades diferentes. Isto é uma fotografia atual, não reconstrução exata do momento do envio.

As falhas dos 28 downloads são 22 unsupported_media, cinco body_too_large e um media_mime_mismatch. As mídias prontas são quatro imagens e um áudio. A falha genérica do leitor não identifica sozinha a causa do arquivo. Não há promessa de recuperar conteúdo antigo, de formato novo suportado ou de transcrição ausente em todos esses registros. Nenhum corpo original, identificador ou credencial foi versionado.

A revisão também tinha 197 fontes ainda não avaliadas. A submissão nativa encerrou como completed, sem erro SDK, após duas leituras de página e duas confirmações. O relatório precisa dizer revisão parcial; submissão concluída não prova cobertura concluída. Nenhum reprocessamento semântico ou reenvio de Telegram foi efetuado para transformar esse estado em conclusão.

Correção limitada: contexto opcional no JSON de decisão e contrato Flue, agrupamento de gravações confirmadas pelo host, descarte separado de falta de confirmação, emojis, orientação por assunto e diagnóstico agregado por motivo com vínculo completo de instalação/gerações. Sem migração. Quantidades de eventos e referências distintas por grupo são explícitas; só resultado blocked com next_retry_at preenchido sustenta previsão de nova tentativa. Exclusões/retiradas continuam filtradas antes da agregação. Detalhes técnicos e códigos internos saem do corpo principal. Exemplos e tamanho Telegram permanecem limitados.

Revisão adversarial: não promover categoria learn a gravação pronta, não confundir evento com conteúdo, não inferir contexto por nomes, não prometer recuperação nem retry sem recibo, não confundir a consulta atual com o envio anterior.
