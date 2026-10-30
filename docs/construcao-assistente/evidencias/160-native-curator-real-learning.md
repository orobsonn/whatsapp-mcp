# Curadoria nativa: aprendizado real compartilhado com o MCP

Observação em 29/10/2026. Ensaio pago e isolado; a rotina diária permanece desligada.

## Fronteira efetivamente exercitada

1. Pelo MCP existente `assistente_memoria`, registrou-se um relato das preferências já informadas pelo dono. Relato de contexto não configura política, ativa rotina ou concede autorização de envio.
2. O host admitiu uma única amostra da sequência própria de fontes `(4100, 4101]`. Nenhuma varredura histórica foi ativada; o cursor diário não foi avançado por essa amostra.
3. O Flue executou o perfil privado de curadoria com modelo real. A operação `remember`, atribuída ao cliente `curator`, terminou `complete/ready`, com evidência exata do relato.
4. Uma consulta independente pelo MCP encontrou cinco relações `agent_derived/reported`: dono do projeto, horário desejado, preferência de resumos, referência de orçamento e ausência de autorização para ativação/contratação. A seleção das relações veio do agente, não de regras de extração ou relações pré-gravadas pelo teste.

## Resultado e limite da prova

O aprendizado compartilhado passou: agente → Cognee → MCP. A passagem terminou com recibo parcial: o item continuou `presented`, sem confirmação de `curator_acknowledge`, embora a escrita já estivesse pronta. O aviso privado foi aceito pelo Telegram; isso não comprova leitura pelo dono. Essa pendência foi investigada e recuperada pelo protocolo descrito abaixo; nenhum estado foi alterado para simular aprendizado.

Na primeira observação, seis chamadas haviam registrado 6.811 microUSD. Após a conclusão da última resposta interna, o total final foi **sete chamadas, 8.313 microUSD (US$0,008313)**. Trata-se da contabilização local pela tabela de preços registrada no recibo, não de uma fatura reconciliada. Uma fonte curta não dimensiona o acervo diário inteiro.

## Implantação e concorrência

- Migração própria aditiva `0048_curator_sample_windows.sql`, sem migração no Source.
- Capacidade publicada inicialmente desligada em `716d13b0-d600-4e3e-8abe-e276b81136b8`.
- Ensaio avulso em `94d20d6f-bfa3-4b53-88a6-9c8615457b1e`, com `NATIVE_CURATOR_SCHEDULE_ENABLED=false`.
- O primeiro vínculo de execução à identidade Flue é imutável e adquirido antes de registrar/despachar. A corrida de dois admissores, com retirada entre eles, foi reproduzida e corrigida em `300aed1`/`9ee0ecc`; 54 testes dirigidos e TypeScript passaram. Revisão adversarial não encontrou outro bloqueio nesse delta.
- Respostas autônomas continuam desligadas. Não houve envio WhatsApp, escrita de agenda ou contratação neste ensaio.

Recibos privados preservados fora do Git; nenhum token, mensagem de terceiro ou dump do grafo acompanha esta evidência.

## Recuperação real do recibo — concluída

A projeção oficial do Durable Object demonstrou a causa: o `knowledge_remember` retornou o ID original com 90 caracteres e a chamada seguinte de `curator_acknowledge` omitiu três caracteres. O guard recusou corretamente o identificador inexistente; não faltava memória no grafo.

Correções `5baa2c4`, `6cc4e52`, `4de4026`, `b68a807` e `ebca434`: o host conserva o ID original da operação, captura a run/task antes da chamada e reflete somente recibos `curator/remember/complete/ready` sobre SourceRefs exatas já apresentadas ou em indexing. O mesmo `acknowledge` mantém as verificações finais de fonte e autoridade. A recuperação é contabilidade da memória já gravada, sem alegar exclusividade da operação à passagem.

A versão própria `358726b0-9cfa-4eee-af94-015e47ece329` publicou apenas esse delta revisado, construído de snapshot Git isolado, com TypeScript e build aprovados. Os 47 casos dirigidos da curadoria/runtime passaram; o código de tarefas em desenvolvimento não entrou nesse bundle. Nenhuma configuração ou credencial existente foi substituída.

O readback real posterior mostrou o item `learned`, vinculado ao ID original. A sessão permaneceu com **sete chamadas e 8.313 microUSD**, e o aviso permaneceu com uma única tentativa aceita. O estado/cursor diário continuou inexistente: a amostra não habilitou recorrência. O primeiro resumo parcial não foi reenviado nem sobrescrito para esconder o ocorrido.
