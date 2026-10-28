# Diálogo Telegram — canário próprio, 27/10/2026

A primeira consulta do dono percorreu Telegram → inbox → Flue nativo → interpretação paga → leitor canônico → outbox → Telegram. Isso demonstra uma jornada real limitada; a issue #144 e o piloto completo continuam abertos.

## Prova observada

Pelo Chrome autenticado foi enviado uma única vez ao bot próprio: “Liste as missões disponíveis neste piloto, por favor.” O Worker registrou a entrada no tópico de missões, interpretou o pedido e consultou o estado canônico. A outbox terminou em `sent`, com uma tentativa e ID da mensagem retornado pelo Telegram. O episódio terminou em `settled` após ler do SDK a conclusão da mesma submissão e conferir os recibos de resposta, modelo e orçamento. Não houve injeção manual de proposta, resumo ou avaliação humana.

O modelo liquidou 108 microUSD (US$0,000108). O censo anterior era 61.701 microUSD comprometidos, incluindo 40.000 incertos históricos e 3.000 reservados; essa chamada acrescentou 108 microUSD. Não é uma conciliação da fatura de infraestrutura. Os recibos detalhados estão no diretório privado do operador, fora do Git.

A confirmação visual da nova resposta no Chrome ficou pendente: após atualizar, a página Telegram Web deixou de renderizar. O ACK do Telegram e a conclusão do Flue estão comprovados; leitura pelo dono e presença visual na tela não foram inferidas. O pedido não foi repetido. Ensino de nota e consulta posterior ainda não foram exercitados por esse caminho.

## Instalação delimitada

- Código implantado: `9d5df3d`, no branch do PR145; pacote continua em 0.50.0, sem nova release desse marco.
- Worker próprio: versão `a5f2860f-839c-4dca-9196-d3c2b31e202c`, promovida a 100%. Migrações 0028–0032 aplicadas sem reset; novo perfil SQLite `FlueOwnerDialogueRuntimeAgent`.
- Readback preservou os 38 bindings anteriores e acrescentou somente o DO e a flag do diálogo. Imagem/container, runtime, cron e exposição foram preservados. Source e Elo não foram alterados.
- Diálogo só para o dono vinculado, mensagens posteriores ao corte de ativação e com prazo original. Cron global permanece pausado; backlog antigo não recebe execução. Resumos automáticos e mídia permanecem desligados.
- Nenhum WhatsApp automático ou escrita no Calendar foi habilitado.

O canário suporta listar notas/missões/pendências/políticas e reconhecer instruções literais para criar nota ou missão pelos controladores existentes. Consultas Calendar/GitHub/WhatsApp/busca semântica e seleção de conversas ainda recebem indicação explícita de indisponibilidade no Telegram. Não chamar esse recorte de assistente completo.

## Validação e trabalho restante

As checagens locais das fases e respostas passaram (7 e 22 casos), além de tipos e builds. A revisão adversarial encontrou e levou à correção de três problemas: suporte sem ACL, cancelamento indevido após ACK perdido e escrita baseada no texto inventado pelo classificador. Também foram corrigidos settlement sem confirmação e recorte silencioso.

A CI do commit `987531d` falhou porque sete fixtures reaplicavam a migração ALTER já instalada pelo setup compartilhado. `6ed2823` remove essa reaplicação redundante; o caso dirigido passou e a CI do commit integrado está em andamento. Não se declarou CI verde por extrapolação.

Para concluir #144 ainda faltam ensino e consulta posterior, leitores e busca integrados, controles naturais e confirmações quando necessárias, contraprovas aplicáveis, revisão final, CI do commit integrado e release minor. Utilidade humana e cobertura representativa do piloto continuam desconhecidas.
