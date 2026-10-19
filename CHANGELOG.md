# Changelog

Todas as mudanças relevantes são registradas aqui, no formato Keep a Changelog.

## [Unreleased]

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
