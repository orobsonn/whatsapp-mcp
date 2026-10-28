# Envio aprovado — implantação e aceite pendente

Atualização mais recente: 28/10/2026, 22:38 UTC. Os snapshots anteriores permanecem abaixo como histórico. [Issue146](https://github.com/orobsonn/whatsapp-mcp/issues/146), [PR147](https://github.com/orobsonn/whatsapp-mcp/pull/147). Este registro distingue código implantado de comportamento homologado.

## Contexto na revisão e feedback real

A prévia real Telegram100 apresentou mensagem recebida, resumo da IA e resposta sugerida em campos separados. Houve callback autenticado de descarte. O Source confirmou ação expirada e `attempted_at=NULL`: nenhuma tentativa WhatsApp. Isso comprova o formato e o descarte; não comprova o envio aprovado. O dono confirmou que o circuito funcionou, mas que aquela mensagem encerrava a conversa e não precisava de resposta. Essa avaliação exige refinar a decisão `no_reply`, sem confundir publicação com utilidade.

Source0017/0018 foram aplicadas. O Source ativo é `e85774d5-8bfb-4623-a3ff-a68c9dfd9d17`; o piloto usa revisão3, `captured_private/conversation_manifest`, preservando cutoff3683. As provas de identidade são metadados de atividade, sem mesclar históricos. O contexto chega ao runtime diretamente pelo manifesto; resposta posterior e nova entrada superam gatilhos antigos.

O caso privado que não publicou revelou resposta e resumo pagos completos, mas citações vazias. A regra adicional do parser recusava o resultado. `fcd49e9` permite citações vazias somente no manifesto privado congelado pelo host; as que forem fornecidas continuam validadas, e os outros modos conservam sua exigência. Os380microUSD da tentativa anterior foram preservados, sem reabrir episódio nem repetir inferência. Episódios preparados vencidos também deixam a coordenação após vencerem os dois prazos, sem renovar autoridade.

A correção visual traduz a assinatura WhatsApp inicial em negrito/itálico escapados no Telegram, preservando original e envelope. A orientação ao modelo passa a considerar silêncio em confirmações, risadas ou encerramentos sem pedido pendente; a qualidade dessa orientação deve ser acompanhada em novas conversas reais.

CI de `44d410b`: [40763919056](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40763919056),1782gerais,13OAuth,70nativos e verificações Node/tipos/builds/auditoria aprovadas. `cd145c4` também tem CI aprovada. Ajustes posteriores têm verificações dirigidas; o resultado de cada CI deve ser consultado no commit exato antes do fechamento do marco.

Auditoria de cobertura às22:41UTC: oito conversas privadas capturadas tinham entradas recebidas após o corte. As cinco últimas entradas textuais estavam mapeadas: duas superadas por resposta do dono, uma já concluída/cancelada no ensaio anterior e duas tentativas preservadas após falha. Três entradas estavam marcadas indisponíveis no Source e continuam explicitamente não avaliadas. Não foram convertidas em `no_reply`. Não havia proposta atual pendente de aprovação nesse recorte.

Censo dos seis ledgers conhecidos do projeto às22:41:34UTC: **94.519microUSD (US$0,094519) comprometidos**, incluindo40.000incertos históricos. RestamUS$9,905481 diante do teto global deUS$10; recibos e reservas permanecem preservados. O censo não é fatura nem reconciliação de infraestrutura.

| Requisito do marco | Evidência atual | Situação |
|---|---|---|
| Captura real → análise automática → Telegram com original/resumo/resposta | Prévia100 e confirmação do dono | Observado; utilidade ainda em avaliação |
| Decidir silêncio quando responder não ajuda | Feedback real de encerramento, orientação ajustada | Acompanhar novos casos reais |
| Aprovação real do texto/destinatário atuais | Só há descarte100 e ação antiga cancelada | Pendente |
| Uma tentativa WhatsApp e consequência do provedor | As ações observadas não foram tentadas | Pendente |
| Descarte, alteração e revogação impedem envio | Descarte real sem tentativa + guards/testes | Evidência negativa disponível |
| Repetição da aprovação conserva a mesma tentativa | Testes dirigidos; sem aprovação real nova | Validação real pendente |
| Resposta autônoma desligada, configuração/custos preservados | Readbacks de publicação, cron e censo | Verificado no recorte observado |
| Release/tag/encerramento da issue | Última release pública0.51.0; issue146 e PR147 abertos | Aguardar aceite |

Ainda falta sugestão atual útil → aprovação real do dono → tentativa única e consequência do provedor. A issue146 e a release0.52 continuam pendentes desse aceite. Resposta autônoma permanece desligada.

## Sugestão real e defeito de identidade —18:14UTC

O segundo episódio concluiu e a revisão real foi publicada no Telegram, mensagem99, com destino/texto integrais e aprovação pendente. Portanto, entrada real→análise automática→sugestão Telegram foi observado. O dono informou que gostou da sugestão e que **já havia respondido**; isso é avaliação do texto, não aprovação de novo envio. A ação Source foi cancelada via controlador existente, com `attempted_at=NULL` e sem ID do provedor. O envio aprovado até consequência WhatsApp continua sem homologação.

A investigação encontrou a resposta do dono capturada às17:41:34 em um chat identificado por LID, separado do chat de telefone usado pelo episódio e pela sugestão, publicada aproximadamente às17:45:50. O diagnóstico inicial de falta de captura foi corrigido: o evento existia, mas a identidade fragmentada impediu reconhecer que a conversa já tinha sido respondida.

Uma consulta de leitura ao provedor confirmou a instância, o callback desta instalação/geração e `receiveCallbackSentByMe=true`. O endpoint `phone-exists` recebeu o telefone **exato capturado**, sem variantes numéricas, e retornou aquele LID; não houve normalização diferente do telefone. Assim, o vínculo foi confirmado pelo provedor, não por nome ou semelhança de mensagens. Credenciais e resposta privada não entram neste registro. [Contrato oficial](https://developer.z-api.io/contacts/get-iswhatsapp) e [identificadores do provedor](https://developer.z-api.io/tips/lid).

A revisão adversarial recomendou relação direta comprovada usada para segurança de atividade, preservando chats, IDs, roteamento e histórico. O bloqueio precisa considerar a sequência original da resposta do dono antes de inferência/publicação/revisão e no claim final Source. Apenas agregar watermark seria insuficiente: uma sugestão gerada depois da resposta poderia nascer com a marca nova e continuar indevida. Identidade não concede acesso; captura ou política restritiva de qualquer lado bloqueia a automação. A implementação dessa correção está em andamento; nenhuma relação de produção foi registrada neste snapshot.

## Atualização real de17:42UTC

- Duas mensagens privadas de texto chegaram naturalmente e foram admitidas no piloto. A seleção foi atualizada para revisão2 antes de haver trabalho admitido, conservando o cutoff Source original; nenhuma mensagem de entrada foi fabricada.
- O primeiro episódio efetivamente chamou o modelo e tem recibo completo de235microUSD. O timestamp de criação do recibo marca admissão, não conclusão: restavam aproximadamente15segundos no prazo quando a chamada começou. O prazo venceu antes de publicar a proposta. O segundo trabalho ficou retido na coordenação global; ausência de Telegram não foi uma decisão `no_reply`.
- Código `dfa622b2b38c2db0dbe2390cfb932ea3654f8df8`: novos leases180s e novos episódios/runtime até120s, sempre limitados por prazo/lease originais. Episódios antigos não receberam extensão nem nova chamada. O destaque do item incerto vencido altera somente metadados da coordenação e preserva job, episódio, recibos, custos e incerteza.
- Perguntas `waiting_context` agora usam o aviso existente no Telegram, sem preparo Source nem botões de envio. Conteúdo vazio, desatualizado ou grande mantém lacuna explícita. Resposta livre ainda não retoma a análise automaticamente; o próprio aviso informa esse limite.
- [CI40736247603](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40736247603) aprovada no mesmo código:1737gerais,13OAuth,70nativos, Node5/9/1/39, tipos, builds e auditoria. Foram executados116testes dirigidos antes da implantação; a suíte geral concluiu em paralelo, antes do fechamento de qualquer entrega.
- Own ativo: `347e4647-6d86-4e93-8cb1-54686821c791`. Onze módulos do build exato,49bindings, piloto revisão2, imagem/runtime, cron e exposição anteriores preservados. Readback e health200 confirmaram envio com aprovação configurado e resposta autônoma desabilitada. O bundle Source foi comparado e não mudou; Source continua na versão `bbec4fe5-82f0-4b47-9c1e-12578208c6c2`.
- Observação17:42UTC: primeiro item em `uncertain/held_expired`, com lacuna `expired_model_attempt_preserved`; o segundo avançou para `restore_checkpoint`. Ainda não há sugestão Telegram, aprovação humana ou envio WhatsApp observado deste circuito. Isso não conclui homologação nem justifica encerrar issue/publicar release final.
- Censo17:30:45UTC:92.844microUSD (US$0,092844) comprometidos conhecidos, incluindo40.000incertos históricos e3.000reservados preservados; teto globalUS$10 mantido. Não é fatura nem reconciliação de infraestrutura.

A [revisão operacional da arquitetura](../ENVIO-APROVADO.md#revisão-operacional-da-arquitetura) distingue falha reproduzida de fragilidades do código e hipóteses. A base permite ensaio acompanhado; fila global, dependência obrigatória de Cognee, textos em sequência e falha invisível ainda impedem declarar o assistente funcional em uso real.

## Snapshot inicial de16:31UTC

## Código e implantação verificados

- Código funcional: `9b33c4fe54a1b2e286aa59136521a581c9959714`, versão de pacote `0.52.0`.
- [CI40721194289](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40721194289) aprovada: 1727 testes gerais, 13OAuth e 70nativos; verificações Node, tipos, builds e auditoria também passaram. A execução anterior falhou na integração de retenção; a causa foi corrigida separando a tabela Source `approved_sends` do catálogo Own, sem ampliar permissões.
- Source: versão `bbec4fe5-82f0-4b47-9c1e-12578208c6c2`, um módulo e31bindings. Health200, pacote0.52.0, manutenção desligada e conexão configurada.
- Own: versão `23f5c0cc-cca4-43af-ba6f-dba36ac47734`, onze módulos e49bindings. Imagem/runtime, bindings anteriores, cron e exposição preservados. Elo não foi alterado.
- Migração Source0016 e Own0034 aplicadas. As quatro definições da migração Calendar0033 já existiam e foram comparadas com o código antes de reconciliar somente seu registro de aplicação; dados/DDL da agenda não foram recriados.
- Health Own confirmou envio configurado, resposta autônoma desabilitada e capacidade reativa Calendar preservada. Health não comprova um envio ao provedor.

## Recorte desta ativação

Oito conversas privadas recentes, respeitando exclusões e pausas existentes; somente novas mensagens de texto recebidas após o início do piloto. Mensagens do próprio dono não disparam resposta. Contexto de até três fontes textuais/8KiB da mesma conversa, com referências congeladas e revalidação na indexação, busca e episódio Flue.

As219 pendências anteriores foram preservadas. FUP anterior, diário e extração automática de missões não são executados por este piloto. Controles reativos existentes permanecem disponíveis. Esta ativação não comprova análise automática de grupos, áudio, imagens, documentos ou de todo o histórico.

## Critérios e força da evidência

| Critério | Evidência atual | Situação |
|---|---|---|
| Nova mensagem privada recebida em escopo | Nenhum evento elegível desde a ativação até este snapshot | Pendente |
| Análise automática com contexto real | Código e testes dirigidos; falta entrada real elegível | Pendente em produção |
| Sugestão útil no Telegram, com destino e texto integrais | Implementação e testes; nenhum novo aviso desse circuito | Pendente em produção |
| Aprovação real do dono sobre a sugestão exata | Nenhum recibo humano novo | Pendente |
| Uma tentativa WhatsApp e consequência do provedor | Nenhum envio real deste circuito | Pendente |
| Clique repetido não duplica; incerteza consulta a mesma ação | Testes de callbacks, concorrência, ACK perdido e Source passaram | Comprovado nos testes; repetição real pendente |
| Alteração, revogação e expiração impedem novo envio | Guards e testes dirigidos, incluindo destinoA→B→A | Comprovado nos testes |
| Responder sem aprovação permanece desligado | Readback da configuração e health Own | Verificado na implantação |
| Custos e recibos anteriores preservados | Comparação das configurações e censo dos ledgers conhecidos | Verificado no recorte observado |
| Release minor, tag e encerramento da issue | Ainda não publicados/encerrados para este marco | Pendentes do aceite real |
| Avaliação humana da utilidade e comportamento longitudinal | Não há avaliação nova atribuível a este circuito | Desconhecida |

Entre o início e este snapshot chegaram nove eventos de grupos, fora do recorte; eles não foram contados como análise privada nem como propostas. A captura e o cron continuam ativos. Não foram fabricados eventos de entrada, notas substitutas ou cliques de aprovação para preencher o aceite.

## Custos e continuidade

Censo às16:19:59UTC: **91.573microUSD (US$0,091573) em custos e reservas conhecidos do projeto**, incluindo40.000incertos históricos e3.000reservados preservados. Não atribuir o total à nova análise proativa, que ainda não teve uma entrada elegível. Fatura e infraestrutura não foram reconciliadas neste censo.

As contas existentes de27/28outubro continuam com600.000microUSD por janelaUTC. Foram configuradas sete janelas futuras,29outubro–4novembro, com o mesmo limite deUS$0,60cada: atéUS$4,20adicionais de autorização, sem cobrança antecipada e sem resetar recibos. O teto global autorizado deUS$10não foi renovado. Após esse período, a continuidade do orçamento precisa ser revista usando o consumo acumulado. GoogleExternal/Testing mantém sua limitação conhecida de renovação de consentimento; ela não foi resolvida por este marco.

## Próximo passo

Receber texto de outra pessoa em conversa habilitada, observar a análise e a sugestão, obter aprovação real e conferir a ação/recibo no Source e no provedor. Só então consolidar o resultado e publicar a release. A aplicação roda no Worker/Flue; o acompanhamento pelo Codex não deve substituir seu processamento.
