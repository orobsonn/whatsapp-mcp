# #32 — mudanças transacionais de captura

Feed append-only de metadados (IDs/escopo/operação), com sequência local. Triggers INSERT/UPDATE/DELETE acompanham a transação da mensagem; timestamps antigos não são cursores. Replay sem alteração material não duplica, status de entrega não vira mudança de contexto, retirada sobrevive à remoção física.

Cinco testes D1/webhook passaram após RED; check aprovado. Testes cobrem edição fora de ordem, replay, retirada, rollback, remoção física, status e DeletedCallback sintético. Revisão independente sem bloqueantes.

O normalizador existente aceitava DeletedCallback, mas a rota o descartava. A rota agora encaminha esse formato após as mesmas verificações de segredo/instância. A documentação Z-API consultada não confirmou emissão desse callback: teste sintético de compatibilidade não é homologação do provedor. Referências: https://developer.z-api.io/webhooks/on-message-received e /webhooks/on-message-received-examples. Nenhuma mensagem real ou deploy.
