# #37 — orçamento de inferência

Quatorze testes D1 passaram e check aprovado. Reserva é uma INSERT SELECT atômica que soma valores efetivos e reservas ainda incertas. Dez tentativas simultâneas sob teto de 30 unidades e reserva de 5 admitem exatamente seis. Chave de operação é única no namespace, independente do período; alteração de modelo, entrada, limite ou versão de preço conflita.

Liquidação concorrente aceita um custo real e recusa resultado contraditório. Excesso é registrado honestamente e bloqueia novas chamadas, inclusive após virar o período. ACK perdido de reserva ou liquidação não gera outra inferência. Adapter é chamado apenas pela reserva criada, e zero vezes quando não há orçamento. Configuração não reseta gasto acumulado.

Valores são microdólares inteiros. Preços, estimativa conservadora e custo efetivo são calculados pelo host, não pela IA. Deadlines pertencem ao adaptador; chamada rejeitada fica incerta. Integração de provedor/engine terá seus próprios testes; esta entrega usa adapter sintético e não fez chamadas pagas. Revisão independente do coordenador não identificou bloqueante no contrato do ledger.

Integração com fila/captura: teto zero conserva ledger prepared, registra job failed/budget_blocked, chama o provider zero vezes e continua aceitando metadados na inbox como pending. A reserva anterior à admissão é compartilhada com o guard exclusivo da fila; reserva sozinha nunca concede execução.
