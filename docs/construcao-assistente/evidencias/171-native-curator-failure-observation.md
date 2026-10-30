# Falha diária: diagnóstico e aviso operacional sem nova inferência

Data:29/10/2026. A primeira rotina diária foi admitida, mas a submission `sub_ik_03102bd78053862c5137ac2bb84cb2da` terminou `failed/conversation_context_unavailable`. A passagem `ce7b4a9a-5d16-4c32-80d4-5829b8228e5a` conserva3679 pendências, sem recibos de modelo dessa submission.

## Evidência e limite da investigação

O contexto privado carregava208 exposições/169 fontes distintas/205 referências de origem provenientes dos ensaios anteriores. Metadados no Source indicavam disponibilidade de172 mensagens,25 mídias e8 derivados. Isso não comprova o hash nem o sucesso de cada RPC sob seu prazo. Não houve prova de limite de subrequests, e o limite oficial dos planos pagos mudou para10000 em2026; não foi aumentado por hipótese.

O diagnóstico `8a096a4`, publicado em `7be600aa-4be6-451a-baef-e26d848df6dd`, separa falhas de SQL anterior/posterior, RPC, parser e consulta local do contexto. Registra somente fase, motivo fechado, tipo de fonte, duração e contadores. Não registra corpos, nomes, endereços, hashes, IDs de fonte ou mensagens arbitrárias de exceção. Falha do logger não altera autorização. Dois casos RED de diagnóstico/sanitização passaram após a mudança.

## Lacuna operacional corrigida

O recibo nativo de admissão era devolvido novamente pelo scheduler, mas a falha do SDK não gerava aviso antes do dia seguinte. A observação terminal agora precede captura, varredura e abertura de contexto dependentes do Source.

`assistant_curator_outcomes` (migração própria0051) separa settlement do SDK, cobertura do arquivo e notificação:

- Lê somente o recibo original persistido; não troca evento, sessão ou submission e não reinicia modelo.
- Confere a encarnação pela API pública `getAgentInstance` antes/depois da leitura. O UID que `read` devolve, sozinho, não é prova independente no SDK instalado.
- Usa um prazo externo para toda a observação. Timeout, instância ausente, UID/submission diferentes e erros de leitura permanecem inconclusivos. Resultados tardios são descartados.
- `completed` do SDK não modifica cobertura nem `finished_at` do curador. `failed/aborted` provados podem produzir um aviso com dia e contadores, sem conteúdo de fonte.
- O aviso usa instalação/geração, recibo/run, dono/vínculo/tópico, restore/hold e autorização original atuais; não depende de conseguir reler as fontes que falharam.
- A outbox de falhas é independente do resumo: erros são avisados mesmo no modo `errors_help`, com zero pendências ou depois de um resumo já aceito. `needsHelp` não é forçado artificialmente.
- Claim condicional admite uma tentativa; ACK perdido conserva `uncertain` e não é reenviado. Grants antigos são excluídos antes da página de trabalho, e avisos preparados avançam o marcador de consulta sem reabrir estado.

## Verificação

RED reproduziu falta de aviso quando o guard de fontes falhava, starvation de um11º run atrás de dez grants antigos e timestamp parado com tópico ausente. A validação dirigida também cobre concorrência, ACK perdido, cancelamento/pausa, revínculo, submission/UID diferentes, erro tardio, conclusão SDK sem falsa cobertura e contagem de capture gaps. Tipos, build e revisão adversarial acompanharam o delta.

## Publicação e prova real posterior

Migração0051 aplicada apenas no D1 próprio, com registro/readback confirmados. Código `afe5e6e` publicado no Own `cd73696b-3c40-4496-bcc9-91c1d32c9646`, preservando bindings, runtime, schedules, modoapproval e recorrência diária. Source não foi alterado.88 casos dirigidos, tipos e build passaram; revisão adversarial final sem Critical/Important. A CI completa desse SHA, `40963147935`, terminou com `success`.

O cron observou o recibo original e persistiu `outcome=failed`, `notice_state=accepted`, mensagem Telegram137. A regressão com resumo já aceito foi coberta em teste; este run real falhou antes de produzir seu resumo. Não houve nova submission, inferência ou modificação da cobertura para produzir a notificação.

Na observação limitada,19 conferências completas dos mesmos166 fences de origem terminaram `current`, com duração de7515 a32598ms. Não houve diagnóstico de indisponibilidade nesse recorte. Isso comprova disponibilidade posterior, **não determina nem corrige por si a causa da falha original**. Prova privada filtrada: `native-context-proof-filtered-1793312423738.json`; a captura temporária foi encerrada.

O fanout de consultas continua um custo estrutural medido. A revisão adversarial recomendou estudar provas hash-only por lote, com normalização idêntica, controle de conexão Source efetivamente revalidado, correspondência exata e todos os checks finais preservados. Essa otimização ainda não estava implementada neste registro. A implementação e a medição posteriores estão na evidência172 (`172-native-context-proof-batching.md`).

Ainda falta concluir uma passagem diária real e observar o envio WhatsApp após aprovação. Durante a investigação chegaram três entradas privadas: as submissions concluíram, com dois resultadossilent e uma revisão enviada ao Telegram. Essa revisão expirou sem aprovação; isso não comprova envio nem validação humana da sugestão. A release final permanece separada na issue146.
