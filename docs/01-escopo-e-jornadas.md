# Escopo desejado e histórias de uso

Este é o destino do produto, não uma lista inteira para implementar no primeiro commit. Nenhuma capacidade abaixo está implementada nesta pasta. “Gerenciar tudo” serve como ambição; a cobertura deve ficar explícita por tipo, origem e operação.

| Jornada | Pedido da pessoa | Resultado observável esperado |
|---|---|---|
| Encontrar alguém | “Manda uma mensagem para fulano.” | Localiza agenda mesmo sem mensagem no arquivo, esclarece homônimos e resolve alvo estável. |
| Encontrar grupo | “Abre o grupo do projeto.” | Busca por nome/alias e distingue grupos homônimos; renomear grupo não troca seu ID. |
| Ler/consultar | “O que falaram ontem naquele grupo?” | Consulta recorte paginado com autoria, horário, respostas e cobertura; não expõe outros grupos. |
| Buscar arquivo | “Qual PDF enviaram sobre isso?” | Encontra mensagem/anexo por conversa, data, nome ou termos disponíveis e oferece o arquivo autorizado. Busca no conteúdo só se extraído/indexado. |
| Entender áudio | “Ouve o áudio que mandaram.” | Seleciona mensagem e processa áudio com idioma/qualidade/limitação claros; distingue original de transcrição. |
| Arquivar | “Quero guardar minhas conversas.” | Guarda as mensagens que efetivamente capturou, recebidas e próprias, com tipo/origem e dedup; relata lacunas e política de retenção. |
| Enviar texto | “Responde isso no grupo certo.” | Resolve destino, texto e citação; aplica política de autorização e consulta o resultado sem retry cego. |
| Enviar imagem/PDF | “Manda este arquivo no grupo.” | Confere destino, conteúdo imutável, nome e legenda; envia o objeto certo e registra mensagem/resultado. |
| Recuperar saída | “O que eu mandei na semana passada?” | Busca mensagens próprias oriundas de telefone, Web e MCP quando essas origens estiverem comprovadamente capturadas. |
| Organizar chats | “Arquiva/muta/fixa essa conversa.” | Efeito explícito no WhatsApp, separado de ler conteúdo no arquivo local. |
| Administrar grupo | “Cria grupo/adiciona pessoa/ajusta descrição.” | Usa permissões reais; esclarece efeitos/participantes; operação específica autorizada. Faz parte do horizonte amplo, prioridade ainda aberta. |
| Corrigir/excluir | “Apaga esta mensagem/este arquivo.” | Distingue apagar no arquivo local, no WhatsApp e derivados; relata alcance real e restrições. |

## Fronteiras importantes

- Consultar conteúdo arquivado não deve marcar mensagens como lidas no WhatsApp por efeito colateral. “Ler” tem os dois sentidos; ferramentas precisam de nomes/descrições inequívocos.
- Salvar futuras mensagens e importar mensagens antigas são capacidades diferentes. Lista de chats não é histórico integral.
- Grupo tem conversa, participantes e autores. Uma pessoa pode aparecer em vários grupos sem misturar os respectivos contextos.
- Áudio recebido, áudio enviado como arquivo, nota de voz, transcrição e síntese de voz não são a mesma função. Leitura/interpretação foi pedida; TTS/voz clonada não foi decidido.
- Imagem/PDF podem ser reenviados sem OCR. Entender/buscar o conteúdo depende de extração e permissões próprias.
- Alterar/administar grupos, apagar mensagens, divulgar links de convite ou mencionar todos não é leitura comum. São ações com efeitos distintos; não incluir num endpoint arbitrário “execute qualquer API”.
- Canais, status, comunidades, ligações, enquetes e mensagens temporárias estão no mapa para descoberta, não automaticamente no primeiro marco. Não usar “tudo” para prometer cada recurso de qualquer versão do WhatsApp.

## Cobertura que deve aparecer no produto

Para uma consulta, informar período solicitado, período disponível, tipos presentes/indisponíveis e paginação restante. Para arquivo/áudio, distinguir não capturado, não baixado, expirado, removido, proibido e falha. Para grupo, não dizer “todo mundo recebeu/leu” a partir de um único estado agregado. Uma lacuna conhecida não impede usar as partes disponíveis.
