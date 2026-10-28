# Texto Owner → execução nativa — plano em implementação, #144

Continuação das unidades de inbox, admissão e outbox do PR145. O requisito11 permanece incompleto; nenhuma mudança deste plano autoriza despausar o processamento global ou enviar WhatsApp/escrever Calendar.

## Decisão após revisão adversarial

O pedido real será preservado como fonte `owner_request`, privada, imutável e auditável. Não será uma nota factual nem será elegível para busca, extração ou ingestão Cognee. O broker existente mantém sua fonte/FK, orçamento e recibos. Alterar o broker para remover esse vínculo exigiria bifurcar permissões, recuperação e retirada.

A revisão encontrou dois P1: o restore atual rejeita essa origem embora o snapshot a exporte; e fases separadas por ticks de cron ultrapassariam o prazo da mensagem. Antes de instalar, haverá prova de snapshot/restore histórico sem restabelecer execução, filtros de corpus e retirada das cópias. Uma única submissão nativa executará as fases; cron somente inicia/consulta conclusão. Limite total nativo de60s e prazo original de120s, sem renovação.

## Unidades necessárias

1. Reidratar o turno já admitido em outra instância do host, por identidade persistida e guard SQL vigente. Não é nova admissão nem exclusão mútua de executores. Não expor checkpoint como RPC/ferramenta ou aceitá-lo do modelo.
2. Capturar `owner_request` sob o mesmo guard da entrada, preservar snapshot/restore como histórico, impedir promoção para fato/público e fechar retirada do pedido original. O origin_key pode guardar somente referência bot/update, sem texto/token, para reconciliar a cópia operacional.
3. Compor fila/episódios com discriminador explícito `flue_owner_dialogue`, sem DecisionJournal artificial. Uma submissão nativa recebe apenas bindingId e mensagem genérica; o host conserva prompt/resposta privados em D1 e devolve ao runtime somente marcador de conclusão.
4. Interpretar intenção tipada sobre o pedido isolado antes de ler contexto. Pergunta, negação e instrução citada não são ordens. Resolver alvos no host; ambiguidade pede esclarecimento. Reutilizar leitores/controllers sob guard na transação.
5. Congelar fase, prompt, modelo e chave antes da reserva financeira. Admitir um slot persistente por fase e orçamento antes de inferir. Integrar dependências, cobertura/estado e observações externas na resposta e na retirada; fonte sozinha não prova completude de uma lista.
6. Conectar consumidor limitado de novas mensagens, homologar conversa real no bot próprio, contraprovas semânticas, CI, revisão adversarial e release minor por marco. Sem usar eco, `/status` ou cliques técnicos como prova dessa jornada.

## Evidência da unidade1

Teste RED confirmou ausência de checkpoint/resume. Nove casos focados passaram após implementação: retomada em nova instância/ordem diferente de campos; zero renovação/reclaim; alteração do digest/update; isolamento bot/instalação/geração; recusa de revogação, novo vínculo, texto editado, retenção, expiração e estado incerto; texto mudado entre leitura e guard. O teste de retomada conclui o turno e confirma que não pode ser reaberto.

O checkpoint identifica a admissão por digest com campos em ordem fixa, tokens persistidos e hash do texto. Sua posse não admite modelo, comando ou resposta. Concorrência continua dependente de slots/CAS e chaves idempotentes nas próximas unidades. Não houve inferência paga, deploy ou interação real no Telegram nesta unidade.

## Evidência da unidade2

`TelegramOwnerRequests.capture` recebe somente turno nominal do host, verifica a autoridade externa de retirada e publica fonte/versão/admissão/change no mesmo batch. O guard Telegram vigente admite o pacote; os filhos concluem somente sob o witness imutável dessa admissão. Origem `owner_request`, corpo original, horário da mensagem, hash e identidade da admissão são conservados; capturas concorrentes convergem para uma fonte/versão/change. A referência só é retornada sob o guard ainda vigente.

O restore aceita a fonte como histórico privado; não restaura ativação, turno ou autoridade. Inventários factuais, listagem de fontes, busca e ingestão Cognee excluem essa origem. Correção/compartilhamento são recusados, com triggers de identidade/privacidade e versão única. A retirada apaga também a pergunta operacional identificada por bot/update, preservando prazo/tentativa e metadados financeiros existentes. Nenhuma fonte operacional é criada por texto arbitrário, MCP ou modelo.

Contraprovas RED→GREEN reproduziram o erro de restore, inclusão indevida no inventário/Engine, admissão de job ordinário e compartilhamento. Captura, corrida com revogação e purga da cópia original passaram. A rodada inicial de inbox/captura/fronteira passou38/38; seis arquivos afetados passaram150/150, incluindo snapshot/restore completo, fontes, busca, Engine e MCP. Há sobreposição entre essas rodadas; não somá-las como testes distintos. Types passaram. A CI40607116396 do commit anterior0822607 terminou verde com1572 gerais/13OAuth/66nativos; não representa CI do novo diff.

A revisão encontrou um P2: revalidar o relógio em cada INSERT podia deixar fonte/versão/admissão sem seu `created` quando o último WHERE expirasse. Injeção de avanço do relógio SQL reproduziu exatamente esse estado. Os filhos agora usam o witness do pacote admitido; retorno/modelo/comando não herdam essa permissão histórica e continuam sob guard fresco. A contraprova exige pacote completo e retorno sem autoridade após expiração.

Após o fix, a rodada final de inbox/captura/fronteira passou39/39; types e ambos builds passaram. A revisão adversarial confirmou o fechamento do P2 sem outro finding concreto nessa unidade. São testes sintéticos locais e compilação, não mensagens reais, avaliação humana ou homologação do consumidor ainda ausente.

**Limites pendentes:** a fila ordinária bloqueia pedidos operacionais até existir o ramo específico do diálogo. No resultado final, missões legítimas criadas pelo dono precisam continuar avaliáveis sob sua missão/mandato canônico vigente; o veto provisório não pode impedir essa jornada nem converter pedido cru em autorização. Ainda faltam fases nativas, reserva/slots, intenção natural, provas de estado/cobertura/observações externas na resposta, fechamento da retirada de derivados futuros e consumidor. Nenhuma instalação ou homologação real desse novo caminho foi feita.

## Fila específica e transporte nativo — unidade3

O ramo `flue_owner_dialogue` admite somente Owner, origem operacional, chave de deduplicação reservada, tentativa1 e pedido técnico constante. O texto privado não é copiado para o ledger de jobs. A admissão exige guard do host e a recuperação repete as invariantes; o scheduler geral, seus sweeps de expiração e claim por ID sem guard não consomem essas tentativas. `recordResult`, `complete` e publicação genéricos recusam esse ramo, inclusive antes de escrever recibos: a conclusão depende do coordenador específico ainda pendente.

O broker oferece `describe`, descrição somente leitura da mesma normalização/configuração/chave usadas por `invoke`. Essa descrição permite persistir a operação antes da reserva; não concede autoridade, não gasta e não elimina a janela de reserva sem recibo. A fase futura deve comparar o descriptor congelado antes de chamar `invoke`, jamais adotar prompt/configuração novos após incerteza. Sua unicidade será por pedido+fase, preservada mesmo se outro episódio/payload for proposto.

O perfil `OwnerDialogueRuntime` foi acrescentado ao Flue com bindingId estrito, duração60s e sem ferramentas/delegação. Modelo/lane, classe do Durable Object, nome do agente e submissão precisam corresponder no adaptador. O lane de diálogo só emite o marcador fixo `owner_dialogue_complete`: um corpo privado retornado por engano é recusado antes do primeiro evento. A migração acrescenta `assistant-owner-dialogue-v3`, sem reescrever os tags/classes anteriores. A configuração privada futura precisa dessa nova migração antes de instalar; nenhuma instalação foi feita.

**O resolver de produção continua recusando esse perfil.** Ainda não existe binding de diálogo estrito, journal de fases, conclusão tipada, interpretação ou consumidor. Acrescentar perfil/marker não equivale a executar o pedido. As próximas unidades devem efetuar esse caminho completo com orçamento, dependências/purga e respostas comprovadas, preservando o objetivo integral da #144.

Validação:89 testes em três arquivos de fila/broker passaram, incluindo o broker real com adapter sintético e guard completo na transação. O primeiro encaixe excedeu profundidade100 no D1. Mover o guard autocontido para fora do EXISTS de jobs resolveu admissão e leitura de autorização, conservando predicados, parâmetros, snapshot e relógio; não houve preflight substituindo o guard. Os testes também negam dedupe/limite de tentativas alterados e resultado inventado sem recibo.

No runtime nativo, a primeira rodada teve48 aprovados e uma falha pela migração ausente; a migração corrigida passou no foco do bundle. Seis verificações focadas de provider/privacidade passaram após reproduzir e corrigir emissão indevida de corpo privado.25 verificações Node de instalação passaram com TMPDIR canônico no macOS; a tentativa inicial com diretório temporário por symlink falhou no guard de caminho, sem afrouxar esse guard. Types e ambos builds passaram. Revisão adversarial não encontrou P1/P2 novo nesse diff. A CI40608983403 do commit anteriora54fbb0 concluiu1591gerais/13OAuth/66nativos; o novo commit requer sua CI própria.
