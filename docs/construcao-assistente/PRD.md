# Assistente pessoal — construção até piloto sombra

Status: construção autorizada pelo dono em 25/10/2026. Este documento consolida as decisões de produto já recebidas; escolhas técnicas continuam responsabilidade da engenharia.

## Produto e decisões do dono

Instalação pessoal na Cloudflare, independente do computador/Codex. WhatsApp acompanha privados por padrão com exclusões explícitas; grupos têm ignorar/acompanhar/responder. Telegram privado com tópicos Geral, Resumos, Pendências, Missões e retornos é a superfície reativa. GPT/Claude via MCP ensinam contexto por projeto. Pessoas, projetos, assuntos, missões e FUPs têm relações verificáveis. Captura continua durante pausa humana e retomada recupera mudanças. Áudio, imagem e PDF entram com origem e lacunas explícitas. GitHub é somente leitura em todos os repositórios próprios autorizados, sem expiração configurada da credencial. Conforme retificação explícita do dono em28/10, Calendar deve mostrar títulos e permitir criar, editar e excluir eventos por pedidos autenticados do dono na agenda principal própria.

O marco entregue é um produto integrado pronto para observação em sombra. Decisão hipotética não envia WhatsApp, altera agenda ou encerra compromisso real. O Telegram do dono pode receber resumos após configuração autenticada; nenhuma mensagem de teste será enviada a terceiros. Autonomia real permanece etapa posterior, condicionada à avaliação do piloto.

Cada issue concluída recebe release minor, conforme pedido atual, com evidência de teste e revisão. Issues só fecham após entrega comprovada. Sem copiar dados, configuração ou código do Elo. Sem instalar o harness; adotar seu padrão de issues, planejamento, revisão e evidência.

Atualização de produto em 26/10: MCP e assistente também devem iniciar uma conversa com destinatário sem histórico, inclusive telefone novo, sem exigir que o dono abra o chat antes. É uma capacidade geral; cotação de MacBook foi apenas exemplo e não define feature exclusiva. Contrato em [iniciar conversa sem histórico](ENVIO-PROATIVO.md), issues #126 e #128. O isolamento deste marco sombra continua vigente.

Atualização de escopo em28/10: o primeiro caminho Calendar gerencia eventos únicos da agenda principal, organizados pelo dono e sem convidados; séries/convites exigem implementação específica. Resultado incerto não autoriza repetição automática. Esse limite de entrega não reduz o requisito de produto mais amplo.

## Arquitetura proposta pela engenharia

- Worker da assistente separado do MCP atual: sem credenciais Z-API. A credencial Calendar própria permite gestão reativa pelo dono; decisões e rotinas sombra não recebem essa capacidade. O arquivo/manual atual continua operando. Controle de sombra não depende somente de prompt ou feature flag.
- Ponte durável de captura: outbox transacional no arquivo, entrega autenticada restrita ao receptor da assistente, chave de mudança e cursor. Edições, retirada, transcrição e mudanças de acesso também são eventos. Não basta buscar mensagens por data.
- D1 canônico próprio para pessoas/identidades comprovadas, fontes/versões/permissões, relações e afirmações atribuídas, missões/FUPs, propostas, jobs e recibos. R2 privado para artefatos. Geração operacional externa ao banco restaurável.
- Cognee em Container Cloudflare é projeção de ingestão/busca, reconstruível de fontes canônicas; ledger, orçamento e identidade de trabalho fora do disco efêmero. Checkpoints/snapshots verificáveis e reconstrução testados. O §11 antigo da proposta não prevalece sobre rodadas 4–6.
- Busca por texto, significado e relações produz candidatos. O host verifica identidade, público, versão, retirada e cobertura. A IA seleciona contexto e interpreta linguagem; código controla autorização e recibos. Limites explícitos, nunca truncamento silencioso.
- Flue conduz episódios com IDs/contexto/ferramentas separados para dono e interlocutor. Estado duradouro não depende do transcript. Revogação/correção invalida episódios e rascunhos.
- Fila durável e orçamento transacional antes da IA. Resultado incerto permanece reconciliável; timeout não autoriza repetição. Cron/alarmes retomam trabalho, FUPs e revisão diária.

## Requisitos rastreáveis

As 64 histórias originais são o mapa funcional. Os números seguintes agrupam contratos de implementação e fundamentam `#ac-N.M` nas issues.

1. Preservar e integrar a base publicada antes de alterações, com testes/release reproduzíveis.
2. Isolar instalação, geração, identidade do dono e modo sombra de capacidades de envio.
3. Persistir identidades, projetos, fontes/versões, relações, mandatos e mudanças com integridade.
4. Capturar cada mudança de mensagem/acesso/mídia com outbox durável e replay idempotente.
5. Controlar cobertura, pausa, retomada e limites sem perder eventos nem confundir ausência com silêncio.
6. Publicar candidatos de extração com fonte/versão; correção e retirada só pelo controlador.
7. Recuperar contexto por texto/significado/relações, conferir originais e registrar lacunas.
8. Executar Cognee na Cloudflare com ingestão, ledger, orçamento, persistência e recuperação reais.
9. Executar IA com custo reservado, prazo, caps e episódios isolados por público/mandato.
10. Produzir encaminhamento responder/revisar/silêncio, texto proposto e linguagem sustentada por fonte/recibo.
11. Administrar memória/contexto/missões/políticas pelo dono autenticado em MCP e Telegram.
12. Manter FUPs e missões versionados separados de jobs, com próximo vencimento e parada.
13. Consultar GitHub somente leitura, consultar títulos e gerenciar eventos Calendar por pedido autenticado do dono, e interpretar mídia limitada com evidência e falha visível.
14. Organizar tópicos, notificações, aprovações simuladas e revisão diária com vínculo autenticado.
15. Medir cobertura, custos, qualidade, invalidações, silêncios e tempo de revisão no piloto.
16. Instalar, migrar, pausar, restaurar, exportar/retirar e operar em nuvem com runbook e prova integrada.

## Aceite do marco

Todos os contratos críticos testados na integração e revisados adversarialmente. Instalação reproduzível com credenciais fornecidas por mecanismos privados. Eventos sintéticos atravessam captura→memória→contexto→episódio→decisão sombra→revisão; reinício, duplicata, correção, revogação, atraso de mídia, falha de modelo e orçamento esgotado preservam estado honesto. Teste negativo demonstra ausência de envio WhatsApp e de escrita Calendar por decisão/rotina sombra. Pedidos reativos do dono para Calendar têm teste real separado de criar/editar/excluir, sem terceiros. A lacuna de canal/configuração deve ser nomeada e não virar alegação de piloto operacional. Avaliação longitudinal e benefício real são realizados durante o piloto, não inferidos de fixtures.

## Limites e decisões de engenharia

Escopo inicial do piloto terá limites explícitos de acervo e custo; aumentar capacidade exige evidência. R6 provou somente 24 fontes/24 kB por escopo, não escala geral. Ampliar e medir recuperação com corpus representativo antes de ativar observação contínua. Linguagem controlada conserva atribuição e não alega entendimento universal. A escolha de modelo é configurável: usar o menor capaz que passe no mesmo corpus; nenhuma superioridade geral presumida. Não iniciar custos contínuos desnecessários durante construção.
