# Investigação de resposta sobre funcionalidade — 30/10/2026

## Evidência real anterior à correção

Uma pergunta recebida em grupo habilitado foi admitida na conversa nativa. O modelo produziu uma proposta, Source preparou a ação e o Telegram aceitou a revisão. A proposta expirou sem aprovação; nenhuma mensagem foi enviada ao WhatsApp por este teste.

O histórico nativo dessa execução contém `propose_reply`, mas nenhuma consulta GitHub. A proposta misturava uma orientação conceitual com uma afirmação sobre cálculo proporcional do produto sem verificar sua implementação. O envio da revisão não prova a qualidade da resposta.

Um pedido posterior do operador, pela sessão autenticada do dono no Telegram, solicitou pesquisa na conversa e no código. O agente consultou arquivo e Cognee, não encontrou a associação com o repositório e tentou resolver três nomes presumidos, todos indisponíveis. Entregou ao dono uma resposta que reconhecia a falta de verificação. Esse teste é dirigido: não demonstra descoberta autônoma nem encerra a aceitação de envio aprovado.

## Causas observáveis e correção

- O prompt permitia usar ferramentas, mas não orientava claramente a verificação de afirmações sobre funcionalidades do software. Agora exige conferir o código relevante, distinguir implementação de produção observada e de mudança proposta, e informar a lacuna quando não puder verificar. Conversa genérica não exige GitHub.
- O modelo possuía resolução, diretórios e leitura, todos dependentes de um nome de repositório conhecido. A associação necessária não estava disponível na memória consultada. `github_repositories` permite descobrir o catálogo autorizado e confirmar candidatos pelo README/código, sem deduzir identidade apenas pelo nome.

Não é possível afirmar o motivo interno exato da escolha do modelo. A sequência de ferramentas, a orientação existente e a ausência de descoberta são os fatores diretamente demonstrados.

## Autoridade e cobertura

O catálogo com autorização para todos os repositórios do dono usa somente `GET /user/repos`, filtrado por propriedade. Cada resultado precisa corresponder ao login e identificador numérico configurados. Descrições e nomes são dados não confiáveis; não concedem ações. O código devolve apenas os campos necessários, nunca os demais campos do provedor ou credenciais.

Sem autorização por dono, lista apenas os descritores explicitamente configurados e não enumera externamente. Cada página mantém a autorização antes da consulta e antes de publicar o resultado no contexto nativo, incluindo a exposição e as verificações finais existentes. Credencial ausente permanece indisponibilidade explícita. Paginação de 20 itens não limita o acervo total; `nextPage` e consistência de leitura corrente ficam explícitos.

Contrato do provedor: [GitHub — repositórios do usuário autenticado](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user).

## Verificação

Cinco testes novos passaram: privados autorizados/paginação, proprietário divergente, retirada de autorização durante exposição, descritores restritos sem busca externa e credencial ausente. Revisão adversarial do código não encontrou Critical/Important. Verificação de tipos passou.

Publicação e repetição na infraestrutura real continuam pendentes nesta evidência. Não declarar pesquisa autônoma, correção semântica ou envio validado antes dos respectivos recibos.
