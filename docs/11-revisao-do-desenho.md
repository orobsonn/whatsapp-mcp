# Revisão adversarial da implementação

19/10/2026. Revisor independente `design_adversary`, gpt-6.1-sol/high, somente leitura. Sem código, credenciais ou dados do Elo. Escopo: PRD integral e handoff de privacidade/engenharia/testes. Achados são lacunas de contrato, pois a aplicação ainda não existia.

## Achados e resposta

1. P1: aprovação separada ainda exposta a GET, CSRF, bearer MCP e HTML hostil. Incorporado: GET só apresenta, POST Access + nonce único vinculado a envelope/subject/epoch + origem exata, escape e CSP; MCP não confirma.
2. P1: captura/retenção/exclusão seriam atalhos para instrução maliciosa. Incorporado: mesma confirmação humana para expansão de captura, políticas persistentes e exclusão destrutiva; consultas e propostas continuam simples.
3. P1: restore poderia recuperar grants/sessões/trabalhos. Incorporado: epoch externo em todas as autorizações e trabalhos, além de geração da conexão; expiração e revalidação de identidade. Logout Access não promete revogar tokens MCP.
4. P1: D1/R2 sem atomicidade conjunta. Incorporado: D1 governa visibilidade; chaves imutáveis e publicação condicional por versão/epoch/geração/tombstone, cleanup de fence perdido, exclusão lógica antes dos bytes. Nenhuma transação durante rede/IA.
5. P1: mídia expira antes do download sob demanda. Incorporado: mensagem + trabalho durável antes do sucesso webhook; cron bounded/lease/retry para originais, transcrição continua sob demanda. Lacunas e falhas explícitas.
6. P1: como o fornecedor obtém mídia privada? Escolhido Base64 até 2 MiB, sem URL pública. Contrato revalidado no adaptador; mídia maior explicitamente recusada. Navegador autenticado e conteúdo MCP são caminhos separados, sem alegar compatibilidade real antes do ensaio.
7. P2: namespace/correlação de status incompletos. Incorporado: geração + conversa + ID; IDs retornados distintos; status ambíguo pendente; progressão e falha/incerteza separados.
8. P2: limites vagos. Incorporados no PRD limites de corpo, arquivo, texto, saída, páginas, jobs, lease e retry; duração declarada não é medição real. Nenhum decoder/OCR universal introduzido.

O revisor recomendou manter as seis issues e não acrescentar SaaS, DO, embeddings ou motor de políticas. Os contratos foram incorporados ao PRD e guiarão os testes de cada módulo. Essa revisão não é prova de implementação nem homologação de fornecedor/cliente.
