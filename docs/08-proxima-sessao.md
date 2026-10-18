# Retomar este projeto

## Pedido pronto para a próxima conversa

> Leia integralmente README.md, BRIEF.md, CONTEXT.md e os documentos de docs/ em /Users/robson/Desktop/dev/whatsapp-mcp. É um MCP pessoal amplo para meu WhatsApp: grupos e individuais, áudio, texto, imagem/PDF e arquivo das mensagens recebidas e enviadas. Privacidade é importante, mas não pode inviabilizar o uso; diferencie dados armazenados de dados enviados ao modelo e mantenha credenciais protegidas. O Elo fica separado para demonstração. Use o mapa do Elo para reutilizar os aprendizados e verificar código/testes/contratos antes de copiar implementação. Primeiro feche só as decisões necessárias à primeira fatia e apresente o caminho mínimo de ponta a ponta com revisão crítica. Não assuma que instância, credenciais, webhook ou autorizações do Elo podem ser reutilizados. Este texto de retomada não autoriza por si só compras, pareamento, migração, envio ou implementação: eu definirei a ação da nova sessão.

O prompt é contexto para planejamento. Quando Robson pedir implementação, essa nova instrução define a autorização; não transformar esta nota em bloqueio permanente a pedidos futuros.

## Perguntas realmente abertas

- Vamos usar Z-API também neste MCP ou queremos comparar/substituir o transporte? “Próprio” já define o MCP, não respondeu quem conecta ao WhatsApp.
- Qual número/instância e grupo de teste estão autorizados? Não comprar nem mudar a demonstração para descobrir.
- Captura geral ou por conversas? Quanto tempo guardar texto e mídia? Existe necessidade concreta de passado anterior à ativação?
- Para áudio e conteúdo relevante, podemos usar o modelo atual do chat ou um transcritor escolhido, ou deve haver caminho local? Escolher com custo e experiência real, sem prometer zero exposição.
- Regras para envios e outras alterações: manter revisão por ação nos ensaios ou desenhar outra política explícita? Não presumir que desejar enviar em grupo libera qualquer disparo.

O agente deve resolver decisões de baixo nível sozinho, pesquisar contratos ainda incertos e perguntar ao dono só o que exige preferência ou autorização real. Nenhum teste real novo foi feito durante a preparação desta pasta.

## Atenção à documentação histórica

O Elo evoluiu durante 17–18/10. Arquivos antigos mencionam 50 chamadas/dia, ausência de agenda, issues abertas e limitações já corrigidas. A fotografia de referência é o commit fixado em `referencias/elo-snapshot.json`; ler código/evidência mais recente em caso de conflito. As funcionalidades de grupo/mídia não foram implementadas pelo fato de o fornecedor documentá-las.
