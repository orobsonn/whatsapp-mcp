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

GitHub autenticado nesta VPS e publicação confirmada. Perfil Cloudflare pessoal local retornou invalid access token9109; credenciais/probes do Mac não vieram no clone. Login Wrangler por dispositivo funciona sem callback localhost, mas a tentativa interativa expirou sem consentimento. Autenticação Cloudflare, OAuth Calendar e vínculo real Telegram/MCP/cliente continuam pendentes; a engenharia independente prossegue. Docker ausente no inventário inicial; resolver por CLI se necessário ao build/deploy, sem alegar bloqueio humano antes de tentar.

## Custos e tentativas incertas

Novas chamadas de APIs de modelo deste executor:0; custo incremental de modelo até este registro:US$0. Tests usam dados sintéticos e adapters limitados; nenhum ensaio pago foi iniciado. O limite TOTAL autorizado permaneceUS$10, sem apagar reservas antigas.

Último ledger conhecido do handoff (ainda NÃO relido na Cloudflare):229 recibos completos; UTC26/build-g3 comprometido3693microUSD; outros períodos/gerações44712microUSD, incluindo40000incertos. Global conhecido48405microUSD=US$0,048405;US$0,04 incertos permanecem comprometidos. Não significa saldo/fatura atual nem custo de Container. Cap anteriorUS$0,30; elevação aUS$0,60 NÃO aplicada por esta sessão. Não apagar contas ou reconfigurar insert-only para forçar teste. Recalcular ledger vivo antes de qualquer aumento/ensaio e separar tokens, Containers e ferramentas de desenvolvimento.

## Próxima fronteira de validação

Congelar árvore integrada antes de executar suíte, aguardar resultado antes de mutações e rodar apenas uma suíte pesada local por vez. Suite/CI em HEAD intermediário nunca valida mudanças posteriores. Homologação semântica cloud exige corpus completo, ACL/correção/retirada/restart/cache sem nova cobrança, checkpoint atualizado antes de parar e custos/recibos reconciliados. Canais sem consentimento/configuração continuam visíveis; prontidão do piloto e utilidade longitudinal não são inferidas de fixtures.
