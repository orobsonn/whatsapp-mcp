# Operação local

Implementado em 19/10/2026 para validação sintética em Worker, D1 e R2. Sem instância WhatsApp, conexão, deploy ou dados reais.

## Interface interna

- `diagnostics(env)` retorna versão declarada, manutenção, configuração de epoch/geração, retenção e contagens de chats, cobertura, mensagens, mídia, jobs e ações incertas. Não retorna nomes, endereços, textos, URLs, tokens ou erros brutos.
- `proposalPolicy(env,input)` aceita `capture {chatId,enabled}`, `retention {days: 1..36500|null}` ou `delete {chatId}`. Persiste envelope e hash por dez minutos; retorna `id,kind,envelope,hash,status,expiresAt,confirmationUrl`.
- `getPolicyProposal(env,id)` lê a proposta no epoch e geração atuais. A rota humana deve chamar `humanConfirmation` com `resourceId=id`, o envelope devolvido e propósito `capture-policy`, `retention` ou `delete`. O POST autenticado fornece o `ConfirmationProof` para `applyPolicyProposal(env,id,proof)`. Nenhuma ferramenta MCP executa a política diretamente.
- `exportConversation(env,MessageQuery)` reutiliza `queryMessages`: mesmos filtros, cursor, limite de 50 e projeção sem endereço externo, URL de origem ou segredo. Texto e nomes presentes na mensagem são dados intencionais da exportação.
- `cleanup(env)` executa no máximo 50 unidades por chamada. Retenção só age quando há política em dias no epoch atual. `null` significa prazo indefinido. Limpa tombstones no R2, nonces vencidos, propostas vencidas e payloads de ações expiradas. Resultado contém contagens, sem conteúdo.

## Exclusão e recuperação

Ao aprovar exclusão, uma transação D1 desliga captura e registra a lacuna, marca mensagens como apagadas e travadas para privacidade, remove texto e versões, invalida mídia e derivados, cancela trabalhos e propostas pendentes do chat, cancela ações propostas/aprovadas e limpa payloads de todas as ações do chat. O registro do chat continua para que replay do mesmo evento não reabra captura. A remoção dos bytes privados ocorre depois, gradualmente, pelo cleanup. Leitura de mídia precisa verificar tombstone e fence no D1 antes de devolver bytes; publicação de download/transcrição precisa conferir esses mesmos campos após o processamento.

Uma nova captura requer proposta e confirmação do dono. A exclusão aqui é apenas do arquivo local; não apaga mensagens no WhatsApp, não revoga uma tentativa de envio já iniciada e não prova apagamento de cópias externas. O identificador externo do chat permanece no banco para correlação e bloqueio de replay. Restauração deve começar em manutenção, reaplicar migrations e usar novo `INSTALLATION_EPOCH` externo antes de liberar tráfego; dados/grants/jobs antigos não recebem autoridade pelo conteúdo restaurado.

## Evidência local

`npm test -- tests/operations.test.ts`: 4 testes passando em workerd/D1/R2 local, incluindo confirmação vinculada, proposta concorrente obsoleta, exclusão D1 antes do R2, limpeza e retenção opt-in. Isto não comprova comportamento em cliente MCP ou fornecedor real.

A auditoria final corrigiu a contagem de jobs para os estados reais pending/retry/processing e reservou orçamento por categoria: 25 mensagens, 10 objetos, 5 nonces, 3 propostas, 3 jobs, 2 pendências de status e 2 payloads por tick. Uploads sem message_id permanecem até exclusão local do chat; a retenção de mensagens não os expira por idade. Essas fronteiras estão no manual de instalação.
