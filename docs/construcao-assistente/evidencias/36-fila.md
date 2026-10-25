# #36 — execução persistente com autorização atual

Trinta e oito testes da fila passaram, preservando os dezoito cenários iniciais; vinte testes de fontes também passaram durante a integração. Admissão e publicação embutem o mesmo SELECT de acesso usado na leitura. Conferem fonte/versão/hash/público, política, identidade/prova e último mandato vigente na própria mutação, com lease atual e pedido efetivo persistido. Reiniciar como dono não promove um trabalho do interlocutor.

Ledger de tentativa e recibo do resultado são distintos da publicação. Timeout/not_found depois de tentativa não autoriza outra inferência. Recibo tardio fica preservado; fonte alterada ou lease vencido impede publicar. Preparação de orçamento acontece antes da tentativa e pode deixar falha visível sem chamar o provider.

A revisão reproduziu e corrigiu três corridas: executor antigo alterando estado de substituto; objeto lease mutado durante await desviando recibo; erro de admissão concorrente na mesma geração derrubando o vencedor. O último caso agora retorna incerteza sem demover ledger/job, aguardando expiração e consulta do resultado. Testes RED→GREEN preservam as contraprovas. Guarda de preparação também não derruba quem já venceu a admissão.

Limites: provider é determinístico nesta entrega; custo/provedor real seguem #37/#79. O guard atual é local e de fonte única. Frescor remoto #70 e pacote de várias fontes serão ligados no consumidor #44. Nenhum cron, envio ou deploy foi ativado. O diff excede o alvo pequeno porque controle e provas das corridas formam uma mesma fronteira de atomicidade; os testes não foram removidos para caber no tamanho.
