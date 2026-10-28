# Assistente proativa com envio aprovado

Autorização de Robson em 28/10/2026: a assistente analisa conversas e sugere respostas no Telegram; aprovar a mensagem envia diretamente ao WhatsApp. Responder sem aprovação fica para uma autorização futura. Esta etapa continua nesta conversa, preservando código, custos, evidências e credenciais próprias.

## Contrato de produto

- Uma nova mensagem recebida em conversa habilitada pode produzir uma sugestão, silêncio ou pedido de esclarecimento. Conteúdo recebido nunca autoriza envio.
- A revisão mostra destino inequívoco, mensagem recebida original (identificada como trecho quando abreviada), resumo curto da IA quando útil e resposta sugerida integral. Contexto e resumo nunca compõem o texto enviado. “✅ Aprovar e enviar” autoriza somente essa versão; “❌ Descartar” encerra sem enviar. Botões antigos de simulação continuam apenas simulando.
- Aprovação vencida, proposta alterada, vínculo revogado, fonte retirada ou conversa desatualizada impedem nova tentativa. Clique repetido consulta o mesmo envio, sem duplicar.
- Telegram distingue aceito, enviado, entregue e resultado incerto. Incerteza conserva a ação para reconciliação, sem criar outra tentativa.
- O piloto preserva o corte Source original 3683 e passa a descobrir conversas privadas capturadas, respeitando exclusões e pausas. Não exige lista manual de contatos. Backlog e FUPs anteriores permanecem preservados. Resumo diário e resposta autônoma permanecem desligados nesta ativação inicial.
- Contexto inicial: até três fontes textuais e 8 KiB da mesma conversa, em manifesto imutável. O modo `conversation_manifest` entrega os originais do manifesto diretamente ao runtime e reconstrói a mesma seleção na revisão, sem aquecimento/indexação/busca Cognee no caminho dessa resposta curta. A restrição limita seleção e validação; não concede acesso nem promete histórico completo. Políticas e retenção existentes continuam valendo.

## Arquitetura proposta

Own mantém inferência e revisão autenticada; Source mantém credenciais WhatsApp e a única tentativa externa. Um RPC nominal privado prepara ações de texto idempotentes e executa somente após conferir recibo humano atual em Own. O claim final Source inclui destino, conexão, envelope e mapeamento congelados. Não há ferramenta genérica de envio para o modelo.

A autorização é revalidada imediatamente antes do claim Source e tem vida curta. Bancos separados não fornecem revogação global atômica: revogar após o início da tentativa não desfaz um envio em curso. Esse limite é registrado, sem alegação de cancelamento instantâneo.

## Aceite

1. Mensagem real recebida → análise automática → sugestão útil no Telegram, com contexto e custo registrados.
2. Clique real de Robson em destino/texto visíveis → uma tentativa Source → recibo e consequência observada no provedor.
3. Repetição do botão não duplica; rejeição, mudança e vencimento não enviam.
4. Backlog, conversas excluídas e mensagens enviadas pelo próprio dono não disparam respostas novas.
5. Revisão independente, CI do código entregue, release minor e evidências sanitizadas. Qualidade longitudinal permanece em avaliação humana.

## Revisão adversarial e situação

Issue [146](https://github.com/orobsonn/whatsapp-mcp/issues/146). A revisão exigiu mapeamento/ação atômicos, comparação do destino efetivamente usado no envio e nova aprovação explícita. Os testes reproduziram e corrigiram mudança de destino A→B→A e parser incompatível com metadados reais do Telegram. Reconciliação consulta a mesma ação; nunca repete envio por ACK perdido.

O piloto inicial não executa extração automática de missões fora das três fontes. Registra `not_evaluated/pilot_context_only`; controles reativos existentes permanecem disponíveis. FUP e diário não fazem parte da primeira ativação. Ampliar essas rotinas exige validar seu recorte, sem tratar o circuito de respostas como prova delas.

Status em 28/10/2026: `04f0be8` foi publicado nos dois Workers com migração Source0017 e CI aprovada (1761 testes gerais, 13 OAuth, 70 nativos e verificações Node). O vínculo comprovado telefone/LID foi registrado; a proposta antiga continua cancelada e o gatilho respondido é vetado. Não houve envio aprovado real. A próxima alteração inclui conversas privadas novas, evita gatilhos superados, reduz o caminho da resposta e apresenta o contexto ao dono. Seu deploy e sua homologação permanecem pendentes até readback em produção. [Critérios, readbacks, custos e pendências](evidencias/146-envio-aprovado.md).

## Revisão operacional da arquitetura

Revisão adversarial do código `dfa622b`, solicitada pelo dono após o silêncio no Telegram. A base separa captura/credenciais/envio no Source de raciocínio/revisão no Own. A prévia integral e a aprovação autenticada conservam uma única tentativa de envio. Isso constitui uma base para ensaio acompanhado, ainda sem prova de uso funcional completo.

- **Falha reproduzida:** uma análise real paga terminou sem proposta publicada e reteve a próxima. O ajuste amplia somente prazos futuros e destaca o item vencido da coordenação, sem renovar episódios, repetir inferência ou apagar custos/recibos. A liberação do primeiro item foi observada; falta concluir o segundo percurso.
- **Fragilidade constatada no código:** o coordenador global mantém um único item ativo e pula materialização/descoberta ao reconciliá-lo. O destaque novo cobre episódio incerto expirado; não resolve toda incerteza de ingestão/índice.
- **Correção em validação:** o modo `conversation_manifest` usa os originais já selecionados e dispensa o caminho Cognee nessa resposta curta. O modo fica congelado no trabalho, episódio e recibo de busca e é reconstituído na revisão; a busca geral do dono preserva seu funcionamento.
- **Correção em validação:** nova entrada recebida supera gatilhos anteriores da conversa, mesmo se a entrada for áudio ou exceder o limite textual. O veto usa a sequência original e o watermark Source, distingue resposta do dono e conserva tentativas/custos anteriores.
- **Lacuna de produto constatada:** falha técnica pode continuar parecendo silêncio deliberado. `no_reply` é decisão do modelo; falha sem decisão é ausência de avaliação. O ajuste publica perguntas `waiting_context` sem botão de envio, mas resposta livre ainda não retoma a análise automaticamente; a mensagem informa esse limite.

Esses pontos não são novos resultados de homologação nem autorização para resposta autônoma. O aceite deve observar sugestão atual e útil, latência, falha visível, independência entre conversas e o envio aprovado real. Três fontes/8KiB não comprovam compreensão de todo o histórico, preferências pessoais ou compromissos antigos.
