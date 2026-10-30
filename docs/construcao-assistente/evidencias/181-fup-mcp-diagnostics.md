# Diagnóstico de fup.put no MCP

Em 30/10/2026, duas tentativas com datas distintas, fonte de nota do dono e projetos existentes retornaram `operation_failed`. A inspeção somente leitura na produção confirmou: nenhum dos dois IDs de follow-up nem dos dois operationIds estava persistido; fonte ativa rev1/v1 e projetos rev1 existiam. A captura das duas conversas estava habilitada. Uma é individual e a outra é grupo; nenhuma tinha a política explícita exigida pelo contrato desse FUP.

Causa reproduzida: OwnerControl rejeita `fup.put` sem outgoing e com policyRevision0 antes de criar o ledger ou qualquer follow-up. Essa rejeição era um Error de domínio convertido em erro genérico no Source/MCP. As datas ISO com offset -03:00 e America/Fortaleza passam pelo parser e não causaram essa rejeição. Captura e política de atendimento não são intercambiáveis.

Correção: código específico `control_policy_required`, campo policyRevision e mensagem estática de orientação, atravessando o handler MCP. Apenas a operação administrativa traduz um vocabulário fechado de erros conhecidos; exceções inesperadas continuam privadas, sem SQL, IDs, corpo de fonte ou segredos. O catálogo explica a exigência de política e a exceção outgoing. Nenhuma política foi habilitada para contornar o erro.

Regressões: dois formatos de data, duas rejeições com zero escritas, resposta MCP com diagnóstico e sem conteúdo privado, exceção remota arbitrária oculta, criação sintética com política válida e estado awaiting_approval, replay após perda de confirmação com uma única linha e zero jobs. Quatro arquivos e107 testes passaram, além de TypeScript e builds de Source/Own. Fixture adicional prepara o mesmo ensaio com namespace sintético em D1 isolado, sem capacidade de envio, finalizando os registros em paused; o resultado remoto deve ser registrado separadamente após execução.

Os dois pedidos reais continuam não criados. Correção do diagnóstico não equivale a agendamento, execução ou autorização de contato. Nenhum envio WhatsApp, follow-up real, mudança de captura ou duplicação de dados reais é parte desta validação.
