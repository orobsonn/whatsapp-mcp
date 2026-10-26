# #56 — preparação dos readers no arquivo pessoal, VPS

Observação controlada em 26/10/2026. Esta etapa prepara a instalação; não conclui #56 nem homologa a assistente ou o piloto.

## Código e revisão

Cut preservado `codex/assistant-archive-affinity-stage`, commit `49292bd96f51154a61c82bfc009979abe325f813`: release integrada `f3e99b57d739510e2b9bc452eb8c70fc3b5fa03f` mais o handshake nominal de afinidade de leitura, originalmente `59b9269`. Não reinicia a implementação. [CI no commit exato](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40374973169) aprovada antes do upload; TypeScript e build local também passaram.

Revisão independente de `routine_final_review` confirmou: DDL 0012–0015 contém outbox de **metadados**, cursor e índices, sem backfill de corpos; readers negam sem a chave própria; `deliverCaptureChanges` retorna antes de consultar o D1 enquanto faltam binding/segredo/configuração da assistente. Conferida a interação dos triggers com `RETURNING` e contagens de mudanças do arquivo. Não houve novo gatilho de envio ou mudança em Access/Elo.

## Efeito observado na Cloudflare

Somente o Worker próprio `whatsapp-mcp` e seu D1 existente receberam esta etapa. Baseline do Worker: `941702a4-c474-487a-818f-08b3a4271c36`, configuração SHA-256 canônica `da84c3e0a7804bf9c10bce51958deb2301a02828cea217b1c8dcc71c9b724ef5`.

As quatro migrações aditivas foram aplicadas, com confirmação posterior de `d1_migrations` até `0015_assistant_reader_index.sql`. A primeira chamada da CLI foi **rejeitada antes da operação** por argumento `--yes` não suportado; nomes de migrações continuaram inalterados. Preservados log e recibo dessa tentativa. A chamada corrigida usou modo não interativo sem esse argumento e confirmou as quatro migrações. Não se repetiu uma tentativa de resultado incerto.

Build oficial `wrangler deploy --dry-run`: módulo `index.js`, 2.055.823 bytes, SHA-256 `026a223299385ea800221035ed9135180c76c88693986d5aa4d67938479a271c`. Upload REST único confirmado; versão ativa `4aad0059-75d4-49a8-8850-a555a2568cf2` a 100%. Download posterior confirmou o hash exato desse módulo. A API confirmou handlers padrão `fetch`/`scheduled` e named entrypoints `CaptureReader` (`readSnapshot`, `installationAffinity`) e `CaptureMediaReader` (`readBoundedMedia`).

Upload manteve todos os 23 bindings existentes por tipo, incluindo os secrets sem ler seus valores. Comparação posterior confirmou bindings, configurações de runtime, cron e subdomínio preservados. A única diferença de metadata foi a annotation de sistema `workers/triggered_by`, de `version_upload` para `upload`, correspondente ao endpoint utilizado. Verificação inicialmente estrita recusou essa diferença e uma expectativa incorreta do nome `MediaReader`; foram corrigidas as verificações contra os handlers reais, sem segundo upload.

O **cliente MCP conectado**, pela ferramenta tipada `zap_diagnosticar`, respondeu autenticado depois do deploy e informou versão `0.35.0`. Recibo agregado permanece privado; não se versionaram mensagens, nomes, contagens pessoais ou configuração secreta. Isso comprova preservação desse fluxo MCP, sem provar novos comandos owner-control, pareamento atual do fornecedor ou homologação dos canais da assistente.

## Estado e limites

Nenhum binding/var `ASSISTANT_*` foi adicionado ao arquivo nesta etapa. Não há bridge habilitado, backfill, envio de WhatsApp ou escrita Calendar. O Worker `personal-assistant-shadow` ainda não foi instalado por esta etapa. O handshake remoto e os gates da autoridade de retenção, configuração, orçamento, cron e cliente owner-control continuam pendentes.

Logs, plano, journals, metadata e recibos privados ficam em `local/assistant-build/personal-shadow-stage/archive-upgrade-49292bd-v1/`, fora do Git, com permissões restritas. Rollback de código não desfaz os triggers, índices ou tabelas aditivos; não se restaurou D1 nem se prometeu reversão das migrações.

Nenhuma chamada paga de modelo. Custos operacionais de D1/Worker/API não foram medidos pela fatura; não se apresentam como custo zero. O histórico financeiro do laboratório e as tentativas incertas anteriores permanecem intactos.
