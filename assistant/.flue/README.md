# O que existe no bot

Esta é a aplicação Flue do assistente pessoal. O Vite tem `assistant/` como raiz, por isso a pasta fica em `assistant/.flue/`.

| Pasta | O que você encontra |
| --- | --- |
| `agents/` | O agente de conversa e as entradas de compatibilidade. WhatsApp responde em nome do dono; Telegram conversa com o dono; curadoria organiza a memória. |
| `tools/` | Ferramentas de memória, pesquisa, agenda, tarefas e propostas de resposta, separadas por função. |
| `skills/` | Guias que o agente carrega para uma tarefa. `escrever-como-robson/SKILL.md` contém o estilo de escrita no WhatsApp. |
| `instructions/` | Orientações permanentes da conversa e da curadoria. |
| `providers/` | Escolha do fornecedor/modelo e transporte com contabilização. |

`app.ts` conecta essa aplicação ao serviço. `cloudflare.ts` mantém os recursos e a execução agendada já existentes. A configuração de build está em `../vite.config.ts`.

Fora desta pasta, `assistant/` mantém armazenamento, integrações, permissões, recibos e controles de operação. O próprio Flue continua responsável pelas sessões, histórico e ciclo de ferramentas. Os arquivos em `agents/shadow.ts` mantêm compatibilidade com os fluxos anteriores; reorganizar não apaga conversas nem cria outro bot.

Para entender ou ajustar a escrita, comece pela [skill](skills/escrever-como-robson/SKILL.md). Ela orienta o tom no WhatsApp e nos rascunhos pedidos pelo dono no Telegram, sem autorizar envios. As respostas do assistente ao dono mantêm seu papel próprio e a curadoria não monta essa skill. Registrar uma skill a disponibiliza ao agente; o teste do runtime verifica seu carregamento real antes de uma proposta.

OpenAI direto: `NATIVE_MODEL_PROVIDER=openai`. Sol: `NATIVE_OPENAI_MODEL=gpt-6.1-sol`. As configurações existentes sem essa seleção conservam Luna. A chave permanece no cofre do Worker, nunca nesta pasta. Configuração local não comprova publicação nem vínculo da chave aos créditos da assinatura.
