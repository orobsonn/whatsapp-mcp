# #70 — da captura recebida à fonte atual

Vinte e três testes D1 passaram e check aprovado. Incluem CaptureReader real local → ingress autenticado → materializador → OriginGuard, sem RPC publicado. Fonte/versão/hash/dependências, resultado da inbox e cursores são publicados no mesmo batch com token de admissão. Concorrência gera uma versão; falha D1 não deixa aplicação parcial; ACK perdido é recuperado sem duplicação.

Recebido, avaliado e aplicado são números separados. Lacuna persiste com motivo e tentativas limitadas; não impede tratar uma retirada posterior. Reader sem resposta tem deadline; resposta tardia não publica. Retirada autenticada funciona mesmo com reader indisponível e evento antigo em conversa cujo watermark já avançou. Geração antiga não aplica no namespace novo.

Revisão independente encontrou e corrigiu: watermark novo invalidava todo histórico, retirada atrasada podia ficar bloqueada, e desligar captura marcava somente a projeção sem bloquear o banco canônico. Novo fence pode reutilizar fonte histórica somente após conferir sua versão/hash na origem atual; fence anterior deixa de valer. Captureoff agora retira canonicamente todas as fontes vinculadas à conversa, registra mudanças e tombstones no mesmo batch, sem apagar bytes; SourceAccess e admissão da fila recusam o conteúdo. Essa operação custa proporcionalmente às fontes da conversa, sem alegação de escala ilimitada.

Limites: observação remota não é transação entre Workers. Conferência atual deve acontecer antes da IA e da publicação, junto ao guard local atômico. Mudança de captureSince/discontinuous exige rematerialização explícita. Retenção deve remover versões e projeções com recibo próprio. Testes locais não substituem o binding real da instalação.

Diff ~642 linhas: produção TS264, SQL41 e testes337; mantido inseparável para validar atomicidade, cobertura, revogação e as contraprovas de integração. Nenhum deploy, envio ou inferência paga.
