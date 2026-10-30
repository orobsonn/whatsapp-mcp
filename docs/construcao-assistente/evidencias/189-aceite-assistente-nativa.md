# Aceite do marco nativo — modo aprovação

Revisão em30/10/2026 contra A01–A17 do plano aprovado. Implementação preserva os três modos com a mesma inteligência. A instalação real opera em aprovação; autonomia em produção depende de autorização posterior. Esta auditoria não transforma ensaio controlado em homologação autônoma real.

| Critério | Evidência e limite |
|---|---|
| A01 Continuidade |153/156: Flue nativo em DO, continuidade/reinício/isolamento e compactação controlados.188: orientação real retoma a mesma sessão WhatsApp. |
| A02 Ferramentas |158/161/180/185/188: chamadas reais de memória, arquivo, GitHub, agenda e mídia usadas pelo agente. |
| A03 Aprendizado |160/187: agente escolhe gravações, com recibo pronto e consulta posterior independente. |
| A04 Grafo |155/158/177/184: entidades, relações e suportes explícitos; consulta por entidade/predicado, correção/retirada e concorrência. |
| A05 Compartilhamento |158: MCP→bot;160/187: curador→MCP. Cliente de status de operação continua restrito; consulta do grafo é compartilhada. |
| A06 Relação cruzada |155/158/160: sessão distinta recupera relação e originais autorizados; não depende só de similaridade. |
| A07 Correção/retirada |153/154/156/158: retirada de suporte, invalidação de contexto e purga nativa; cópias externas/backups não têm promessa de revogação instantânea. |
| A08 Curadoria |170/187: agendamento03:00America/Fortaleza; recuperação real e encerramento parcial.158avaliadas,1aprendizado creditado,88indisponíveis,204lacunas de captura. Resumo anterior aceito; nenhum novo resumo final. Resumo diário permanece até confirmação do dono para mudar avisos. |
| A09 Ajuda |188: pergunta real→resposta autenticada e vinculada→mesma sessão→nova proposta. Reavaliação/rejeição de atividade posterior também coberta pelos testes de autoridade/atividade; este caso não simula uma mensagem concorrente. |
| A10 Ação |188: sugestão atual, clique humano, mesma ação e uma tentativa Source aceita, ID do provedor e uma mensagem enviada capturada com texto exato. Retomada operacional após correção de relógio explicitada. Não prova entrega/leitura ou callback ininterrupto após o patch. |
| A11 Autonomia |Contrato de política e envio nativo testado nos três modos, incluindo silêncio/ajuda, bloqueio por autorização e repetição sem segundo efeito. Autonomia real desligada e não homologada com destinatário real; ativação exige autorização específica. |
| A12 Conectores |161/166/180: GitHub real com código/SHA, agenda com títulos e CRUD de um evento próprio verificado de forma independente. Falhas permanecem indisponíveis, sem inventar fato. |
| A13 Uso contínuo |177/184: crescimento, restauração e concorrência em corpus controlado, além de relações reais do dono. Não é promessa de escala ilimitada ou cobertura de todo o arquivo. |
| A14 Custos |182/187/188: estimativa antes de ativação, reservas/recibos/estados incertos preservados. Controle conservadorUS$6,596799, saldoUS$3,403201contraUS$10. Não é fatura nem garantia deR$100/mêsIA+infra. |
| A15 Divulgação |183: ensaio DeepSeek real com dados fictícios/instruções maliciosas e fronteira de ação;188: envio real separado do texto aprovado. Sem teste de exfiltração na esposa nem garantia de confidencialidade perfeita. |
| A16 Uso real |Sugestões/descarte observados pelo dono, conectores, imagem, lembrete, orientação e aprovação reais; custos, falhas e latência observados. O caso188 encontrou uma falha de autorização antes do envio, corrigida sem substituir a observação por testes locais. |
| A17 Escopo |154/156 e testes de elegibilidade/retirada: individuais por padrão, exclusões e grupos opt-in no mesmo acesso compartilhado. Captura armazenada não concede participação nem autorização de envio. |

## Revisão e integração

Revisor adversarial independente não encontrou novo bloqueio funcional para este marco em aprovação. Exigiu manter as ressalvas acima, registrar a retomada operacional e aguardar a CI do código antes de fechar o marco.

Código mais recente: `0d4556c`. Source ativo `35d1339e-6d84-4840-8003-53f3407ac6c9`; Own `5a6f01a1-a629-463d-8e37-1177f03429b4`.35testes dirigidos, typecheck e build Source passaram. CI41144283773 concluiu com sucesso no código0d4556c, incluindo suítes gerais, OAuth, runtime nativo, contratos, builds e auditoria de dependências sem vulnerabilidades. A integração acrescenta somente a consolidação documental desta evidência,188 e changelog; código de runtime é o mesmo verificado pela CI. Merge/tag/release seguem o fechamento deste marco. Nenhum envio autônomo ou contratação de infraestrutura foi ativado.
