# #33 — mídia tardia, retirada e limpeza parcial

Nove testes D1/R2 passaram e check aprovado. Derivado pronto, alteração/remoção, mídia inserida pronta após mensagem, atualização de mídia e mudança de captura entram no feed transacional de metadados. Replay após retirada não república derivado.

Revisão adversarial encontrou perda da mídia inserida diretamente em ready após eco; trigger de INSERT corrigiu e contraprova passou. R2 indisponível conserva tombstone e object_key; diagnostics.pendingObjectPurges informa referências aguardando limpeza. Retry remove objeto e encerra pendência sem voltar a upsert. Revisão final sem bloqueantes.

Não comprova apagamento em outros processadores. Entrega autenticada, revalidação e aplicação canônica seguem #34/#35. Não foi aplicado em produção.

A suíte integrada encontrou regressão que os testes isolados não viram: D1 meta.changes inclui linhas de triggers; a atualização de uma mídia passou a reportar 2 e o código existente tratava como stale, removendo R2. Experimento confirmou changes=2 com RETURNING de uma única linha. Três CAS em media.ts usam agora RETURNING id, conservando verificação de lease e publicação. Os 47 testes de mídia/transcrição/outbox passaram após a correção. A suíte completa é repetida por essa alteração material.

Contraprova adicional reproduziu perda de R2 após commit D1 bem-sucedido cuja confirmação se perdeu. O catch agora consulta referências antes de descartar a chave única da tentativa; se o banco está indisponível, conserva o objeto. Referências retiradas seguem limpeza administrativa. Objetos órfãos sem confirmação ficam para reconciliação #55, cujo aceite foi ampliado explicitamente. A falha não provoca download duplicado de job já ready.
