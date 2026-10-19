# Matriz de cobertura dos grupos

Inventário em 19/10/2026. Cobertura de código e contratos sintéticos; todas as linhas ainda aguardam homologação real na instância própria. `preparar_acao_grupo` recebe a operação indicada, seguida de confirmação Access e `executar_acao_grupo`; consulta/cancelamento compartilham a referência persistente.

| Operação oficial | Contrato | Interface MCP | Teste de contrato |
| --- | --- | --- | --- |
| [Buscar grupos](https://developer.z-api.io/group/get-groups.md) | `GET /groups` | sincronizar_diretorio (kind=group) | `zapi.test.ts` |
| [Criando grupos](https://developer.z-api.io/group/create-group.md) | `POST /create-group` | `preparar_acao_grupo`: `create` | `zapi-groups.test.ts` |
| [Atualizar nome do grupo](https://developer.z-api.io/group/update-group-name.md) | `POST /update-group-name` | `preparar_acao_grupo`: `name` | `zapi-groups.test.ts` |
| [Atualizar imagem do grupo](https://developer.z-api.io/group/update-group-photo.md) | `POST /update-group-photo` | `preparar_acao_grupo`: `photo` | `zapi-groups.test.ts` |
| [Adicionar participantes](https://developer.z-api.io/group/add-participant.md) | `POST /add-participant` | `preparar_acao_grupo`: `add_participants` | `zapi-groups.test.ts` |
| [Remover participantes](https://developer.z-api.io/group/remove-participant.md) | `POST /remove-participant` | `preparar_acao_grupo`: `remove_participants` | `zapi-groups.test.ts` |
| [Aprovar participantes](https://developer.z-api.io/group/approve-participant.md) | `POST /approve-participant` | `preparar_acao_grupo`: `approve_participants` | `zapi-groups.test.ts` |
| [Rejeitar participantes](https://developer.z-api.io/group/reject-participant.md) | `POST /reject-participant` | `preparar_acao_grupo`: `reject_participants` | `zapi-groups.test.ts` |
| [Mencionar membro](https://developer.z-api.io/group/mention-participant.md) | `POST /send-text` | `preparar_acao_grupo`: `mention_members` | `zapi-groups.test.ts` |
| [Mencionar grupo](https://developer.z-api.io/group/mention-group.md) | `POST /send-text` | `preparar_acao_grupo`: `mention_groups` | `zapi-groups.test.ts` |
| [Mencionar todos](https://developer.z-api.io/group/mention-all.md) | `POST /send-text` | `preparar_acao_grupo`: `mention_all` | `zapi-groups.test.ts` |
| [Promover admin do grupo](https://developer.z-api.io/group/add-admin.md) | `POST /add-admin` | `preparar_acao_grupo`: `promote_admins` | `zapi-groups.test.ts` |
| [Remover admin do grupo](https://developer.z-api.io/group/remove-admin.md) | `POST /remove-admin` | `preparar_acao_grupo`: `demote_admins` | `zapi-groups.test.ts` |
| [Sair do grupo](https://developer.z-api.io/group/leave-group.md) | `POST /leave-group` | `preparar_acao_grupo`: `leave` | `zapi-groups.test.ts` |
| [Metadata do grupo](https://developer.z-api.io/group/metadata-group.md) | `GET /group-metadata/{phone}` | consultar_grupo (variant=full) | `zapi-groups.test.ts` |
| [Metadata do grupo (leve)](https://developer.z-api.io/group/light-group-metadata.md) | `GET /light-group-metadata/{phone}` | consultar_grupo (variant=light) | `zapi-groups.test.ts` |
| [Metadata do grupo por convite](https://developer.z-api.io/group/group-invitation-metadata.md) | `GET /group-invitation-metadata` | consultar_grupo_por_convite | `zapi-groups.test.ts` |
| [Configurações do grupo](https://developer.z-api.io/group/update-group-settings.md) | `POST /update-group-settings` | `preparar_acao_grupo`: `settings` | `zapi-groups.test.ts` |
| [Alterar descrição](https://developer.z-api.io/group/update-group-description.md) | `POST /update-group-description` | `preparar_acao_grupo`: `description` | `zapi-groups.test.ts` |
| [Redefinir link de convite](https://developer.z-api.io/group/redefine-invitation-link.md) | `POST /redefine-invitation-link/{groupId}` | `preparar_acao_grupo`: `reset_invite` | `zapi-groups.test.ts` |
| [Obter link de convite](https://developer.z-api.io/group/get-invitation-link.md) | `GET /group-invitation-link/{groupId}` | obter_convite_grupo → página Access | `zapi-groups.test.ts` |
| [Aceitar convite do grupo](https://developer.z-api.io/group/accept-group-invite.md) | `GET /accept-invite-group` | `preparar_acao_grupo`: `accept_invite` | `zapi-groups.test.ts` |
| [Pegar chats](https://developer.z-api.io/chats/get-chats.md) | `GET /chats` | listar_chats_grupo | `zapi-groups.test.ts` |
| [Pegar metadata do chat](https://developer.z-api.io/chats/get-metadata-chat.md) | `GET /chats/{phone}` | consultar_chat_grupo | `zapi-groups.test.ts` |
| [Ler chats](https://developer.z-api.io/chats/read-chat.md) | `POST /modify-chat` | `preparar_acao_grupo`: `chat_read` | `zapi-groups.test.ts` |
| [Arquivar chats](https://developer.z-api.io/chats/archive-chat.md) | `POST /modify-chat` | `preparar_acao_grupo`: `chat_archive` | `zapi-groups.test.ts` |
| [Fixar chats](https://developer.z-api.io/chats/pin-chat.md) | `POST /modify-chat` | `preparar_acao_grupo`: `chat_pin` | `zapi-groups.test.ts` |
| [Mutar chats](https://developer.z-api.io/chats/mute-chat.md) | `POST /modify-chat` | `preparar_acao_grupo`: `chat_mute` | `zapi-groups.test.ts` |
| [Limpar chat](https://developer.z-api.io/chats/clear-chat.md) | `POST /modify-chat` | `preparar_acao_grupo`: `chat_clear` | `zapi-groups.test.ts` |
| [Deletar chats](https://developer.z-api.io/chats/delete-chat.md) | `POST /modify-chat` | `preparar_acao_grupo`: `chat_delete` | `zapi-groups.test.ts` |
| [Expiração do chat](https://developer.z-api.io/chats/send-chat-expiration.md) | `POST /send-chat-expiration` | `preparar_acao_grupo`: `chat_expiration` | `zapi-groups.test.ts` |
| [Listar comunidades](https://developer.z-api.io/communities/list-communities.md) | `GET /communities` | listar_comunidades | `zapi-groups.test.ts` |
| [Vincular grupos](https://developer.z-api.io/communities/link-groups.md) | `POST /communities/link` | `preparar_acao_grupo`: `link_groups` | `zapi-groups.test.ts` |
| [Desvincular grupos](https://developer.z-api.io/communities/unlink-groups.md) | `POST /communities/unlink` | `preparar_acao_grupo`: `unlink_groups` | `zapi-groups.test.ts` |
| [Metadata da comunidade](https://developer.z-api.io/communities/community-metadata.md) | `GET /communities-metadata/{communityId}` | consultar_comunidade | `zapi-groups.test.ts` |

Testes de serviço (`groups.test.ts`) cobrem referências por tipo/grupo, confirmação/hash aninhado, concorrência, timeout, revogação de mídia no claim, resultado parcial, recuperação local sem novo efeito, paginação, exclusão e limpeza de gerações antigas. `groups-migration.test.ts` aplica o SQL entregue sobre nonces legados. `journey.test.ts` usa cliente SDK MCP, OAuth, Access e rede sintética para alteração de nome e entrada por convite. `operations.test.ts` verifica exclusão de contato secundário invalidando criação pendente.

Não há lista documentada de pedidos pendentes, menção combinada com arquivo/resposta, prova de aplicação de temporárias a grupos ou sucesso por item nos endpoints booleanos. Limites e confirmações estão no [manual](23-usar-grupos.md).
