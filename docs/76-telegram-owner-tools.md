# Comandos WhatsApp pelo Telegram

Pedido do dono em 03/11/2026: disponibilizar os doze grupos de capacidades do MCP ao assistente privado, sem habilitar respostas autônomas.

O bot descobre o catálogo atual por `whatsapp_capabilities` e usa `whatsapp_execute` com os argumentos do schema original. Os mesmos handlers do MCP validam formatos, destino, preparo, confirmação e execução. Não existe ferramenta genérica HTTP/SQL.

| Capacidade aprovada | Ferramentas MCP reutilizadas |
| --- | --- |
| Texto, áudio, imagem/PDF | preparar_envio, executar_envio |
| Voz cadastrada | gerar_audio, consultar_audio_gerado |
| Destinatários | buscar_conversas, sincronizar_diretorio, resolver_destinatario |
| Estado e cancelamento | consultar_envio, cancelar_envio |
| Arquivo e mídia | consultar_mensagens, exportar_conversa, consultar_midia, obter_midia, adicionar_arquivo, transcrever_audio |
| Grupos e comunidades | capacidades_grupos, consultas/listagens, preparar_acao_grupo, executar_acao_grupo, consultar_acao_grupo, cancelar_acao_grupo |
| Captura, retenção e exclusão | propor_captura, propor_retencao, aplicar_politica, propor_exclusao |
| Administração privada | assistente_fonte, assistente_memoria, assistente_controlar, assistente_avaliar, assistente_consultar, assistente_telegram, assistente_telegram_revisar |
| Diagnósticos | diagnosticar, diagnosticar_captura |

Somente o último comando real do dono autenticado no Telegram concede acesso. Mensagens WhatsApp, curadoria e despertares de missões/retornos não concedem essa autoridade. A autorização é revalidada pelo serviço de origem, e antes do claim de envio/ação de grupo. As configurações de autonomia permanecem desligadas.

O pedido exato de envio já autoriza o destino/conteúdo solicitados. Ambiguidade exige esclarecimento. Gerar áudio ou redigir rascunho não autoriza enviar. Operações críticas conservam confirmação por página privada. Cadastro de lembrete não concede autorização futura para contatar terceiros.

Recibos por comando, ferramenta e argumentos preservam a mesma preparação e impedem repetição após resultado incerto. Estado aceito não significa entregue ou lido. Os limites e formatos de mídia existentes são preservados; o novo acesso não recupera histórico descartado nem adiciona formatos.

Validação de publicação e prova de envio a terceiros são estados distintos. Não enviar mensagens reais apenas para testar esta liberação.
