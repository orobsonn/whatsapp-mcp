# Usar a gestão de grupos pelo MCP

Software preparado para 35 operações documentadas da Z-API. A conta precisa ter a permissão correspondente no WhatsApp. A instância própria e o ensaio real ainda estão pendentes; exemplos e testes são sintéticos.

## Encontrar e consultar

- `sincronizar_diretorio` com `kind: group` importa uma página de grupos sem liberar captura nem importar histórico.
- `buscar_conversas` encontra os IDs internos. Grupos com o mesmo nome mantêm IDs diferentes.
- `consultar_grupo` retorna metadados leves ou completos e participantes paginados. Cada participante recebe uma referência `id`, usada no campo `memberIds` e restrita àquele grupo. Para adicionar alguém ou aprovar/rejeitar entrada, use o ID individual do diretório, obtido por sincronização de contatos.
- `consultar_grupo_por_convite` lê informações de um convite; não entra no grupo.
- `obter_convite_grupo` abre a página autenticada do dono, onde o convite pode ser visto. O segredo do convite não retorna ao MCP.
- `listar_chats_grupo` e `consultar_chat_grupo` mostram organização/leitura do chat. Uma página filtrada vazia ainda pode ter continuação.
- `listar_comunidades` e `consultar_comunidade` retornam referências próprias de comunidades e grupos associados.
- `capacidades_grupos` informa cobertura e limites. Não comprova conexão nem permissão atual.

## Alterar com confirmação

Use `preparar_acao_grupo` com o campo `acao`. Abra `confirmationUrl`, confira os alvos e conteúdo, confirme com o login do dono e volte ao chat para `executar_acao_grupo` com o ID da proposta. `consultar_acao_grupo` recupera o resultado; `cancelar_acao_grupo` cancela antes da tentativa. O MCP não tem ferramenta de aprovação.

| Família | Valor de `operation` | Dados principais |
| --- | --- | --- |
| Criar | `create` | `name`, `contactIds`, `autoInvite` explícito |
| Nome, foto, descrição | `name`, `photo`, `description` | `chatId` + nome/descrição ou `mediaId`/`mediaHash` do upload privado |
| Adicionar | `add_participants` | `chatId`, `contactIds`, `autoInvite` |
| Remover, promover, rebaixar | `remove_participants`, `promote_admins`, `demote_admins` | `chatId`, `memberIds` |
| Aprovar/rejeitar entrada | `approve_participants`, `reject_participants` | `chatId`, `contactIds` conhecidos |
| Permissões | `settings` | `chatId` e os quatro booleanos abaixo |
| Convites | `reset_invite`, `accept_invite` | `chatId` ou `inviteURL` WhatsApp exata |
| Menções | `mention_members`, `mention_groups`, `mention_all` | `chatId`, `text`, referências de membros/grupos quando aplicável |
| Leitura, arquivo, fixação, silêncio | `chat_read`, `chat_archive`, `chat_pin`, `chat_mute` | `chatId`, `enabled` true/false |
| Limpar/excluir chat, sair | `chat_clear`, `chat_delete`, `leave` | `chatId` |
| Mensagens temporárias | `chat_expiration` | `chatId`, `chatExpiration`: `24_HOURS`, `7_DAYS`, `90_DAYS` ou `OFF` |
| Associação a comunidade | `link_groups`, `unlink_groups` | `communityId`, `chatIds` |

Os quatro campos de `settings` são obrigatórios: `adminOnlyMessage`, `adminOnlySettings`, `requireAdminApproval` e `adminOnlyAddMember`. A operação substitui essas opções; confira todas.

Exemplo de nome:

```json
{"acao":{"operation":"name","chatId":"ID_INTERNO_DO_GRUPO","name":"Equipe de produto"}}
```

`autoInvite: true` pode enviar convites privados aos contatos que não forem adicionados diretamente. Menção a todos usa `@all` no texto e alcança os membros presentes no momento da execução, inclusive quem entrar depois da aprovação. Menções a grupos exigem a mesma comunidade. Para mencionar um membro ou grupo, use no texto `@{ID_INTERNO}` e inclua esse ID em `memberIds` ou `groupIds`; o backend resolve o endereço exigido pela Z-API. O texto aprovado mantém o marcador e o nome do alvo. Não existe combinação documentada de menções com mídia/resposta neste módulo.

## Resultados e limites

`accepted` significa confirmação do provedor, não prova de propagação, entrega ou leitura. Criação pode retornar participantes não adicionados; o resultado mostra quantidade e possibilidade de parcialidade. Alguns endpoints só retornam um booleano e não comprovam sucesso de cada item. `rejected` é rejeição conhecida. `uncertain` indica que houve tentativa e o resultado não ficou conhecido: consultar a mesma referência não repete a chamada. Verifique no WhatsApp antes de preparar uma nova tentativa.

Criar/entrar mantém captura desabilitada para novos grupos. Limpar/excluir chat no WhatsApp não apaga o arquivo local. A exclusão local é uma proposta separada e invalida ações ainda não tentadas que referenciem aquele chat/contato.

Não há endpoint documentado para listar a fila de pedidos de entrada; o módulo não inventa essa lista. Endereços LID não viram telefones. Fotos usam arquivos privados até 2 MiB; páginas têm até 50 itens/32 KiB. Metadados grandes demais para o limite remoto falham explicitamente, sem alegar lista completa. A aplicação de mensagens temporárias a grupos e o comportamento de cada operação dependem de homologação com a instância real.
