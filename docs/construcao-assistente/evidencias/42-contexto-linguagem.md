# #42 — Contexto integral e linguagem vinculada a recibos

O seletor pode destacar/ordenar trechos, mas não remove originais autorizados. Cada citação precisa corresponder exatamente ao texto e aos offsets UTF-16; falha conserva os originais se couberem. Se o pacote exceder o limite, retorna `waiting_context`, sem truncar negações ou dependências. Fontes/origem são revalidadas antes e depois, inclusive no fallback e antes do transporte pago.

## Prova nova com modelo real

Quatro casos sintéticos novos foram executados no Worker isolado com GPT-6 Luna: negação/condição, homônimos, correção de prazo e instrução maliciosa citada. [Resultados](42-contexto-cloud.json).

- 4/4 mantiveram os originais necessários, incluindo negações, correções e vínculos.
- 3/4 produziram focos válidos e completos conforme o corpus. No outro caso o modelo apontou um offset que não correspondia à citação; o host recusou o foco e conservou o pacote original. Não anunciamos 100% de precisão do modelo.
- 4 chamadas reais; encargo conservador de 1083 microUSD (US$0,001083), não fatura. Repetição: **zero chamadas novas e zero custo adicional**, com revalidação e os mesmos resultados.

A medição mostra por que o texto original permanece no pacote: uma seleção plausível não basta para eliminar evidência. O foco continua opcional; não existe vantagem de custo demonstrada para chamar o seletor em todo pacote pequeno. O consumidor pode usar `originals` diretamente. São quatro casos, não estimativa estatística de qualidade em conversas reais.

## Linguagem operacional

Aceito, enviado, entregue e lido têm textos distintos. O recibo precisa corresponder à instalação, geração, ação, hash do pedido, destinatário e tipo; caso contrário não há confirmação. Estado de grupo não promete confirmação individual. Evidência recuperada é campo separado e marcado como não confiável: texto citado não cria recibo.

## Verificação

18 testes do contexto/probe e 28 da recuperação passaram na execução conjunta (46/46). Contraprovas: alterações de fonte antes/durante chamada, timeout, resposta inválida, spans/emoji, limite efetivo de bytes, recibo de outra ação, injeção citada, orçamento e replay. A fronteira HTTP da homologação exige configuração/token próprios e só aceita rotas fixas; não existe envio de mensagem nem escrita Calendar.

O broker admite uma fonte âncora; a autorização do pacote inteiro é responsabilidade explícita de `PackGuard`, repetida antes do transporte e no retorno. A #44 ainda revalida pacote/conversa/trabalho antes de produzir efeito. `ready` descreve um pacote conferido naquele momento, não autorização perpétua nem certificação semântica. Testes atuais não executam conversa Flue/Telegram de ponta a ponta; essas entregas seguem separadas.

Revisão adversarial independente repetiu os 46 testes e não encontrou bloqueador neste escopo. A implementação, teste e prova cloud formam uma única fronteira; o diff excede o alvo de 400 linhas por incluir o probe isolado e o resultado verificável, sem adicionar outro recurso do produto.
