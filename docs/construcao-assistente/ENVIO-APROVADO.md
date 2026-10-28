# Assistente proativa com envio aprovado

Autorização de Robson em 28/10/2026: a assistente analisa conversas e sugere respostas no Telegram; aprovar a mensagem envia diretamente ao WhatsApp. Responder sem aprovação fica para uma autorização futura. Esta etapa continua nesta conversa, preservando código, custos, evidências e credenciais próprias.

## Contrato de produto

- Uma nova mensagem recebida em conversa habilitada pode produzir uma sugestão, silêncio ou pedido de esclarecimento. Conteúdo recebido nunca autoriza envio.
- A revisão mostra destino inequívoco e texto integral. “✅ Aprovar e enviar” autoriza somente essa versão; “❌ Descartar” encerra sem enviar. Botões antigos de simulação continuam apenas simulando.
- Aprovação vencida, proposta alterada, vínculo revogado, fonte retirada ou conversa desatualizada impedem nova tentativa. Clique repetido consulta o mesmo envio, sem duplicar.
- Telegram distingue aceito, enviado, entregue e resultado incerto. Incerteza conserva a ação para reconciliação, sem criar outra tentativa.
- O piloto começa após o watermark atual do Source, em conversas explicitamente selecionadas. Backlog e FUPs anteriores permanecem preservados. Resumo diário e resposta autônoma permanecem desligados nesta ativação inicial.
- Contexto inicial: até três fontes textuais e 8 KiB da mesma conversa, em manifesto imutável. A restrição limita inventário, indexação, busca e validação; não concede acesso nem promete histórico completo. Políticas e retenção existentes continuam valendo.

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

Status em28/10/2026, 18:14UTC: o ajuste `dfa622b` está ativo com CI completa aprovada; a tentativa vencida foi preservada e a segunda concluiu, com sugestão real no Telegram. O dono gostou do texto, mas já havia respondido. A resposta foi capturada em registro LID separado do telefone usado pela sugestão; o provedor confirmou que são a mesma conversa. A ação antiga foi cancelada sem tentativa. A correção da atividade entre os dois registros está em andamento. Ainda não há aprovação/envio WhatsApp comprovados deste circuito; release e encerramento da issue aguardam essa prova. Nenhum clique de aprovação foi fabricado pelo agente. [Critérios, readbacks, custos e pendências](evidencias/146-envio-aprovado.md).

## Revisão operacional da arquitetura

Revisão adversarial do código `dfa622b`, solicitada pelo dono após o silêncio no Telegram. A base separa captura/credenciais/envio no Source de raciocínio/revisão no Own. A prévia integral e a aprovação autenticada conservam uma única tentativa de envio. Isso constitui uma base para ensaio acompanhado, ainda sem prova de uso funcional completo.

- **Falha reproduzida:** uma análise real paga terminou sem proposta publicada e reteve a próxima. O ajuste amplia somente prazos futuros e destaca o item vencido da coordenação, sem renovar episódios, repetir inferência ou apagar custos/recibos. A liberação do primeiro item foi observada; falta concluir o segundo percurso.
- **Fragilidade constatada no código:** o coordenador global mantém um único item ativo e pula materialização/descoberta ao reconciliá-lo. O destaque novo cobre episódio incerto expirado; não resolve toda incerteza de ingestão/índice.
- **Fragilidade constatada no código:** três textos já selecionados ainda dependem de aquecimento/restauração, ingestão, verificações, checkpoint e busca semântica antes do Flue. Cognee está no caminho obrigatório da resposta curta; medir latência real e avaliar um caminho menor com os mesmos limites de acesso/origem/atualidade é uma recomendação, ainda não implementada.
- **Risco identificado, não reproduzido:** textos distintos em sequência geram trabalhos separados; o contexto congela fontes anteriores ao gatilho. Uma correção posterior pode já existir quando uma sugestão baseada no texto anterior for gerada. Reconhecer gatilhos superados deve conservar recibos pagos e distinguir nova mensagem recebida de resposta do dono.
- **Lacuna de produto constatada:** falha técnica pode continuar parecendo silêncio deliberado. `no_reply` é decisão do modelo; falha sem decisão é ausência de avaliação. O ajuste publica perguntas `waiting_context` sem botão de envio, mas resposta livre ainda não retoma a análise automaticamente; a mensagem informa esse limite.

Esses pontos não são novos resultados de homologação nem autorização para resposta autônoma. O aceite deve observar sugestão atual e útil, latência, falha visível, independência entre conversas e o envio aprovado real. Três fontes/8KiB não comprovam compreensão de todo o histórico, preferências pessoais ou compromissos antigos.
