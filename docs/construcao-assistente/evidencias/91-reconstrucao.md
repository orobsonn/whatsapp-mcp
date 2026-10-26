# #91 — Reconstrução limitada aos recibos completos

O índice pode ser materializado num processo/diretório vazio usando somente respostas já completas e autorizadas, por hash exato. Reconstrução nunca cria reserva, liquida custo, chama o adapter de modelo ou transforma uma incerteza em autorização para tentar novamente. Cache ausente, fonte corrigida, configuração incompatível ou perda da guarda deixam uma lacuna explícita.

## Prova local com Cognee real

`assistant/cognee/test_real_rebuild.py` executa cinco processos e diretórios novos, Cognee 1.6.5 e os bancos nativos, com rede externa bloqueada. O transporte HTTP é sintético, com recibos separados por fonte/revisão/versão/hash e pedido efetivo; não é uma chamada paga nem prova integrada de D1 na nuvem.

- Registro sintético inicial: 40 subchamadas de conteúdo, 2 originais.
- Reconstrução idêntica: 40 hits exatos, 2 originais e seus chunks/vetores conferidos fisicamente.
- Ordem invertida: 40 hits, 2 originais conferidos.
- Retirada da primeira fonte do conjunto: 20 hits, apenas a outra fonte materializada e conferida.
- Texto corrigido: o primeiro pedido divergente é recusado, sem resultado pronto nem inferência nova.
- Zero chamadas pagas em todas as etapas. Os 40 recibos sintéticos permanecem disponíveis.

A prova não demonstra estabilidade para qualquer corpus, mudança de versão ou configuração. A ordem das chamadas de embedding pode mudar; o cache compara o pedido efetivo, nunca sua posição. Qualquer payload novo continua bloqueado.

## Probes e configuração

A contraprova inicial, sem a flag oficial `COGNEE_SKIP_CONNECTION_TEST`, encontrou um detalhe material: inverter as fontes fazia o probe de conectividade idêntico cair sob outra âncora, onde não havia recibo. Não houve evidência de UUID aleatório no payload desses casos. Não reutilizamos recibo de outra fonte nem conservamos uma fonte retirada como bootstrap.

A flag oficial agora é uniforme e faz parte do fingerprint do build. Ela também suprime validações de preflight e o fallback local sem chave; por isso provider, modelo, rota e dimensões continuam fixados no backend e conferidos pelo broker do host. Extração nativa continua executando; não fabricamos respostas de conectividade. O hash do pedido de conteúdo e sua vinculação à fonte permanecem os mesmos.

## Fronteiras e recuperação

`broker.replay` só libera `complete` com resposta válida e guarda da fonte vigente antes/depois. Nem `attempting`, `uncertain` ou `response_ready` são reconciliados por esse método. A execução paga existente usa o mesmo cálculo de chave, separado da capacidade de reconstrução.

Cada reconstrução ganha um `indexEpoch`; a geração operacional/D1 permanece. IDs de materialização incluem a época, evitando que o recibo de uma computação antiga pule a escrita no índice vazio. Recibos e reservas de modelo não incluem a época e não são apagados ou zerados.

O plano persistido contém identidade, imagem, fingerprint, configuração, versões e hashes, sem textos. Cada passo materializa no máximo uma fonte; cursores repetidos não avançam outro passo. A confirmação exige inventário físico exato, hash original, chunks/vetores presentes e nova conferência canônica/origem. O resultado fica `needs_checkpoint`: reconstruir não confirma um snapshot.

Falhas entram em `stopping` por CAS antes do cleanup. `begin` recusa fases ativas. `recover(epoch)` transfere a posse e confirma a destruição antes de permitir outra época. Portas físicas e gravações em storage conferem época e dono; contraprovas suspendem cleanup/resposta antigos e retomam depois de criar outro índice, sem destruir ou sobrescrever o substituto. O checkpoint anterior fica em sua chave independente.

No pior caso de queda após persistir uma fase ativa, ela continua visível e fechada. Um host confiável precisa chamar `recover` e iniciar nova época; não há retomada automática ou scheduler entregue aqui (#53/#56). Uma destruição não confirmada conserva a quarentena.

## Capacidade e limites

O conjunto de trabalho tem até 128 IDs distintos, cada um em sua versão atual. Não existe seleção silenciosa das primeiras 128 fontes. Excesso retorna `source_capacity`; o restante continua coberto pelo inventário/recuperação canônica e por suas lacunas explícitas, sem anunciar índice global completo.

Uma época nova descarta somente o filesystem derivado obsoleto, liberando suas 128 versões/256 aliases. Os IDs internos do host são determinísticos por época/pedido, e o histórico financeiro/anti-repetição permanece fora do filesystem. O limite de 256 operações físicas continua aplicado; a reconstrução admite até oito inícios por dia, incluindo tentativas incertas. Não há aumento desses limites nem limpeza automática do ledger nesta entrega.

## Verificação

- Broker: 6 falhas novas esperadas antes da implementação; depois 23 testes verdes, incluindo dia novo com orçamento zero e nenhuma chamada a reserve/settle/adapter.
- Controlador: 14 falhas iniciais; 16 testes verdes após implementação e contraprovas adicionais de posse/cleanup atrasado.
- Engine/callback: 3 falhas novas iniciais; 29 verdes com época física, modo imposto pelo host e resposta antiga impedida de escrever no substituto.
- Probe: uma falha funcional antes das rotas fixas; 14 verdes com autenticação e rejeição de parâmetros/rotas arbitrários.
- Com os 25 testes de checkpoint: **107/107**. `npm run check` passou.

Rotas privadas da homologação g3: `/rebuild/begin`, `/rebuild/step/0`, `/rebuild/step/1`, `/rebuild/step/2`, `/rebuild/recover`, `/rebuild/status`. Exigem os mesmos token/configuração isolados, só usam os dois originais sintéticos existentes e ignoram corpos enviados pelo cliente. Não criam geração, fonte, orçamento ou chamada paga. A prova na nuvem precisa comparar recibos e custo antes/depois; não foi executada pelo implementador nesta evidência local.

## Homologação real na Cloudflare pelo coordenador

Worker isolado `assistant-build-check`, versão `26c6a0de-8896-4802-a905-02b5c4138794`, dois originais sintéticos e geração g3 já existente. A sequência de 14 pedidos reconstruiu em filesystem vazio, repetiu o primeiro passo sem avançar outro, verificou o conjunto físico, criou um checkpoint novo, destruiu e restaurou o container. Todos os pedidos retornaram 200 e os estados esperados. O container foi desligado ao final.

Os três snapshots financeiros foram idênticos: 79 recibos completos e 1.819 microUSD comprometidos na geração. **Zero chamada de modelo e zero custo de API adicional nesta rodada**; execução/snapshot do container ainda têm consumo próprio. Não foi usada busca normal que pudesse admitir inferência nova. Snapshot novo: 2.977.910 bytes, duas fontes, confirmação após restauração. Traço sintético integral em `91-rebuild-cloud.json`.

Revisão independente adversarial não encontrou bloqueio adicional após a correção de posse no cleanup. Ressalva de escala: 128 é teto de segurança, não capacidade de throughput homologada. A rechecagem integral do plano a cada passo pode fazer cerca de 32 mil consultas à origem no teto; esta prova real usa duas fontes. A integração do piloto deve manter isso visível e medir o conjunto de trabalho antes de ampliá-lo. Suíte nativa final: 16/16, incluindo recuperação de checkpoint e os cinco diretórios novos de reconstrução.

O diff supera o alvo de 400 linhas por reunir a capacidade de replay sem cobrança, a posse durável do processo, seus adapters e as contraprovas inseparáveis; a maior parte adicional são testes nativos/TS e o traço real de homologação. Separar o adapter de replay do controlador deixaria uma recuperação sem a garantia financeira exigida nesta issue.
