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

## Produção e limite confirmado

Gateway v0.52.2 publicado em 100% na versão `dc074934-464b-473c-a948-80fb4bb88eff`. A versão sem tráfego foi inspecionada antes da promoção: somente as quatro variáveis esperadas diferiam; todos os segredos e service bindings foram preservados. URLs de preview continuam desabilitadas. `/health` confirmou a versão, conexão configurada e manutenção desligada.

Pelo Zap conectado desta conversa, `projects`, `follow_ups`, `policies`, `source` e `follow_up` voltaram a responder. A listagem completa comprovou ausência dos dois acompanhamentos pedidos. Ambos foram cadastrados, relidos por ID com data/fuso/estado `scheduled`, e repetidos com os mesmos operationIds: mesmos recibos e versão 1, sem duplicidade na listagem final. As duas políticas privadas ausentes foram explicitadas com revisão esperada zero e sem remover exclusões; privados já tinham padrão `attend`. Nenhum envio foi executado, nenhuma identidade foi fundida por nome e nenhum dado privado desses registros foi versionado.

**Limite:** cadastro em modo sombra não comprova execução futura nem inscrição no agendador nativo. O Worker atual usa o caminho nativo quando habilitado; esse caminho admite apenas tarefas explicitamente inscritas em `assistant_native_task_bindings`. `fup.put` pelo MCP grava o modelo legado sem essa inscrição. Não foi ativado backlog legado nem alterada autonomia para contornar isso. Os dois registros estão persistidos, mas lembrete/avaliação automática pelo runtime nativo continua pendente.

Validação local final: 2.293 testes gerais, 13 de OAuth, 77 do runtime e 40 de instalação passaram; TypeScript, verificações de conectores, ambos os builds e audit sem vulnerabilidades também passaram.
