# Calendar no diálogo Telegram — atualização 28/10/2026

## Títulos comprovados em produção

`b5b31d4` foi publicado na versão `da2f3eee-f998-43b8-a37a-88de3c5011e5`, conservando42bindings/runtime/imagem/cron/pausa. Uma pergunta real no bot sobre hoje retornou três compromissos, todos com título, cobertura de eventos completa e uma agenda autorizada. Update12319753, resposta51 `sent`/uma tentativa, episódio Flue `61a1e063…` `settled`. Títulos e horários pessoais permanecem privados; não se afirma leitura humana dessa resposta.

Títulos são opção interna habilitada apenas no caminho Telegram; o MCP de disponibilidade continua sem títulos. Eventos transparentes/dia inteiro ficam separados da agregação de horários ocupados. Resposta/projeção são limitadas e lacunas/truncamento explícitos. Os30 casos de leitor/Telegram, tipos/build passaram; CI40674561557/`b5b31d4` aprovada.

## Escopo retificado pelo dono

O dono explicitou que a agenda deve permitir leitura de títulos e criação, edição e exclusão de eventos; GitHub permanece somente leitura. A restrição anterior de escrita Calendar abaixo é histórica e foi substituída por esse pedido. WhatsApp automático continua desabilitado.

O consentimento Google `calendar.events.owned` foi concluído no Chrome e validado contra os mesmos três compromissos da agenda já conectada. Credencial/configuração usam perfil separado do cache readonly, nova versão/epoch, sem reutilizar autorização antiga como escritora. `ba7d89d` implementa pedidos do dono autenticado para eventos únicos da agenda principal, organizados por ele e sem convidados. Convites, séries e alterações proativas não foram habilitados. Publicação concluída na versão3a83ad3c-bfc8-4745-9da8-70d1f682977b,44bindings, migração0033; runtime/imagem/cron/pausa preservados.

O host interpreta a instrução completa, pede título/dia/dados faltantes e seleciona alvo único com paginação completa e GET atual. PATCH/DELETE usam ETag, sem reaplicar sobre uma versão nova. A tabela de ações conserva tentativa consumida após purga, removendo conteúdo; falha de resposta Telegram não repete o efeito Google. Após timeout/ACK perdido, não há reconciliação automática em segundo plano: o resultado continua incerto e pede consulta da agenda. DELETE404 não comprova autoria de exclusão.

A revisão não encontrou P1. Um P2 de identidade entre bots foi corrigido incluindo o pedido canônico e validando os vínculos da ação; a ausência de reconciliação automática é limite declarado, sem alegação de recuperação do efeito. Testes dirigidos56/56, helper/nativo OAuth5/5 e checagem final9/9/tipos/build passaram. Uma expectativa de representação ISO equivalente falhou inicialmente e foi corrigida no teste, preservando o log.

## Canário real de criar, editar e excluir

Updates12319754/755/756 criaram, renomearam e excluíram o mesmo evento técnico futuro, sem convidados/lembretes. As três ações ficaram `applied`, com respostas53/55/57 em `sent`, uma tentativa cada. GETs independentes no Google comprovaram título/horários/marcador após criação, novo título com os mesmos horários após edição e `status=cancelled` após exclusão; não se promete remoção física de toda cópia no provedor. O marcador/ID foi o mesmo nas três ações. Não houve nova tentativa de efeito, convite ou mudança em outros eventos.

As três conclusões nativas ficaram `settled`; a conversa foi trazida para uma janela não minimizada, e a leitura da interface confirmou as três respostas renderizadas em documento visível. Isso não é avaliação humana de utilidade. CI40677012537/ba7d89d aprovada:1650 gerais,13 OAuth,70 nativos, verificações Node5/9/1/39, tipos/builds e auditoria0vulnerabilidades. O piloto completo continua pendente.

Censo global às11:09:10UTC:64449microUSD (US$0,064449), conservando40000incertos históricos e3000reservados. Os quatro pedidos adicionais (títulos e CRUD) somaram860microUSD liquidados. Infraestrutura/fatura separadas. A credencial temporária usada apenas nos GETs de prova foi removida do disco; o refresh token de instalação permanece privado.

## Evidência anterior de disponibilidade (27/10/2026)


A consulta de disponibilidade passou no caminho real: mensagem do dono no Chrome autenticado → Flue → leitor Google Calendar já configurado → resposta no tópico original. O Worker não ganhou capacidade de escrita de agenda.

## Resultado real

A pergunta “Tenho algum horário ocupado amanhã na agenda?” foi interpretada como consulta de28/10/2026, usando a data original da mensagem em America/Fortaleza. O leitor retornou `available`, três períodos ocupados, uma agenda autorizada, cobertura completa somente desse dia e sem lacunas. O snapshot continua não atômico.

A outbox registrou `sent`, uma tentativa e ID de mensagem retornado pelo Telegram. O episódio terminou em `settled` após conferir a conclusão da mesma submissão Flue, recibo do modelo, orçamento e resposta. A interpretação consumiu132microUSD (US$0,000132). Nenhum evento foi criado ou alterado; a leitura continua limitada à agenda principal previamente consentida.

A resposta armazenada e enviada tem título em negrito, parágrafos, horários de Fortaleza e indicação de somente leitura, sem a decoração de lua rejeitada pelo dono. O Telegram Web estava em segundo plano e sua conversa ainda exibia o trecho anterior; a API não foi usada como prova de leitura humana ou renderização dessa nova mensagem. Não houve reenvio.

## Implementação e preservação

`11b1eca` compartilha a configuração Calendar entre MCP e Telegram e reutiliza `CalendarReader`. O modelo escolhe a intenção; o host resolve o dia e os calendários autorizados. Dados de eventos não vão ao modelo nem ao histórico Flue. O token e cada GET respeitam o prazo e a autorização atual, inclusive depois de awaits. Uma observação privada do episódio prende consulta/resultado à submissão nativa e aos suportes autorizadores; a outbox confere essa mesma observação antes do envio.

Retirada do suporte elimina observação, resposta e derivados, preservando o custo já ocorrido. O teste dirigido alterou a observação antes do envio e comprovou bloqueio; depois retirou a autorização e conferiu a purga. A revisão adversarial não encontrou P1; um P2 de faixa/data ambígua foi reproduzido e corrigido. Os57 casos dos quatro arquivos afetados passaram; os cinco focos do parser passaram após essa correção, além de tipos/build. A CI40620118231 do commit integrado foi posteriormente confirmada como aprovada.

A versão própria `59878ece-bceb-4135-8441-306924f1db6e` foi promovida a100%, conservando40bindings, runtime/imagem, cron, exposição e pausa global. Não houve migração, segredo novo ou alteração em Source/Elo. A primeira leitura de implantação recusou o OAuth Cloudflare expirado antes de qualquer tentativa de upload; o Wrangler renovou a sessão existente e confirmou a mesma versão anterior antes da publicação.

## Limites restantes

O diálogo resolve hoje, amanhã, depois de amanhã ou uma data completa DD/MM/AAAA para um dia inteiro. Faixas de horário, múltiplas datas e datas ambíguas pedem esclarecimento; essa implementação não demonstra interpretação universal de datas. O código GitHub foi acrescentado depois, mas seu canário Telegram ficou indisponível por quota anônima; consulte a evidência144-github-telegram. WhatsApp/busca semântica e administração natural mais ampla continuam pendentes da #144. O piloto completo e utilidade humana não estão homologados por esse ensaio.

O censo posterior dos ledgers conhecidos registra62.687microUSD (US$0,062687), incluindo40.000incertos históricos e3.000reservados preservados. Infraestrutura não está conciliada nessa soma. Recibos, intervalos reais e credenciais ficam fora do Git.
