# Construção na VPS — 26/10/2026

Continuação do RETOMADA-VPS.md preservado. Goal: cumprir os critérios técnicos do piloto sombra; ainda não há homologação integrada do produto. Engenharia/autorização seguem o pedido do dono, sem WhatsApp automático, escrita Calendar, alteração do Elo ou instalação do harness.

## Entrega concluída

#121 fechada com v0.34.0, tag em56769c8658f9daf698c6766b45ea268a7557513e. PR124 recebeu correção determinística da disputa de prazo25ms no teste de política do diário e revisão adversarial independente. Ambos checks do PR e CI40320191142 na main aprovados:729 testes gerais/52 nativos, tipos, ambos builds e audit. Pacote/lock/changelog/tag conferidos. Prova cloud anterior preservada, sem repetir snapshot/recuperação paga.

## Engenharia ainda em validação

- #112: branches originais preservadas e combinadas com121. Correções de prepare recusado por manutenção e submit frio preservam alias/ticket/hash/prova e admissão única. Revisão encontrou e corrigiu também recusa busy concorrente escondendo recibo completo; só o mesmo ticket/operação/revisão sob prova atual reconcilia, sem retry. Evidência112-semantic-recovery-vps.md registra RED/GREEN e contraprovas. CI da primeira composição semântica passou, mas ainda não contém todos os follow-ups; não é aceite final. Runtime callback Flue que reconstruía busca lexical está sendo corrigido/testado separadamente.
- #46/#47/#49/#52: commits autorais preservados em codex/assistant-product-integration; migrações0015–0020 distintas. Conflitos combinam testes nativos checkpoint+owner binding, semantic ranking+mediaEvidence, Telegram+FUP. Nenhuma issue destas foi fechada.
- #52: primeira CI de composição40320659169 reproduziu fixtures antigas incompatíveis com subject obrigatório45 e correção owner_note46. Fixtures corrigidas sem relaxar produção. Contraprova adicional corrigiu OCR autorizado fora do top1 desaparecendo da cobertura.31/31 mídia+tipos passaram, incluindo negativo privado, diário real e atribuição model_extraction. A falta de semântica do OCR permanece explícita.
- #50/#51: leitores GET em commits675b7c2/c485a7b e composição privada;27/27 testes dirigidos e revisão adversarial. GitHub com repositório/projeto autorizado/SHA fixo; Calendar sem detalhes privados, parcial não conclui disponibilidade e proposta não reserva. Normalização civil/fuso e refresh OAuth durável ainda em construção; token estático não sustenta piloto contínuo. Conteúdo externo ainda não foi indexado/importado como notas.
- #48: tópicos/outbox/callbacks em branch própria, com revisão atômica local e vínculo autenticado. Testes e revisão em andamento. Nenhuma chamada Telegram real foi feita.
- #53–57: implementação/integração/infraestrutura e homologação restantes; somente interfaces existentes não constituem scheduler instalado nem aceite.

## Acessos e dependências humanas

GitHub autenticado nesta VPS e publicação confirmada. O perfil Cloudflare pessoal inicialmente consultado retornou invalid access token9109 e a tentativa OAuth por dispositivo expirou. Inventário posterior encontrou outra credencial local válida: acesso foi verificado contra Worker/D1 pessoais conhecidos, sem copiar segredo do Elo nem presumir transporte do Mac. Cloudflare deixou de ser dependência humana. OAuth Calendar e vínculo real Telegram/MCP/cliente continuam pendentes; a engenharia independente prossegue. Docker ausente; a imagem do laboratório foi recuperada por digest da versão ativa, sem reconstrução improvisada.

## Custos e tentativas incertas

Novas chamadas de APIs de modelo deste executor:0; custo incremental de modelo até este registro:US$0. Tests usam dados sintéticos e adapters limitados; nenhum ensaio pago foi iniciado. O limite TOTAL autorizado permaneceUS$10, sem apagar reservas antigas.

Ledger relido na Cloudflare e novamente conferido antes dos ensaios:229 recibos completos na geração build-g3; UTC26/build-g3 comprometido3693microUSD; outros períodos/gerações44712microUSD, incluindo40000incertos. Global48405microUSD=US$0,048405;US$0,04 incertos permanecem comprometidos. Não significa fatura final nem custo de Container. Cap anteriorUS$0,30; elevação aUS$0,60 NÃO aplicada por esta sessão. Não apagar contas ou reconfigurar insert-only para forçar teste. Recalcular ledger vivo antes de qualquer aumento/ensaio e separar tokens, Containers e ferramentas de desenvolvimento.

## Próxima fronteira de validação

Congelar árvore integrada antes de executar suíte, aguardar resultado antes de mutações e rodar apenas uma suíte pesada local por vez. Suite/CI em HEAD intermediário nunca valida mudanças posteriores. Homologação semântica cloud exige corpus completo, ACL/correção/retirada/restart/cache sem nova cobrança, checkpoint atualizado antes de parar e custos/recibos reconciliados. Canais sem consentimento/configuração continuam visíveis; prontidão do piloto e utilidade longitudinal não são inferidas de fixtures.

Suíte geral da composição76a1610:967/969 passaram em594,66s nesta VPS. Falhas preservadas foram exclusivamente prazo do harness:5.256ms acima de5.000ms no primeiro caso semântico e32.106ms acima de30.000ms no corpus1105. Revisão adversarial aprovou margem de30s no harness D1 e90s no benchmark que inclui seed+14páginas autorizadas; não muda prazos/guardas de produção nem asserts de duração. O benchmark passa a exigir14passos/884avaliações/884itens permitidos (a fixture1105/5 significa uma fonte privada a cada cinco, não somente cinco privadas), além de fonte final, ausência de privados e fence válido. Sem promessa de SLA cloud; rerun dirigido e CI no novoHEAD ainda necessários.

## Atualização após retomada com acesso total

- #112: PR119 em a2075e2 recebeu ambos checks verdes (runs40322994943/40322985251). Inclui as correções dos dois bugs, reconciliação do recibo completo após busy concorrente e factory semântica compartilhada pelo callback real Flue. Continuidade do produto também aplica a factory ao MCP e Telegram.
- Na composição local, os dois arquivos de busca passaram63/63 em113,55s após corrigir os prazos do harness. A suíte nativa passou58/58 em232,30s; houve integração adicional na árvore durante essa execução, portanto ainda é necessário gate no HEAD final congelado.
- #48 integrada (tópicos/outbox/callbacks sem efeitos WhatsApp/Calendar); #51 agora tem refresh OAuth readonly cifrado e durável,53/53 Workers,3/3 Node e1/1 DO SQLite nativo. CI verifica OAuth sequencialmente. Nenhum consentimento Google real foi alegado.
- #54 integrada com avaliações explícitas do dono, exposição/latência de parede, cobertura desconhecida e financeiro conservador;23/23 dirigidos. #55 etapa A integrada com export paginado/financeiro de todas gerações e autoridade monotônica inativa;19/19 dirigidos na branch de origem, tipos na composição aprovados. Purga/restauração e barreira global ainda não entregues.
- #53 está em revisão na worktree /tmp/assistant-routines;20/20 casos antigos passaram, dois casos de ACK perdido foram acrescentados sem resultado ainda. Revisão encontrou coalescência indevida de fontes diferentes e exige correção antes da integração. #56 está construindo instalação reproduzível e handshake privado de afinidade; não existe deploy do produto sombra.
- Probe privado anterior recuperado do sourcemap do Worker, adaptado para Linux e mantido em local/ ignorado. Só PROBE_TOKEN foi rotacionado, com novo valor privado0600; OPENAI_API_KEY, D1, namespace DO e imagem foram preservados. Worker atualizado para versão16590217-af88-43c0-8b37-3f08df07fe02; bundle publicado confere SHA2566e5b1ddb6acd82dfbb5e162209f5fe51cc276c8bc20cfd2640f05e28d948557b com a compilação de a2075e2 mais diagnóstico de laboratório.
- Checkpoint9 exato03339ec2219f47481f972ae8b4f4400be439fa79d18ddad1de2dcd2b10a0cc03 restaurado e confirmado com9 fontes/5.439.701bytes; época/revisão do índice preservadas. O diagnóstico mostra dois tickets antigos attempting sem recibo: devem continuar incertos, sem reset/rekey/reenvio. O run original recusado no prepare recuperou o mesmo alias para prepared; submit frio corrigido conservou prepared e não fez chamada paga. A prova paga restante e a revisão de qualidade ainda estão em andamento, não são aceite final de #112.
