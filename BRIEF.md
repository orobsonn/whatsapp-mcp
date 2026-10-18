# Brief — meu WhatsApp gerenciado pelo meu MCP

Data: 18/10/2026. Origem: pedido direto de Robson no chat do Elo. Documento de intenção e handoff; não é arquitetura aprovada ou autorização de implementação.

## O que Robson pediu

Criar um diretório separado em `Desktop/dev`, levar o máximo de conhecimento útil do Elo e deixar o próximo trabalho de código bem direcionado. O MCP será próprio, para o gerenciamento pessoal amplo do WhatsApp. O Elo e a Z-API ligada à demonstração ficam como estão por enquanto.

Capacidades explicitamente desejadas:

- Ler conversas individuais e grupos.
- Lidar com áudios; operacionalizar acesso ao áudio e interpretação/transcrição, sem assumir que o provedor já entrega texto.
- Mandar mensagens em grupos e em conversas individuais.
- Enviar arquivos, incluindo imagem e PDF, também em grupos.
- Salvar mensagens enviadas e recebidas em conversas individuais e grupos.
- Ampliar o gerenciamento para outras operações do WhatsApp, conforme capacidade real e utilidade.

Atualização explícita de privacidade: idealmente preservar dados e não expô-los à IA; se isso se tornar complicado ou limitar demais as funções, Robson aceita flexibilizar. Isso expressa uma preferência de produto; não decide que todo histórico pode sair para qualquer serviço, nem pede que a aplicação esconda tudo a ponto de não funcionar.

## Experiência pretendida

A pessoa pede no chat: “O que ficou combinado no grupo?”, “Ouve esse áudio”, “Ache o PDF que mandaram”, “Manda este arquivo no grupo certo”. O MCP resolve conversa, mensagem, participante e anexo; apresenta contexto suficiente para a decisão e informa o resultado observado da ação.

O objetivo é uso diário simples. Evitar um painel administrativo grande ou fluxo cheio de aprovações para cada leitura comum. Quando houver ambiguidade real de pessoa/grupo, conteúdo faltante ou ação importante, esclarecer o mínimo necessário. As ferramentas devem fornecer referências estáveis e resultados que a IA consiga utilizar sem administrar números, URLs privadas ou tokens.

## O que não transferir automaticamente do Elo

| Elo | Novo MCP pessoal |
|---|---|
| Memória de relacionamento/rotina de consultor | Gerenciamento amplo do WhatsApp; memória pode ser útil depois |
| V0 exclui grupos, áudio e anexos | Grupos, áudio, imagem e PDF fazem parte do pedido |
| Corte de histórico ativo em 30 dias | Política de arquivo/retenção ainda precisa ser escolhida |
| DeepSeek por blocos e limite diário | Processamento generativo não precisa acontecer em toda mensagem |
| Aprovação exata por mensagem via Skill | É um precedente útil, mas a política deste projeto ainda será definida |
| Alias muito restrito/IDs de telefone escondidos | Preferir minimização sem impedir localizar pessoas e grupos por nomes úteis |
| Instalação para alunos | Instalação pessoal primeiro; não inventar SaaS, contas ou multi-tenancy |

## Limite desta rodada

Somente documentação, referências e revisão. Não parear outro número, instalar cliente WhatsApp, mover webhook, usar tokens, criar recursos Cloudflare, implementar endpoints, testar grupos reais, enviar mensagens ou comprar serviços.

## Resultado esperado na futura implementação

Uma primeira jornada real de ponta a ponta com grupo de teste e anexos controlados, seguida da expansão para o restante. Não considerar completo por listar ferramentas ou receber HTTP 200. A sequência em [plano inicial](docs/05-plano-inicial-e-testes.md) é recomendação de engenharia, não redução do objetivo final.

## Decisões ainda abertas

1. Provedor/canal efetivo: Z-API é a referência mais conhecida, mas não foi contratado/associado um novo número ou instância a este projeto. “MCP próprio” não significa necessariamente implementar o protocolo WhatsApp ou trocar de provedor.
2. Qual número/instância e qual ambiente de teste podem ser usados sem afetar a demonstração.
3. Quais chats entram no arquivo, possibilidade real de importar passado e prazo de retenção de texto/mídia/derivados.
4. Quais conteúdos podem ir ao modelo do chat, a um transcritor/OCR e a outros processadores; nomes e participantes precisam ser úteis no uso diário.
5. Regras para enviar, responder, apagar, marcar lido e administrar grupos, incluindo eventual automação futura. Não existe autorização permanente de envio neste handoff.
6. Clientes de IA prioritários e se o uso será remoto, local ou híbrido. Claude/ChatGPT são precedentes testados no Elo, não uma restrição nova do dono.

Fechar essas escolhas quando forem necessárias à primeira fatia; não abrir uma entrevista extensa para decisões que o código/documentação e um ensaio simples possam resolver.
