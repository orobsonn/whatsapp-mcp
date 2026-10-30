# Recebimento WhatsApp: ACK durável antes da admissão nativa

Data: 29/10/2026. Correção `2bcfdd3`, publicada no Worker próprio como versão `89f53e58-83de-4b89-bcec-2721a48530bb`.

## Falha observada na infraestrutura

O Source limita a espera pelo recibo da ponte a dois segundos. A nova composição persistia o metadado e, antes de responder, aguardava leituras e admissão da conversa nativa. O cancelamento pelo Source interrompia essa execução; uma entrada permanecia `pending`, embora seu original já estivesse materializado. O cursor confirmado do Source não avançava e retinha entradas posteriores.

O tail real mostrou solicitações `/internal/capture` canceladas, próximas ao prazo da ponte. Esse resultado não foi considerado silêncio deliberado da IA: o evento ainda não havia chegado a ela.

## Correção e contraprova

O callback é chamado somente depois da autenticação e do commit do recibo. Ele registra imediatamente o processamento em `ctx.waitUntil`, sem aguardar a admissão e sem herdar o sinal de cancelamento do Source. O ACK continua significando apenas `received`; a fila persistida e o cron continuam responsáveis por retomar trabalho interrompido. `waitUntil` não é anunciado como fila durável ou execução ilimitada. [Ciclo de vida do contexto Cloudflare](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)

O teste de fronteira manteve a admissão propositalmente pendente: antes, não havia ACK; depois, o ACK foi devolvido com o recibo já persistido e uma continuação registrada. Autenticação inválida não agenda trabalho. Os cinco testes dirigidos da ponte passaram, assim como tipos e build do assistente; os chamadores de teste passaram a fornecer o contexto Worker.

## Readback real

- A entrada anteriormente retida passou a `admitted`.
- O cursor confirmado do Source avançou e novos metadados chegaram ao Worker próprio.
- As solicitações observadas passaram de `canceled` a `ok`, inclusive quando o processamento posterior levou mais de dois segundos.
- Houve novas chamadas reais do modelo nas conversas nativas, conservando orçamento e recibos.

Não foram alterados o prazo da ponte, as permissões, a política de grupos ou a aprovação obrigatória do WhatsApp. A fila acumulada continua sendo recuperada. Esse resultado comprova a correção da fronteira de recebimento; não substitui o aceite de uma sugestão útil, do clique humano e da consequência do envio no provedor.

Recibos de implantação, eventos do tail e observações de cursores/estados estão guardados no diretório privado do operador. Nenhum corpo de mensagem, contato ou segredo foi publicado.

## Recuperação do transporte acumulado

O Source passou a aceitar tamanho configurável de página de metadados (padrão 10, intervalo 1–100), sem alterar autenticação, confirmação por item ou autoridade de ação. A configuração temporária 100 foi publicada na versão `36064aae-03a9-43bd-b34b-a5587028717f`. O teste dirigido preservou o 101º registro para a próxima página; nove casos do bridge, TypeScript e build passaram.

Antes da publicação, a próxima página foi dimensionada por conversas distintas e reservas disponíveis; o teto diário e o teto global de testes não foram aumentados. Depois, Source confirmou a sequência 5647 enquanto a cabeça observada era 5648, e o inbox próprio confirmou 5647. Isso comprova recuperação do transporte, não processamento sem lacunas de todas as fontes.

Seis propostas surgidas durante a recuperação não chegaram ao Telegram: a consulta cruzada mostrou que todas já tinham resposta posterior do dono ou entrada mais recente. Zero ações Source foram preparadas para esses gatilhos vencidos. Não há, nesses casos, prova de defeito no RPC ou no Telegram; o bloqueio de atualidade foi correto.
