# Extração canônica no scheduler

O caminho do scheduler agora chama `CanonicalCandidateExtractor` antes de
indexação e busca. A extração produz candidatos atribuídos em D1; o grafo
derivado do Cognee continua sendo outra projeção. Isso fecha a ausência do
produtor runtime de `Relations.publish`, sem declarar homologação cloud do
critério #57/ac-16.311.

O host lê a fonte atual com `SourceAccess(actor)`. O catálogo contém somente
projetos explicitamente associados a owner notes, ou missões **draft** ligadas à
mesma fonte/revisão e seus projetos explícitos. São até 16 referências, com IDs
e revisões canônicos; nomes, objetivos privados de missões, hashes de autores e
HMACs não viram identidades. Não há inferência/criação de pessoas, identidades,
memberships, autorização, missões ou FUPs. Fonte e autor originais permanecem
registrados em cada lote de candidatos.

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
de publicado, outro actor atualmente autorizado pode ler o terminal sem mudar
o actor pinado. Isso exige mesma fonte/configuração/catálogo/payload, origem e
ACL atuais, recibo completo com settlement correspondente e lote/hash de claims
consistentes. Backing ausente/divergente permanece lacuna, sem reinferência.

## Operação e retenção

Pausa impede a chamada ao extrator. O resumo diário conta fontes ativas textuais
owner note/WhatsApp da geração atual,
terminais com backing presente, pendências, catálogo ausente e unknown; também
preserva gaps concretos dos itens. Uma fonte positiva não remove a lacuna de
outras fontes. Namespace sem fontes informa `not_observed`, sem percentual de
completude. O resumo diário continua sendo uma fotografia de metadados, não
prova semântica de toda a memória.

A tabela nova participa de feature health e export completo do dono. Purga
remove seu payload junto ao fechamento da fonte e preserva orçamento/recibos
financeiros. Triggers bloqueiam admissão/publicação durante quiescence;
settlement e a marcação conservadora de unknown continuam possíveis. Snapshots
canônicos e restore excluem slots/payloads de extração e não ativam tentativas
antigas. A migração é aditiva e não foi aplicada em cloud nesta entrega.

No rollout, aplicar 0026 no D1 próprio da assistente antes do novo código/daily,
mesmo em pausa. A configuração do scheduler mudou: itens preparados sob a
configuração anterior ficam bloqueados por `configuration_or_binding_changed`.
Medir esse backlog; não rekeyar trabalho desconhecido para fazê-lo avançar.

## Evidência e limites

Os testes dirigidos usam D1/guards reais com adapters sintéticos. Há contraprova
do módulo ausente e do hook removido, teste de WhatsApp materializado com missão
e projeto explícitos e recuperação da fonte pela relation lane, revogações
durante modelo/no INSERT final, ACK perdido, orçamento, whitelist, zero claims,
reuso por guest, export/purga e exclusão do restore. Nenhum teste usa provider,
segredo real, deploy ou dados pessoais. Custo de provider nesta implementação:
US$0.

Ainda é necessária execução do fluxo integrado em recursos reais com os novos
bundle e schema, CI do commit integrado, revisão da integração e as demais
fronteiras de #57. Atribuição de autor não homologa identidade canônica de
pessoas; canais, consentimentos e cliente MCP mantêm suas pendências próprias.
