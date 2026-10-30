# DeepSeek direto no runtime nativo

Em 30/10/2026, o dono pediu a API direta da DeepSeek como padrão e entregou a chave por formulário loopback privado. As consultas não pagas de modelos e saldo confirmaram credencial válida, `deepseek-flash` disponível e saldo disponível. Nenhuma chave entra no repositório, no prompt ou nos recibos.

O runtime reutiliza o provider DeepSeek da versão instalada Pi1.1.0, via Chat Completions, sem criar adaptador de histórico. Seleção explícita do host fixa `deepseek/deepseek-flash`, thinking high e endpoint oficial. A documentação identifica esse nome com V4.1-Flash-1017. Sessões e epochs do Flue permanecem; o histórico não é apagado para trocar fornecedor. Configuração inválida ou chave ausente não dispara fallback pago.

O mesmo controle financeiro cobre chamadas, ferramentas e pedidos de resumo: reserva anterior ao transporte, claim único, tarifas e versão próprias, retenção das incertezas e teto global anterior. Contabilização conservadora usa prompt_tokens completo a US$0,30/M e completion_tokens a US$1,20/M, incluindo reasoning uma vez, sem presumir descontos de cache/horário. Exemplo: 20mil entrada +2mil saída = US$0,0084 por chamada, não por tarefa inteira.

Verificação local: 134 testes em quatro arquivos, TypeScript e build passaram. O ensaio Pi faz chamada de função, resultado, reasoning e resposta seguinte; atravessa histórico OpenAI com par chamada/resultado sem repassar reasoning opaco. Verifica também o protocolo de chamada de resumo, recibos, retirada de autoridade, falhas e ausência de novas tentativas pagas. O pedido de resumo sintético não é prova de compactação efetivamente disparada pelo Flue. A comprovação do fornecedor ativo e uso real na Cloudflare fica separada desta validação local.

Revisão adversarial sem achados críticos/importantes de seleção, autoridade ou custos. O timeout de transporte de90s permanece uma limitação operacional observável; resultado incerto não é repetido automaticamente. O envio autônomo WhatsApp permanece desligado. Mídia e componentes legados não são ativados pela troca do modelo.

Fontes oficiais: [modelos e tarifas](https://api-docs.deepseek.com/quick_start/pricing/), [thinking e continuidade das ferramentas](https://api-docs.deepseek.com/guides/thinking_mode/), [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/).

Publicação confirmada no Own: `8d5e8a79-76f5-44ed-884e-74244eb00599`, com `NATIVE_MODEL_PROVIDER=deepseek` e secret DEEPSEEK_API_KEY presente. Demais bindings, runtime, agenda do curador e modo de aprovação foram preservados. Health confirma autonomia de envio falsa. Essa leitura de configuração ainda não é prova de uma resposta real produzida pelo DeepSeek; a próxima interação do bot precisa ter seu recibo de modelo verificado.
