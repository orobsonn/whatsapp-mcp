# Calendar: ciclo real de criação, edição e exclusão no runtime nativo

Data: 29/10/2026. Worker próprio com a versão nativa `bab6f307-1e0b-4a85-b6c1-98ec9c813231`. Agenda principal, evento técnico único organizado pelo dono, sem convidados ou recorrência.

## Prova no bot e no Google

O pedido foi enviado pelo Telegram Web autenticado do dono. A IA consultou disponibilidade, escolheu `calendar_change` e entregou a confirmação por `respond_owner`.

| Ação | Estado persistido | Leitura independente pela conexão Google Calendar |
|---|---|---|
| Criar `Homologação nativa Calendar 29X` | `applied`, verbo `create` | Mesmo ID confirmado; `15/11/2026 03:10–03:20`, America/Fortaleza; organizador é o dono; zero convidados e nenhuma recorrência |
| Renomear para `Homologação nativa Calendar 29X — editado` | `applied`, verbo `edit` | Mesmo ID, título atualizado, horários preservados, zero convidados e nenhuma recorrência |
| Excluir o evento técnico | `applied`, verbo `delete` | Mesmo ID com `status=cancelled` no Google |

ID do evento técnico: `85bfaa0896bb89bcd942b56a1c611132a0fed1ca4b36f9f1c942768b77f61dea`.

Os recibos próprios conservaram ações distintas:

- Criação: `ae9b0f291972f9e7d40d8beeaa8693e67b5578b9040d5f0737ae9b3c06de6b3a`.
- Edição: `53dacdf8b232fa896e7bd4e99ee5d1f8bfea12d9eb38a5f03cf8b577d5d18332`.
- Exclusão: `5c8db1031ba810189e309133b47e74218413eafc1d097c7c3f8d464d8d022e8e`.

A leitura independente usou a conexão Google Calendar do chat, separada do recibo do Worker. Nenhum compromisso pessoal foi publicado para demonstrar o teste. O evento técnico foi cancelado ao final.

## Interrupção anterior preservada

O primeiro pedido de criação terminou com `budget_exhausted` antes da inferência. A consulta independente ao ledger mostrou zero ações Calendar daquele ensaio antes da nova solicitação; nenhum efeito incerto foi repetido.

O operador ampliou apenas a conta de testes de 29/10 de 600.000 para 1.200.000 microUSD, mantendo o teto histórico global de US$10, os gastos/reservas existentes e as contas posteriores de 600.000 microUSD. Essa alocação não é aumento de orçamento recorrente nem contratação. Prova privada: `native-test-budget-topup-1793305926731`.

## Limites do aceite

O teste comprova o caminho nativo atual de criação, edição e exclusão por pedido autenticado do dono na agenda principal. Não amplia o escopo para convidados, recorrência, eventos de terceiros ou outras agendas. Não habilita escrita de agenda por evento do WhatsApp ou por tarefa agendada sem um pedido atual autorizado.

CI completa do código `959f29a`: execução GitHub `40948883105`, resultado `success`. A curadoria representativa, o envio WhatsApp após aprovação real e a release final permanecem critérios separados.
