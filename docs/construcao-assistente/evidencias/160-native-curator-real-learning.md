# Curadoria nativa: aprendizado real compartilhado com o MCP

Observação em 29/10/2026. Ensaio pago e isolado; a rotina diária permanece desligada.

## Fronteira efetivamente exercitada

1. Pelo MCP existente `assistente_memoria`, registrou-se um relato das preferências já informadas pelo dono. Relato de contexto não configura política, ativa rotina ou concede autorização de envio.
2. O host admitiu uma única amostra da sequência própria de fontes `(4100, 4101]`. Nenhuma varredura histórica foi ativada; o cursor diário não foi avançado por essa amostra.
3. O Flue executou o perfil privado de curadoria com modelo real. A operação `remember`, atribuída ao cliente `curator`, terminou `complete/ready`, com evidência exata do relato.
4. Uma consulta independente pelo MCP encontrou cinco relações `agent_derived/reported`: dono do projeto, horário desejado, preferência de resumos, referência de orçamento e ausência de autorização para ativação/contratação. A seleção das relações veio do agente, não de regras de extração ou relações pré-gravadas pelo teste.

## Resultado e limite da prova

O aprendizado compartilhado passou: agente → Cognee → MCP. A passagem terminou com recibo parcial: o item continuou `presented`, sem confirmação de `curator_acknowledge`, embora a escrita já estivesse pronta. O aviso privado foi aceito pelo Telegram; isso não comprova leitura pelo dono. Essa pendência está sob investigação e não foi corrigida alterando estados manualmente.

Seis chamadas reais do modelo na sessão de curadoria registraram **6.811 microUSD (US$0,006811)**. Trata-se da contabilização local pela tabela de preços registrada no recibo, não de uma fatura reconciliada. Uma fonte curta não dimensiona o acervo diário inteiro.

## Implantação e concorrência

- Migração própria aditiva `0048_curator_sample_windows.sql`, sem migração no Source.
- Capacidade publicada inicialmente desligada em `716d13b0-d600-4e3e-8abe-e276b81136b8`.
- Ensaio avulso em `94d20d6f-bfa3-4b53-88a6-9c8615457b1e`, com `NATIVE_CURATOR_SCHEDULE_ENABLED=false`.
- O primeiro vínculo de execução à identidade Flue é imutável e adquirido antes de registrar/despachar. A corrida de dois admissores, com retirada entre eles, foi reproduzida e corrigida em `300aed1`/`9ee0ecc`; 54 testes dirigidos e TypeScript passaram. Revisão adversarial não encontrou outro bloqueio nesse delta.
- Respostas autônomas continuam desligadas. Não houve envio WhatsApp, escrita de agenda ou contratação neste ensaio.

Recibos privados preservados fora do Git; nenhum token, mensagem de terceiro ou dump do grafo acompanha esta evidência.
