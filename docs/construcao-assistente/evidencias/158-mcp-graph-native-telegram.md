# Grafo compartilhado: MCP existente → agente Telegram

Data: 29/10/2026. Ensaio em infraestrutura real, com informações inteiramente fictícias. Não comprova a homologação integral do WhatsApp nem da curadoria diária.

## Fronteiras verificadas

- O endpoint existente `https://whatsapp.robsonlins.com/mcp` anunciou 40 ferramentas, incluindo `assistente_memoria`. Um cliente do SDK MCP fez discovery e chamadas por Streamable HTTP com OAuth real do dono. Depois da atualização do catálogo, a ferramenta também respondeu nesta conversa; nenhuma conexão MCP adicional do Cognee foi instalada.
- `context.report` registrou o contexto como `owner_report`. `remember` criou pessoas, projeto e grupo com referências canônicas, citações do original e classificação `reported`. O recibo ficou `ready` no Cognee da instalação.
- A confirmação independente reutilizou as mesmas entidades e acrescentou outro suporte à relação entre grupo e projeto, sem criar um grafo separado por cliente.
- Uma pergunta real foi enviada pelo Chrome autenticado ao bot Telegram. O texto citava apenas o projeto; não fornecia os nomes esperados na resposta. O agente nativo usou as fontes registradas pelo MCP e entregou a resposta no Telegram. As exposições do contexto foram observadas no D1 próprio.

## Resultados observados

| Etapa | Resultado no grafo/MCP | Resposta observada no Telegram |
| --- | --- | --- |
| Criação | Iara Neblina coordena o Projeto Farol 29X; Sala Âmbar acompanha o projeto | Identificou Iara Neblina e Sala Âmbar |
| Correção da fonte principal, revisão 1 → 2 | Suporte antigo retirado; nova relação com Lia Horizonte; grupo mantém suporte independente | Identificou Lia Horizonte e Sala Âmbar |
| Retirada da fonte principal | Relação de coordenação indisponível; relação do grupo permanece com um suporte válido | Informou que não sabia quem coordenava e manteve Sala Âmbar |
| Limpeza da fonte independente | Último suporte de teste retirado com recibo `ready` | Nenhuma nova inferência solicitada para a limpeza |

A correção/retirada invalidou o contexto nativo que havia consumido a fonte anterior. O registro de purga observou a remoção física pelo SDK Flue e a conferência de ausência da instância; não foi apenas uma instrução para o modelo ignorar o histórico. Recibos financeiros foram preservados.

## Autenticação e evidência

O cliente de ensaio usou PKCE e callback HTTPS no domínio próprio, sem modificar a política de OAuth de produção. O servidor recusou corretamente o callback HTTP de loopback. Ao terminar o teste de protocolo, os tokens desse cliente temporário foram revogados pela interface RFC 7009, com respostas HTTP 200. A conexão principal do Zap foi preservada.

Os recibos completos, identificadores das fontes, saídas do cliente MCP, resumo de aceitação e observações dos efeitos ficaram no diretório privado do operador. Nenhuma chave, token OAuth, conteúdo real de terceiros ou histórico pessoal foi incluído nesta evidência pública.

O ensaio teve inferência real paga e entrega real ao dono no Telegram. A contabilidade global conserva tentativas incertas e o teto histórico de US$10; os valores finais devem ser reconciliados com o censo do marco. Não houve envio de teste ao WhatsApp, alteração de agenda, ativação de respostas autônomas ou ativação da curadoria diária por esta evidência.
