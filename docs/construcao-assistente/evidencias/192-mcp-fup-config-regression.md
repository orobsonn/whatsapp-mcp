# Consultas e cadastro de FUP: configuração perdida no gateway

Data: 31/10/2026. Pedido: corrigir `invalid_input` em consultas e cadastro de FUP pelo Zap.

## Causa comprovada

O Zap conectado retornou `invalid_input` para `projects` e `follow_ups` válidos. A versão do gateway publicada na madrugada de 31/10 não continha as quatro variáveis não secretas da assistente presentes na versão anterior: instalação, geração, descoberta de memória e tamanho do lote da ponte. Os segredos e os service bindings permaneciam presentes.

`src/mcp.ts` validava a afinidade obtida do ambiente com `parse`. A ausência de instalação/geração lançava `ZodError`, convertido em erro de entrada do cliente antes de qualquer RPC. O schema do pedido não era a causa. A configuração de produção em `wrangler.jsonc` omitia essas variáveis; publicação normal substitui variáveis remotas pelas declaradas.

Instalação e geração anteriores foram conferidas contra o Worker da assistente efetivamente publicado, sem gerar identidade nova. O serviço de conhecimento continuava configurado. Nenhuma credencial foi restaurada, rotacionada ou versionada.

## Correção e revisão adversarial

- Declarar as quatro variáveis na configuração do gateway para sobreviver a futuras publicações.
- Validar a afinidade interna com `safeParse` e retornar `assistant_unconfigured` se inválida. Erros de payload continuam com sua validação original.
- Conferir o arquivo real de publicação no conjunto de testes de instalação já executado pelo CI.
- Revisão adversarial exigiu conservar namespace, autonomia e orçamento; conferir persistência e idempotência no handler real; não confundir sucesso de leitura com cadastro ou envio.

## Evidência de teste controlado

As regressões foram observadas falhando antes da correção: ausência das duas variáveis era apresentada como `invalid_input`, e o arquivo de publicação não declarava a afinidade. Após a correção, consultas `projects`, `follow_ups` e `follow_up`, cadastro para duas datas civis em America/Fortaleza, releitura por ID e repetição idempotente passam pela entrada HTTP MCP e `OwnerAssistant` real com D1 sintético.

Um teste de timeout do operador teve falha transitória por prazo curto sob carga; o conjunto completo de instalação passou na repetição, sem alterar esse teste nem o operador.

## Produção

Gateway v0.52.2 inicialmente publicado em 100% na versão `dc074934-464b-473c-a948-80fb4bb88eff`. A versão sem tráfego foi inspecionada antes da promoção: somente as quatro variáveis esperadas diferiam; todos os segredos e service bindings foram preservados. A descrição final do contrato de agendamento está na versão `89f204bb-3bdd-4484-abfb-a2e4eff6910e`, também em 100%, sem diferença de bindings/runtime. URLs de preview continuam desabilitadas. `/health` confirmou a versão, conexão configurada e manutenção desligada.

Pelo Zap conectado desta conversa, `projects`, `follow_ups`, `policies`, `source` e `follow_up` voltaram a responder. A listagem completa comprovou ausência dos dois acompanhamentos pedidos. Ambos foram cadastrados, relidos por ID com data/fuso/estado `scheduled`, e repetidos com os mesmos operationIds: mesmos recibos e versão 1, sem duplicidade na listagem final. As duas políticas privadas ausentes foram explicitadas com revisão esperada zero e sem remover exclusões; privados já tinham padrão `attend`. Nenhum envio foi executado, nenhuma identidade foi fundida por nome e nenhum dado privado desses registros foi versionado.

## Segunda causa: inscrição no agendador

A inspeção encontrou outra falha: o Worker ativo usa o caminho nativo, que admite apenas tarefas explicitamente inscritas em `assistant_native_task_bindings`. `fup.put` pelo MCP gravava o modelo legado sem essa inscrição. Apenas corrigir a consulta não bastava para executar o prazo.

O plano/revisão adversarial está em [193](193-mcp-fup-native-plan.md). `OwnerAssistant.control`, capability exclusiva do gateway autenticado, agora deriva a inscrição a partir de fonte atual, vínculo Telegram, ativação e sessão privada existente. Todos os guards, incluindo retenção, entram na mesma transação do FUP e recibo. O conteúdo da fonte não concede autoridade; não foram flexibilizados os comandos do runtime. Recuperação usa a mesma normalização/hash do ledger e funciona mesmo após retirada do suporte ou pausa. A configuração de ativação usa o JSON original já protegido pelo guard, sem hash duplicado dependente de ordem de campos.

Assistente publicada em 100% na versão `c4acd4a3-2e26-4dc1-be38-ba635d18cffe`. Upload somente dos módulos compilados; todos os bindings, segredos herdados, namespaces, runtime, compatibilidade e imagem Container foram comparados com a versão ativa antes de promover. Nenhuma migração ou operação sobre aplicações Containers foi feita.

Os dois acompanhamentos existentes foram atualizados por versão esperada, preservando seus IDs e datas. Recibo e releitura pelo Zap confirmaram `version=2`, `obligationState=scheduled` e `native=enrolled`. Repetição das mesmas operações retornou os mesmos recibos; a listagem completa mostrou um registro atual para cada acompanhamento. Nenhum dado privado foi versionado.

O agendamento produz retorno privado ao dono no Telegram, sem autorização de WhatsApp aos interlocutores. Não houve envio imediato, execução de backlog nem promessa de entrega futura já observada. O percurso por data foi comprovado no runtime com dados sintéticos; a entrega dos dois retornos reais só poderá ser observada nos respectivos prazos.

Validação local final: 2.305 testes gerais e 77 do runtime passaram no código da inscrição; 102 testes direcionados cobriram MCP/FUP/tarefas nativas. A etapa anterior passou também em 13 de OAuth e 40 de instalação; TypeScript, verificações de conectores, ambos os builds e audit sem vulnerabilidades passaram. Revisão adversarial final sem bloqueadores.
