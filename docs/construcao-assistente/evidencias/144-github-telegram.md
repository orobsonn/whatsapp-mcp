# GitHub no diálogo Telegram — 28/10/2026

## Atualização: resposta à pergunta, além da leitura de arquivo

A primeira prova abaixo validava transporte e acesso ao arquivo; não validava responder a uma pergunta sobre o projeto. A implementação posterior acrescenta seleção de até cinco arquivos da branch padrão, fixada no mesmo SHA, e uma segunda fase de modelo para explicar a resposta com referências verificadas. Os textos dos arquivos são dados; esse caminho é travado pelo host como consulta somente leitura antes de qualquer nome externo chegar ao modelo.

O canário público12319760 perguntou como a autenticação protege a API e restringe o acesso ao dono. O bot consultou cinco arquivos e explicou instalação/identidade, Cloudflare Access e OAuth, com referências a `src/auth.ts` e `migrations/0002_auth.sql`. Resposta63 `sent`, uma tentativa; episódio nativo `settled`, com recibo do job. Isso comprova uma resposta sobre código, sem afirmar que a configuração de produção foi auditada pelo modelo.

O canário privado12319764 consultou cinco arquivos, mas o modelo devolveu conteúdo vazio com `finish_reason=length`, consumindo os1800tokens disponíveis; a resposta69 foi fallback e não contou como sucesso. O ajuste manteve o modelo Luna, configurou esforço `none` na seleção e `low`/4000tokens na resposta, dentro do cap existente.

O novo canário privado12319767 respondeu para que serve o projeto e como suas partes funcionam: cinco documentos, quatro afirmações e onze citações literais conferidas contra os corpos exatos. Resposta76 `sent`, uma tentativa, Flue `settled` e um recibo de job. Revisão técnica reconheceu utilidade no recorte; a finalidade geral é síntese das partes, sem certificação automática de semântica. Nenhum nome, caminho, conteúdo ou SHA privado é publicado aqui.

Falhas anteriores12319757/759 permanecem registradas: a duplicação dos documentos no checkpoint excedia o limite real de32768caracteres do episódio. `70cf9be` passou a reutilizar o corpo durável da fase do modelo; `02b9396` limita o envelope completo do manifesto. Não houve repetição das tentativas antigas ou renovação de seus prazos. CI40685190593 e40690583687 aprovadas. O conjunto `a8ab1cb` passou na CI40695615316:1694gerais,13OAuth,70nativos, verificações Node5/9/1/39, tipos/builds e auditoria sem vulnerabilidades. A release final vincula seu próprio SHA/CI, sem reutilizar a aprovação anterior como se fosse do novo commit.

Limites atuais: consulta de um repositório próprio explicitamente citado, branch padrão, até cinco arquivos de texto e cobertura indicada. Não representa leitura integral de todos os repositórios, execução do código ou busca semântica global. A credencial continua somente leitura para todos os repositórios próprios, sem expiração configurada.

Os parágrafos seguintes conservam a prova histórica do leitor de arquivos.

A leitura de um arquivo existente de repositório privado próprio passou no bot real: mensagem no Telegram autenticado → Flue nativo → GitHub → resposta no tópico original. O dono pediu explicitamente todos os repositórios da sua conta, públicos/privados e sem expiração configurada. Contents/Metadata permanecem somente leitura; não há escrita GitHub pelo bot.

## Histórico do leitor de arquivos — escopo e autorização

Após a confirmação de identidade, duas tentativas automatizadas de gerar a chave falharam e foram reconciliadas pela listagem. O dono gerou a credencial manualmente. Ela foi recolhida diretamente da página, guardada com modo0600 e instalada como segredo próprio, sem aparecer no chat/Git. A validação confirmou a conta/ID numérico e acesso a metadados privados. Essa consulta foi uma página de validação, não um inventário completo.

`8b59b50` acrescenta autorização canônica para o owner e valida login/ID numérico antes das leituras. O nome selecionado deve aparecer literalmente no pedido autenticado; sua ausência pede esclarecimento antes de HTTP. A autorização do owner prevalece sobre aliases antigos, sem fallback para um grant público após revogação. Inclui repositórios próprios atuais/futuros; não inclui automaticamente organizações ou repositórios de outros donos.

## Prova real e falhas preservadas

Dois pedidos iniciais ao repositório público ficaram indisponíveis. O diagnóstico confirmou403, quota anônima60 e restante0; uma leitura MCP posterior não foi apresentada como sucesso do bot. A mensagem sobre quota foi corrigida sem retry automático.

Um primeiro canário privado pediu README ausente. A investigação também encontrou uma resposta de commit maior que o limite; o erro genérico original não foi retroativamente atribuído a uma única dessas causas. `ba08aa0` passou a resolver a branch pelo pequeno endpoint Git refs, sem buscar patches do commit.

O pedido seguinte selecionou um arquivo existente, sem Elo, e passou: update12319752, resposta49 em `sent`, uma tentativa; episódio Flue `622cf23e…` em `settled`; observação GitHub `available/file`, SHA fixado, hashes de arquivo/trecho e suporte do grant do owner verificados. O arquivo tinha2014bytes e coube no trecho, sem truncamento. Nome do repositório, caminho, conteúdo e SHA privado permanecem fora do Git.

## Verificações e limites

CI40664621765/`8b59b50` aprovada:1635 gerais,13 OAuth e70 nativos, além de Node/tipos/builds/auditoria. O ajuste do Git ref passou13 casos dirigidos, tipos e build. A versão `cf80d31a-697e-40c8-8a8a-ca0f0bc526f2` conservou42bindings, runtime/imagem, cron, exposição e pausa; o rollout posterior de títulos Calendar também conservou esses recursos. Source/Elo não foram alterados.

Conteúdo externo é trecho literal escapado, com proveniência/recorte; não entra no modelo, histórico Flue ou memória factual. Leitura não é execução de instruções encontradas no arquivo. A listagem é de arquivos de um repositório, sem promessa de inventariar todos os repositórios. Retirada remove derivados e preserva custos. Não se afirma leitura humana ou renderização do canário enquanto a interface estiver em segundo plano.

Naquele checkpoint, a #144 ainda tinha pendências de WhatsApp e controles naturais. Os ensaios integrados posteriores estão nas evidências atuais do marco; a autorização de escrita Calendar não altera o GitHub somente leitura.
