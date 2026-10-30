# Diagnóstico de fup.put no MCP

Em 30/10/2026, duas tentativas com datas distintas, fonte de nota do dono e projetos existentes retornaram `operation_failed`. A inspeção somente leitura na produção confirmou: nenhum dos dois IDs de follow-up nem dos dois operationIds estava persistido; fonte ativa rev1/v1 e projetos rev1 existiam. A captura das duas conversas estava habilitada. Uma é individual e a outra é grupo; nenhuma tinha a política explícita exigida pelo contrato desse FUP.

Causa reproduzida: OwnerControl rejeita `fup.put` sem outgoing e com policyRevision0 antes de criar o ledger ou qualquer follow-up. Essa rejeição era um Error de domínio convertido em erro genérico no Source/MCP. As datas ISO com offset -03:00 e America/Fortaleza passam pelo parser e não causaram essa rejeição. Captura e política de atendimento não são intercambiáveis.

Correção: código específico `control_policy_required`, campo policyRevision e mensagem estática de orientação, atravessando o handler MCP. Apenas a operação administrativa traduz um vocabulário fechado de erros conhecidos; exceções inesperadas continuam privadas, sem SQL, IDs, corpo de fonte ou segredos. O catálogo explica a exigência de política e a exceção outgoing. Nenhuma política foi habilitada para contornar o erro.

Regressões: dois formatos de data, duas rejeições com zero escritas, resposta MCP com diagnóstico e sem conteúdo privado, exceção remota arbitrária oculta, criação sintética com política válida e estado awaiting_approval, replay após perda de confirmação com uma única linha e zero jobs. Quatro arquivos e107 testes passaram, além de TypeScript e builds de Source/Own. Fixture adicional prepara o mesmo ensaio com namespace sintético em D1 isolado, sem capacidade de envio, finalizando os registros em paused; o resultado remoto deve ser registrado separadamente após execução.

Os dois pedidos reais continuam não criados. Correção do diagnóstico não equivale a agendamento, execução ou autorização de contato. Nenhum envio WhatsApp, follow-up real, mudança de captura ou duplicação de dados reais é parte desta validação.

## Resultado remoto

O Worker de teste existente, com D1 separado da produção, executou o fixture com sucesso. Nos dois casos: revisão0 recusada sem gravação, revisão1 sintética aceita, repetição com o mesmo recibo, uma linha da versão1 e estado awaiting_approval. Datas persistidas: 03/11/2026 e05/11/2026 às13:00UTC, correspondentes às10:00 de America/Fortaleza. Ao fim, ambos ficaram paused. Zero jobs, zero chamadas de IA e nenhuma capacidade de envio disponibilizada ao fixture. O primeiro upload do probe foi recusado por faltar um módulo de assets; a versão ativa ficou preservada, o inventário de módulos foi corrigido e a publicação seguinte foi confirmada antes de executar o ensaio.

Own publicado em `8d5e8a79-76f5-44ed-884e-74244eb00599`; Source em `28f2ae70-4c70-4d21-9f1e-b9240d354893`, com bindings, runtime, horários e configuração de captura preservados. Pelo conector Zap desta conversa, dois comandos diagnósticos sintéticos de revisão0 devolveram efetivamente `control_policy_required`, campo e orientação, atravessando o RPC real. SELECT posterior confirmou ausência tanto desses IDs diagnósticos quanto dos dois IDs reais no ledger e nos follow-ups de produção. Health de Source e Own respondeu; envio autônomo continua falso.
