# Sessão nativa Flue, ferramentas e retirada na Cloudflare

Data: 2026-10-29. Conteúdo exclusivamente sintético. **Zero inferências pagas; respostas SSE controladas.**

## Infraestrutura e implementação exercitadas

Worker isolado `assistant-native-context-proof`, D1 real e o serviço Cognee 1.6.5 na VPS existente. Versão final `9343bd53-dcc6-43b9-ba6b-51676b52c609`, revisão `native-p2p5-protocol-r6`. O agente compilado chama a implementação pública de `ConversationRuntimeAgent`; Flue/Pi executam seu histórico e ciclo nativo de ferramentas. A consulta passa pelo `KnowledgeService` e pelo transporte HTTPS autenticado até o grafo persistente real.

O transporte SSE substitui apenas o fornecedor do modelo: solicita uma ferramenta a partir de um marcador sintético e constrói a resposta com o resultado efetivamente recebido. Isso verifica o protocolo e o percurso dos dados, **não o julgamento de uma IA**.

Fixture versionada: `tests/fixtures/assistant-conversation-native-probe.ts`, commit `32a3652`. O manifesto privado identifica os hashes dos módulos públicos e do bundle efetivamente implantado. O Worker principal, suas permissões e os canais reais não foram migrados neste ensaio.

## Resultados observados

| Percurso | Evidência observada |
| --- | --- |
| Continuidade | Duas entregas da conversa A preservaram a mesma instância e ampliaram seu histórico; a conversa B usou outra instância. |
| Memória compartilhada | Uma relação fornecida pelo cliente `owner_mcp` foi consultada pela ferramenta do agente; a resposta controlada usou os nomes, relação e referências retornados pelo Cognee. |
| Original da entrada | Outra fonte canônica provou o corpo e hash exatos da mensagem recebida. A fonte da pergunta e a fonte da relação são distintas. Autor participante e destino da conversa permanecem separados. |
| Retirada | A retirada da fonte bloqueou o contexto anterior, novas entregas e solicitações de modelo/compaction sujeitas à mesma autorização. |
| Purga física | Tombstone fora do DO precedeu a retirada da instância pelo `destroy` suportado pelo SDK. Consulta pública posterior retornou instância ausente e nenhum recibo de modelo em `attempting`. |
| Operação em andamento | Outro ensaio retirou a fonte durante um transporte observado como `attempting`; interrupção e reconciliação precederam a purga. Uma cobrança incerta simulada foi preservada. |
| Isolamento | A conversa B continuou com a mesma instância e histórico após a retirada de A e após novas implantações. Nenhum reset global de memória foi usado. |

Recibos privados, sem credenciais no documento:

- `native-integrated-summary.json`: 11 verificações, ensaio `1b61c24e-fbde-4ee2-9aa0-6f4dfe95040e`.
- `native-inflight-summary.json`: 7 verificações, ensaio `51bf8abf-4c4f-4656-b33a-1421d817b9d4`.
- `native-event-source-summary.json`: 8 verificações, ensaio canônico `2e24d830-5fe1-4414-91d9-800fc6315c85`.
- `native-restart-receipts.json`: releituras de instância, eventos e histórico após as implantações.
- `native-final-manifest.json`: versão, revisão e hashes do bundle e das fontes exercitadas.

O ensaio anterior `r5` associava a entrada à fonte factual, sem provar seu corpo exato. Sua evidência foi preservada como **inválida e substituída por r6**; não conta como prova de entrada canônica.

## Limites e próximos aceites

- A compactação automática nativa foi exercitada em P0. Neste percurso Cloudflare foi usada uma solicitação com formato de compaction para conferir a autorização do mesmo transporte; não foi forçada uma compactação automática.
- A ausência da instância confirma a purga operacional observada. Não comprova apagamento instantâneo de backups do fornecedor ou cópias externas.
- Os recibos de custo deste D1 são simulados, separados do histórico financeiro real. Não representam fatura e não reiniciam o teto global de testes pagos.
- Faltam a integração principal, uma IA real escolhendo ferramentas, a curadoria diária integrada e o percurso real de Telegram/aprovação/WhatsApp. Não houve ativação autônoma ou envio a pessoas neste ensaio.

O responsável principal releu os recibos e o manifesto antes deste registro. Não foi repetida toda a bateria para produzir o documento.
