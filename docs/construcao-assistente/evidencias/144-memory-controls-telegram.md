# Memória e políticas pelo Telegram — 28/10/2026

O dono pode ensinar uma nota, perguntar sobre seu conteúdo, corrigir e retirar a nota pelo bot autenticado. Pode também configurar observação em sombra, ignorar ou excluir uma conversa usando os controladores existentes. Texto recuperado ou uma classificação do modelo não concede autorização para essas mudanças.

## Ciclo real de memória

Um cenário identificado como técnico foi criado e retirado ao final da homologação:

| Etapa | Update / resposta | Consequência verificada |
|---|---|---|
| Ensinar nota |12319766 /73| `source.create`, revisão1/versão1 |
| Perguntar sobre o conteúdo |12319768 /77| Respondeu sexta-feira, sustentado pelo original ensinado |
| Corrigir |12319769 /79| `source.correct`, revisão2/versão2 |
| Consultar novamente |12319771 /83| Respondeu segunda-feira, sem repetir sexta-feira; hash e texto da versão2 conferidos |
| Retirar do uso |12319772 /85| `source.withdraw`, revisão3, estado `withdrawn`; leitura Owner recusada |

As cinco respostas foram enviadas com uma tentativa; os cinco episódios Flue terminaram em `settled`. As duas perguntas produziram explicação e citação literal do conteúdo atual, em vez de apenas listar títulos. A segunda consulta confirmou a consequência da correção, além do recibo administrativo.

A retirada conservou a versão2 como histórico e uma barreira `retired/external_state=recorded`, impedindo uso do original pelo leitor canônico. Não foi apresentada como limpeza física integral concluída. Exatamente três recibos únicos registram criação, correção e retirada.

## Política real, sem ativar processamento contínuo

Uma conversa de grupo já capturada, em `ignore`, foi configurada temporariamente como `observe` pelo Telegram. Update12319773/resposta87 concluiu com uma tentativa e Flue `settled`; readback confirmou revisão1, `observe`, exclusão0. O comando seguinte12319774/resposta89 retornou a `ignore`; readback confirmou revisão2, modo efetivo `ignore`, exclusão0 e Flue `settled`.

Era um grupo comum, não apresentado como grupo técnico ou interno. O teste alterou somente a política administrativa enquanto a pausa global permanecia ativa. Não houve envio WhatsApp, retomada de rotinas, mandato, mudança de captura ou avaliação humana fabricada. Nome, identidade e conteúdo do grupo permanecem nos recibos privados.

## Implementação e limites

- Comandos literais do dono resolvem alvo único e congelam identidade/revisão antes de `SourceController.execute` ou `OwnerControl`. Checkpoint e guard atual participam da admissão da mesma transação; a recuperação conserva o comando e não seleciona outro homônimo.
- Correção/retirada confirmam o recibo da operação; não exigem que o fence antigo continue válido depois da mutação. Exclusão preserva o modo anterior e exige `excluded=true`; não habilita respostas automáticas.
- Consulta de notas usa até três originais atuais com dependências e cobertura limitada. O corpo da fase já existente congela os documentos antes de qualquer chamada paga. Payload antigo não é reconstruído com parâmetros novos.
- As notas são globais. Essa prova não equivale a extração automática de relações por projeto ou busca semântica de todo o arquivo. O contexto por projeto e seus controles MCP têm evidências próprias.

Os helpers passaram15 testes dirigidos e tipos. O caminho integrado passou15 testes de fases/host, incluindo consulta real aos originais, recuperação sem nova inferência/envio e correção cujo corpo contém uma pergunta sobre repositório, tratada como dado. CI do código `a8ab1cb` aprovada; o marco final vincula seu próprio SHA/CI na release.
