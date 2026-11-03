# Finalização precoce e mídias recuperáveis

Pedido do dono: corrigir causa, retomar fontes pendentes e não criar bateria de cenários irreais. Diagnóstico e arquivos reais permanecem privados fora do Git.

## Causa observada

A revisão de 02/11 recebeu100 fontes, confirmou59 e avançou o cursor além das41 que ficaram apenas apresentadas. Leu mais10, confirmou10 e chamou finish. O runtime encerrou normalmente;156 fontes continuavam pending e41 presented. O problema era aceitar a finalização do agente como suficiente para encerrar a passagem, apesar do saldo conhecido pelo host.

O host agora devolve continue_required antes de gravar finished_at ou consumir aviso, com cursor anterior ao primeiro item pendente autorizado. O wrapper não marca esse retorno como efeito concluído. O hook Flue existente continua oferecendo um lembrete e falha se o agente insistir em encerrar sem concluir; não foi criado scheduler nem loop autônomo de novas submissões. Pergunta humana concreta e indisponibilidade real continuam separadas de fonte processável. Corpo inacessível não fica indefinidamente pending sem progresso.

## Mídias

As28 URLs responderam200 durante a inspeção. Treze JPEG não tinham marcador final e falharam também na carga estrita por decoder independente: não basta o header reconhecer JPEG. Um JPEG era completo com metadados apósEOI e outro era JPEG completo declaradoPNG. O detector anterior recusava o primeiro e a comparação estrita de MIME recusava o segundo. Dois JPEG tinham3,1/3,7MiB, oito arquivos eramHEIC e trêsMOV excederam20MiB; não eramPDFs recuperáveis dentro das capacidades atuais.

A inspeção estrutural compartilhada entre Source e admissão da IA percorre segmentos e scans atéEOI, sem confundi-lo com bytes deEXIF e sem completar arquivo truncado. O MIME dos bytes prevalece apenas em downloads recebidos entre imagens já suportadas; o nome original continua como metadado. Upload permanece estrito. Documento declaradoimagem é classificadoimagem na captura. Não foi introduzido suporteHEIC/vídeo ou aumento de limites.

O reparo operacional seleciona somente os dois arquivos recuperáveis, com nova versão da mensagem e novoIDde mídia, invalidando anteriores e mantendo tentativas históricas. Os26 restantes permanecem registrados; não são descartados por política, marcadosavaliados ou convertidos em sucesso para zerar contadores.

## Verificação

Dois testes novos: uma página parcialmente confirmada não finaliza nem consome aviso e retoma no item abandonado; JPEG com metadados/MIME errado passa na fronteira correta, mantendo upload estrito. O caso do encerramento falhou antes da correção; o caso deJPEG foi repetido com o código antigo e falhou no download. Os207 testes afetados passaram, assim comoTypeScript. A recuperação real depende dos recibos de produção, separadamente desta prova local.

A revisão adversarial adicional exigiu o guard também no UPDATE final: uma leitura concorrente não pode abrir fontes entre a contagem e o commit. O CAS final verifica NOT EXISTS(pending,presented) e seu RETURNING; perda dessa condição devolve continuação. Os126 testes de curadoria/host passaram após o ajuste.

A API HTTP de batch foi verificada na fronteira real com uma tabela isolada: falha de chave primária após CREATE/INSERT/UPDATE desfez o lote inteiro e deixou zero tabelas de prova; nenhum registro do usuário foi alterado. O reparo confere sucessos individuais e duas CAS, além dos recibos novos; ACK incerto requer conciliação, sem repetir apply.

A suíte geral encontrou fixtures antigos de envio/destinatário que eram12bytes marcadosJPEG, sem estrutura de imagem. Foram substituídos pelo JPEG1x1 real já existente, sem acrescentar cenários.
