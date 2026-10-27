# Recuperação limitada de bootstrap anterior ao dispatch

Decisão de engenharia de27/10/2026, dentro do pedido de Robson para validar o piloto autonomamente. Não é aprovação técnica atribuída ao dono. O harness permanece não instalado.

## Problema e prova disponível

A primeira execução Owner real encontrou alias de imagem ausente. O mapa foi restaurado pela versão histórica exata, com mesmo código e37bindings preservados. A inspeção real do códigoF0, aprovado na [CI40538028510](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40538028510), observou atomicamente: ticket inicial `uncertain`, índice `empty/lost` com zero fontes, ausência de `access:<op>` e `receipt:<op>`, nenhum active. O indicador de imagem atual étrue. Comprovante privado `owner-once-inspect-first-result.json`, SHA256 `fa787f80df8d494ec7e9c7d63be1adee24054e0b0eed65080235dc0c935e6bf5`.

Na fonte335d6d3 examinada, access é persistido antes de emitir permit, definir active, interceptar o broker e chamar `/ingest`; nenhuma API examinada remove access/receipt. O histórico de implantação e o namespace foram conferidos, sem limpeza/restauração externa durante o ensaio. O censo16:12UTC permaneceu55.310microUSD comprometidos globalmente,40.000incertos antigos e zero reserva na geração própria. Esses fatos sustentam uma exceção restrita ao bootstrap que nunca habilitou o dispatch; não autorizam readmitir chamadas de modelo incertas.

O prazo do Root original expirou e seu grant continua expirado. `initialInput` inclui a autoridade no hash; substituir token e fingir o mesmo ticket seria incorreto. O contrato atual não oferece recuperação desse estado. As alternativas de despausar cron, ingest bruto, trocar geração/epoch, limpar registros ou estender o grant foram rejeitadas pela revisão adversarial.

## Resultado desejado e limites

Admitir explicitamente uma nova operação Owner, ligada à falha anterior, que possa realizar o primeiro dispatch do mesmo original. Manter todos os dados, recibos, orçamento e evidências anteriores. A operação original permanece expirada, sem proposta nem declaração retroativa de sucesso.

- Mesma instalação, geração, períodoUTC, conta/cap acumulados, projeto, fonte/revisão, manifesto e pergunta. Nenhuma conta nova, reset ou aumento de cap.
- Apenas bootstrap Owner com `admissionKind=owner_once`. Não serve para busca, modelo, ingest já despachado, snapshot, rebuild ou histórico desconhecido.
- Uma recuperação por linhagem original. Uma operação que já recupera outra é inelegível; não existe recuperação da recuperação ou renovação automática.
- O primeiro plano de recuperação comprometido consome a linhagem na admissão D1: o guard atômico recusa planos irmãos, excluindo somente o próprio Root em sua manutenção. Expirar esse plano não autoriza outro descendente.
- Sem rota pública, SQL/URL/chave de storage arbitrários, alteração de imagem ou start dentro da manutenção. WhatsApp automático e escrita Calendar continuam indisponíveis.

## Nova admissão Owner

Comando estrito `owner_once.recovery_plan` recebe `operationId` novo, `previousOperationId`, `deadlineAt` e `maxCostMicroUsd`. A capability já autenticada fixa o restante. O replay compara o hash desse comando antes de ler/regravar conteúdo.

O host recupera o plano original e o job/ledger originais; verifica SHA256 bruto de request_json, owner_request/runtimeflue/actorOwner/source/key/queryHash, job pending com attempts0/sem lease e ledger prepared. Exige prazo original expirado, mesmo períodoUTC, ausência de recuperação anterior e manifesto ainda exatamente igual. A pergunta vem desse ledger privado; nunca é retornada no resultado.

O host solicita ao Core uma testemunha readonly de elegibilidade. O novo recibo plan conserva a forma existente e acrescenta recovery `{previousId,previousPlanHash,previousJobHash,indexEpoch,operationId,witnessHash}`. Os hashes vinculam o recibo integral do plano anterior e o request_json anterior por SHA256 bruto. Plano, novo job e nova pergunta compartilham o batch existente de admissão. Seu guard inclui CAS do plano anterior request_hash/result_json exatos, job pending/attempts0/lease_generation0/lease_untilNULL e ledger prepared/request_hash/request_json exatos, além de inventory/retention e ausência de histórico pago. Uma validação TypeScript anterior ao batch não substitui esse CAS. O primeiro advance continua inserindo somente o novo recibo admit; o grant antigo não participa da nova autoridade.

O guard específico de admissão da manutenção exige ainda ausência de reservas e recibos de modelo em todos os períodos da geração própria. Esse limite deliberado cobre o primeiro bootstrap desta instalação; não habilita recuperação genérica em instalação com histórico pago. Esse guard vale na criação da manutenção, sem se autoinvalidar quando a nova execução legítima começar a gastar.

## Testemunha e transação no Core

O Core produz a testemunha; o cliente não declara ausência de dispatch/limpeza. A testemunha vincula o ticket original completo por digest, o índice vazio exato e os gates abaixo. Não contém corpos, tokens ou inputHash bruto.

Pré-condições sob o mutex exclusivo do Core: processo parado; activeEpoch nulo; slot original estritamente válido, uncertain e do Root anterior; índice namespace/epoch correspondentes, revisionempty, sources[], losttrue e needs_checkpoint; quarantine exatamente true; active ausente ou null; access e receipt estritamente ausentes; checkpoint/rebuild/maintenance ausentes; marcador de recuperação ausente. Incorporar também os mesmos scans globais bounded da condição pristine: prefixos access:, receipt:, search-ticket:, search-operation: e search-operation-history-v1, cada qual limit1. Qualquer entrada, inclusive null/corrompida, recusa; nenhuma delas é removida. Ausência e corrupção nunca são equivalentes. A imagem atual precisa estar configurada.

A reserva recuperada recebe input com o NOVO grant. Calcula novo inputHash, preserva o indexEpoch original e exige que a operationId calculada do wire atual seja exatamente a do ticket anterior. O Core valida a nova autoridade e sua referência à testemunha; revalida a testemunha numa única transação de storage imediatamente antes de alterar metadados.

Nessa única transação:

1. Grava um registro imutável de consumo/arquivo por Root anterior, contendo a testemunha e todos os valores anteriores de initial/index/quarantine/active.
2. Instala o novo ticket reservado, com Root e inputHash novos, mesmo epoch/operationId do wire.
3. Remove exclusivamente o índice vazio comprovado, quarantine e active ausente/null. O registro anterior fica integralmente no arquivo; nenhum access, receipt, custo, D1slot ou job anterior é removido.

O adapter disponibiliza delete somente ao código interno da transação; a RPC não aceita nomes de keys. A quarentena em memória só é liberada após commit confirmado, sob o mesmo mutex. Falha antes de commit não altera nada. Após ACK perdido, o mesmo novo Root recupera o ticket já instalado pelo registro exato; não repete remoções nem revalida pristine de um estado já avançado. Outro Root ou marcador corrompido falha fechado. Se o resultado do commit for desconhecido, nenhuma execução é iniciada nessa chamada.

## Continuação normal e verdade histórica

O coordenador executa a manutenção como passo separado, antes do gate normal quarantine/lost e antes de montar expectedIndex: lê a âncora atual e monta input inicial sem expectedIndex. Criação confirmada retorna pending; na chamada seguinte relê lifecycle. Replay reconhece o marcador exato mesmo após índice/custo avançarem e não reaplica pristine/zero custo a uma admissão já comprometida. Um replay que comprova commit sem ACK também pode liberar a quarentena em memória sob o mutex. Cada consulta continua exigindo o grant NOVO vigente, sem renovar o antigo.

Depois reutiliza reserve/commit iniciais, slots D1 por novo Root, ingestão, busca, claimId, episódio e diário existentes. D1slot incerto e job pendente do Root anterior ficam intactos; grant antigo continua expirado e seu commit antigo recusa ticket diferente. A presença de arquivo/consumo não concede autoridade de modelo. Elegibilidade integral do predecessor é repetida antes da criação da manutenção; o arquivo já comprometido é a prova histórica para seu replay, que mantém autorização/ACL atuais do Root novo.

O novo Root precisa de fonte/ACL/configuração/prazo/orçamento atuais em cada fronteira. Correção/retirada pode bloquear a continuação, conservando o histórico. Se a execução recuperada falhar, não cria outra linhagem para tentar novamente. O resultado de revisão/qualidade humana permanece desconhecido até relato real do dono.

## Revisão adversarial e verificação

A revisão identificou e incorporou: hash acoplado à autoridade; cadeia A→B→C; quarentena em memória; crash entre arquivo e remoções; ACK perdido após instalação do ticket; corrupção confundida com ausência; e falsa prova de ausência após limpeza desconhecida. Não encontrou uma API existente menor que cumpra esses fences. A engenharia assume essas escolhas, sem pedir validação técnica ao dono.

Contraprovas obrigatórias: marker inválido, access/receipt inclusive null e entradas incompatíveis de qualquer operação no namespace, índice não vazio/epoch trocado, processo ativo, grant/Root/fonte/manifesto divergentes, reservas existentes, prazo/período alterados, recuperação de recuperação, concorrência entre novos Roots, rollback e ACK perdido. Confirmar arquivo integral, mesmo epoch/opid, novo inputHash, ausência de start/model na manutenção e uma única tentativa lógica de ingestão. As chamadas legítimas de modelo são identificadas pelos seus recibos/reservas, sem duplicação, e não reduzidas artificialmente a uma chamada por fluxo.

CI exata e revisão independente antes da operação própria. A execução real só ocorre após confirmar essa testemunha e os limites atuais. #140/#48 permanecem abertas até decisão legítima e callbacks reais; release minor e auditoria dos16requisitos seguem os gates existentes.
