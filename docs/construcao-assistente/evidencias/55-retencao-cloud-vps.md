# #55 — export, retirada, restore inativo e purga na Cloudflare

Ensaio controlado em 26–27/10/2026, com fontes e objetos sintéticos, host privado isolado e classes produtivas OwnerAssistant/RetentionAuthority. Código-base `6171513`, contratos de restore até `0025`; **não exercita a migração27** nem o novo contexto canônico Owner da #57. Esta documentação foi preparada sobre `7157b54`, sem modificar produção, CLI, versão ou changelog.

O [inventário JSON](55-retencao-cloud-vps.json) fixa SHA-256 dos comprovantes privados, sem publicar corpos, credenciais, afinidades ou endereços de objetos. As [provas locais](55-retencao-restore.md) e o [runbook](../55-retencao-restore.md) continuam necessários: o ensaio remoto tem tamanho e casos definidos, não substitui todas as contraprovas locais.

## Critérios e efeitos observados

| Critério | Prova real e limite |
| --- | --- |
| #ac-16.291 — export autenticado paginado | Capacidade privada nominal Owner: **16 páginas, 15 partes, 14 registros**, com hashes de linha verificados. Export completo da instalação autenticada, com financeiro das suas gerações; sentinela de outra instalação não pertence ao export. É export **vivo paginado**, não snapshot consistente de todo o ambiente. Autenticação/negações e limites também têm provas locais; não houve homologação do cliente MCP nesta rodada. |
| #ac-16.292 — bloquear antes de limpar | Após ACK de retirada, Source.query devolveu `unavailable` enquanto a observação D1 ainda encontrava versões/corpo, relação, permit e resposta. Bloqueio lógico antecedeu a purga física. |
| #ac-16.293 — nova geração externa e sombra | Snapshot produzido sob quiescência e autoridade externa retornou `sealed`, **9 linhas**. Restore no mesmo D1, em geração nova reservada externamente, retornou `inactive_complete`, `mode:shadow`, com **2 membros retirados ignorados** e quarentena exigindo reproof. Nenhuma troca da geração operacional ou ativação foi executada. |
| #ac-16.294 — jobs antigos não reativam | Release da mesma operação retornou `released_paused`: writers liberados, execução em hold. Observação D1: job antigo cancelado, zero jobs/contas no target e missão/FUP pausados. Tentativa administrativa controlada de retomar trabalho foi recusada por `restore_runtime_paused`. |
| #ac-16.295 — relatório por camada | Recibo da purga distingue `logicalBlock:withdrawn`, `d1:purged`, R2/índice externo/cópias externas pendentes e tombstone/financeiro/metadados retidos. Readbacks posteriores confirmam somente os objetos enumerados abaixo; não transformam o relatório em eliminação global. |
| #ac-16.296 — reconciliação R2 sem apagar referência/outro namespace | R2 confirmou ausência do objeto retirado e do órfão, e presença com hash exato das sentinelas referenciada e de outra geração. Um objeto com sua **única referência em outra instalação sintética** foi retido pelo coletor e relido com hash exato após perda de confirmação D1 **injetada explicitamente**. A observação independente já conhecia o commit real; não foi falha espontânea da rede. |
| #ac-16.297 — dependências antes do original | Purga produtiva completou o fechamento do namespace/fonte: observação final com **zero versões originais e zero relações**. O fechamento e a ordem das exclusões são também cobertos pelos testes D1 locais; a coleta remota final não é uma filmagem atômica de cada DELETE. |
| #ac-16.298 — permit/resposta removidos, custo preservado | Observação final com **zero model_permits e zero model_receipts derivados** da fonte purgada. Recibo financeiro sintético de valor zero permaneceu; soma real liquidada da mídia existente no D1 continuou **4.136 microUSD**. O registro sintético não é uma chamada de modelo ou fatura. |

## Restore e evidências que permanecem

O bundle selado é distinto do export vivo. Membership, páginas e cadeia de hashes foram verificados pelo produtor/importer reais; a geração de destino terminou inativa. O relatório conservou financeiro vivo de todas as gerações, sem importar contas do backup ou criar cap novo, e manteve a geração de credencial OAuth. Três registros de proveniência representaram duas versões distintas de trabalho, sem inferir novos pedidos humanos.

A fonte retirada depois do selo não reapareceu no target; a fonte retida permaneceu. Quarentenas, trabalhos pausados e hold continuam exigindo comandos explícitos e provas atuais. Não houve `activate_generation`, execução de jobs restaurados, identidade real reprovada, inferência, Telegram, envio WhatsApp ou escrita Calendar.

A purga D1 terminou em uma continuação da **mesma entrada/operação** após resposta conhecida pendente. Isso não é repetição automática de efeito incerto. O caso R2 de outra geração terminou em **HTTP502/estado incerto do operador, sem ACK classificado**; preservamos esse resultado e não atribuímos um motivo interno inexistente no transporte. A presença/hash da sentinela veio de readback separado. Nenhum retry automático foi realizado.

A injeção de perda de confirmação D1 tem registros separados de intenção, commit observado e visão incerta do chamador. O coletor encontrou a referência atual no outro namespace e preservou o objeto. Entrada inicialmente inválida e sua correção também foram conservadas no registro privado, sem reescrever o histórico como sucesso inicial.

## Escopo e limites

- Host e bucket do ensaio são separados dos recursos do piloto; o D1 existente foi usado com instalação/gerações sintéticas próprias. Não foi rollback físico, clone integral da produção ou restore para outro banco.
- Export e snapshot não carregam todos os namespaces do D1. Referências a R2 não equivalem a backup dos bytes; não houve cópia completa de mídias, índice ou histórico de provedores.
- A ausência física foi provada para os objetos enumerados. Originais do transporte, Telegram, checkpoints, snapshots Cloudflare e outras cópias externas continuam fora dessa eliminação. Não foi escolhida TTL nem executada limpeza em massa.
- Os operadores usados nas leituras/restore foram encerrados com confirmação de processo/grupo e remoção das credenciais temporárias; esses comprovantes são separados dos recibos de conclusão de cada operação.
- **Zero chamadas de modelo/provedor de inferência nesta rodada; custo adicional de inferência US$0.** Os 4.136 microUSD já liquidados pertencem ao ensaio de mídia anterior e foram preservados. Consumo de D1/R2/Workers não foi faturado ou estimado aqui.

As evidências remotas completam os casos controlados acima. Não homologam escala máxima do formato, restore físico, ativação da geração restaurada, cópias externas ou prontidão integral do piloto. Release, tag, CI do commit integrado e fechamento da issue são gates separados do coordenador.
