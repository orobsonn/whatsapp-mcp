# #56 — Worker integrado instalado, ainda inativo

26/10/2026. Código integrado `2055d047eb4002d9eda6256756b5b31a4077ffd2`, [CI40383981628 aprovada](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40383981628): **1169 gerais,62 nativos,4 OAuth Node,9 quota Node e29 instalação/operadores Node**, tipos, ambos builds e audit. Inclui as correções finais de ACL restaurada e quota128, com revisão adversarial independente e contraprovas D1 na composição. Isso não é homologação de latência, canais ou piloto.

O D1 próprio recebeu também `0025_restore.sql`, após confirmar CI/HEAD, hashes das25 migrações e os24 nomes anteriores. CLI/API confirmaram os25 nomes aplicados; hash da0025 `bace54d3b85e8f02b3f6c4d4b157148ec8e308f826e98c57f1af0a0f5d2e10ee`. Nenhum orçamento foi configurado ou reiniciado por essa migração.

## Publicação e conferência

Build oficial Flue do commit exato, com configuração privada validada. Módulos:

| Módulo | Bytes | SHA-256 |
| --- | ---: | --- |
| index.js | 3.726.021 | 0cc8d837039a9e3905094d55ba66535486684ec62500967698bf839e3f12a306 |
| assets/mimetext.node.es-FB4pisAJ.js | 230.920 | e2f6e74738ec2e88685901d19f48013e5952fab87bb7d43e3efdb14f5ca940ef |
| assets/rolldown-runtime-oLLnCvco.js | 1.806 | bd162d053a2002dbfcd9a76e8e10228715c3b056862d0d385090f23d9985efad |

Primeiro, a ausência do novo nome foi confirmada e um stub sem bindings respondeu somente403. `workers.dev`/previews foram desabilitados e conferidos antes de substituir o stub. O upload completo ocorreu **uma vez**, com journal fsync anterior e ACK registrado. A leitura posterior confirmou todos os módulos acima, bindings/vars, cinco namespaces novos e distintos do laboratório, imagem imutável própria e migration tag `assistant-shadow-host-v2`.

Worker `personal-assistant-shadow`: versão inicial completa `9f2625ae-149e-41e2-b598-eab111c95bb7`. Cinco classes: `FlueOwnerRuntimeAgent`, `FlueInterlocutorRuntimeAgent`, `CogneeContainer`, `CalendarOAuth`, `RetentionAuthority`. Exports incluem `OwnerAssistant` e `CogneeBroker`. Configuração inicial:21 bindings, zero secrets, `ROUTINES_ENABLED=off`, `ROUTINES_PAUSED=true`, mídia e resumos Telegram desabilitados, cron vazio e acesso `workers.dev`/previews desabilitado.

Um preflight anterior parou **antes de qualquer upload completo** porque o parser Wrangler contém também o sourcemap `index.js.map`. Fixado o baseline fechado dos dois módulos, conservando versão/settings e hash do código; map observado SHA `4444b05eebb5da6e7a8555686cacf7186f2ec1d79db6ef26a70b134388c9f7dc`. Depois do único upload, um guard estrito recusou o default `environment=production` acrescentado pela API aos três service bindings. O verificador foi corrigido somente para esse default conhecido; a reconciliação foi apenas GET, sem segundo upload. Snapshots dos helpers e registros das duas paradas foram preservados;21 e23 casos Node, respectivamente, e revisão independente sustentaram os ajustes.

## Preparação posterior e limites

A aplicação `personal-assistant-shadow-cognee` foi conferida pelo namespace próprio `4bd22e310234489ca814d7488c8d6b2d`, política `durable_object` e logs desabilitados. Nenhuma chamada de start do Container ou modelo foi realizada nesta etapa.

Um PUT único posterior de `BRIDGE_SECRET` teve ACK e observação de código/settings preservados, versão `629e0e0f-81f8-430e-bf5d-7f882216a2f2`. Não habilita o transporte de captura: o Archive continua sem `ASSISTANT_INGRESS` nem chave de envio. É apenas a preparação da leitura nominal. O primeiro operador de afinidade retornou403 local antes do RPC: Node fetch acrescenta `Sec-Fetch-Mode:cors` e o handler recusa esse header de navegador. Contraprova HTTP local confirmou; correção dos dois CLIs para Node HTTP está separada do backend instalado. Não se rebaixou a proteção de navegador nem se assumiu sucesso desse handshake.

Custos: nenhuma chamada paga de modelo adicional; ledger histórico permanece US$0,049053 comprometidos, incluindo US$0,040000 incertos. Custos operacionais Cloudflare não foram reconciliados com a fatura. Nenhum envio WhatsApp, escrita Calendar ou alteração Elo/Access.

Recibos e scripts em `local/assistant-build/personal-shadow-stage/` permanecem privados/ignorados. Faltam afinidade real, bootstrap da autoridade, credenciais/configuração financeira, cron e demonstração do fluxo no MCP/canais. A issue e o piloto continuam sem conclusão.
