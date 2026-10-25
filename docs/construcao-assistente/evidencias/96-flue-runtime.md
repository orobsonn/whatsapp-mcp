# #96 — foundation Flue

Foundation local e sintética. Não conclui episódios #44 nem o piloto sombra.

## Fronteira entregue

- Build oficial `flue()` → plugin Cloudflare → bundle com dois DOs SQLite:
  `FlueOwnerRuntimeAgent` e `FlueInterlocutorRuntimeAgent`, identidades fixadas.
- Endereço derivado de instalação, geração, perfil e job fornecidos pelo host.
  O helper constrói um endereço; não autentica pedidos nem concede autoridade.
- Aplicação preserva `/health`, receptor autenticado de metadados da captura,
  `CogneeContainer` e `CogneeBroker`. Demais rotas continuam `shadow_only`.
- Nenhum router Flue, ferramenta operacional, sandbox, skill ou subagente é
  registrado pela aplicação. Flue pode montar sua ferramenta reservada `task`;
  não existe delegado declarado. #44 ainda implementará o bloqueio explícito.
- `assistant-host/shadow` fica sem provider na aplicação de produção. Somente a
  aplicação descartável dos testes registra o provider sintético Pi. Ela usa
  raiz/build/configuração/estado próprios e não substitui o redirect de deploy
  da aplicação de produção.

## Versões e segurança de dependências

Diretas fixadas no lock: Flue runtime/vite 2.3.0, Pi AI 1.1.0, Vite 8.3.5,
plugin Cloudflare 1.64.0 e Miniflare 5.20261019.0-beta. Node mínimo 22.19.0.
Overrides fixam Agents 0.28.1, MCP SDK 1.32.1, client/server 2.3.1, Zod 4.6.7
e Undici 7.30.1; Valibot direto 1.5.0. A resolução original de Flue trazia
dependências com advisories, inclusive componentes empacotados pelo build.
Não foi usado `--force` ou `--legacy-peer-deps`. A compatibilidade dos overrides
foi verificada no bundle e runtime reais; não é promessa sobre APIs não usadas.

## Verificação reproduzível

```sh
npm ci
npm run check
npm test
npm run test:assistant-runtime
npm run build
npm run build:assistant
npm audit
```

Resultado local em 25/10/2026: instalação limpa pelo lock, check, build do arquivo
e build oficial da assistente passaram; suíte existente 505/505 e dedicada 7/7.
Auditoria completa: zero vulnerabilidades. A suíte existente emitiu avisos de
sourcemap/punycode e um erro interno workerd sem falhar os testes; isso não é
evidência de execução em produção. A suíte dedicada final passou sem esse erro.

RED observado: o build anterior não produzia runtimes Flue; o helper ausente
recusava dispatch; a primeira fixture substituía o redirect de produção.
Contraprovas foram mantidas. O bundle emitido é carregado diretamente, com
todos os seus chunks, sem rebundle ou bootstrap interno do Flue.

Teste dedicado em workerd real cobre `init`/`dispatch`/`read`, leitura do mesmo
recibo após encerrar/reiniciar o processo, continuação do histórico, isolamento
dos perfis e namespaces, configuração inválida sem alocação de instância,
exports Cognee recusando acesso sem configuração, rotas públicas negadas e
captura autenticada chegando ao D1 com estado `pending`. Captura recebida não
é fonte canônica aplicada. Qualquer fetch externo faz a prova falhar.

O estado persistente provado aqui é o stream operacional do Flue. Fatos,
políticas, missões e autorização continuam fora do transcript. #44 implementará
fences de fontes/origem/conversa/trabalho, budget/recibos de cada chamada,
incerteza persistente, retorno bufferizado, propostas tipadas e rebuild a
partir de checkpoint canônico. Nenhuma chave real, API paga ou deploy foi usado.

Referências oficiais: [Cloudflare target](https://flueframework.com/docs/guide/cloudflare-target/),
[Agent API](https://flueframework.com/docs/reference/agent-api/),
[Provider API](https://flueframework.com/docs/reference/provider-api/).

A CI audita também dependências de desenvolvimento: o build oficial incorpora partes do runtime a partir delas. Não basta auditar somente o grupo production do package.json.

Na integração, a nova execução encontrou um literal de URL inválido na fixture, introduzido após a execução anterior. Corrigido e repetido no arquivo final: 7/7 em workerd, zero fetch externo e auditoria completa sem vulnerabilidades. A CI verifica o commit integrado exato.
