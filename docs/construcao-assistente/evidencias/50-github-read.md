# #50 — consulta GitHub somente leitura

Implementação em worktree própria sobre owner-core preservado, sem substituir as branches de semântica/checkpoint. Esta entrega adiciona consultas `github.list` e `github.read` à família MCP autenticada `assistente_consultar`. O receiver verifica afinidade de instalação/geração antes de ler configuração ou chamar rede.

A configuração do Worker `GITHUB_READ_REPOSITORIES` contém uma lista de `{id, owner, repo, projectId, version, authorization:{sourceId,revision}}`; `GITHUB_READ_TOKEN`, quando necessário, fica em secret do Worker. São recursos próprios; o login GitHub do executor e os conectores desta conversa não são credenciais do produto. Recomenda-se token fine-grained com Contents:read apenas para os repositórios escolhidos. A lista é definida pelo host, nunca pela consulta nem pelo conteúdo externo. A nota canônica de suporte deve ser owner_note, audience owner, na revisão e projeto configurados. SourceAccess valida esse suporte antes da rede e num guard D1 final; retirada/correção/ACL durante a resposta suprime o corpo. Projeto precisa existir no mesmo namespace.

Toda consulta exige SHA completo de commit. O único endpoint de conteúdo é `GET https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={sha}`. Não há método, URL ou domínio fornecidos pelo modelo, download_url/nextLink seguidos, redirect autorizado ou código executado. Headers de credencial e erros upstream não retornam. Corpos JSON são limitados na leitura e no prazo; texto UTF-8 até32768bytes. Resultado traz origem github, projeto, configuração, commit, caminho, blobSHA, SHA256 do texto, audience owner, execution unconfirmed e deployment not_observed. Não se declara que código consultado esteja implantado. Conteúdo segue sendo dado não confiável.

Diretórios são uma listagem bounded da API Contents, sem inventar paginação server-side ou parâmetros page/per_page. O cursor local vincula configuração/permissão/revisão, SHA, caminho e hash exato da listagem. Alterações recusam o cursor. A página final de uma resposta com1000 entradas conserva api_capacity/incomplete, pois esse é o limite documentado do endpoint; subdiretórios não são anunciados percorridos. O escopo de cobertura é directory_only. Credenciais ausentes para recurso privado, arquivo binário/grande, submódulo, erro e redirect produzem indisponibilidade explícita.

Esta fatia retorna consultas autenticadas diretamente ao dono. Não importa corpos externos como owner_note, não os indexa e não concede consulta a interlocutores. Contexto indexado e leitura por mandato precisam de integração própria com origem atual; não se inferem desta entrega.

## Evidências controladas

- RED: removida temporariamente apenas a extensão MCP, o teste de RPC real falhou na rejeição da consulta desconhecida;1 falha,11 pulados. O módulo de produção foi restaurado após a execução, sem alterações em outras branches.
- GREEN:12/12 testes D1/workerd, incluindo endpoint GET/ref, corpo literal/hash, repositório não autorizado, principal extractor, suporte retirado durante rede, campos administrativos injetados, commit móvel, path traversal, cursor/listagem divergentes, cap1000, redirect, tamanho, submódulo, binário, resposta inválida e receiver autenticado real.
- `npm run check`: passou na worktree.
- Nenhuma chamada de modelo, envio WhatsApp, escrita Calendar ou consulta de dados reais. Custo incremental de modelo:US$0. Custos/reservas antigos não alterados.

A revisão adversarial prévia do coordenador aprovou consultas diretas com guard canônico em vez de falsificar importação como nota. Exigiu cursor Contents honesto, projeção privada, configuração/versão/projeto e ausência de inferência de deployment; incorporados. Revisão final independente, integração/CI, release minor e homologação com credencial própria continuam gates; não fechar a issue por este teste local.

## Fontes oficiais consultadas

- GitHub, [Get repository content](https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content): ref aceita commit; limite1000 por diretório; submódulos/links e permissões Contents:read.
