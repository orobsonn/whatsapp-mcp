# #29 — fontes canônicas

Schema dedicado da assistente: fontes, versões imutáveis, mudanças sequenciais e cursores de leitura/aplicação separados. Chaves compostas por instalação/geração; origem única, autoria e hash registrados; original em texto ou objeto.

Oito testes D1 passaram depois do RED sem tabelas: duplicação/REPLACE, namespace, versão inexistente, correção/retirada em batch, rollback, purge administrativo e retomada. Check passou. O teste negativo de FK diferida emite aviso interno inputGateBroken do workerd; resultado do teste e processo são bem-sucedidos.

Revisão adversarial encontrou bloqueio de purge no primeiro desenho. Corrigido: só fonte retirada permite apagar corpos; tombstone e metadados sobrevivem, reinserção na fonte retirada é recusada. Nova revisão sem bloqueantes.

Limites: DDL não autentica, não calcula hash e não aplica CAS automaticamente. Controladores #35/#46 farão essa fronteira. Schema não foi aplicado em produção. CI do PR verifica suíte/build no commit publicado.
