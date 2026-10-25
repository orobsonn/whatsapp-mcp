# #34 — transporte autenticado e retomável

Oito testes de ponte e onze de fronteira sombra passaram; check e build dry-run da assistente aprovados. Somente metadados, com schema estrito/hash normalizado/namespace configurado. Até dez eventos por rodada, corpo e ACK limitados a 4 KiB, deadline de 2s por evento.

Receptor confirma evento persistido e avanço de leitura em transação; repetição recupera mesmo recibo, conflito não sobrescreve. Cursor de origem usa CAS/RETURNING depois de ACK com sequência e hash correspondentes. Testes de ACK perdido, hash incorreto, timeout, consumidores concorrentes, gaps de sequência e mudança de mídia/acesso passaram. Nenhum fetch público ou envio é usado.

Revisão independente sem bloqueantes. Recebido não significa fonte aplicada: applied_sequence continua separado. A ponte não transporta texto e não concede autorização. Materialização atual segue #35/#69/#70. Binding/segredo/configuração real só na instalação; desligado, vazio e falhando devem aparecer distintamente no health #54/#56. Captura e dados anteriores à outbox têm cobertura própria, não inferida do cursor.
