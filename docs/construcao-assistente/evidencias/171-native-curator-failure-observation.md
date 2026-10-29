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

Ainda falta comprovar o aviso pelo caminho publicado, identificar a causa original quando reproduzida e concluir uma passagem diária real. Esses itens não são substituídos pelos testes locais. O envio WhatsApp aprovado e a release final seguem separados na issue146.
