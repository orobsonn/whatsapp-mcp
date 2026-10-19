# Changelog

Todas as mudanças relevantes são registradas aqui, no formato Keep a Changelog.

## [Unreleased]

## [0.3.0] - 2026-10-19

### Added

- Página privada de primeira configuração da instância Z-API, com três campos, login Access do dono, nonce próprio e verificação antes da ativação.
- Credenciais cifradas com chave exclusiva do Worker, tentativa imutável e retomada após falhas, sem exibir segredos ao navegador/MCP/logs.
- Configuração de callbacks com recusa de integração estrangeira e readback; runtime em modo database fechado até conexão ativa.
- Plugin privado WhatsApp pessoal para GPT, OAuth/DCR e botão de conexão após configuração.
- Recursos Cloudflare exclusivos e publicação em whatsapp.robsonlins.com; testes de segurança/recuperação/roteamento e verificação visual mobile/desktop.

### Notes

- Primeira conexão apenas; alteração de conexão ativa exige fluxo específico futuro. Captura continua desabilitada até autorização por chat.
- Login, submissão da instância e consentimento no GPT pertencem ao dono. Homologação Z-API/GPT e download real de anexos recebidos dependem dessas etapas.

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
