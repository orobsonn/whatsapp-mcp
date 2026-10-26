# #55 — catálogo do export após a composição de restauração

CI integrada [40378903500](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40378903500), commit `7d7a0b6ea769ac16f137efa4e0d3248573229440`: **1140 passaram, 10 falharam**, todas as falhas com `export_schema_unsupported:assistant_retention_runtime_hold`. Não foi homologação nem gate aprovado.

O conjunto fechado `installationWide` já atribuía esse diagnóstico à instalação, mas a validação PRAGMA ainda exigia a coluna `generation` de todas as tabelas. O hold da instalação tem `target_generation`, e o seletor de geração ativa precisa continuar exportável mesmo quando diverge da geração consultada. A correção mantém `installation_id` obrigatório em todas; dispensa `generation` apenas nos nomes já aprovados desse conjunto. Tabelas desconhecidas não ganham escopo global por inferência.

**24/24 GREEN**, dois arquivos `assistant-retention.test.ts` e `assistant-retention-authority.test.ts`, em 25,04 s. Além das dez falhas reais da CI, os novos casos verificam hold e geração ativa próprios, exclusão da outra instalação e recusa de tabela desconhecida sem geração. Não modifica snapshot canônico, autoridade externa, dados reais, migrações ou orçamento. Gate completo no próximo HEAD continua obrigatório. Nenhum modelo chamado.
