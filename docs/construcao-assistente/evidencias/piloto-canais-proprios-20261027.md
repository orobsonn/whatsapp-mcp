# Canais próprios e auditoria do piloto sombra — 27/10/2026

Homologação técnica com a atuação global pausada e captura ativa. O resultado não ativa WhatsApp automático, escrita Calendar, processamento de todo o acervo ou observação contínua. Avaliação longitudinal e benefício humano continuam trabalho do piloto. A publicação dos marcos #140/#48 exige CI do commit entregue, versão/tag/release e encerramento coerentes; esse gate é separado das provas funcionais abaixo.

O marco #140 foi publicado na [v0.49.0](https://github.com/orobsonn/whatsapp-mcp/releases/tag/v0.49.0), com CI do PR/main aprovada e readback Source em0.49.0 preservando30bindings/runtime/cron/exposição; só então a issue foi encerrada. A v0.50.0 formaliza o marco próprio da #48, sem nova inferência ou código funcional. Seus resultados de CI e implantação pertencem ao commit/asset dessa release, sem reutilizar a CI anterior como prova de um novo SHA. O estado final pode ser conferido na [release0.50.0](https://github.com/orobsonn/whatsapp-mcp/releases/tag/v0.50.0) e na [issue48](https://github.com/orobsonn/whatsapp-mcp/issues/48).

## Fronteiras atuais

- **Cliente MCP:** ferramentas da assistente chamadas realmente pelo conector autenticado; #46 e #47 têm releases próprias. O pareamento Telegram/revogação/novo vínculo já foi comprovado, sem supor que publicar plugin atualizasse o catálogo.
- **Owner/Flue:** o [ensaio próprio](140-owner-once-cloud-20261027.md) restaurou checkpoint, consultou duas notas técnicas/964bytes, executou semântica obrigatória e Flue nativo e publicou uma proposta atual pelo diário normal. Um resultado anterior de citação não literal foi recusado e conservou seus recibos/custos. Não houve proposta ou avaliação humana inserida porSQL.
- **Telegram:** [quatro mensagens e quatro callbacks reais](48-telegram-review.md), duas revisões/duas simulações e quatro respostas confirmadas. Uma repetição de botão consumido, antes de expirar e com decisão atual, deixou os quatro recibos/estados integralmente iguais após POST200 correlacionado. Não foi observado o corpo de resposta `denied`; não se transforma HTTP200 em prova desse texto. Cliques feitos pelo executor autorizado não são avaliação humana de utilidade.
- **Calendar:** nova chamada própria retornou `available`, uma página/agenda principal concluída, cobertura completa somente do recorte consultado e snapshot não atômico. O [consentimento readonly](51-calendar-google-real-20261027.md), a proposta sem reserva e os limites Google continuam válidos. Não houve criação de evento/convite.
- **GitHub:** allowlist com uma única entrada para `orobsonn/whatsapp-mcp`, sem token, sustentada por nota administrativa privada do operador criada depois dos callbacks. A versão própria `1358e34e-6d0e-4a5d-a270-f8b200f8c76c` preserva os cinco módulos do código49cb077 e37bindings/runtime/imagem/cron/pausa/exposição, acrescentando apenas a configuração plain_text. Um guard recusou a primeira comparação de settings após upload; a mesma candidata foi reconciliada e promovida, sem novo upload.

GitHub retornou README disponível no commit `50076468075375be4734d98705f9092e086aa3a7`,5786bytes, blob `426fdd71400a24fb69206d44394a9cc00f025479` e SHA256 `1cd869041027b583b14fc2d625ca3e6192fb7908277d6ab0a599e1751ae652dc`. Conservou `execution=unconfirmed`, `deployment=not_observed` e cobertura single_file. A listagem inicial retornou `github_read_failed/coverageunknown`; um GET separado pelo computador respondeu200, sem provar a resposta recebida pelo Worker ou sua causa. Uma reconciliação explícita do mesmo GET Own completou uma página de uma entrada e outra de22, com `directory_end/complete` somente da raiz. Repositório fora da allowlist retornou `repository_not_authorized`. Nenhum corpo externo foi importado como owner_note, indexado ou usado para autorizar comandos. Repositórios privados continuam fora dessa configuração.

A nota administrativa nova muda o catálogo. A decisão já revisada passou posteriormente a `freshness=stale`, como esperado, sem renovar sua autoridade ou invalidar o histórico de revisão feito quando estava atual. Não se gerou outra proposta para esconder essa mudança.

## Auditoria dos16requisitos

| PRD | Evidência e fronteira |
| --- | --- |
|1 base e entrega | Base0.48.1 preservada, CI49cb077 verde1508/66/13 e módulos instalados conferidos; CI/tag/release do novo marco são gates próprios. |
|2 isolamento | Afinidade Owner atual, Worker separado, pausa/sombra preservadas; credenciais próprias, sem capacidade automática WhatsApp/Calendar write. |
|3 memória versionada | Fontes/notas/projetos/revisões/hash e acesso atuais; [contraprovas de fontes](35-acesso.md) e guards transacionais integrados. |
|4 captura/replay | Captura real continua e saúde confirma afinidade; [integração cloud](57-integracao-sombra-vps.md) exercitou materialização, duplicata, correção e retirada com dados sintéticos declarados. |
|5 cobertura/pausa | [Cron natural pausado](53-56-natural-cron-vps.md), cursores e lacunas explícitas. Há eventos bloqueados/tipo não observado; recebidos não equivalem ao universo upstream, e cobertura não é total. |
|6 extração | Ensaio cloud57 extraiu candidatos atribuídos com negação/condição e invalidou suporte retirado. A jornada Owner atual usa notas diretas e não refaz extração de todo o WhatsApp. |
|7 contexto | Busca semântica obrigatória e catálogo completo do corpus controlado; ordem inversa dos IDs reproduzida/corrigida e guard de citação não literal exercitado. Não prova compreensão geral. |
|8 Cognee/recuperação | Ingestão/checkpoint/restore reais e rebuild replay_only sem nova inferência; duas notas, limites de corpus e tentativas incertas conservados. |
|9 IA/custo/isolamento | Orçamento reservado antes dos efeitos, recibos/episódios persistentes e CI nativa; períodos/caps/fontes/prazos preservados, sem retry cego. |
|10 encaminhamento | Proposta real sustentada por citação literal; falha de qualidade anterior recusada. Estrutura/atribuição não equivalem a utilidade ou verdade semântica universal. |
|11 direção Owner | Comandos reais MCP e [pareamento/revogação](47-revogacao-revinculo-real-20261027.md); Telegram só registra revisão/simulação, sem autoridade de envio ou relato humano inferido. |
|12 missões/FUPs | [Contratos versionados](31-trabalhos.md) e testes integrados separam missão/FUP/ocorrência/job; simulação não encerra compromisso real. |
|13 conectores/mídia | GitHub público e Calendar primary reais acima; [mídia cloud controlada](52-media-cloud-vps.md). Contexto de mídia Own continua off, sem importação em massa ou alegação de leitura de todo o arquivo. |
|14 revisão | Quatro tópicos/notificações/callbacks e botão consumido reais; timeout/concorrência/ACK perdido têm contraprovas integradas, sem induzir envio incerto real. |
|15 avaliação | Métricas reais conservam avaliações humanas0, denominador0/fração null e correção atualunknown; custo169reservas/6391microUSD Own. Uma latência de parede de210225ms não mede atenção ativa, inferência isolada ou SLA geral. |
|16 operação | [Instalação](56-instalacao-integrada-vps.md), [export/retirada/restore](55-retencao-cloud-vps.md), recovery Owner real e [runbook atualizado](../operacao.md); rollback não apaga D1/ledger nem ativa geração restaurada. |

## Custos e limites restantes

Censo dos ledgers conhecidos:61.701microUSD (US$0,061701), incluindo40.000incertos históricos e3.000em duas reservas anteriores conservadas. A Own tem167recibos completos/3.391microUSD liquidados, mais as duas reservas. Conta diária600.000microUSD e teto global autorizadoUS$10 permanecem iguais; não há nova inferência nos cliques ou consultas de conectores. Ledger não é fatura; Container/Workers/D1/R2/egress e outras despesas de infraestrutura continuam separados e não conciliados integralmente.

Google continuaExternal/Testing, com validade de7dias para esse refresh token Calendar. Continuidade longa requer nova autorização ou publicação apropriada, sem prometer token permanente. Antes de observação contínua, ampliar/medir corpus representativo e definir o escopo de atuação; a pausa global foi preservada nesta homologação. Cobertura parcial do arquivo e lacunas permanecem visíveis. Avaliação humana/benefício longitudinal não foram fabricados como condição de aceite técnico.

O Chrome utilizado permanece com JavaScript por Eventos da Apple habilitado; sua desativação não foi confirmada. Essa permissão local foi usada no bot próprio, não entregue ao Worker. Tails temporários foram removidos, processos locais encerrados e credenciais de operadores efêmeros retiradas conforme os recibos privados. Segredos e dados pessoais não constam desta evidência pública.
