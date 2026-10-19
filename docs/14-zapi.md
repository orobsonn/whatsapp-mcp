# Adaptador Z-API — contrato e limites

Verificação documental em 19/10/2026, sem instância ou credenciais deste projeto. O adaptador em `src/zapi.ts` usa somente `https://api.z-api.io` e o prefixo `/instances/{instanceId}/token/{token}`; ambos os segmentos são codificados. Cada chamada envia `Client-Token`, usa HTTPS, recusa redirecionamento e limita a resposta a 256 KiB. Prazo por requisição: 15 s. Nenhum erro devolve corpo remoto, URL ou segredo.

## Chamadas implementadas

| Método | Contrato oficial | Resultado do adaptador |
|---|---|---|
| `status()` | [GET status](https://developer.z-api.io/instance/status), [GET device](https://developer.z-api.io/instance/device) | `{connected:false}` se desconectado; se conectado, busca `device.phone` e retorna `{connected:true, phone}`. A aplicação deve comparar o número exato com `CONNECTED_PHONE` antes de qualquer efeito. `connected` sozinho não prova identidade. |
| `listContacts(page,pageSize)` | [GET contacts](https://developer.z-api.io/contacts/get-contacts) | `phone` exato e nomes documentados; exige página positiva e tamanho 1–100. |
| `listGroups(page,pageSize)` | [GET groups](https://developer.z-api.io/group/get-groups) | `phone` exato e nome; exige página positiva e tamanho 1–100. Nome igual não funde grupos. |
| `send({kind:'text'})` | [POST send-text](https://developer.z-api.io/message/send-text), [responder mensagem](https://developer.z-api.io/message/reply-message) | `phone`, `message` e `messageId` opcional para citação. |
| `send({kind:'image'})` | [POST send-image](https://developer.z-api.io/message/send-message-image) | `image` como `data:<mime>;base64,...`, `caption` e `messageId` opcionais. |
| `send({kind:'pdf'})` | [POST send-document/pdf](https://developer.z-api.io/message/send-message-document) | `document` Base64, `fileName`, `caption` e `messageId` opcionais. |
| `send({kind:'audio'})` | [POST send-audio](https://developer.z-api.io/message/send-message-audio) | `audio` Base64. O contrato lido não documenta `messageId` nem legenda para áudio; ambos são recusados. |

Mídia tem teto de 2 MiB e aceita apenas MIME explicitamente permitido no código. O transportador recebe bytes já validados pela camada de mídia; não comprova tipo real ou duração. PDF exige nome simples terminado em `.pdf`. O endereço de destino é preservado como recebido, inclusive LID e ID de grupo; nenhum nome vira endereço e nenhum LID é convertido em telefone. O adaptador só lê uma página por chamada; ausência em página não apaga registro local.

`send` devolve `messageId`, `zaapId` e `id` como campos distintos, sem inferir equivalência ou entrega. A [introdução do fornecedor](https://developer.z-api.io/quickstart/introduction) descreve fila e callbacks posteriores. A resposta HTTP é aceitação da chamada, não entrega ou leitura. Timeout, falha de rede, 3xx, 5xx ou resposta de sucesso inválida após POST produzem `ProviderUncertainError`; a ação persistida precisa ser conciliada, sem repetição automática. 4xx explícito produz erro sanitizado. O adaptador não persiste ação nem faz retry.

## Pendente de prova real

Uma instância própria ainda precisa demonstrar os formatos efetivos de retorno, LID, grupo, envio de cada MIME, citação, latência, timeout, callbacks e correlação dos três IDs. O ensaio deve conferir número do aparelho antes e depois de operações relevantes. Nenhuma chamada real foi feita nesta entrega.
