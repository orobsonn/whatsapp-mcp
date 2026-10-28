# GitHub no diálogo Telegram — 28/10/2026

A leitura de um arquivo existente de repositório privado próprio passou no bot real: mensagem no Telegram autenticado → Flue nativo → GitHub → resposta no tópico original. O dono pediu explicitamente todos os repositórios da sua conta, públicos/privados e sem expiração configurada. Contents/Metadata permanecem somente leitura; não há escrita GitHub pelo bot.

## Escopo e autorização

Após a confirmação de identidade, duas tentativas automatizadas de gerar a chave falharam e foram reconciliadas pela listagem. O dono gerou a credencial manualmente. Ela foi recolhida diretamente da página, guardada com modo0600 e instalada como segredo próprio, sem aparecer no chat/Git. A validação confirmou a conta/ID numérico e acesso a metadados privados. Essa consulta foi uma página de validação, não um inventário completo.

`8b59b50` acrescenta autorização canônica para o owner e valida login/ID numérico antes das leituras. O nome selecionado deve aparecer literalmente no pedido autenticado; sua ausência pede esclarecimento antes de HTTP. A autorização do owner prevalece sobre aliases antigos, sem fallback para um grant público após revogação. Inclui repositórios próprios atuais/futuros; não inclui automaticamente organizações ou repositórios de outros donos.

## Prova real e falhas preservadas

Dois pedidos iniciais ao repositório público ficaram indisponíveis. O diagnóstico confirmou403, quota anônima60 e restante0; uma leitura MCP posterior não foi apresentada como sucesso do bot. A mensagem sobre quota foi corrigida sem retry automático.

Um primeiro canário privado pediu README ausente. A investigação também encontrou uma resposta de commit maior que o limite; o erro genérico original não foi retroativamente atribuído a uma única dessas causas. `ba08aa0` passou a resolver a branch pelo pequeno endpoint Git refs, sem buscar patches do commit.

O pedido seguinte selecionou um arquivo existente, sem Elo, e passou: update12319752, resposta49 em `sent`, uma tentativa; episódio Flue `622cf23e…` em `settled`; observação GitHub `available/file`, SHA fixado, hashes de arquivo/trecho e suporte do grant do owner verificados. O arquivo tinha2014bytes e coube no trecho, sem truncamento. Nome do repositório, caminho, conteúdo e SHA privado permanecem fora do Git.

## Verificações e limites

CI40664621765/`8b59b50` aprovada:1635 gerais,13 OAuth e70 nativos, além de Node/tipos/builds/auditoria. O ajuste do Git ref passou13 casos dirigidos, tipos e build. A versão `cf80d31a-697e-40c8-8a8a-ca0f0bc526f2` conservou42bindings, runtime/imagem, cron, exposição e pausa; o rollout posterior de títulos Calendar também conservou esses recursos. Source/Elo não foram alterados.

Conteúdo externo é trecho literal escapado, com proveniência/recorte; não entra no modelo, histórico Flue ou memória factual. Leitura não é execução de instruções encontradas no arquivo. A listagem é de arquivos de um repositório, sem promessa de inventariar todos os repositórios. Retirada remove derivados e preserva custos. Não se afirma leitura humana ou renderização do canário enquanto a interface estiver em segundo plano.

A #144 continua aberta: WhatsApp/busca, controles naturais restantes e validação integrada do piloto ainda não estão completos. A autorização de escrita Calendar foi dada separadamente pelo dono; não altera o GitHub somente leitura.
