# Destinatário individual sem histórico — #126

`resolver_destinatario` transforma um telefone internacional explícito em
`chatId` local, inclusive sem mensagens ou cadastro na agenda. Usa o mesmo
registro que `preparar_envio` já aceita para texto, imagem, PDF e áudio. Resolver
não envia, não cria mensagem, não grava contato no aparelho, não lê conversa no
WhatsApp e não cria pessoa/identidade/mandato na assistente.

Entrada estrita:

```json
{"phone":"+12025550123","alias":"Contato sintético"}
```

`phone` exige `+` e de 8 a 15 dígitos, primeiro dígito de 1 a 9. O backend remove
somente o `+` para o endereço de transporte. Não adiciona país, nono dígito,
ramal, sufixo de grupo/LID ou telefone inferido de nome. `alias` é opcional,
limitado a 128 caracteres e usado somente ao criar registro novo. O rótulo é dado
do dono, não prova de identidade nem autorização para executar ações.

O resultado inclui `chatId`, nome/tipo, captura observada e `created`.
`validated_format:true` significa apenas formato sintático aceito;
`registeredOnWhatsApp:"unknown"` mantém explícito que a conta não foi verificada.
Não há consulta de existência do destinatário nem promessa de entrega. O número
não precisa aparecer novamente no resultado, pois os próximos passos usam a
referência interna.

## Conexão, repetição e privacidade

O resolver verifica o aparelho conectado antes/depois das leituras. Em produção,
confere o Env já decifrado com o cipher atual de `connection_state` e pina epoch,
attempt, versão e cipher na mutação D1. Repete o guard após o await da mutação;
troca de conexão não transforma uma referência antiga em alvo da nova geração.
Os únicos endpoints externos usados são leituras de status/device da própria
instância, pelo transporte existente. Credenciais não integram argumentos ou
resultados MCP.

Unicidade por epoch/generation/endereço exato garante uma referência em repetição
ou concorrência; conflito com tipo group é recusado. Um ACK D1 perdido pode ser
recuperado repetindo o mesmo número, sem recadastrar nem sobrescrever a primeira
escolha de nome. Se a conexão mudar depois de uma transação válida, a referência
antiga pode permanecer no namespace anterior; o resolver recusa devolvê-la sob o
pin alterado e não apaga histórico para compensar esse caso.

Para chat existente, não há UPDATE: nome, captura, revisões, exceções,
`capture_since`, gaps e mensagens/tombstones permanecem iguais. Registro sem
`capture_settings` não é reparado silenciosamente. Captura desligada ou exclusão
local não são convertidas em uma política inventada de “não contatar”. Esta
fatia também não cria uma autorização de envio.

Um chat **novo** recebe exatamente a política global vigente pelo trigger de
criação já existente: mode `default`, incluindo padrão global desligado quando
configurado. O resolver não muda triggers nem preferência global. Um
`captureSince` inicial é o começo observável dessa política, sem recuperação do
passado e sem fabricação de mensagens anteriores.

## Fronteira MCP e evidências

O HTTP MCP exige o dono/epoch autenticados e origem permitida antes do callback.
A ferramenta tem `readOnlyHint:false` porque pode criar referência local, e
`idempotentHint:true` pelo contrato de unicidade. Schema estrito rejeita destino
group/LID, namespace, flags de captura, URLs e campos administrativos. Mensagens
recebidas, anexos e páginas encontradas não substituem autorização do dono.

| Fronteira | Observação desta implementação |
| --- | --- |
| D1/workerd sintético | Referência nova/agenda sem mensagens; concorrência; ACK perdido; captura e tombstones preservados; conflito de tipo; dispositivo/generation/conexão alterados; preparo de texto e mídias existentes. |
| HTTP MCP com SDK oficial | Lista autenticada, annotations, chamada real do handler, schema estrito e recusa de principal/origem inválidos; transporte externo substituído por mock somente GET status/device. |
| ChatGPT/Claude em conversa real | Pendente: atualizar catálogo/conexão e executar a ferramenta nessa fronteira. Ferramenta listada em HTTP não prova chamada ou apresentação no cliente. |
| WhatsApp/provedor real | Nenhum envio ou cadastro no aparelho realizado; número/conta e entrega não homologados por estes testes. |

RED observado com resolver ausente e ferramenta não registrada; GREEN dirigido
de destinatários, diretório e captura. Sem nova dependência, migração, segredo,
modelo pago, deploy ou mudança de versão nesta fatia. CI integrada, revisão e
release minor continuam gates próprios antes de fechar #126.

A jornada atual é individual. O reuso do mesmo destinatário para a assistente
iniciar conversa em sombra pertence a #128; não foi implementado aqui. Não há
produto específico de fornecedor, cotação ou broadcast. O Worker sombra continua sem executor ou credenciais de
envio e Calendar permanece sem escrita.
