# Respostas fundamentadas no Telegram — 28/10/2026

O dono esclareceu que ler arquivos não satisfaz a jornada: ele pergunta e a assistente deve responder. GitHub e WhatsApp foram solicitados em paralelo. Não declarar o GitHub pronto pela entrega de trechos. Calendar títulos/CRUD e GitHub somente leitura permanecem no escopo humano atual; WhatsApp automático continua desligado.

## Implementação

- GitHub: host identifica um único repo citado e fixa episódio somente leitura antes de apresentar nomes de arquivos ao modelo. Árvore limitada e commit imutável; primeira fase seleciona até cinco arquivos permitidos; segunda explica a resposta. Cada afirmação tem evidência literal validada, separando observação, inferência e lacuna. Nenhum dos resultados pode alcançar controladores de escrita. Referência explícita de outra branch/tag/commit pede esclarecimento.
- Seleção automática não lê arquivos de credenciais/chaves, binários, symlinks ou submódulos. Campos conhecidos de segredo inline são removidos antes da IA. Conteúdo total limitado, com omissões/recortes explícitos para o modelo. O recorte não prova ausência no repo inteiro.
- WhatsApp: descoberta privada paginada por nome sob segredo/afinidade/captura atual; devolve referências, sem sincronizar agenda ou ler um destino excluído. Homônimos pedem esclarecimento, sem retirar filtro para ampliar busca silenciosamente.
- Mensagens vêm das versões canônicas locais após SourceAccess e OriginGuard, com autor/data/fromMe provados e até seis mensagens completas. Busca lexical recente, cobertura parcial; não declarar busca semântica global pronta. Ausência de mensagens produz explicação host sem uma segunda chamada paga.
- Respostas são síntese da IA, não reprodução dos documentos. Perguntas e conteúdo externo não viram memória factual ou autorização. Segredos nunca aparecem no chat/Git.
- Contextos e todas as dependências ficam congelados no episódio antes de cada chamada paga. Fases existentes reservam custo e guardam recibos; retomada reutiliza o mesmo contexto/SHA, sem substituir corpo ou repetir provider. Purga reconhece dependencies e remove cópias mantendo custo/incerteza. Outbox conserva uma tentativa, origem atual e vínculo dono/chat/tópico.

## Revisão e verificação

Revisão adversarial anterior ao código e revisão do diff concluídas. P2 corrigidos: Ana não pode ser extraída de semana; mensagem vazia não gera Plan vazio; referência GitHub explícita não muda silenciosamente para default; valores curtos/literais de campos de segredo também são removidos. Testes dirigidos, tipos e builds passaram; CI integrada e canários reais são registrados na evidência posterior, não presumidos aqui.

Aceite de produto: pergunta sobre implementação de um repo → seleção autônoma de arquivos → explicação com fontes; pergunta sobre conversa WhatsApp → mensagens atuais autorizadas → resposta com autoria/condições. Recibo de leitura sozinho não satisfaz nenhum desses aceites. Questões sem evidência devem explicar a lacuna em linguagem comum.
