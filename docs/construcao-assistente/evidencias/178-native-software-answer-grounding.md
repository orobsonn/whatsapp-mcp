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

## Publicação e pesquisa real

O commit `ff9b1e8` foi publicado na versão própria `869e3f3f-91d8-4edf-bd30-408a1ed0f2ff`, preservando os bindings, rotinas, autorização somente leitura e modo de aprovação. Nenhuma ativação autônoma ocorreu.

Na repetição pelo Telegram autenticado, sem informar o nome do repositório, o modelo usou `github_repositories` com paginação, investigou candidatos e confirmou o projeto pelo README de `app-rc`. Resolveu o SHA `834330f8ac6b628cf44e2144d7a1d89876462134` e leu componentes do painel, políticas de receita, geradores de compras e documentação. Houve tentativa de leitura de caminho indisponível, sem falsificar seu conteúdo; os arquivos necessários foram lidos com sucesso. A execução nativa terminou e `respond_owner` registrou a mensagem155 enviada.

A nova resposta separou a quantidade de molho pronto escalável pela receita da expansão do molho nos ingredientes de seu lote, que não está implementada no código examinado. A primeira proposta não fazia essa distinção. O modelo explicitou que código de branch padrão não comprova a versão implantada. Esta pesquisa é dirigida por pedido do operador no histórico Telegram, não um novo recebimento espontâneo de WhatsApp; a descoberta e a leitura foram feitas pelo agente, sem fornecer o repositório ou os arquivos como resposta pronta.

## Reavaliação solicitada pelo dono

`whatsapp_reassess` encaminha um pedido atual e autenticado do dono à conversa original de uma mensagem capturada. Aceita somente a referência exata da fonte. O destino vem do registro canônico; o texto encaminhado é exatamente o pedido do dono, sem uma instrução livre inventada pelo modelo. A âncora é uma entrada real de pessoa, com versão/hash e sequência original. A atividade Source precisa continuar atual; contexto, autorização, retenção e entrada atual do dono são verificados.

Uma nova avaliação pode gerar sugestão, pergunta ou silêncio. Não renova a ação expirada nem autoriza envio. O fluxo normal cria uma nova intenção e exige a aprovação correspondente. Replay e confirmação nativa perdida conservam a mesma identidade da entrega.

Oito testes dirigidos passaram: corpo exato/âncora/replay, chamador indevido e argumento forjado, atividade posterior recebida/enviada, substituição do pedido do dono, corrida com nova entrada WhatsApp, corrida com novo pedido Telegram e confirmação nativa perdida. Tipos e build passaram. A revisão adversarial não encontrou Critical/Important. CI41074107480 passou no commit `ff9b1e8`; a reavaliação terá a verificação do novo head.

A aprovação humana e a consequência real no provedor continuam pendentes. Pesquisa, entrada admitida e mensagem no Telegram não substituem essa prova.
