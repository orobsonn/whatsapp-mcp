# #55 — admissão de execução na integração #53/#54

Teste controlado local, dados sintéticos, 26/10/2026. Base integrada `676b16a`.
Não é homologação de Cloudflare, transporte privado, modelos reais ou piloto.

## Falhas reproduzidas

Cinco RED dirigidos em 32,91s: o broker e OCR ainda chamavam seus adapters quando
um hold de restore ou a troca de geração eram gravados depois da reserva de
orçamento e antes da admissão do recibo; o scheduler iniciava trabalho sob hold
e terminava como operação incerta. Ambos os adapters eram sintéticos, sem rede.

## Correção

- Guard SQL de execução separado de ACL: ausência de hold/quiescência e geração
  ativa compatível, repetido na mutação final dos recibos de modelo e OCR.
- Última conferência antes de entregar o corpo ao adapter. Não bloqueia updates
  de settlement nem apaga ou libera reservas anteriores. Recibos de modelo
  completos deixam de devolver corpos enquanto execução estiver bloqueada.
- Scheduler e callbacks usam a mesma factory `runtimeHost`, preservando clock,
  modelo e propósito. Um hold posterior a `prepare` impede dispatch nativo.
  Efeitos da rotina usam também o guard SQL dentro da admissão transacional.
- Core repete a prova de runtime nas fronteiras de preflight, reconstrução,
  checkpoint, autorização e broker. Predicados `isCurrent` são conferidos antes
  e depois dos awaits, preservando o deadline global do preflight #53.
- Nenhum guard global em `SourceAccess` ou `receiveCapture`: reparo do dono,
  política fresca e metadata de catchup continuam possíveis durante o hold.
  Nenhuma migração foi alterada; a integração requer o schema #55/M25.

## Validação

Comando inicial dos cinco RED: `vitest run` nos arquivos model-broker, media e
routines, filtrado por `restore .*after .*reservation|restore hold stops`.
A primeira passagem após a correção teve três GREEN e duas recusas seguras
`broker_denied`: a expectativa dos dois testes foi ajustada ao contrato já
existente de recusa antes do latch, sem mudar essa regra do broker.

- 11/11 dirigidos GREEN em 36,14s: holds após reserva, após o latch, settlement
  tardio, parada do scheduler/Core e deadlines de origem/preflight.
- 23/23 dirigidos finais GREEN em 65,11s, quatro arquivos filtrados: além desses
  casos, hold após preparação do episódio e durante verificação física do Core,
  callback semântico, pipeline até journal, replay exato e OCR positivo.
- `npm run check` e `git diff --check` aprovados.

Seleção final: arquivos `assistant-model-broker`, `assistant-media`,
`assistant-routines`, `assistant-runtime-search`; filtro:
`restore |runs the concrete|verifies a clean appended|physical exclusion after|reserves before inference|late OCR answer|deduplicates different job|replays complete exact receipts|reserves the exact request|runtime resolution|host configuration|elapsed preflight budget|late reader RPC`.

Revisão Root aprovou a direção dos guards finais SQL e da factory compartilhada
antes do commit. Sem nova suíte completa local; CI integrada é gate separado.
Custos pagos desta alteração: US$0. Nenhum deploy, chave real, chamada Cloudflare,
modelo real, envio WhatsApp ou escrita Calendar. Escala máxima e piloto real
permanecem sem homologação.
