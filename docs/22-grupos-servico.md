# Serviço de gestão de grupos

Implementado em 19/10/2026, com dados sintéticos em Workers/D1/R2. Nenhuma instância real, segredo, conexão do Elo ou deploy foi usado. O inventário/contrato oficial permanece em [21](21-grupos-contratos.md); comportamento efetivo no WhatsApp continua pendente.

## Contratos públicos

`groupActionSchema` é união discriminada por `operation`, estrita em todos os objetos. Admite as 26 operações com efeito do inventário: criação; nome/foto/descrição/settings; adição/remoção/aprovação/rejeição/promoção/rebaixamento; saída; redefinição/aceite de convite; três menções; read/archive/pin/mute/clear/delete/expiration do chat; associação/desassociação de grupos e comunidade.

As referências são tipadas por domínio: `chatId`/`groupIds`/`chatIds` precisam ser chats de grupo; `contactIds` são chats individuais do diretório; `memberIds` vêm dos metadados e estão vinculados ao grupo; `communityId` vem das consultas de comunidades. Até 50 referências totais por proposta. LID permanece armazenável/consultável, mas operações documentadas com telefones o recusam; não há conversão numérica. Endereços de grupo `@g.us` e `-group` são preservados exatamente.

- `prepareGroupAction(env,input,provider?)`, `getGroupAction(env,id)`, `approveGroupAction(env,id,proof)`, `executeGroupAction(env,id,provider?)`, `cancelGroupAction(env,id)`.
- `readGroup(env,{chatId,variant?,limit?,cursor?},provider?)`, `readGroupInviteMetadata(env,{invite,limit?,cursor?},provider?)`.
- `listGroupChats(env,{page?,pageSize?},provider?)`, `readGroupChat(env,chatId,provider?)`.
- `listCommunities(env,{page?,pageSize?},provider?)`, `readCommunity(env,{communityId,limit?,cursor?},provider?)`.
- `getGroupCapabilities(env?)` descreve cobertura, limites e pendências reais.
- `getGroupInvite(env,chatId,provider?)` retorna a string de convite somente ao backend da página Access. Não é resultado MCP.

Menções a membros/grupos usam `@{ID_INTERNO}` no texto para cada referência escolhida. A proposta exibe esse texto e os nomes exatos dos alvos. Somente o backend substitui os marcadores por `@<endereço exato>` no DTO tipado do fornecedor. Marcadores desconhecidos ou ausentes são recusados. `mention_all` exige `@all` e avisa sobre audiência dinâmica; `delayMessage` vai de 1 a 15 segundos. `autoInvite` é sempre booleano explícito em criação/adição, com aviso sobre convites privados.

## Aprovação e tentativa única

O envelope público contém operação/opções exatas, nomes e IDs dos alvos, avisos e compromisso dos vínculos privados. `private_json` contém os endereços resolvidos, convite de entrada, detalhes da mídia e uma chave aleatória de 32 bytes por proposta. O compromisso é HMAC, evitando hash enumerável de telefone. `hashEnvelope` canônico recursivo cobre também campos aninhados e o compromisso.

Aceitar convite congela no envelope público o nome e a contagem de participantes observada, sem URL/token. O endereço exato fica no compromisso privado. Preflight reconsulta metadados e recusa mudança de endereço/nome; essa leitura nunca chama o endpoint GET com efeito de aceitar.

A aprovação só aceita dono/epoch/purpose `group`/ID/hash exatos. A execução confere aparelho conectado, referências atuais, membros presentes e comunidade comum nas menções de grupo. Papéis ausentes permanecem `null`; o serviço não declara privilégio administrativo inventado. O fornecedor continua autoridade para permissões e efeito final.

O único claim `approved → attempting` é um UPDATE D1 condicional: versão/estado/validade/epoch/geração, strings dos snapshots verificadas, referências/nomes/endereços atuais e mídia/hash/versão/chave/tombstone/contexto da mensagem. `json_each` limita o número de binds mesmo em lote. O DTO passa pela validação pura do transporte antes do claim. Foto usa bytes privados conferidos por hash, sem URL escolhida pelo modelo.

Uma ação chama `provider.mutate` no máximo uma vez. Timeout/erro após claim vira `uncertain`, inclusive consultas de um claim interrompido. Reexecução não repete o fornecedor. Ack booleano é `accepted`/`rejected`, com `evidence:provider_ack`; não prova propagação, leitura de todos ou inclusão de cada pessoa. Na criação, `notAdded` é mapeado para referências/nomes dos contatos aprovados; respostas com endereços desconhecidos aparecem apenas como contagem não mapeada. Links retornados por criação/redefinição são descartados; para revelar convite é necessária a consulta explícita pela página Access.

Ack conhecido é persistido antes da referência local. Criar/entrar materializa chat com captura desabilitada; esse INSERT, o vínculo em `group_action_targets` e o resultado público compartilham um batch guardado. Falha local mantém ack mínimo recuperável; nova execução só materializa localmente. Recuperação exige o epoch/geração da ação atual: cleanup de instalação antiga apenas redige.

## Paginação e privacidade

Saídas têm até 50 itens e 32 KiB. O transporte limita corpo remoto independentemente; overflow é erro explícito. Cursores amarram epoch, geração, escopo e snapshot; mudança de membros invalida continuidade. Chaves privadas aleatórias por escopo tornam IDs estáveis de membros e compromissos de snapshot não enumeráveis. Apenas a página de membros e os autores úteis de metadados são materializados; comunidades também paginam antes de gravar os grupos. A página bruta de `/chats` determina continuidade antes do filtro: zero grupos em página cheia não significa fim. Ausência em resposta parcial não apaga referências.

`invalidateGroupActionsStatements(env,chatId,guard?)` retorna statements para o mesmo batch da política de exclusão local. O guard SQL/binds é interno do serviço de políticas. Redige snapshots/resultados/ack de toda ação vinculada, cancela apenas ações ainda não tentadas e mantém estado mínimo de ações tentadas. Remove referências de membros e a chave privada do escopo do grupo. O vínculo inclui alvo primário, grupos secundários, contatos e o chat resultante de criação/entrada.

`cleanupGroupActions(env,limit=50)` processa lote limitado, retorna a quantidade de payloads alterados para o orçamento da manutenção e redige propostas vencidas/canceladas e payloads de ações finais vencidas. Ação tentando vira incerta. Mesmo com falha de materialização, convite/contatos/bytes/chave da proposta são apagados; só o ack mínimo necessário à gravação local permanece. O scheduler pode tentar essa gravação local novamente, sem repetir a mutação externa.

## Validação controlada

`tests/groups.test.ts` cobre schemas fechados, domínio incorreto, propósito humano, concorrência/timeout, membro fora de grupo, LID, alterações aninhadas públicas/privadas, troca de alvo durante preflight, revogação de foto antes do claim, convite sem vazamento, criação parcial, cursores/filtragem de chats, exclusão secundária e do grupo resultante, guard de política, aging, grupo grande, recuperação local, endereço oficial `-group`, marcadores internos, papéis desconhecidos, rename e recuperação de geração antiga.

A migração `0006_group_management.sql` reconstrói o CHECK de `auth_nonces` preservando linhas/consumo/expiração/índice e inclui `group`. Acrescenta ações, vínculos de alvos, membros/comunidades e chaves privadas de escopo. O teste específico de migração e a jornada MCP/Access estão na integração do projeto.
