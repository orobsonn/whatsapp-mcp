# Continuidade após falha e publicação das tarefas nativas

Data: 29/10/2026. Marco ainda em homologação; não autoriza respostas autônomas.

## Problema confirmado e correção

No Flue 2.3.0, um `turn_end` com erro consumia um pedido novo que aguardava na fila da conversa. Os dois pedidos podiam terminar como falhos. A transformação de build em `297d83a` preserva o pedido que ainda está na fila quando o turno termina em `error` ou `aborted`. O próximo processamento nativo recebe esse pedido. Turnos normais mantêm o agrupamento original.

Não há nova fila, reenvio de transporte ou alteração de `node_modules`. Versão, hash e ponto único da transformação são verificados durante o build. Escopo: todos os perfis Flue empacotados na assistente, sem mudança no Worker Source ou no Elo. Detalhes e limites na [decisão do SDK](../../superpowers/decisions/2026-10-29-flue-failed-turn-queue.md).

## Prova na Cloudflare

Worker de teste existente: `assistant-native-context-proof`, versão ativa verificada `e6b4d6aa-170f-44a9-af6b-270c649780ca`. Banco e Durable Objects do teste preservados; nenhum recurso novo foi contratado.

O teste usa o bundle publicado, o SDK nativo, o perfil e o protocolo do provedor da aplicação. As respostas SSE são controladas, com credencial fictícia e sem transporte para o modelo externo. Não é prova de julgamento de IA.

| Cenário | Execução anterior | Pedido seguinte | Repetição dos recibos |
|---|---|---|---|
| Falha após pedido seguinte entrar na fila | Falhou | Concluiu em nova execução, no mesmo DO | Sem novos transportes ou recibos de modelo |
| Turno normal | Concluiu | Concluiu no agrupamento nativo esperado | Sem novos transportes ou recibos de modelo |

Cada cenário teve dois transportes **simulados**, um por entrada. No cenário de erro houve uma resolução adicional do modelo, recusada pela autoridade cancelada antes de reservar orçamento ou abrir transporte. Não afirmar que o SDK deixa de tentar resolver o modelo.

O teste local havia medido zero chamadas externas por bloqueio de saída. Na Cloudflare, a ausência de chamada paga decorre do transporte controlado, sem chave real; os campos de contagem da fixture não são uma medição independente da rede. Recibos financeiros dessa fixture são simulados, não fatura. Relatório completo privado `native-sdk-seam-cf-proof-1793301510278.json`.

## Publicação na assistente

- Revisão de código adversarial concluída para `297d83a` e `5d0251b`, sem bloqueadores remanescentes identificados.
- Migração aditiva `0050_native_tasks.sql` aplicada e relida no D1 próprio. Bookmark anterior, em `2026-10-29T19:18:50Z`: `00000024-00000d90-00005113-55e83fc2d0160e69e87ab15b5b45be2b`.
- Versão própria `acac4d7f-e888-4230-9308-23d3db846d6a` promovida a 100%, com todos os bindings, configurações de runtime, exposição e agendamentos existentes preservados.
- Inclui ferramentas nativas para consultar/criar/editar/cancelar missões e aderir explicitamente às versões atuais de tarefas. Prazos geram avaliação privada no Telegram; não autorizam envio proativo ao WhatsApp.
- Inclui a correção de vínculo do primeiro contexto do Telegram e arbitragem atômica entre entradas distintas, anteriormente publicada em `13510e2c`.
- Respostas autônomas e recorrência da curadoria continuam desligadas. A amostra explícita de curadoria anterior permanece idempotente.

## Aceite ainda pendente

Esta publicação não prova que um lembrete real foi criado, despertou e foi cancelado pelo bot. Esse ensaio permanece pendente, assim como o envio de uma sugestão atual após aprovação exata do dono, a avaliação de custos da recorrência e a CI/release finais. Não fechar a issue #146 com base neste documento.
