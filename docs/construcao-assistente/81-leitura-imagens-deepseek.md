# Leitura visual com o modelo configurado

O arquivo pode estar capturado e disponível sem que tenha sido interpretado. O caso observado era um JPEG válido, com objeto armazenado; a ferramenta nativa retornou `media_context_unconfigured` porque a flag de mídia estava desligada. Não era evidência de imagem corrompida.

## Caminho

O agente decide usar `media_read` para uma referência autorizada. O host confere fonte, versão, hash, captura, grupo/exclusões e contexto; busca os bytes pela capacidade privada existente e confere o hash. A interpretação usa o mesmo provedor selecionado para a conversa. Com DeepSeek, usa `deepseek-flash` por Chat Completions, imagem inline, thinking desligado e JSON de observações/texto visível. Não há URL pública, upload Files, escolha de endpoint pelo modelo ou fallback para outro provedor.

O resultado volta como observação derivada, com referência ao arquivo original. Conteúdo da imagem não concede instruções, identidade ou autorização. Um print de erro não comprova, sozinho, sua causa no backend ou perda de dados. Os originais são preservados e a retirada da fonte invalida o uso da interpretação.

O caminho aceita os formatos estruturais já admitidos pelo sistema: JPEG, PNG e WebP dentro dos limites existentes. No provedor DeepSeek, PDF retorna pendência explícita antes de buscar bytes ou cobrar inferência. A existência do parser não comprova suporte multimodal completo; o caminho OpenAI anterior permanece separado e não é acionado automaticamente.

## Custo e custódia

O limite conservador por interpretação DeepSeek é11.060microUSD, ou US$0,011060, sem desconto de cache: entrada até4.096 e saída até8.192tokens, com preços de pico configurados de US$0,30/US$1,20 por milhão. O guia oficial limita uma imagem a1.024tokens; o host restringe o texto fixo a2.048bytes UTF-8 e reserva1.024tokens de margem para framing. Cem leituras representam até US$1,106 nessa etapa, além da pesquisa/resposta da conversa e da infraestrutura existente. Isso é um limite de reserva, não uma fatura nem estimativa do gasto normal.

O orçamento global e o período existente continuam sendo conferidos antes do transporte. Provider/modelo/preço/formato entram na identidade da configuração; recibos antigos não são reprecificados. Usage válido é preservado mesmo quando a saída é truncada ou inválida. Outra configuração não pode contornar uma tentativa paga ainda não resolvida do mesmo parent: o veto aparece na admissão SQL e no último snapshot antes do upload. Parsing/prepared não criam um bloqueio mútuo de preparações. A interpretação concluída é reutilizável pelo mesmo recibo.

Referências oficiais: [visão e tokenização](https://api-docs.deepseek.com/guides/vision/), [Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/), [preços](https://api-docs.deepseek.com/quick_start/pricing/).

## Verificação

Em30/10/2026, o bot executou a leitura de um JPEG real pelo DeepSeek na Cloudflare e respondeu no Telegram identificando o aviso da tela. Recibo visual concluído:426microUSD; a conversa do agente tem custo separado. A evidência185 registra o escopo e as limitações.

A legenda mantém texto e referência próprios. A ferramenta aceita a referência da mensagem ou do arquivo, confere seu vínculo e usa o mesmo parent/recibo da imagem. Quando os bytes ficam prontos depois da mensagem, a projeção é reconciliada; uma conversa já respondida não é reativada por essa recuperação. Foto sem legenda retorna ausência explícita.

Os testes dirigidos cobrem protocolo/endpoint, JSON inválido e truncamento com cobrança preservada, cache do artefato, custódia entre configurações, legado e isolamento de PDF. A regressão concorrente primeiro mostrou dois uploads e passou com um upload após o guard atômico. A prova real deve registrar separadamente a interpretação útil pelo bot, seu recibo e sua reutilização; testes locais não bastam para anunciar entrega.
