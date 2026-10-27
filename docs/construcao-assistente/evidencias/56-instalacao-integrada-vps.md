# #56 — instalação própria integrada e readbacks de código

27/10/2026. Consolidação documental sobre `6b4bd49822a2da27f67ccc77409969bf8d80ea40`, [CI40428641551 aprovada](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40428641551). Preserva a cronologia dos documentos anteriores: recursos, Worker inicialmente inativo, ponte e cron foram etapas distintas. Este documento não modifica código, configurações, versão ou changelog.

O [JSON de evidência](56-instalacao-integrada-vps.json) fixa hashes dos comprovantes privados. O probe remoto somente de leitura confirmou saúde/afinidade em sombra pausada e rejeição reader_denied para segredo incorreto no novo leitor de destinatários. O diagnóstico MCP existente também respondeu autenticado com versão0.40.0, cercas configuradas e manutenção desativada. Corpos, afinidades, valores de secrets e contagens de uso pessoal não são publicados.

| Critério | Prova e alcance |
| --- | --- |
| #ac-16.301 — recursos reproduzíveis, migrações e secrets privados | Renderer/validator/CLI e builds oficiais têm provas locais/CI. [Recursos próprios](56-own-resources-vps.md), [instalação inicial](56-worker-inactive-vps.md) e aplicação observada de0026 compõem a instalação real. Readback6b4 conservou cinco namespaces DO, imagem/runtime, serviços, banco/R2 e markers de cinco secrets da Own. Marker prova presença/tipo/preservação, não valor ou funcionamento de cada provedor. Não foi aplicado0027 nesta etapa. |
| #ac-16.302 — saúde verifica bindings/configuração | Health implementada verifica metadata D1, afinidade nominal, R2 próprio, autoridade externa, flags/pausa e orçamento sem iniciar Container/modelo ou renovar OAuth. Contraprovas locais/CI incluem segredo incorreto e mudança durante await. | 
| #ac-16.303 — cron independente do computador | [Ciclos naturais pós617](53-56-natural-cron-vps.md) foram observados na plataforma sem tick ou scheduler mantido por operador local; pelo menos três janelas distintas concluíram com processamento pausado. Readback6b4 preservou `fetch`/`scheduled` e o cron existente. Não foi feita avaliação sem pausa nem novo ensaio de desligamento físico da VPS. |
| #ac-16.304 — conservar MCP e Elo | [Ponte e capability real](56-cloud-bridge-and-owner-smoke-vps.md) têm prova própria. Atualização6b4 fez PUT somente de código: Source29 bindings e Own26 preservados, com cron/exposição/rotas/domínio/settings/runtime conferidos. CaptureReader ganhou somente o RPC readonly esperado `readRecipientEnvelope`. O diagnóstico MCP existente respondeu autenticado na versão0.40.0 após o upgrade; novo catálogo no cliente continua pendente da #46. Elo/Access não foram modificados. |
| #ac-16.305 — rollback não desfaz migração | O [runbook](../operacao.md) distingue reaplicar código/configuração compatível de recuperar dados. Os uploads6b4 não fizeram DDL, reset de ledger, mudança de namespace/geração, rekey de tentativa ou limpeza de estado. Não se executou rollback real para alegar reversão de migrações. |

Para302, o RPC real confirmou schema pronto, autoridade selada, artefatos próprios e afinidade com captura. O novo reader recusou segredo incorreto antes do status, conforme o caminho do código; não foi alegado contador de rede. Resultado, hash e cleanup do operador/remote proxy foram conferidos. A observação de saúde é distinta dos readbacks de metadata e não iniciou modelo ou Container.

## Readbacks finais preservados

| Worker | Versão observada | Inventário |
| --- | --- | --- |
| Source | `47e637b5-9a12-416a-a676-49bd444e1775` | Um módulo;29 bindings; serviços/secret markers existentes preservados; somente expansão readonly esperada no reader. |
| Own | `83542665-7413-47eb-9b82-9ee1e9fa8d72` | Três módulos;26 bindings; cinco DOs e cinco markers de secrets; imagem/migration tag/runtime preservados. |

O build exato foi conferido por receipt/hashes; cada PUT teve journal durável anterior, ACK com versão fixada e GET de módulos/settings/runtime/handlers/exposição/cron. O Source usou como baseline a ponte já ativa, não o antigo recibo com27 bindings. Nenhum resultado incerto autoriza repetir PUT automaticamente.

Na Own continuam `ROUTINES_ENABLED=shadow`, `ROUTINES_PAUSED=true`, `MEDIA_CONTEXT_ENABLED=false` e `TELEGRAM_SUMMARIES_ENABLED=false`; workers.dev/previews permanecem desativados. O cron privado existente continua na plataforma. Preservação desses gates não prova integração autenticada de Telegram/Google, saúde semântica, processamento Flue cloud sem pausa ou prontidão funcional de #57.

## Recuperação e pendências reais

Rollback de código/configuração exige versão anterior **compatível com o schema atual** e revisão dos gates; não desfaz migrações D1 nem efeitos externos. Não apagar DOs, recibos financeiros, tombstones ou latches para obter novo começo. Snapshot/restore tem protocolo próprio #55; export vivo não é backup atômico. As instruções são contrato de recuperação, não registro de rollback executado.

O probe remoto foi incorporado; não restam gates de metadata/saúde desta instalação. Vínculo/credenciais Telegram, consentimento Google e refresh/homologação do catálogo MCP são dependências humanas das respectivas integrações; não são substituídas por markers. A demonstração funcional completa #57 e os resultados reais do piloto permanecem separados.

Esta preparação documental não chamou modelo, alterou infraestrutura ou habilitou WhatsApp/Calendar write. Custo adicional de inferência: **US$0**; custos de infraestrutura não foram faturados/estimados aqui. Release minor, CI do commit final, versão/changelog/tag e fechamento cabem ao coordenador; a instalação sombra pausada não é anunciada como piloto homologado.
