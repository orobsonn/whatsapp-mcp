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

Publicação e consultas reais devem ser registradas separadamente. Cadastro de FUP em modo sombra não comprova execução futura, envio de WhatsApp ou inscrição no agendador nativo. Não ativar backlog legado para comprovar a correção.
