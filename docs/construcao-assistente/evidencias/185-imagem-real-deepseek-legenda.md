# Imagem real, interpretação DeepSeek e legenda

## Incidente observado em30/10/2026

Uma entrada real tinha fotografia pronta no Source e legenda original. A interpretação estava indisponível porque a flag de mídia estava desligada. Além disso, a chegada posterior dos bytes mudou o snapshot da mensagem; a projeção anterior não era reconciliada e sua admissão nativa ficou indisponível. O agente recebeu o arquivo sem a pergunta que o acompanhava e pediu ajuda ao dono.

O problema não demonstrava falha do JPEG nem falta de capacidade visual do modelo. A seleção de provedor da conversa foi estendida à interpretação já existente. DeepSeek usa uma imagem inline, endpoint fixo, JSON de observações e recibo próprio, sem fallback para outro provedor.

## Prova real publicada

O Worker Own recebeu uma consulta autorizada do dono pelo Telegram. O perfil nativo escolheu `media_read`; a interpretação identificou o aviso visível de falha de atualização. Em seguida, `respond_owner` publicou a explicação no Telegram. O SDK concluiu a passagem sem erro, tentativa1; o recibo de mídia terminou `complete` e conservou426microUSD de custo calculado. As três chamadas do agente terminaram com160.411microUSD adicionais, calculados conservadoramente pelo uso informado. Não são valores reconciliados de fatura.

Versão publicada nessa prova: `a04082a3-f581-4c49-92be-2a87ed9a4eba`, código `9f5d4b0`. O input do ensaio não continha a transcrição esperada. A resposta foi conferida independentemente na interface Telegram. IDs, mensagem original, foto, hashes, contagens pessoais e comprovantes completos ficam somente no diretório privado.

Nenhuma proposta foi aprovada ou enviada ao WhatsApp no ensaio. A conversa original já tinha resposta manual; não foi reaberta para testar o recurso. Reconhecer um aviso na tela também não prova a causa do defeito do aplicativo.

## Correção complementar da legenda

A projeção passa a reconciliar o evento real já recebido quando o anexo fica pronto, sem criar entrada, autor ou sequência de captura. A ferramenta aceita referência da mensagem com legenda ou do arquivo, mas usa sempre o mesmo arquivo como parent da interpretação paga. O resultado distingue legenda original, referência própria e observações visuais derivadas. Ausência de legenda é explícita, sem promover JSON de metadados a texto recebido.

O vínculo usa conversa, mensagem, versão da mensagem, mídia, versão da mídia e hash. Ambos os originais são expostos às verificações de acesso e retenção. Uma recuperação interrompida continua exigindo atividade atual; resposta manual ou entrada posterior comprovada encerra a recuperação como `superseded`, sem inferência ou reenvio.

A correção complementar foi publicada em100% do Own na versão `9de1f75d-6189-4bc1-8d37-600947669576`, código `e398d25`, mantendo configuração e autonomia desativada. A leitura posterior da projeção antiga ainda estava pendente: o agendador estava percorrendo entradas indisponíveis anteriores. A publicação não foi declarada como prova de recuperação desse caso. Não se alterou posição da fila, recibo de captura ou tarefa encerrada para forçar o resultado.

## Verificação local e limites

A regressão de cinco arquivos passou158casos e expôs um erro apenas no SQL da nova asserção de teste; a asserção corrigida passou isoladamente. A revisão adversarial encontrou dois problemas adicionais: perda da exigência de atividade após falha transitória e metadados anunciados como legenda quando ela não existia. Ambos foram corrigidos; os oito casos dirigidos passaram, incluindo legenda ausente, reaproveitamento com apenas uma chamada ao modelo, retirada do arquivo, recuperação pelo evento real da mídia e resposta manual posterior. Typecheck e build Own passaram.

Isso comprova os caminhos descritos, não todas as combinações multimodais. PDF com DeepSeek permanece pendência explícita; não houve teste de nova resposta à pessoa que enviou a foto nem envio de WhatsApp por este ensaio.
