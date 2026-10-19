# Transporte e ações — evidência parcial

Adaptador Z-API: 9 testes workerd verdes de contratos/redirect/timeout/tamanho/esquema; `npm run check` exit0 no módulo. Não houve contato com instância real.

Ações: RED observado em 2 testes de envelope (digest vazio/validação ausente), GREEN2; mais 4 RED de comportamento D1 (sem aprovação, concorrência, timeout, expiração/epoch); GREEN6 `npm test -- tests/actions.test.ts` exit0.

A confirmação humana é uma fronteira HTTP autenticada separada; o catálogo MCP não inclui aprovação. Hash da ação inclui alvo interno, texto/citação, referência/hash do arquivo e legenda. Uma tentativa é reivindicada atomicamente antes de chamar o provedor. Crash ou timeout depois desse ponto fica incerto e nunca faz retry automático.
