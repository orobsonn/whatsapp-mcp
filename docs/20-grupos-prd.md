# Gestão completa de grupos — PRD e plano

Pedido do dono em 19/10/2026: “eu quero gerenciar todas as possibilidades de grupo tbm que a API fornece”. Amplia o horizonte de administração antes excluído na v0.1.0. Não muda a autorização operacional: ainda sem instância real; não tocar no Elo.

## Resultado

Usar o MCP para todas as operações documentadas na categoria Groups da Z-API, além das operações de Chats aplicáveis a grupos. Incluir consulta e associação de grupos a comunidades; administrar a comunidade inteira e os demais produtos/canais não é consequência desse pedido. Inventário fechado por método/path/campos/retorno/fontes atuais, sem inferir endpoint pelo slug.

Escopo encontrado no índice oficial: 22 operações de Groups (listar/criar, nome/foto/descrição, adicionar/remover/aprovar/rejeitar participantes, promover/rebaixar admin, sair, três metadatas, configurações, consultar/redefinir/aceitar convite e três tipos de menção); 9 de Chats aplicáveis; 4 de Communities necessárias para listar/consultar comunidade e vincular/desvincular grupos. A contagem e contratos serão conferidos contra as páginas atuais antes do código.

## Decisões de engenharia revisadas

- Continuar TypeScript/Workers/D1/R2/OAuth existente. Adaptador fixo Z-API, sem ferramenta de endpoint/HTTP/SQL arbitrário. Métodos internos aceitam apenas operações tipadas e schemas fechados; nenhuma URL de download fornecida pelo modelo.
- Leituras: metadados completos/leves, participantes (sem endpoint documentado de fila de pedidos), metadados por convite, link de convite sob pedido explícito, estado do chat, chats de grupo e comunidades/grupos associados. Paginação/projeção limitada, sem payload bruto ou credenciais. Metadados completos não divulgam link de convite por efeito colateral; ferramenta própria abre a página Access do dono, onde o convite validado pode ser visto.
- Efeitos: criar/alterar grupo, participantes/admin, aceitar/redefinir convite, sair, settings, menções (pessoa/grupo/todos), organização/leitura/limpeza/exclusão/temporárias no WhatsApp e associações com comunidade. Todos são propostas congeladas → confirmação Access humana independente → execução por claim D1 único → consulta/cancelamento. Nenhuma operação real nos testes.
- `group_actions` separada das ações de mensagem existentes: permite criar/entrar sem chat previamente conhecido, sem inventar destino sentinela ou generalizar todo o motor. Estado proposed/approved/attempting/accepted/rejected/uncertain/cancelled/expired. Retorno do provedor aceito não vira prova de readback. Resultado sanitizado; timeout depois do claim nunca repete. Resultado conhecido e incerto são recuperáveis pela mesma referência.
- Identidade: grupos existentes usam chatId tipo group; contatos novos usam IDs individuais do diretório; membros atuais usam referências internas vinculadas ao grupo/epoch/geração e endereço exato do fornecedor. Nunca fundir nomes ou converter LID em telefone. Comunidades têm referências próprias, distintas de chats/grupos. Criação/entrada retorna referência interna nova com captura desabilitada.
- Envelope público contém operação, referências/opções exatas, nomes úteis congelados, hash dos bytes e compromisso/hash dos endereços resolvidos. Credenciais e endereços de transporte ficam no backend. Revalidar o compromisso e geração/aparelho antes de claim; alterar destino, participantes, texto/opções/arquivo invalida a aprovação. Foto usa upload privado existente e bytes/hash verificados, sem URL arbitrária.
- Permissões: preflight confere conexão/aparelho; consultar metadata para contexto e papéis quando o contrato permitir. O fornecedor continua autoridade de permissão: não inventar que o dono é admin nem prometer sucesso por mock. A página humana mostra grupo e participantes/operação legíveis, especialmente remoção, rebaixamento, menção a todos, limpar/excluir/sair e temporárias.
- Convites: parsing estrito de `https://chat.whatsapp.com/<codigo>` ou código documentado, sem buscar URL arbitrária. Token/URL não vai a logs ou diagnóstico; o dono pode fornecê-lo para consulta/entrada e solicitar explicitamente o link de um grupo. Nunca conectar comunidade/grupo por semelhança de nome.
- Limites conservadores: páginas de saída até 50 membros/32 KiB; diretório até 100 itens; até 50 referências por proposta, permitindo lotes conscientes em grupos grandes; texto/nome/descrição conforme contrato e teto local; arquivo 2 MiB. Resposta de provedor bounded; grupos grandes/saída truncada sinalizados, nunca lista alegadamente completa após corte.
- Ações administrativas no WhatsApp não apagam implicitamente o arquivo local, e apagar arquivo local não altera WhatsApp. Exclusão local/restore/epoch/geração/manutenção também invalidam ações de grupo ainda não tentadas. Não usar leitura de arquivo como read-chat remoto oculto.
- Evolução aditiva: migration de group_actions, referências de membros/comunidades e extensão do purpose do nonce para `group` via rebuild SQLite seguro. OAuth/grants existentes mantêm fronteiras; não reaproveitar `send` como purpose administrativo.

## Interfaces e entregas coesas

1. Inventário verificável e adaptador HTTP tipado. `src/zapi-groups.ts` + ajuste mínimo transport privado `src/zapi.ts`, testes de método/path/campos/retorno/limites/redirect/timeout. Nenhum endpoint inventado ou fallback arbitrário. Rotear implementação delimitada gpt-6-sol/medium; promover incerteza de contratos.
2. Serviço de grupos/referências/ações persistentes. `src/groups.ts`, schema aditivo e testes Workers/D1/R2: schemas estritos, IDs de tipo errado, envelope/snapshot alterado, confirmação vinculada, concorrência/expiração/cancelamento, timeout/crash e arquivo congelado. Rotear segurança/efeitos gpt-6.1-sol/high.
3. Ferramentas MCP e confirmação. `src/mcp.ts`, `src/index.ts`, `src/auth.ts`, migração purpose; consultas específicas e uma ferramenta de proposta com união fechada de operações, execução/consulta/cancelamento por ID. Ferramenta de capacidades mostra cobertura exata. Jornada SDK real até administração de grupo com rede sintética e login/nonce; manter os 91 testes anteriores.
4. Revisão adversarial forte, correções, suite/check/build/audit, docs/PRD/README, CI no HEAD, merge/issues e release por marco 0.2.0. Ativação real continua pendente de instância própria.

## Aceitação

- Matriz operação oficial → método/path real → schema → ferramenta → teste, cobrindo integralmente o inventário escolhido. Registrar formatos não documentados como limite, não fabricar prova.
- Todos os efeitos precisam de confirmação humana exata; GET, bearer MCP, nonce reutilizado/expirado, estado alterado e epoch antigo não executam.
- Grupo/contato/membro/comunidade são distintos; alteração concorrente dos endereços/arquivo não troca alvo. Criar/sair/entrar e exclusão de chat não ligam captura sem aprovação.
- Uma tentativa externa por ação mesmo com chamadas concorrentes ou resposta perdida. Estado aceito/observado/incerto explícito; nenhuma repetição cega de criar/adicionar/remover/menção.
- Campos desconhecidos/operações inexistentes, payload excessivo, redirect, referência fora do grupo e foto errada recusados. Resultado não retorna tokens/payload bruto nem convite não solicitado.
- Fluxo sintético via cliente SDK, testes relevantes no runtime real local, CI e build; relatório distingue código/contrato de teste real do WhatsApp.

## Registro

- Base `9f1634823970ec5d577255733e3f834f7c867d20`, release 0.1.0, branch `codex/grupos-completos`.
- Índice oficial atual consultado em 19/10/2026: https://developer.z-api.io/_llms/pt-br/api-reference.txt. O web reader falhou nessa URL; curl com TLS normal recuperou. Python local tem CA desatualizada; não foi desabilitada validação TLS.
- Harness remoto continua no commit `7634e3284dbe402f9229b18a13c658ace3afe3fd`. Usar somente lógica, sem instalar.
- [x] Inventário fechado e revisão adversarial do desenho.
- [x] Issues #8–10 e implementação das três áreas.
- [x] Revisão final e verificações locais; evidências em [docs/25-entrega-grupos.md](25-entrega-grupos.md). Integração/CI/release verificáveis nos links GitHub da entrega.

## Revisão adversarial incorporada antes do código

Revisor independente `groups_design_adversary` (gpt-6.1-sol/high), somente leitura, apontou oito lacunas; todas viram contratos de implementação:

1. Claim `approved→attempting` verifica no próprio UPDATE referências imutáveis, epoch/geração, integridade dos snapshots e mídia/hash/versão/tombstone. Pré-check com await não basta. Usar json_each sobre lista limitada para não ultrapassar parâmetros D1, sem SQL escolhido pelo cliente.
2. Separar `private_json` (convite/endereço exato/salt aleatório privado) do envelope público redigido. Compromisso usa HMAC com chave aleatória privada por proposta, não hash simples de telefone. Link solicitado é revelado somente em página Access; MCP recebe URL dessa página. Não registrar segredo em resultado/erro/diagnóstico.
3. Transporte declara `{method, endpoint, body?, effect}` de forma independente: `GET /accept-invite-group` é mutação, jamais leitura/prefetch. Nenhum endpoint/verb é escolhido por argumentos livres do MCP.
4. Resultados `accepted|rejected|uncertain` com `evidence:provider_ack|readback`; resultado parcial ou por item só quando o contrato o permite. Uma confirmação booleana não prova todos adicionados/vinculados. Persistir ack antes de materializar chat; retomar somente gravação local sem repetir criar/entrar.
5. Exatamente uma chamada com efeito por ação; arrays apenas nos endpoints documentados para lote. `autoInvite` é obrigatório e explícito, podendo enviar convites privados. Menção a todos confirma audiência dinâmica, inclusive membros que entrarem até a execução.
6. Exclusão local cancela ações ainda não tentadas que referenciem o chat, inclusive alvo secundário/contato. Retenção/exclusão de mídia bloqueia claims por fence. Cleanup limita e redige snapshots/convites/resultados privados vencidos, preservando estado mínimo recuperável sem reenviar.
7. Cursor de membros/grupos vinculado a epoch/geração, alvo e hash do snapshot. Corpo remoto tem limite independente de saída MCP; overflow retorna limitação explícita. Filtrar chats individuais não encerra uma página bruta ainda cheia. Não remover ausentes após resposta parcial.
8. Hash de envelope aninhado usa `hashEnvelope` recursivo do auth, não `actionDigest` de mensagens. Testar mudança em campo interno e migração do nonce preservando consumed/expiry/índice/checks.

Inventário oficial foi fechado em **35 operações: 22 Groups, 9 Chats, 4 Communities**. O contrato não documenta fila/listagem de pedidos de entrada; aprovar/rejeitar usa contatos conhecidos por referência, sem inventar essa fila. Menções documentadas são texto via send-text; combinação com mídia/resposta não foi comprovada. `send-chat-expiration` documenta o endpoint e enum, mas não prova aplicação em grupos antes de ensaio real. Essas capacidades são implementadas conforme contrato e a cobertura real permanece pendente.
