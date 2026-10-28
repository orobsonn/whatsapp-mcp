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

Status em28/10/2026: código implantado com CI aprovada e piloto de novas mensagens textuais ativo em oito conversas privadas. A homologação real ainda depende de entrada elegível, sugestão e aprovação do dono; a release final e o encerramento da issue aguardam essa prova. Nenhum envio de teste foi autorizado por um clique fabricado pelo agente. [Critérios, readbacks, custos e pendências](evidencias/146-envio-aprovado.md).
