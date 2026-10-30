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

## Falhas encontradas na primeira reavaliação real

A nova capacidade foi publicada na versão `1db6e1f0-9596-435d-be60-e9341cfa915c`. O agente Telegram usou `whatsapp_reassess` com a fonte original e o host admitiu um novo esclarecimento na mesma conversa WhatsApp. A retomada não produziu revisão: o agente WhatsApp interpretou a instrução de encaminhamento Telegram como se ainda precisasse encaminhar o pedido, consultou o original e registrou silêncio por considerar essa ferramenta ausente. Não houve envio externo. A orientação compartilhada entre canais era ambígua; a correção identifica explicitamente o canal a partir da identidade validada e restringe instruções operacionais/ferramentas ao respectivo perfil.

Esse caso também reproduziu um erro de encerramento já observado em execuções anteriores. O lembrete de finalização usava um sinal interno sem evento canônico. O cursor `useDelivery()` avança após um `append` de hook, sem novo `useAgentStart`; a continuação então falhava em `bound()` com `conversation_delivery_denied`. A correção reapresenta somente o envelope canônico já autenticado, mantém a mesma coorte e preserva o limite existente de uma continuação. Não afrouxa a autenticação nem cria uma fonte nova.

A reprodução usa o perfil de produção, Flue/Pi, SQLite Durable Object local e transporte SSE sintético, sem chamadas pagas ou saída externa. O caso cobre finalização inicial sem ferramenta, continuação com entrega válida e erro previsto quando a segunda finalização continua incompleta. As provas anteriores de coorte/entrada concorrente/reinício continuam no mesmo ensaio. A repetição real ainda é necessária depois da publicação dessas correções.

Os dois testes nativos passaram, assim como tipos e build. O SDK oculta a causa interna ao cliente: a asserção negativa confere o recibo falho correto, somente uma continuação e nenhum efeito adicional; o log local confirma `conversation_effect_not_completed`. A revisão adversarial do diff final não encontrou Critical/Important. CI41076383180 passou em `06aa52d`.

Após publicar `e6f3280` na versão `4b14ab70-898a-48e1-983b-8405035d47b6`, a repetição na conversa WhatsApp terminou sem erro do SDK e enviou a revisão160 ao Telegram. O caminho de reavaliação/revisão funcionou, mas a resposta voltou a tratar a dúvida como orientação culinária genérica, sem GitHub. Portanto, não passou no aceite semântico solicitado. A ação Source correspondente foi cancelada pelo operador via MCP, ainda sem tentativa; isso não é um descarte humano simulado.

A orientação foi refinada para considerar o projeto pelo histórico, mesmo quando a última mensagem usa apenas termos de domínio, e para verificar o código antes de sugerir mudanças de cadastro/cálculo, inclusive em frases como “eu registraria”. Se o escopo não ficar claro, deve pedir orientação. O próximo pedido explicita naturalmente que a dúvida é de cadastro e lista de compras no app, sem fornecer repositório, arquivos ou uma resposta pronta.

A revisão factual independente distingue também os limites da pesquisa anterior: código/docs não provam o estado atual do CMS; o editor exige ingrediente existente no catálogo; um aviso editorial não é automaticamente bloqueio de lista; expansão automática de sub-receita é diferente de curadoria manual de quantidades ou manutenção deliberada de um lote inteiro com sobra descrita. Não foi feita alteração no aplicativo do cliente.
