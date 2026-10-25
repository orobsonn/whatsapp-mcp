# #41 — recuperação de contexto permitido

Vinte e oito testes D1 passaram. Fonte e origem são autorizadas antes de qualquer pontuação ou chamada ao motor. O pacote tem limites explícitos: 256 registros examinados, até 64 fontes permitidas, dez resultados e 64 KiB de originais. Fontes privadas não ocupam a cota permitida; exame incompleto continua visível, sem divulgar IDs ou contagens privadas.

Retornos do motor passam por contrato estrito, sem campos auxiliares, duplicatas ou referências fora do pacote autorizado. Correção canônica prevalece sobre índice antigo. Toda pista — lexical, relações e motor — termina na releitura da fonte original e de seus fences. O recibo opaco permite reconciliação posterior; não concede autorização para publicar.

Corpus independente recuperou 5/5 fontes necessárias e zero fontes negativas; são testes de contratos e busca local, não prova de qualidade semântica de Cognee ou da IA. Contraprovas incluem homônimos, dois projetos, negação, correção, comandos citados, entidades explícitas, muitos privados antes de fonte permitida, alteração de política e índices obsoletos. Limites e indisponibilidade aparecem como lacunas.

O prazo curto do recuperador pode terminar antes do motor frio. Nesse caso a resposta informa recuperação parcial; #44 precisa esperar contexto/reconciliar recibos e revalidar o pacote antes da inferência/publicação. Rechecagem sequencial não é uma transação distribuída. Checkpoint e retorno operacional completo dependem de #39/#40/#44. Nenhuma chamada paga ou deploy nesta entrega.

Revisão do coordenador: o limite64 deste componente ainda não oferece continuação para fontes posteriores. Isso impede tratá-lo sozinho como busca de toda a memória; a construção do piloto precisa de paginação/continuação persistente e uma contraprova com alvo depois de1000 fontes. A limitação fica explícita em source_limit/inventory_limit e não é interpretada como ausência de informação. O diff supera400 linhas por reunir o contrato estrito e suas contraprovas; 170 linhas são implementação,284 são testes.
