# Diálogo Telegram — canário próprio, 27/10/2026

O diálogo do dono percorreu Telegram → inbox → Flue nativo → interpretação paga → leitor/controlador canônico → outbox → Telegram. Consultas, anotação e missão foram exercitadas na conversa real. Isso demonstra jornadas delimitadas; #144 e o piloto completo continuam abertos.

## Prova observada

Pelo Chrome autenticado no bot próprio foram conferidos:

- Consulta de missões inicialmente vazia, com resposta real.
- Instrução de anotação, recibo `source.create` e fonte canônica ativa; uma consulta posterior devolveu a anotação.
- Criação de missão pelo `OwnerControl`, estado canônico ativo/revisão1 e consulta posterior devolvendo o mesmo objetivo.
- Nova consulta após o ajuste visual, com título e numeração em negrito, status em itálico/português, emojis e parágrafos separados, efetivamente renderizados pelo Telegram.

As sete entradas observadas concluíram suas fases, respostas `sent` com uma tentativa por update e episódios `settled` após ler a conclusão da mesma submissão SDK. Os recibos de modelo e orçamento foram liquidados. Não houve injeção manual de proposta, resumo ou avaliação humana. O canal recebeu duas mensagens distintas de anotação com conteúdo igual, em updates/IDs de mensagem diferentes; cada uma produziu sua própria nota. Isso não é prova de replay do mesmo update, e a origem da segunda mensagem não foi atribuída por suposição.

O bloqueio de renderização do Telegram Web foi resolvido ao trazer o Chrome à frente pelo Dock. Perguntas e respostas completas foram conferidas na conversa, além da prévia. Essa atuação do executor autorizado não é avaliação humana de utilidade.

As sete chamadas de modelo somaram 758 microUSD (US$0,000758). O financeiro histórico, incluindo tentativas incertas e reservas anteriores, foi preservado. Os recibos detalhados e a captura visual estão no diretório privado do operador, fora do Git.

## Instalação delimitada

- Código atual do diálogo: `99db45c`, no branch do PR145; pacote continua em0.50.0, sem nova release desse marco.
- Worker próprio: versão `3945718e-bbed-4cb8-bea9-bf8fa6bdb319`, promovida a100%. Migrações0028–0032 aplicadas sem reset; perfil SQLite `FlueOwnerDialogueRuntimeAgent`.
- Readback do ajuste visual preservou os40bindings, imagem/container, runtime, cron e exposição. Source e Elo não foram alterados.
- Diálogo só para o dono vinculado, mensagens posteriores ao corte de ativação e com prazo original. Cron global permanece pausado; backlog antigo não recebe execução. Resumos automáticos e mídia permanecem desligados.
- Nenhum WhatsApp automático ou escrita no Calendar foi habilitado.

O canário suporta listar notas/missões/pendências/políticas e reconhecer instruções literais para criar nota ou missão pelos controladores existentes. Calendar foi conectado depois deste primeiro canário e tem [evidência própria](144-calendar-telegram.md). Consultas GitHub/WhatsApp/busca semântica e seleção de conversas continuam pendentes no Telegram. Não chamar esse recorte de assistente completo.

## Validação e trabalho restante

A revisão adversarial confirmou corrigidos três P1 (ACL dos suportes, timeout de ACK cancelando vencedor e escrita baseada só no classificador) e dois P2 (settlement não confirmado e recorte silencioso), sem bloqueante novo no delta. As checagens locais das fases/respostas, tipos e builds passaram.

A CI integrada de `0857aa3`, run40617434349, terminou aprovada:1608 gerais,13OAuth e70nativos, além dos checks Node/builds. As falhas anteriores em987531d/6ed2823 ocorreram por fixtures reaplicando a migração ALTER já instalada pelo setup compartilhado; todas essas reaplicações redundantes foram removidas. Não houve alteração da migração já instalada para esconder o erro. O ajuste visual99db45c passou em tipos/build e dois checks existentes do transporte; sua CI40618432301 está em andamento. A validação visual foi feita em produção.

Para concluir #144 ainda faltam busca/leitores integrados, controles naturais mais amplos e confirmações quando necessárias, contraprovas aplicáveis, revisão final, CI do commit final e release minor. Utilidade humana e cobertura representativa do piloto continuam desconhecidas.
