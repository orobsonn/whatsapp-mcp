# Extração canônica no scheduler

O caminho do scheduler agora chama `CanonicalCandidateExtractor` antes de
indexação e busca. A extração produz candidatos atribuídos em D1; o grafo
derivado do Cognee continua sendo outra projeção. Isso fecha a ausência do
produtor runtime de `Relations.publish`, sem declarar homologação cloud do
critério #57/ac-16.311.

A descoberta usa uma etapa host Owner privada, separada do actor/perfil do
interlocutor. Fonte original e contexto precisam continuar elegíveis para
leitura/automation, com origem, pausa, exclusão e hold atuais. Projetos podem
ser ensinados por qualquer owner_note ativa autorizada com project_id explícito;
a mensagem nova não precisa estar previamente ligada ao projeto. O catálogo
fornece nomes/descritores necessários e IDs distintos, sem inferir pessoas ou
alterar associações administrativas. Missões draft/active da fonte/revisão
exatas preservam o projeto opcional. São16 entidades/16 notas,8KiB do catálogo
enviado e32KiB de provas metadata; overflow do conjunto inteiro é explícito.

O prefixo reservado canonical-owner-v2: é negação permanente ao interlocutor,
nunca prova de autorização Owner. Provas sidecar0027 ficam vinculadas ao slot0026
único por fonte/revisão; nenhum reset/rekey/lane financeira novo é criado.
Missing/corrupt proof falha fechado. Toda leitura privada exige a afinidade
atual completa (instalação, geração, sourceEpoch e sourceGeneration), compatível
com o pin original, além dos SourceFence/OriginFence originais atuais. Ausência
ou rotação dessa afinidade nega só a projeção privada; não promove/recria o slot. Relações novas são exclusivamente Owner;
legado source audience conserva suas regras. Leitura, score e fingerprint guest
não revelam claims, nomes, existência ou capacidade dos lotes privados.

O query source existente do OwnerMCP expõe canonicalCandidates com claims,
referências de supports e estado unreviewed e semanticValidation=unverified. Quotes pertencem
ao original atual; descritor de outra nota não é fala atribuída ao autor da
mensagem. Zero claims usa o backing do slot/recibo, sem lote fictício. O modelo
não concede ACL, não resolve identidade por nome e não cria Source.project_id,
missões, FUPs ou ferramentas executáveis.

Uma fonte sem catálogo retorna `canonical_catalog_empty` antes de criar slot,
reservar orçamento ou chamar modelo. A busca/episódio existente pode continuar
com os originais; o resumo mantém a lacuna. Uma associação explícita posterior
pode tornar essa fonte elegível. Isso difere de uma resposta válida do modelo
com zero claims: ela tem um recibo pago terminal, sem lote vazio de relações.

Os limites rejeitam excesso integralmente: texto até 16 KiB UTF-8, catálogo até
16 referências/8 KiB, até 8 claims e lote JSON até 32 KiB. Não é ingerido um
prefixo para anunciar cobertura completa. Subject/object precisam pertencer ao
catálogo, kind é limitado e cada quote precisa ser substring literal do
original. Campos administrativos, referências inventadas e quotes fabricadas
invalidam o lote inteiro. Os candidatos não são confirmação de fato ou licença
para executar ferramentas.

## Admissão, recibos e revogação

A migração `0026_canonical_extraction.sql` cria um slot exclusivo por namespace,
fonte e revisão. Actor, source fence, origin fence, catálogo, configuração,
payload e período ficam pinados antes de admissão/modelo. A configuração fixa
usa o broker e os preços versionados existentes; o teto conservador por chamada
é 20.000 microUSD. O ledger existente preserva valores reais e tentativas
incertas; esta entrega não configura cap novo, limpa custos ou reabre uma
tentativa desconhecida.

`ModelAdmission` vincula o slot ao recibo exclusivo do broker na mesma transação
da admissão. Antes do adapter são refeitos runtime, ACL, origem remota/local,
catálogo e lease do ciclo. A publicação repete a observação remota após hashing,
reconstrói os guards locais e confirma recibo completo no `D1.batch` que insere
as relações e marca o terminal. Hold, quarentena, correção, retirada, revogação
de policy/prova ou perda do ciclo podem vetar a publicação após o modelo; seu
custo/recibo continuam preservados.

Para respeitar os 100 parâmetros por statement do D1, apenas os **valores** dos
guards gerados pelo host são empacotados em um JSON bound. O SQL original de
SourceAccess, origem, catálogo, lease e retenção é reavaliado integralmente em
cada transação; nenhum resultado de autorização é cacheado. O helper rejeita
placeholders nomeados/numerados, quotes ambíguas, comentários, cardinalidade
divergente, valores não primitivos/inteiros seguros e JSON acima de 32 KiB.

Após unknown, não há reset, rekey ou replanejamento por novo catálogo/actor. O
mesmo slot só pode recuperar o recibo completo exato, sem provider retry. Depois
de publicado, o Owner atualmente autorizado pode ler o terminal sem mudar
o actor pinado; interlocutores não podem reusar sua descoberta privada. Isso exige mesma fonte/configuração e topologia do catálogo
(kind/id/projectId/cardinalidade), com DTOs estritos. Apenas revisões CAS das
entradas do catálogo podem diferir, incluindo o mesmo catálogo no JSON user do
payload. Source.revision, autor, texto, system, modelo, tokens e demais campos
continuam exatos. Nomes, objetivos e textos/refs dos supports também são semânticos
e precisam continuar idênticos; formato legado inválido ou campos desconhecidos
negam reuso.
O guard SQL usa revisões atuais, com origem/ACL/lease/hold atuais, recibo completo,
settlement correspondente e lote/hash de claims consistentes. Os dados pinados
originais não mudam. Backing ausente/divergente permanece lacuna, sem reinferência.

## Operação e retenção

Pausa impede a chamada ao extrator. O resumo diário do Owner deve contar fontes
textuais elegíveis da geração atual, terminais com backing/contexto local atual,
pendências, catálogo ausente e unknown; sua leitura metadata não atesta freshness
remota nem validação semântica. O resumo usa a mesma elegibilidade do catálogo global, página até64 com
denominador total e cobertura parcial explícita. Zero claims valida slot/proof e
settlement sem lote fictício; ausência/corrupção de proof ou status redacted não
viram terminais saudáveis. Não usa uma observação remota simulada. Uma fonte positiva não remove a lacuna de
outras fontes. Namespace sem fontes informa `not_observed`, sem percentual de
completude. O resumo diário continua sendo uma fotografia de metadados, não
prova semântica de toda a memória. Reviews já cacheadas no mesmo período são
snapshots históricos imutáveis; não são apagadas/recalculadas no rollout. Uma
consulta Source do Owner valida candidatos atuais independentemente desse cache.

Os três sidecars de 0027 participam de feature health e export completo do dono.
Purga de support retira as projeções e payloads Owner derivados, preservando o
slot 0026 como rejeitado/context_purged e seus pins quando a âncora continua ativa.
Purga da própria âncora remove seu fechamento operacional; ambas preservam o
orçamento e os recibos financeiros. Triggers bloqueiam admissão/publicação durante quiescence;
settlement e a marcação conservadora de unknown continuam possíveis. Snapshots
canônicos e restore excluem slots/payloads de extração e não ativam tentativas
antigas. A migração é aditiva e não foi aplicada em cloud nesta entrega.

No rollout, aplicar 0026 e 0027 no D1 próprio da assistente antes do novo código/daily,
mesmo em pausa. A configuração do scheduler mudou: itens preparados sob a
configuração anterior ficam bloqueados por `configuration_or_binding_changed`.
Medir esse backlog; não rekeyar trabalho desconhecido para fazê-lo avançar.

## Evidência e limites

Os testes dirigidos usam D1/guards reais com adapters sintéticos. Há contraprova
do módulo ausente e do hook removido, teste de WhatsApp materializado com missão
e projeto explícitos e recuperação da fonte pela relation lane, revogações
durante modelo/no INSERT final, ACK perdido, orçamento, whitelist, zero claims,
negação de reuso pelo guest, export/purga e exclusão do restore. Nenhum teste usa provider,
segredo real, deploy ou dados pessoais. Custo de provider nesta implementação:
US$0.

Ainda é necessária execução do fluxo integrado em recursos reais com os novos
bundle e schema, CI do commit integrado, revisão da integração e as demais
fronteiras de #57. Atribuição de autor não homologa identidade canônica de
pessoas; canais, consentimentos e cliente MCP mantêm suas pendências próprias.

## Atualização de integração Owner privada

O scheduler persiste o resultado/gap Owner em assistant_owner_canonical_status.
Um erro/unknown de descoberta privada não altera o actor, coverage, phase,
last_gap ou revisão do episódio interlocutor; o orçamento global e seus holds
continuam valendo. O loop não cria um segundo episódio Flue nem repete inferência
incerta. Perfil Owner pode manter sua própria pendência explícita.

Guards de escrita recompõem os predicates concretos compartilhados de
SourceAccess/Conversations e o catálogo atual completo, com clock após os awaits.
Essa forma preserva profundidade100 e binds100 no D1; a fronteira16/16 é testada.
Leituras de candidates executam SELECTs de todos os guards em um único D1.batch,
um snapshot transacional, sem grant persistido entre awaits. Owner fingerprints
usam o mesmo universo de notas elegíveis antes do limite; mudança de support
invalida rank/fence mesmo quando a nota não participa do escopo de busca.

Mudança de configuração não autoriza rekey de itens/slots antigos. Os itens
capturados antes da configv2 precisam de inventário e recuperação explícita,
separada da prova de novos eventos. CI, revisão de integração e cloud continuam
pendentes; esta documentação não declara o piloto pronto.
