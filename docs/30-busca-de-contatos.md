# Busca assistida de contatos — 19/10/2026

Pedido: localizar pessoas por linguagem natural, nome e final de telefone sem exigir cadastro manual do dono.

## Comportamento

`buscar_conversas` aceita `term`, `phoneSuffix` (4–15 dígitos), `kind`, `limit` e `cursor`. Nome + final são filtros combinados. Padrão: individuais. Grupo precisa de `kind=group`. Só endereços estritamente numéricos de individuais participam do filtro telefônico; LID não é convertido.

A primeira busca sincroniza páginas de agenda automaticamente, com no máximo três páginas por lote. Estado é separado por tipo/epoch/generation; cache de 15 minutos. Diretório parcial retorna `directory.complete=false` e instrução de continuar a mesma busca. Busca vazia após agenda completa consulta metadados de conversas para pessoas não salvas, em lotes de três páginas brutas de 50; estado separado por fonte, sem ler mensagens. Fallback iniciado continua até completar, mesmo se encontrar candidato intermediário. Grupos/LID não entram como pessoas. Nomes de agenda prevalecem sobre apelidos/ausência de nome nos chats.

Erro de provedor não vira busca vazia. Aparelho é conferido antes/depois do lote e antes da persistência. Sincronização manual usa estado separado para não invalidar cobertura automática. Nenhuma sincronização libera captura, importa histórico ou envia mensagens. Registros antigos não são removidos automaticamente: cache não é espelho instantâneo de exclusões do WhatsApp.

## Verificação

TDD reproduziu ausência do filtro, falta de sincronização e contaminação por página manual. Suíte completa: 172 testes passaram, incluindo paginação bruta só com grupos, homônimos, nome+final, LID, cursor vinculado ao filtro, cache separado, aparelho alterado e falha intermediária sem persistir lote. TypeScript e dry-run passaram.

Revisão adversarial independente identificou e corrigiu estado manual misturado e cobertura sem kind. Validar efeitos no WhatsApp exige outra jornada com alvos aprovados; este teste não cria grupo nem envia mensagens.

## Prova real final

Zap executou a busca por nome e final no GPT, após carregar a agenda e os metadados de conversas. Encontrou o contato-alvo pela combinação solicitada; homônimos do outro participante foram mantidos separados. Não publicar nomes, números ou capturas de dados reais no repositório. Nenhuma ação foi preparada/criada/enviada e nenhum chat teve captura habilitada.

Uma entrada real sem endereço utilizável bloqueava a página; projeção de diretório agora preserva a contagem bruta e marca entradas sem identidade como indisponíveis. `coverage=available_identifiers_only` permanece inclusive no cache, e `complete` significa término das páginas disponíveis. `unsupportedEntriesInBatch` conta somente o lote atual, sem alegar total acumulado.

Limite do cliente observado: a resposta correta ficou registrada na conversa do GPT, mas a interface web mostrou “This response couldn’t load”, inclusive ao resumir sem ferramenta e com outra opção de modelo. A execução autenticada e o resultado foram confirmados separadamente; a apresentação visual do ChatGPT permanece sem validação. Não declarar experiência visual integral concluída.
