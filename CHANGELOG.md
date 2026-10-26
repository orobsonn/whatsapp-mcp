# Changelog

Todas as mudanças relevantes são registradas aqui, no formato Keep a Changelog.

## [Unreleased]

## [0.32.0] - 2026-10-25

### Added
- Episódios Flue isolados em sombra, com contexto autorizado, orçamento persistente, retomada e revalidação de saída (#44).

## [0.31.0] - 2026-10-25

### Added
- Reader nominal de imagem/PDF capturado com limite de 2 MiB, integridade e revalidação de captura/privacidade antes e depois do R2 (#114).

## [0.30.0] - 2026-10-25

### Added
- Continuação persistente da busca canônica com cobertura atual, retomada de páginas e leitura manual durante pausa.

## [0.29.0] - 2026-10-25

### Added
- Reconstrução do índice com recibos exatos existentes, posse durável e recuperação homologada na Cloudflare sem novas chamadas de modelo.

## [0.28.0] - 2026-10-25

### Added
- Runtime oficial Flue com perfis isolados, sessões SQLite duráveis e prova integrada em workerd.

## [0.27.0] - 2026-10-25

### Added
- Comandos versionados do dono, com repetição segura e invalidação de trabalho antigo após mudanças de FUP.

## [0.26.0] - 2026-10-25

### Added
- Snapshots do Cognee são confirmados apenas após restauração e verificação das fontes; recuperação real na Cloudflare preserva chamadas e orçamento.

## [0.25.0] - 2026-10-25

### Added
- Contexto preserva originais e recusa seleções inválidas; linguagem operacional vinculada a recibos, com prova real e replay sem nova chamada.

## [0.24.0] - 2026-10-25

### Added
- Recuperação limitada de contexto autorizado com fontes e versões verificadas; continuação entre lotes segue como entrega separada antes do piloto.

## [0.23.0] - 2026-10-25

### Added
- Motor Cognee em Container restrito, integrado ao broker persistente e homologado com API real na Cloudflare.

## [0.22.0] - 2026-10-25

### Added
- Pausa e replay persistentes por conversa, com lacunas explícitas e admissão atômica de trabalho.

## [0.21.0] - 2026-10-25

### Added
- Broker de modelos com orçamento persistente, recibos recuperáveis e revalidação de acesso às fontes.

## [0.20.0] - 2026-10-25

### Added
- Materialização de fontes capturadas com versões, retirada e verificação de origem antes do uso (#70).

## [0.19.0] - 2026-10-25

### Added
- Orçamento persistente de inferência com reserva antes da execução e conservação de custos incertos (#37).

## [0.18.0] - 2026-10-25

### Added
- Fila persistente com autorização atual na admissão e publicação, recibos tardios e recuperação sem repetição de tentativa (#36).

## [0.17.0] - 2026-10-25

### Added
- Relações e afirmações atribuídas com referências canônicas, fonte vigente e cobertura limitada explícita (#38).

## [0.16.0] - 2026-10-25

### Added
- Leitura autenticada e restrita de snapshots da captura, com versões, limites e watermark por conversa (#69).

## [0.15.0] - 2026-10-25

### Added
- Fontes canônicas com versões, atribuição e controle de acesso por público, prova e mandato vigente (#35).

## [0.14.0] - 2026-10-25

### Added
- Ponte autenticada e retomável de metadados da captura, com inbox persistente e recibos por sequência (#34).

## [0.13.0] - 2026-10-25

### Added
- Feed transacional de mudanças em mídia, derivados e captura para a assistente (#33).

### Fixed
- Publicação de mídia com triggers D1 e conservação de R2 quando a confirmação do banco se perde.

## [0.12.0] - 2026-10-25

### Added
- Feed transacional de metadados para inserções, correções e retiradas da captura (#32).

### Fixed
- Callback sintético de exclusão alcança o normalizador existente após as verificações do webhook; emissão real pelo provedor ainda não homologada.

## [0.11.0] - 2026-10-25

### Added
- Missões, FUPs versionados, ocorrências únicas e jobs separados, sem confundir conclusão simulada com contato real (#31).

## [0.10.0] - 2026-10-25

### Added
- Pessoas e identidades comprovadas, projetos, políticas por conversa e mandatos versionados no banco da assistente (#30).

## [0.9.0] - 2026-10-25

### Added
- Schema canônico da assistente com fontes, versões imutáveis, tombstones e cursores separados; oito testes D1 (#29).

### Added
### Changed
### Fixed
### Removed

## [0.8.0] - 2026-10-25

### Added

- Runtime próprio da assistente em sombra, sem credenciais ou bindings de envio, com saúde e recusa explícita de ações externas.
- Plano rastreável de construção, revisão adversarial e build isolado obrigatório no CI.

## [0.7.0] - 2026-10-25

### Added

- Geração de MP3 com voz própria previamente cadastrada no Fish Audio via API na nuvem, desativada por padrão, com prévia autenticada e armazenamento privado.
- Registro persistente de geração, deduplicação concorrente e resultado incerto sem repetição automática; envio exige pedido explícito do dono e proposta vinculada ao arquivo final e destinatário, sem confirmação adicional após geração.

### Fixed

- Dependências transitivas body-parser e fast-uri atualizadas para remover avisos de segurança da base.
- Novas autorizações do GPT duram 30 dias absolutos, em vez de exigir reconexão diária; cadastro do cliente dura 90 dias e tokens de acesso continuam em cinco minutos. Autorizações existentes exigem uma reconexão para receber o prazo novo.
- Falhas inesperadas de armazenamento/runtime no OAuth respondem indisponibilidade temporária (503), com orientação de retry, em vez de acesso negado (403).


## [0.6.0] - 2026-10-21

### Added

- Transcrição automática dos áudios novos recebidos, com Whisper Turbo, fila limitada, cota diária e texto vinculado à versão da mensagem.
- Consulta e busca incluem transcrição separada do original, com estados de processamento, falha e pausa.
- Áudios recebidos de até 10 minutos e 20 MiB; uploads e envios preservam limites anteriores.

### Fixed

- Configuração de download passa a permitir a origem exata verificada das mídias recebidas; HTTPS, bloqueio de redirects e validação de conteúdo permanecem ativos.

## [0.5.2] - 2026-10-20

### Fixed

- Botões de atualização do Client-Token e conexão no GPT têm espaçamento próprio; conexão no GPT recebe estilo secundário, preservando o formulário e o comportamento móvel.

## [0.5.1] - 2026-10-20

### Fixed

- Página privada permite atualizar somente o Client-Token da Z-API em uma conexão já configurada, validando o aparelho antes de salvar.
- Token inválido ou formulário concorrente preserva a chave salva; instância, webhooks, OAuth, captura e histórico permanecem os mesmos.

## [0.5.0] - 2026-10-20

### Added

- Captura automática opt-out: padrão global ligado para conversas novas, descoberta autenticada pelo webhook e exceções persistentes por conversa.
- Migração estrutural idempotente mantém desativados antigos em revisão; métricas agregadas, lacunas e ferramenta de diagnóstico de captura.

### Fixed

- Guards transacionais impedem gravação de autor/mídia e conclusão de download após opt-out concorrente; propostas incluem revisão de captura.

## [0.4.2] - 2026-10-19

### Fixed

- Catálogo MCP publica os campos de preparar_envio em um objeto válido, preservando validação estrita por tipo e envio de imagem com legenda.
- Registros explicitamente marcados como não-grupo na resposta da Z-API deixam de bloquear a busca; paginação bruta, contagem de exclusões e limites preservados.
- Recusas HTTP explícitas mantêm o código sanitizado e encerram a ação como rejeitada; timeout, rede, 408 e resultado desconhecido continuam incertos, sem repetição automática.
- Instruções do Zap explicam localização automática de uploads e proíbem substituir silenciosamente imagem por texto.

## [0.4.1] - 2026-10-19

### Changed

- Upload, resultado, consentimento, confirmações, convites e erros seguem o padrão visual da configuração privada.
- Páginas humanas mostram nomes, ações e próximos passos sem JSON, hashes ou identificadores internos.
- O cliente pode consultar os dez uploads recentes da conversa sem pedir códigos ao dono; isolamento e compatibilidade JSON preservados.

## [0.4.0] - 2026-10-19

### Changed

- Autorização no chat para envios, criação de grupos e operações comuns; proposta retorna o canal exigido pelo servidor. Pedido humano com destino/conteúdo exatos pode autorizar sem pergunta repetida.
- Página Access reservada para exclusão/limpeza, redução de retenção, temporárias ativadas, remoção de pessoas/saída, administradores/permissões e vínculos com comunidades.
- Confirmações críticas mostram nomes, mudanças e consequências; IDs/JSON/hash ficam em detalhes recolhidos. Resultado da página também é legível.
- Auditoria registra `chat_client` ou `page`. Confirmação no chat é declaração do cliente autenticado, não prova humana independente. Integridade, expiração, isolamento e tentativa única preservados.


## [0.3.0] - 2026-10-19

### Added

- Página privada de primeira configuração da instância Z-API, com três campos, login Access do dono, nonce próprio e verificação antes da ativação.
- Credenciais cifradas com chave exclusiva do Worker, tentativa imutável e retomada após falhas, sem exibir segredos ao navegador/MCP/logs.
- Configuração de callbacks com recusa de integração estrangeira e readback; runtime em modo database fechado até conexão ativa.
- Plugin privado WhatsApp pessoal para GPT, OAuth/DCR e botão de conexão após configuração.
- Recursos Cloudflare exclusivos e publicação em whatsapp.robsonlins.com; testes de segurança/recuperação/roteamento e verificação visual mobile/desktop.

### Fixed

- Busca de contatos sincroniza automaticamente a agenda em lotes limitados, com continuação explícita e cache de 15 minutos separado por tipo; busca vazia consulta também cadastro de conversas, sem ler mensagens.
- Filtro combinado por nome e final do telefone (4–15 dígitos), sem tratar LID/grupo como telefone nem expor número completo.
- Sincronização manual não contamina a cobertura automática; conferir aparelho antes/depois do lote e preservar captura desabilitada.

- Consentimento OAuth permite o redirecionamento somente à origem validada do cliente; preserva nonce único e proteção de origem.
- Transporte fetch no Workers, normalização de credenciais coladas e contratos opcionais de callbacks da Z-API.

### Notes

- Primeira conexão apenas; alteração de conexão ativa exige fluxo específico futuro. Captura continua desabilitada até autorização por chat.
- Login, submissão da instância e consentimento no GPT pertencem ao dono. Zap autenticado no GPT e consulta paginada real à Z-API validados. Envios, alterações de grupos e download real de anexos recebidos não foram homologados.

## [0.2.0] - 2026-10-19

### Added

- Gestão das 35 operações documentadas de grupos/chats/associações de comunidade via 12 novas ferramentas MCP e união fechada de 26 ações.
- Criação/entrada, nome/foto/descrição, participantes e admins, permissões, convites privados, menções, organização/leitura/limpeza/exclusão/temporárias de chats e vínculos com comunidades.
- Propostas com alvos legíveis e compromisso privado, confirmação Access com purpose próprio, claim atômico e uma tentativa por ação; resultados parciais e recuperação local sem repetir efeito.
- Participantes/comunidades com referências próprias, metadados paginados e papéis desconhecidos explícitos; links de convite somente em página privada.
- Inventário com fontes oficiais, matriz de cobertura, manual e regressões de contrato, segurança, migração e jornada MCP/OAuth/Access.

### Fixed

- Identificadores oficiais `-group` preservados, menções resolvidas por referência interna e delay de 1–15 segundos.
- Exclusão local redige ações relacionadas inclusive a alvos secundários e grupos recém-criados; limpeza de ações antigas preserva estado mínimo e respeita epoch/geração.

### Notes

- Cobertura de software e contratos verificada com rede/dados sintéticos. Instância própria, deploy, permissões e comportamento real de WhatsApp/clientes continuam pendentes.
- API não documenta listagem de pedidos pendentes nem combinação de menções com mídia/resposta; aplicação de temporárias a grupos aguarda ensaio real.

## [0.1.0] - 2026-10-19

### Added

- Arquivo pessoal de conversas individuais/grupos, autores separados, deduplicação, edição, proteção de mensagens temporárias e cobertura com lacunas.
- MCP remoto com schemas fechados, OAuth/Access do dono e confirmação humana independente para envios/políticas/exclusão.
- Mídia privada em R2, captura durável limitada, upload/download com hash e transcrição de áudio selecionado com opt-in.
- Texto/imagem/PDF/áudio por adaptador Z-API, proposta imutável, uma tentativa e conciliação de status sem retry cego.
- Retenção opcional, exportação paginada, exclusão local recuperável, diagnóstico, manual, CI e smoke local.

### Fixed

- Replay de privacidade, concorrência em status, paginação de conteúdo grande e registro de interrupções de captura identificados na revisão independente.
- Conciliação de callback antes da resposta em chat sem captura e rejeição de formato não enviável antes da tentativa.

### Notes

- Software validado localmente; sem instância Z-API própria, deploy ou homologação real. Ativação pendente por instrução explícita do dono.
- Limites: arquivo até 2 MiB; conteúdo MCP até 128 KiB; WAV para arquivo/transcrição; áudio enviável Ogg/MP3/M4A. Sem OCR, importação retroativa ou administração de grupos nesta versão.

## [0.0.1] - 2026-10-19

### Added

- Marco zero: handoff documental, PRD e plano de implementação; repositório público próprio.
