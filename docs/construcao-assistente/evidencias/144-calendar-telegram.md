# Calendar no diálogo Telegram — 27/10/2026

A consulta de disponibilidade passou no caminho real: mensagem do dono no Chrome autenticado → Flue → leitor Google Calendar já configurado → resposta no tópico original. O Worker não ganhou capacidade de escrita de agenda.

## Resultado real

A pergunta “Tenho algum horário ocupado amanhã na agenda?” foi interpretada como consulta de28/10/2026, usando a data original da mensagem em America/Fortaleza. O leitor retornou `available`, três períodos ocupados, uma agenda autorizada, cobertura completa somente desse dia e sem lacunas. O snapshot continua não atômico.

A outbox registrou `sent`, uma tentativa e ID de mensagem retornado pelo Telegram. O episódio terminou em `settled` após conferir a conclusão da mesma submissão Flue, recibo do modelo, orçamento e resposta. A interpretação consumiu132microUSD (US$0,000132). Nenhum evento foi criado ou alterado; a leitura continua limitada à agenda principal previamente consentida.

A resposta armazenada e enviada tem título em negrito, parágrafos, horários de Fortaleza e indicação de somente leitura, sem a decoração de lua rejeitada pelo dono. O Telegram Web estava em segundo plano e sua conversa ainda exibia o trecho anterior; a API não foi usada como prova de leitura humana ou renderização dessa nova mensagem. Não houve reenvio.

## Implementação e preservação

`11b1eca` compartilha a configuração Calendar entre MCP e Telegram e reutiliza `CalendarReader`. O modelo escolhe a intenção; o host resolve o dia e os calendários autorizados. Dados de eventos não vão ao modelo nem ao histórico Flue. O token e cada GET respeitam o prazo e a autorização atual, inclusive depois de awaits. Uma observação privada do episódio prende consulta/resultado à submissão nativa e aos suportes autorizadores; a outbox confere essa mesma observação antes do envio.

Retirada do suporte elimina observação, resposta e derivados, preservando o custo já ocorrido. O teste dirigido alterou a observação antes do envio e comprovou bloqueio; depois retirou a autorização e conferiu a purga. A revisão adversarial não encontrou P1; um P2 de faixa/data ambígua foi reproduzido e corrigido. Os57 casos dos quatro arquivos afetados passaram; os cinco focos do parser passaram após essa correção, além de tipos/build. A CI40620118231 do commit integrado está em andamento; não é declarada verde por extrapolação.

A versão própria `59878ece-bceb-4135-8441-306924f1db6e` foi promovida a100%, conservando40bindings, runtime/imagem, cron, exposição e pausa global. Não houve migração, segredo novo ou alteração em Source/Elo. A primeira leitura de implantação recusou o OAuth Cloudflare expirado antes de qualquer tentativa de upload; o Wrangler renovou a sessão existente e confirmou a mesma versão anterior antes da publicação.

## Limites restantes

O diálogo resolve hoje, amanhã, depois de amanhã ou uma data completa DD/MM/AAAA para um dia inteiro. Faixas de horário, múltiplas datas e datas ambíguas pedem esclarecimento; essa implementação não demonstra interpretação universal de datas. Consultas GitHub/WhatsApp/busca semântica e administração natural mais ampla continuam pendentes da #144. O piloto completo e utilidade humana não estão homologados por esse ensaio.

O censo posterior dos ledgers conhecidos registra62.687microUSD (US$0,062687), incluindo40.000incertos históricos e3.000reservados preservados. Infraestrutura não está conciliada nessa soma. Recibos, intervalos reais e credenciais ficam fora do Git.
