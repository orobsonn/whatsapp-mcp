# Coortes de entregas efetivamente consumidas — P2

Data: 2026-10-29. Escopo: código local e SQLite Durable Object em Miniflare, com Flue 2.3.0 e Pi 1.1.0 instalados. Nenhuma inferência paga, publicação ou ação externa nesta prova.

## Correção da fronteira real

O ensaio Cloudflare encontrou uma entrega legítima rejeitada porque a normalização nativa ordena as propriedades como `kind,type,body,attributes`; o host emitia `kind,type,attributes,body`. `JSON.stringify` dos envelopes fazia ordem de propriedades virar condição de autorização.

Regressão observada falhando com `conversation_delivery_denied`; corrigida em `2654659`. A comparação agora exige as mesmas propriedades e os mesmos valores, mantendo o corpo como string exata. Acrescentar campo administrativo, atributo, `tagName`, trocar referência/corpo ou remover campo continua recusado. A correção não modifica a política nem interpreta novamente o JSON do corpo.

## Implementação

- `useResponseStart` ancora um token na metadata nativa e inicia a coorte. Um reinício da mesma resposta que repita esse seam reutiliza o token durável; outra resposta começa vazia.
- Um único `useAgentStart` resolve e valida a entrega atual pelo host antes de acrescentar sua referência. Entregas pendentes na fila não são consultadas.
- `usePersistentState` usa updaters funcionais, cujo valor anterior vem do buffer nativo no momento da chamada. Estado e gravação do seam seguem a transação do runtime. Não há ponteiro global de tarefa ativa.
- Ferramentas fecham o cursor do próprio render e recebem o prefixo observado até esse cursor. `ConversationRuntime.resolveTask` continua validando eventos, ordem, sessão, autorização e destino; seu resultado é imutável.
- `consumedTaskRefs` opcional do resolver é uma asserção adicional do host: precisa coincidir com a observação nativa, sem estender a coorte.
- `useResponseFinish` publica referências da coorte na metadata da resposta. Token, estado e concessão do host não entram no payload do modelo.

As APIs utilizadas são públicas: `node_modules/@flue/runtime/docs/reference/agent-hooks-api.md`, seções `usePersistentState`, `useAgentStart`, `useResponseStart` e `useResponseFinish`; a atomicidade é descrita também em `docs/guide/durability.md` do pacote instalado.

## Prova controlada nativa

`tests/assistant-conversation-native-cohorts.test.ts` executa o perfil de produção, `ConversationRuntime` e `KnowledgeService` reais. A fixture usa um protocolo Responses SSE sintético; o port de conhecimento retorna uma página vazia. O teste não avalia raciocínio do modelo nem o serviço Cognee.

1. A é entregue ao DO do dono no Telegram; a primeira chamada ao provider fica bloqueada.
2. B, em outro tópico, é admitida no mesmo DO enquanto A está em execução.
3. Ao liberar a chamada, a ferramenta de A recebe exatamente `[A]`; a próxima ferramenta recebe `[A,B]`. A autoria de ambas é preservada; a coorte posterior retorna a `topic-2`, e o contexto anterior continua em `topic-1`.
4. Um HTTP 429 sintético antes da ferramenta de B é repetido pelo runtime. A coorte permanece `[A,B]`; ambos os recibos leem a mesma resposta e a mesma metadata.
5. O teste verifica que o primeiro payload não contém B e que os payloads não contêm token de resposta, estado da coorte ou concessão do host.
6. Miniflare é encerrado e reaberto com o mesmo armazenamento. O recibo anterior mantém sua metadata. A mensagem C preserva o mesmo endereço/histórico, começa um token novo e recebe apenas `[C]`, com `topic-3`.
7. Qualquer saída de rede não prevista é recusada; contagem final de chamadas externas: zero.

## Comandos e resultados

```sh
npx vitest run tests/assistant-conversation-runtime.test.ts tests/assistant-conversation-cohorts.test.ts
npx vitest run --config assistant/flue-test.config.ts tests/assistant-conversation-native-cohorts.test.ts
npm run check
npm run build:assistant
```

- Testes de runtime e hooks: 21 aprovados.
- Ensaio nativo: 1 aprovado.
- TypeScript e build offline: aprovados.
- O build conserva avisos já emitidos pelo projeto sobre imports sem extensão e a diretiva de outro módulo legado; nenhuma falha de build.

## Limites

O reinício foi testado após a resposta terminar, mais releitura do recibo e próxima resposta. O retry foi uma falha transitória do provider durante a resposta. Não foi provada recuperação após matar o processo no meio de um seam ou ferramenta. O perfil atual mantém `maxAttempts:1`; ampliar tentativas de submissão exige revisão do controle de orçamento e efeitos, fora desta alteração. Os testes pequenos com hooks falsos comprovam apenas a composição das callbacks, não a durabilidade do DO.

Nenhuma configuração legada, provider, instalação, variável de ambiente ou execução de produção foi alterada por este trabalho. A prova Cloudflare isolada é registrada separadamente pelo executor responsável.
