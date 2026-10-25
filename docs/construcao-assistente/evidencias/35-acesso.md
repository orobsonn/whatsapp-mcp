# #35 — fontes e acesso atuais

Vinte testes D1 passaram, incluindo duas contraprovas adicionadas pela revisão independente. Criação idempotente, correções e mudanças de público com CAS preservam versões e atribuição. Retirada impede leitura. Owner-only não atravessa para interlocutor, mesmo com identidade e mandato; fonte restrita fora da conversa exige prova vigente e a última versão do mandato, com ação/fonte/projeto correspondentes. Público comum pode ser usado sem inventar identidade para contato desconhecido.

A revisão reproduziu mutação da entrada durante o hash: o corpo salvo podia divergir do hash calculado. Create/correct agora copiam os campos escalares antes do primeiro await; ambas as contraprovas passaram. Actor e namespace também são fornecidos pelo host e copiados.

Limites: read/revalidate retornam fotografias e fence; #36 incorpora o guard na mesma mutação de admissão/publicação. Retry de correção/retirada após ACK perdido é conflito seguro, sem duplicação; não é recibo reconciliado. Ainda não há autenticação HTTP/MCP, consumo da inbox ou configuração real. Nenhum deploy nem chamada paga.
