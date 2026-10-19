# Entrega de grupos — v0.2.0

19/10/2026. Ampliação solicitada pelo dono depois da v0.1.0: gerenciar todas as possibilidades de grupo documentadas na Z-API. Foram cobertas **35 operações: 22 Groups, 9 Chats e 4 Communities para associação de grupos**, por 12 novas ferramentas MCP (28 no total), com 26 variantes de ação. O [manual](23-usar-grupos.md) e a [matriz de cobertura](24-grupos-cobertura.md) relacionam cada operação à interface e fonte oficial.

## Evidência local

- `npm test`: **123 testes em 10 arquivos**, todos passando. Preserva os 91 anteriores e acrescenta 32 regressões de contratos/serviço/jornada/migração/operação.
- `npm run check`: passou com package 0.2.0.
- `npm run build`: dry-run passou; não publica Worker.
- `npm audit --audit-level=moderate`: zero vulnerabilidades.
- `npm run db:local`: migration 0006 aplicada, 14 comandos, preservando estado local. Teste separado aplica SQL entregue sobre nonces legados e confere consumo, validade, índice e CHECK.
- Smoke em Wrangler local: `service=whatsapp-mcp`, `version=0.2.0`, `maintenance=true`, `privateAccessDenied=true`.
- Cliente SDK MCP real em runtime local: OAuth/PKCE, confirmação Access, alteração de nome e entrada por convite. Rede e identidades sintéticas; nenhum efeito em conta real.

A suite cobre as 26 mutações, rotas de leitura, GET com efeito e timeout, alvos de tipos diferentes, hashes aninhados, claim concorrente, foto revogada antes do claim, menções por referência, grupos grandes, resultado parcial, recuperação local sem nova chamada, exclusão de alvos secundários/resultantes e limpeza após troca de geração.

## Revisão independente e correções

Aplicada a lógica de delivery do claude-harness sem instalá-lo. Rotas: gpt-6-sol/medium para inventário/transporte, gpt-6.1-sol/high para serviço/segurança e gpt-6-astra/high para revisão adversarial final. Documentação e integração ficaram com o agente principal.

A revisão encontrou e corrigiu: identificação oficial `-group`; convite sem identificação legível do alvo; possível recuperação de grupo em geração errada; paginação posterior a milhares de gravações; papéis ausentes tratados como false; nomes de membros desatualizados; perda dos contatos não adicionados; protocolo de menções não descobrível; descrição vazia; exclusão do grupo resultante sem vínculo com sua ação; ack já redigido preso na limpeza. O último caso foi reproduzido com teste RED e corrigido para GREEN. Fechamento independente: nenhum achado acionável pendente no código estabilizado.

## GitHub e limite da conclusão

- Issues do marco: [#8](https://github.com/orobsonn/whatsapp-mcp/issues/8), [#9](https://github.com/orobsonn/whatsapp-mcp/issues/9), [#10](https://github.com/orobsonn/whatsapp-mcp/issues/10).
- [CI e commits](https://github.com/orobsonn/whatsapp-mcp/actions), [PRs](https://github.com/orobsonn/whatsapp-mcp/pulls?q=is%3Apr+grupos) e [release v0.2.0](https://github.com/orobsonn/whatsapp-mcp/releases/tag/v0.2.0) são a autoridade para resultado remoto de integração/publicação.

Software e contratos verificados localmente. **Instância Z-API própria, deploy e homologação real continuam pendentes**, conforme decisão do dono de seguir sem conexão por enquanto. Não houve pareamento, uso de credenciais ou dados reais, envio a terceiros, criação de recursos Cloudflare nem alteração no Elo. Ausência de fila documentada de pedidos, combinação de menções com mídia/resposta e aplicação real de temporárias a grupos permanecem explícitas, sem inventar capacidade comprovada.
