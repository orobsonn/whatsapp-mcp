# Recuperação da revisão diária por orçamento — 31/10/2026

## Causa confirmada

O recibo original Flue da revisão referente a 30/10 terminou `failed` em 31/10 às 06:18:07 UTC, com `budget_exhausted`. Não é atribuído a erro de captura, à publicação v0.52.1 ou à falha de um fornecedor.

A conta UTC de 31/10 tinha teto de 600.000 microUSD e 294.814 comprometidos. Restavam 305.186, insuficientes para a reserva conservadora de 319.661 exigida por outra chamada DeepSeek. O teto reserva a janela completa instalada mais a saída máxima, sem reduzir histórico ou liberar incertos. Consumo realizado e reserva máxima são grandezas distintas.

## Correção operacional autorizada

O dono pediu investigar, corrigir e concluir o pendente. Revisão adversarial explícita exigiu preservar recibos e incertos, confirmar encerramento do predecessor, manter a configuração de retomada durante a execução e verificar cobertura além do settlement SDK.

Os cinco períodos já configurados (31/10 a 04/11) passaram condicionalmente de 600.000 para 2.000.000 microUSD cada. São tetos diários compartilhados da instalação, não novos saldos contratados nem orçamento exclusivo do curador. O guard geral de 10.000.000 microUSD e o carry externo permaneceram intactos. Tetos diários não autorizam ultrapassar o guard geral; a recuperação não garante execução ilimitada após atingir esse teto ou após as datas configuradas. Nenhum recibo ou reserva foi apagado/reclassificado.

O censo anterior à recuperação conservou 6.763.494 microUSD comprometidos e 381.277 incertos nos ledgers conhecidos, sem equivaler a fatura do fornecedor. A margem do aumento do dia corrente foi conferida com provisões externas conservadoras.

A configuração publicada reutilizou os 22 módulos ativos byte a byte, com conferência de hashes, todos os demais bindings, runtime/containers, agendamento e modo aprovação preservados. Não houve alteração de código nem nova versão funcional. O pedido de retomada selecionou o predecessor exato, no mesmo run/sessão/janela, sem reiniciar a submissão encerrada. A nova revisão foi admitida e iniciou execução às 12:01:44 UTC. A primeira chamada ultrapassou o bloqueio antigo e terminou com recibo financeiro completo.

## Resultado

A continuação terminou `completed`, sem erro, em 31/10 às 12:31:01 UTC. Foram nove chamadas com recibo completo, acrescentando 773.372 microUSD ao dia corrente, sem novo incerto. A passagem registrou 116 fontes avaliadas, 2 com aprendizado confirmado, 128 indisponíveis, 613 fora da política, 32 substituídas e 226 retiradas. Não havia itens pendentes, apresentados ou em indexação. O domínio permaneceu `partial/needs_help`, com 245 lacunas de captura: término do SDK não foi convertido em cobertura completa.

O seletor de retomada foi removido depois do settlement. A primeira restauração reutilizou uma versão anterior de módulos idênticos; a consulta de settings ainda mostrava a versão mais recentemente enviada. Não se repetiu aquela publicação. Uma remoção explícita reconciliou versão ativa e settings sem o seletor, preservando todos os demais bindings e os bytes do código.

## Seis textos anteriores à ativação

A investigação das lacunas encontrou seis textos individuais legíveis e autorizados no Source, presentes no inbox Own, mas ainda sem projeção canônica ou tentativa de materialização. O corte de ativação nativa impedia também sua projeção, além de impedir resposta retroativa. Não foram classificados como conteúdo perdido.

Revisão adversarial recomendou reparo operacional limitado aos seis, sem baixar o corte, drenar o acervo inteiro ou criar manutenção genérica. Um operador temporário autenticado pelo segredo administrativo existente chamou somente `CaptureMaterializer.process` para a allowlist exata de sequência/hash/namespace. Guardas de vínculo, retenção, quarentena e política envolveram a transação D1; Source e proveniência foram revalidados. O segredo do bridge permaneceu no ambiente do Worker. Nenhum corpo, token ou número de telefone entra neste documento/Git.

Oito verificações dirigidas cobriram autenticação, geração/hash divergentes, fonte retirada, mudança de política durante a leitura e na admissão do batch, projeção/replay sem versão duplicada ou evento nativo, e proveniência atual. A reprodução inicial falhou; o reparo passou. Typecheck e build Own passaram. Os testes e o operador são artefatos privados temporários, sem aumentar a suíte permanente do projeto.

O operador projetou os seis textos e não criou eventos nativos para essas fontes. As seis novas alterações canônicas foram conferidas, sem fontes concorrentes dentro da janela complementar. O operador foi removido logo após o readback; módulos originais foram restaurados byte a byte e bindings/runtime/horários preservados.

A avaliação complementar usa a capacidade de sample existente, limitada às seis novas projeções. Uma sample não encerra os capture gaps da diária original; seus resultados devem ser relatados separadamente, sem mutação manual dos recibos. A passagem complementar terminou `completed`, sem erro, em 31/10 às 13:05:28 UTC. As seis fontes foram marcadas como avaliadas, sem aprendizado adicional. Não restaram fontes pendentes, apresentadas, indisponíveis ou em indexação nessa sample. A configuração temporária foi removida após o settlement; o agendamento diário voltou a `true`, sem pedido de sample ou retomada ativo e com o modo aprovação preservado.

O censo final conservou 7891009 microUSD comprometidos nos ledgers conhecidos, incluindo 381.277 incertos anteriores. Não é fatura do fornecedor. O teto geral de 10.000.000 microUSD permaneceu sem aumento.

A separação permanente entre projeção do acervo e ativação de resposta foi registrada em [#149](https://github.com/orobsonn/whatsapp-mcp/issues/149). A recuperação desta rodada foi operacional e limitada; não se criou um mecanismo genérico de manutenção nem se ampliou a suíte permanente de testes.
