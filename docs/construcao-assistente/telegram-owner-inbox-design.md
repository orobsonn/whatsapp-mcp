# Interação Owner no Telegram — desenho em preparação, #144

Status: diagnóstico confirmado; decisões de implementação ainda em levantamento/ataque adversarial. Este documento não concede novos efeitos nem declara a proposta fechada.

## Intenção já autorizada

O dono escreve em português no bot privado e recebe resposta verificável; pode consultar fontes/contexto, ensinar memória e administrar missões/políticas, conforme requisito11 do PRD. Preservar a base e os componentes existentes. O pedido de engenharia autônoma não é validação técnica das escolhas; desenho e riscos são responsabilidade da engenharia.

## Diagnóstico e causa do silêncio

`telegram-auth.ts` aceita apenas o dono/chat do vínculo atual e persiste mensagens diretas não/start como pending. Não existe consumidor desses registros. `telegram-webhook.ts` devolve JSON ao provedor e o scheduler processa outras tabelas. As entregas47/48 cobrem vínculo/tópicos/revisão, não a administração reativa. Pausa global e resumos off também impedem atividade contínua, mas ligar flags não supre esse caminho ausente.

## Contratos obrigatórios para o desenho final

- Não reduzir a interação a comandos JSON, `/status` ou eco fixo. Pergunta em linguagem natural, ensino de memória/contexto e missões/políticas precisam de jornada verificável; ambiguidade pede esclarecimento legível.
- Claim durável por update/versão do vínculo; mesmo payload/mesma operação não duplicam modelo, controle ou resposta. Identidade, instalação/geração, retenção, dono/chat/tópico e prazo vêm do host, nunca do modelo.
- Consultas reaproveitam OwnerQueries/leitores, busca e fontes atuais. Inferência reaproveita transportes, orçamento, Flue/fila/diário quando aplicáveis, sem outro motor genérico.
- Mutações reaproveitam SourceController/OwnerControl/CommandLedger com guard atual do vínculo e da mensagem na MESMA transação de admissão. Conferir vínculo antes de chamar um controller Owner não basta. Revalidar acesso/frescor antes do reply.
- Pergunta não vira fato de memória automaticamente. Texto recuperado/encaminhado e extração do modelo não conferem autoridade. Confirmação necessária congela comando, revisões, destinatário e expiração com consequência compreensível.
- Resposta tem outbox nominal, finito, uma tentativa e estado incerto sem reenvio cego. Não fabricar decisão/summary para caber em notificações existentes; ACK do webhook não equivale a resposta.
- Ativação não libera cron global nem drena mensagens/backlog anteriores indiscriminadamente. CurrentLink/activation/retention fences também protegem a seleção; revogação durante await recusa efeito e retorno.
- Export/retirada cobrem os registros novos. Não ressuscitar fontes, redefinir períodos/caps, limpar recibos ou renovar Root expirada para executar.
- WhatsApp automático e escrita Calendar continuam indisponíveis. Custos/recibos incertos e dados/segredos do Elo são preservados; secrets somente em canal privado.

## Componentes existentes e riscos já atacados

Revisão adversarial confirmou o P1 e identificou o menor encaixe conceitual: adaptador nominal de entrada Owner, controllers/leitores existentes e outbox próprio. Ela rejeitou um wrapper que checa o vínculo uma vez e depois chama MCP: os controllers atuais usam principal Owner do host sem telegramLinkGuard no próprio batch. Também rejeitou fake decision/dailySummary para enviar resposta. Perguntas semânticas devem manter fontes/cobertura e orçamento, sem bypass do modo pausado por boolean arbitrário.

Ainda é necessário escolher interfaces concretas após ler as APIs de broker/runtime/control e definir o guard durável de mensagem, confirmação, retomada e retenção. Essas escolhas serão explicitamente atacadas antes de código. O plano deverá cobrir teste causal RED, contraprovas de duplicata/revogação/ACK perdido, CI exata e homologação real no bot próprio.

## Implementação parcial em andamento

As unidades de autoridade/inbox e admissão nos controllers foram definidas após a revisão adversarial e implementadas no branch, conforme [plano parcial](telegram-owner-inbox-authority-plan.md). A primeira só persiste metadados de ativação/tentativa; a segunda compõe o guard Telegram na mesma admissão dos comandos existentes. Não existe ainda ligação ao consumidor do webhook, interpretação natural ou outbox de resposta. Não equivalem a requisito11 cumprido nem a nova homologação Telegram.

A futura factory host Telegram deverá exigir o callback nominal em todos os controllers; construir principal Owner sem ele é bypass. Perguntas não viram fontes de memória só para obter permissão de modelo. Flue, broker, orçamento, retomada e retenção da resposta ainda precisam de desenho completo e prova antes de ativação.

A outbox de respostas também está implementada no branch conforme [plano e contraprovas](telegram-owner-replies-plan.md), ainda sem consumidor ou envio real. Guarda texto/dependências com prazo, verifica fonte/vínculo antes de uma única tentativa e limpa cópias locais na retirada. A confirmação do mesmo envio pode chegar após revogação/purga sem readmitir outra tentativa ou restaurar texto. Isso continua sendo infraestrutura para o requisito11, não interação natural já disponível no bot.
