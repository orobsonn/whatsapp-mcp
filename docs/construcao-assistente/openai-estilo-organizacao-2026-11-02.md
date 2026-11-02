# OpenAI, escrita do dono e organização Flue

Pedido do dono em 02/11/2026: usar OpenAI, considerar GPT-6.1 Sol, analisar suas mensagens para construir uma skill de escrita e proibir travessões e sinais usados como pausa. A referência de organização é o victor-bot. Leitura comparativa apenas; nenhuma implementação ou configuração foi copiada.

## Entrega

- [x] Organizar a aplicação em `assistant/.flue/{agents,tools,skills,instructions,providers}`. Infraestrutura e políticas continuam em `assistant/`. Preservar nomes dos agentes, Durable Objects, identidades e sessões. Configurar entrada única explícita, sem descoberta ampla.
- [x] Adicionar seleção explícita `NATIVE_OPENAI_MODEL=gpt-6.1-sol`, sem fallback de fornecedor. Catálogo, transporte, preço e recibos devem usar o mesmo modelo. Preservar Luna como configuração legada e extração/embeddings existentes.
- [x] Criar e montar a skill `escrever-como-robson` apenas na redação em nome do dono no WhatsApp. Separar estilo de fatos, intimidade e autorização; não afetar a curadoria.
- [x] Validar carregamento pelo Flue, isolamento por papel, protocolo de ferramentas/histórico, contabilização e falha incerta. Compilar a aplicação real.

## Base de estilo

Consulta somente leitura do arquivo em 02/11: janela desde 20/10, mensagens de saída de texto disponíveis em conversas com captura ativa, excluindo correlações com ações conhecidas do MCP. Agregado filtrado: 727 saídas, 65 conversas, média de 55,6 caracteres, 628 abaixo de 100 caracteres. Uma amostra limitada e distribuída foi lida. URLs, números isolados, conteúdo encaminhado/citado e textos com aparência de relatório automatizado não são exemplos de estilo. Nenhum original, nome, identificador ou dado comercial é incluído na skill ou neste documento.

Autoria: saída não correlacionada ao MCP continua sem prova individual de autoria humana. As tendências extraídas são preliminares; a proibição de travessão é instrução explícita do dono. Não alegar corpus humano certificado ou fidelidade validada por essa contagem.

## Revisão adversarial

Revisão independente identificou: `fromMe` não comprova autor humano; `useSkill` disponibiliza o catálogo e não garante ativação; Pi instalado mantém janela de 272 mil tokens para Sol. Preservar essa janela e tarifar de forma conservadora, sem anunciar 1,05 milhão de tokens. A mudança de layout deve preservar entradas únicas e nomes de classes. Montar estilo somente no papel correto e conferir ativação real no protocolo.

## Publicação

Código preparado e verificado localmente não comprova publicação nem uso dos créditos. Conferir organização da chave e configuração efetiva antes de afirmar que o saldo da assinatura está sendo usado. Nenhum novo envio ou mudança de autonomia é autorizado pela skill.

## Evidência de 02/11

- TypeScript e build da aplicação Flue passaram. As classes geradas permanecem as mesmas; não há migração de banco ou mudança de identidade das sessões.
- 172 testes focados passaram; o teste adicional do histórico DeepSeek para Sol passou na suíte do transporte. O SDK preserva o texto e o par ferramenta/resultado, descartando a assinatura opaca do fornecedor anterior.
- 79 testes do runtime passaram. Incluem a skill Markdown real ativada pelo Flue antes da proposta e preservada após reiniciar a sessão, além da ausência dessa skill no agente Telegram. O fornecedor HTTP desse teste é sintético: não mede fidelidade de estilo.
- Revisão independente do diff não encontrou bug concreto, sem usar mensagens ou credenciais.
- Nova chave fornecida pelo dono em formulário privado: catálogo aceitou a chave e incluiu `gpt-6.1-sol`. Isso não consulta saldo nem comprova faturamento pelos créditos da assinatura.
- Uma chamada real com Sol e o guia de escrita avaliou três mensagens sintéticas. Respostas: “Fechado mano, valeu por avisar!”, “Recebi sim, ainda não analisei.” e “Beleza, valeu por avisar!”. Sem travessão e sem a promessa sugerida pela mensagem recebida. A chamada recebeu 1.350 tokens de entrada e 50 de saída; 1.347 tokens de entrada foram informados como escrita de cache. Sem envio externo de mensagem. Três exemplos não constituem validação geral de fidelidade.
- A amostra e a captura de tela do dono não foram incluídas no pacote público. A skill contém somente tendências e exemplos sintéticos.

Suíte completa: 122 arquivos e 2.341 testes passaram em 02/11. Um teste posterior confirmou o ajuste de contabilização do Sol quando o uso real atravessa a faixa de 272 mil tokens: taxas superiores conservadoras do catálogo Pi fixado, sem ampliar a janela configurada nem alterar a contabilização legada. A suíte focada do transporte, seleção e DeepSeek foi repetida após esse ajuste. Publicação ainda não realizada; código e chave locais não significam mudança do bot em produção.
