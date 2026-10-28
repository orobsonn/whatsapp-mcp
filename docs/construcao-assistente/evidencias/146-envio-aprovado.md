# Envio aprovado — implantação e aceite pendente

Snapshot: 28/10/2026, 16:31 UTC. [Issue146](https://github.com/orobsonn/whatsapp-mcp/issues/146), [PR147](https://github.com/orobsonn/whatsapp-mcp/pull/147). Este registro distingue código implantado de comportamento homologado.

## Código e implantação verificados

- Código funcional: `9b33c4fe54a1b2e286aa59136521a581c9959714`, versão de pacote `0.52.0`.
- [CI40721194289](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40721194289) aprovada: 1727 testes gerais, 13OAuth e 70nativos; verificações Node, tipos, builds e auditoria também passaram. A execução anterior falhou na integração de retenção; a causa foi corrigida separando a tabela Source `approved_sends` do catálogo Own, sem ampliar permissões.
- Source: versão `bbec4fe5-82f0-4b47-9c1e-12578208c6c2`, um módulo e31bindings. Health200, pacote0.52.0, manutenção desligada e conexão configurada.
- Own: versão `23f5c0cc-cca4-43af-ba6f-dba36ac47734`, onze módulos e49bindings. Imagem/runtime, bindings anteriores, cron e exposição preservados. Elo não foi alterado.
- Migração Source0016 e Own0034 aplicadas. As quatro definições da migração Calendar0033 já existiam e foram comparadas com o código antes de reconciliar somente seu registro de aplicação; dados/DDL da agenda não foram recriados.
- Health Own confirmou envio configurado, resposta autônoma desabilitada e capacidade reativa Calendar preservada. Health não comprova um envio ao provedor.

## Recorte desta ativação

Oito conversas privadas recentes, respeitando exclusões e pausas existentes; somente novas mensagens de texto recebidas após o início do piloto. Mensagens do próprio dono não disparam resposta. Contexto de até três fontes textuais/8KiB da mesma conversa, com referências congeladas e revalidação na indexação, busca e episódio Flue.

As219 pendências anteriores foram preservadas. FUP anterior, diário e extração automática de missões não são executados por este piloto. Controles reativos existentes permanecem disponíveis. Esta ativação não comprova análise automática de grupos, áudio, imagens, documentos ou de todo o histórico.

## Critérios e força da evidência

| Critério | Evidência atual | Situação |
|---|---|---|
| Nova mensagem privada recebida em escopo | Nenhum evento elegível desde a ativação até este snapshot | Pendente |
| Análise automática com contexto real | Código e testes dirigidos; falta entrada real elegível | Pendente em produção |
| Sugestão útil no Telegram, com destino e texto integrais | Implementação e testes; nenhum novo aviso desse circuito | Pendente em produção |
| Aprovação real do dono sobre a sugestão exata | Nenhum recibo humano novo | Pendente |
| Uma tentativa WhatsApp e consequência do provedor | Nenhum envio real deste circuito | Pendente |
| Clique repetido não duplica; incerteza consulta a mesma ação | Testes de callbacks, concorrência, ACK perdido e Source passaram | Comprovado nos testes; repetição real pendente |
| Alteração, revogação e expiração impedem novo envio | Guards e testes dirigidos, incluindo destinoA→B→A | Comprovado nos testes |
| Responder sem aprovação permanece desligado | Readback da configuração e health Own | Verificado na implantação |
| Custos e recibos anteriores preservados | Comparação das configurações e censo dos ledgers conhecidos | Verificado no recorte observado |
| Release minor, tag e encerramento da issue | Ainda não publicados/encerrados para este marco | Pendentes do aceite real |
| Avaliação humana da utilidade e comportamento longitudinal | Não há avaliação nova atribuível a este circuito | Desconhecida |

Entre o início e este snapshot chegaram nove eventos de grupos, fora do recorte; eles não foram contados como análise privada nem como propostas. A captura e o cron continuam ativos. Não foram fabricados eventos de entrada, notas substitutas ou cliques de aprovação para preencher o aceite.

## Custos e continuidade

Censo às16:19:59UTC: **91.573microUSD (US$0,091573) em custos e reservas conhecidos do projeto**, incluindo40.000incertos históricos e3.000reservados preservados. Não atribuir o total à nova análise proativa, que ainda não teve uma entrada elegível. Fatura e infraestrutura não foram reconciliadas neste censo.

As contas existentes de27/28outubro continuam com600.000microUSD por janelaUTC. Foram configuradas sete janelas futuras,29outubro–4novembro, com o mesmo limite deUS$0,60cada: atéUS$4,20adicionais de autorização, sem cobrança antecipada e sem resetar recibos. O teto global autorizado deUS$10não foi renovado. Após esse período, a continuidade do orçamento precisa ser revista usando o consumo acumulado. GoogleExternal/Testing mantém sua limitação conhecida de renovação de consentimento; ela não foi resolvida por este marco.

## Próximo passo

Receber texto de outra pessoa em conversa habilitada, observar a análise e a sugestão, obter aprovação real e conferir a ação/recibo no Source e no provedor. Só então consolidar o resultado e publicar a release. A aplicação roda no Worker/Flue; o acompanhamento pelo Codex não deve substituir seu processamento.
