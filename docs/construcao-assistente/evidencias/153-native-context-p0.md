# P0 — contexto nativo e retirada por conversa

Data de operação: 28/10/2026, America/Fortaleza. Implementação/testes autorizados após a devolutiva do plano. O ensaio não ativa resposta autônoma nem usa conversas reais.

## Evidência executada

`tests/assistant-native-agent-runtime.test.ts`: cinco testes passaram com Flue2.3, Pi/OpenAI Responses nativos e DO/D1 locais. Tipos passaram. Os testes cobrem ferramenta→resultado→resposta, sessão contínua após reinício, isolamento, reserva assíncrona antes do transporte, tentativa incerta sem nova chamada, compaction pelo mesmo caminho e exclusão de um DO preservando outra conversa.

O mesmo aplicativo descartável foi publicado como **assistant-native-context-proof**, com D1 próprio, classe Flue própria, endpoint autenticado e apenas fontes sintéticas. Não possui chave de modelo real, conexão Telegram/WhatsApp ou ferramentas de envio.

- Versão inicial Cloudflare: `504155cc-254c-440a-9537-a9a5ae68ae1d`.
- Atualização imediata de código/configuração: `15c28921-e329-4899-a728-4b738ea6270c`.
- Ambos os smokes remotos passaram: tool nativa executada, contexto entre entregas, conversas distintas, negação antes de transporte, tentativa incerta não repetida e retirada por conversa.
- Após atualização, o próprio DO informou revisão `restart-2`; o UID da conversa preservada e seu recibo anterior continuaram iguais, com resposta subsequente usando o contexto. O contexto retirado permaneceu bloqueado.
- Recibos integrais ficam no diretório privado do operador. Nenhum segredo ou conteúdo pessoal integra esta evidência.

## O que as provas significam

O protocolo, a persistência e os pontos de integração foram exercitados na Cloudflare real. O transporte HTTP do modelo é sintético: **zero chamadas pagas; não demonstra julgamento ou qualidade do modelo**. A reserva do ensaio é uma prova da barreira assíncrona/idempotência, ainda não integração com o ledger financeiro de produção.

O interceptor Flue envolve também iterações do stream e não recebe payload/modelo. Não serve sozinho para calcular/reservar custos. Usar wrapper estreito do provider nativo, sem converter tools em texto. O catálogo instalado inclui `gpt-6-luna`.

Erros de modelo podem provocar novas tentativas do Flue mesmo com retries HTTP desativados. O ensaio comprovou uma claim durável e uma tentativa de transporte, além de `maxRetries:0`. O caminho final deve integrar o ledger existente e seus recibos incertos.

A extensão pública `extend({base})` permite um método administrativo restrito que chama `Agent.destroy()`. A SDK apaga o armazenamento ativo daquele DO; o host mantém tombstone/contextEpoch fora dele e impede recriação por eventos antigos. Isso não garante eliminação imediata de backups do fornecedor. Testes finais ainda devem cobrir exclusão durante trabalho pendente e conhecimento já compactado.

## Cognee e hospedagem

Cognee1.6.5/Ladybug/LanceDB executou a ingestão nativa e a prova de proveniência em Docker local e na VPS existente, com modelos HTTP sintéticos, sem inferência paga. A VPS recebeu venv e usuário de serviço próprios; nenhum serviço do assistente foi exposto ou ativado ali.

A opção física preferida é volume persistente na VPS existente, com serviço autenticado via TLS e broker de inferência mantido no Own. A ida Cognee→broker exige adaptação explícita: `broker.internal` pertence ao interceptador do Container e não existe automaticamente na VPS. Não transferir a chave OpenAI para contornar isso. ADR definitivo depende de canal autorizado, restauração e medidas de capacidade/custo.

## Pendente

- Relações com IDs canônicos, evidência e consulta independente, correção/retirada e compartilhamento pelo MCP existente.
- Ledger real em todas as inferências nativas/compaction, ensaio pago delimitado de escolha da ferramenta pelo modelo.
- Restore do conhecimento, ensaio acima dos tetos antigos e estimativa de custos.
- Integração com conversas reais no Telegram/WhatsApp antes do aceite de produto.

A instalação principal não foi migrada por este ensaio. Não há declaração de aceite completo ou release funcional decorrente destes testes.
