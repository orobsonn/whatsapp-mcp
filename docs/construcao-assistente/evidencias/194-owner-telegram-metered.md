# Pergunta do dono interrompida e retirada dos tetos monetários

## Causa verificada

Em31/10/2026, uma pergunta real do dono no Telegram foi autenticada, admitida pelo Flue e consultou memória e arquivo. A submissão encerrou com `budget_exhausted` antes de uma resposta final. A conta diária tinha2.000.000microUSD de teto e1.700.199comprometidos; a margem de299.801era menor que a reserva conservadora de319.661da próxima chamada. A reserva não é o gasto efetivo daquela chamada. O inbox permaneceu pendente, mas o cron excluía a entrada por já ter um recibo admitido, mesmo com o SDK encerrado em falha. Nenhuma indisponibilidade do Telegram ou do fornecedor foi presumida.

## Decisão posterior do dono

Em01/11, o dono mandou retirar os limites monetários enquanto observa o uso real. Essa decisão substitui o teto histórico deUS$10e os tetos diários como vetos para a instalação própria. Não autoriza respostas WhatsApp autônomas, contratação ou mudança de permissões.

## Implementação

`INFERENCE_BUDGET_MODE=metered` é configuração do host. Reservas, valores realizados, incertezas, hashes, preços, namespaces e idempotência continuam registrados. Contas novas são abertas para contabilizar o período; contas e reservas anteriores não são apagadas nem reclassificadas. O modo com teto permanece como padrão para ambientes que não tenham escolhido explicitamente a contabilização sem veto.

Modelo nativo, compactação e mídia usam o modo instalado. A comparação monetária entre gasto e estimativa também deixa de descartar a resposta nesse modo; limites de saída/protocolo e validação da resposta continuam. Pausa, retenção, autorizações e bloqueio manual de novas reservas permanecem. Os caminhos legados não foram ativados.

## Retomada operacional

Um operador HTTP temporário, autenticado pelo segredo administrativo existente e limitado à referência exata, foi publicado no Own. A chamada foi feita por proxy local ao binding existente. O caminho HTTP existe no bundle durante a operação; o proxy não o torna exclusivamente local. O operador valida dono, vínculo, ativação, namespace, identidade/UID, predecessor terminal confirmado, envelope original, contexto atual, ausência de resposta incerta/enviada e ausência de entrada posterior.

A retomada usa outra submissão na mesma sessão e o mesmo pedido real, com chave fixa derivada do predecessor. Não fabrica update Telegram, não reabre o recibo encerrado nem sobrescreve sua tentativa. O primeiro preflight foi inconclusivo no prazo de observação de5s; o segundo esbarrou numa regra da SDK que proíbe `uid` com `initialData`. Ambos foram recusados antes da admissão, conferida no armazenamento. A observação passou para30s, sem mudar o prazo de execução, e o dispatch passou a continuar a instância existente sem semente inicial. A nova submissão foi admitida em01/11às03:49:54UTC.

## Validação e estado

Regressões de contabilização sem teto e da integração nativa foram reproduzidas antes da correção; três casos passaram depois. A comparação de custo realizado versus estimativa teve reprodução independente e passou com o contrato corrigido.16testes de orçamento e29do provider passaram, assim como typecheck e build Own. Revisão adversarial não encontrou Critical/Important no delta monetário. Não foi repetida a suíte geral pesada: as verificações cobrem os caminhos alterados e a observação real da instalação.

A configuração sem teto foi lida na versão ativa, com aprovação e autonomia desligada preservadas. A passagem recuperada encerrou sem erro em01/11às03:51:38UTC. O registro de resposta está `sent`, no mesmo tópico original, com ID de mensagem retornado pelo Telegram. Isso comprova aceitação do envio pelo Telegram, sem afirmar leitura pelo dono. O operador foi retirado do build final, publicado em100% como Own `f5c8b716-e3f8-4fec-b45b-718919b2ddc8`, com `INFERENCE_BUDGET_MODE=metered` confirmado na configuração ativa. Bindings, runtime, cron, modo aprovação e autonomia desligada foram preservados. O Source não foi alterado. Recibos completos permanecem privados, sem publicar texto da pergunta, números, tokens ou conteúdo do acervo.
