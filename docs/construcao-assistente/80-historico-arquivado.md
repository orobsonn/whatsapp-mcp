# Integrar originais anteriores à ponte

O arquivo Source pode conter mensagens capturadas antes da instalação da ponte. Os triggers da ponte registram alterações posteriores; sua instalação não cria eventos para os originais anteriores. Isso deixava esses textos fora do índice canônico consultado pelo agente.

## Correção

Uma migração única, conduzida pelo operador, enumera referências no D1 Source, com paginação e checkpoints privados. Não exporta corpos. O levantamento faz a diferença entre páginas de referências e da outbox no cliente, sem buscas correlacionadas sobre o arquivo inteiro. Somente originais sem eventos na ponte entram nesta migração. Cada referência é encaminhada a `POST /internal/archive-import`, autenticado pelo segredo administrativo existente. O endpoint aceita somente `sourceKind` (`message` ou `derivative`), `sourceId`, `chatId` e o limite restritivo `throughSequence` do snapshot do operador; instalação, geração e origem vêm do ambiente. Não é uma ferramenta disponível ao modelo.

O materializador consulta o tipo e acesso atuais da conversa, confere a mesma elegibilidade da memória compartilhada antes de ler o texto e usa a projeção existente: mesmos IDs canônicos, versões, autoria, proveniência e FTS. Sequência zero é válida quando não houve alteração na ponte. Observações posteriores ao snapshot do operador e referências já presentes no inbox live são recusadas; a importação não pode roubar de uma entrada recente o evento inicial de curadoria. A migração não cria uma sequência artificial, inbox, tarefa Flue, âncora de atividade ou sugestão de resposta.

Individuais entram por padrão, respeitando exclusões. Grupos exigem inclusão explícita em observe/respond. Conflito de tipo e quarentena de política negam. Retenção, retirada, geração ativa e configuração de restauração também são revalidadas. Um latch de metadados, a projeção e sua conclusão pertencem ao mesmo batch atômico. O CAS da fonte e da conversa impede sobrescrever uma versão concorrente.

Uma criação histórica inicial não produz `assistant_source_changes`. Assim, disponibilizar o original para consulta não inicia curadoria paga em massa. Edições e retiradas posteriores conservam seus eventos normais. Derivados só são elegíveis quando já estão prontos; este procedimento não transcreve nem processa mídias antigas.

## Operação e reconciliação

1. Confirmar versão ativa e migração0052 no Own. Preservar implantação mais recente, bindings, políticas, recibos e contas.
2. Enumerar referências por namespace e páginas estáveis, restringindo-se a fontes disponíveis no arquivo autorizado. Persistir página/cursor e intenção em arquivo privado antes das chamadas.
3. Registrar resultado de cada referência: aplicado, excluído, retirado ou indisponível. Não contar erro de transporte como ausência de gravação.
4. Em confirmação incerta, reconciliar a origem canônica e sua versão antes de avançar. Repetir uma referência converge no mesmo ID; nunca libera ações externas.
5. Comparar corpos/hashes e proveniência sem publicá-los. Conferir leitura pelo consumidor real, ausência de entradas/tarefas/curadoria produzidas pela migração e política inalterada.

Cobertura parcial permanece parcial enquanto houver referências pendentes. Conversas ignoradas nesta passagem e habilitadas depois podem precisar de nova passagem histórica específica. A ponte cobre mudanças futuras, mas não recupera automaticamente originais antigos que esta seleção excluiu. Original indexado não significa conversa já analisada ou relação aprendida no Cognee.

## Validação antes de publicar

O teste inicialmente falhou pela ausência da capacidade de importação. Os12 casos exercitam texto antigo com watermark zero e pesquisa FTS, replay, correção posterior, grupos/exclusões antes do corpo, política/hold no commit, retirada, entrada estrita, rota privada, corrida com captura live e confirmação de commit perdida. A verificação final conjunta com materialização, acesso ao conhecimento e retenção passou54 testes em5 arquivos. TypeScript e build também foram conferidos. A revisão adversarial não encontrou bloqueio crítico/importante.

Essas verificações locais não substituem a prova de leitura e cobertura na Cloudflare. A evidência operacional deve registrar separadamente o que foi efetivamente integrado.
