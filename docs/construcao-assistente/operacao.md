# Instalação sombra da assistente — #56

Este runbook descreve artefatos e etapas de instalação. Renderizar configuração, ter CI verde e observar um binding não equivalem a homologação do piloto. #57 exige a jornada cloud integrada e os negativos. Instalação/flags não concedem WhatsApp automático ou delegação de escrita Calendar. O diálogo autenticado do dono possui perfil Calendar próprio de gestão, autorizado separadamente em28/10/2026.

## Estado observado na retomada VPS

Consulta Cloudflare somente leitura em 26/10/2026 confirmou o domínio `whatsapp.robsonlins.com` no Worker próprio `whatsapp-mcp`, com D1/R2/KV/AI e cron por minuto. Não havia bindings ASSISTANT_* no deploy observado. O Worker `personal-assistant-shadow` retornou 404. `assistant-build-check` e `assistant-media-pdf-check` existiam como laboratórios sem cron. Esse inventário examinou nomes/tipos e configuração pública permitida; não recuperou valores de secrets nem acessou recursos do Elo. Revalidar no momento da instalação.

Recursos novos do produto: Worker `personal-assistant-shadow`, D1 `personal-assistant-shadow-state`, bucket privado `personal-assistant-shadow-artifacts` (ARTIFACTS_INSTALLATION_ID/ARTIFACTS_GENERATION devem coincidir exatamente com o escopo do host) e parser `personal-assistant-pdf-parser`. Não usar o banco, bucket, namespaces ou estado do laboratório/Archive como se fossem instalação nova. O instalador recusa os IDs conhecidos desses bancos. O digest deve usar o registry da mesma conta e um asset com prefixo assistant; outra conta ou nome apenas contendo assistant são recusados. A imagem Cognee pode reutilizar o digest comprovado do build próprio; o Container/DO e seu namespace de dados são novos. Não há build Docker improvisado quando a VPS não tem Docker.

## Artefatos locais sem ações cloud

Node>=22.19 e dependências do lockfile. Criar um manifest privado com este formato, preenchido pelo executor a partir do inventário atual:

```json
{
  "schema": 1,
  "accountId": "ab9f6d8988145943bf8bbab313e45e6e",
  "installationId": "ID-estavel-da-instalacao",
  "generation": "geracao-operacional-externa-ao-D1",
  "databaseId": "UUID-do-novo-banco",
  "imageDigest": "registry.cloudflare.com/ab9f6d8988145943bf8bbab313e45e6e/assistant-cognee@sha256:DIGEST",
  "archiveBaseline": {
    "versionId": "UUID-da-versao-Archive-observada",
    "settingsHash": "SHA256-do-baseline-privado"
  }
}
```

O exemplo é um formato, não uma configuração pronta. Um manifest incompleto pode ser planejado; render exige ID do banco novo, digest e baseline. Não incluir tokens, Client-Token, epoch de conexão ou credenciais nesse manifest. O plano nunca inicia conta financeira.

```sh
node scripts/assistant-install.mjs plan --manifest /caminho/privado/manifest.json
node scripts/assistant-install.mjs render --manifest /caminho/privado/manifest.json
node scripts/assistant-install.mjs check-config --config local/assistant-build/install/assistant.wrangler.jsonc
```

`plan` não escreve nem chama rede. `render` escreve somente arquivos locais 0600 em diretório 0700 dentro de `local/` ou `/tmp/assistant-install-*`: configuração da assistente, parser, delta Archive, plano e recibo de revisão. Mesmo conteúdo pode ser reencontrado; mudança do plano, inclusive novos marcadores ARTIFACTS, recusa overwrite e pede outra pasta de revisão. O CLI não contém apply/deploy/migrate cloud. O caminho de build é `ASSISTANT_INSTALL_CONFIG` no ambiente do processo `npm run build:assistant`; Vite valida destino, recursos, capacidades e caminhos antes de usar a configuração privada. Deploy posterior deve usar o wrangler.json gerado em `dist/assistant/personal_assistant_shadow/`, conservando as classes oficiais Flue.

A configuração inicial deixa routines off, pausa true, mídia e resumos Telegram off, sem rota pública, sem preview/workers.dev e com semântica exigida. Inclui bindings nominativos CaptureReader/CaptureMediaReader; nunca dá à assistente o Fetcher default do Archive. Parser recebe zero banco/secret/binding e CPU 100ms. Cognee usa scheduling_policy durable_object, alias cognee e digest; max_instances não se aplica a essa política. Flue owner/interlocutor, CogneeContainer, CalendarOAuth e RetentionAuthority mantêm classes/migrações explícitas.

## Sequência do coordenador, após revisar o plano

1. Conferir Worker/conta, ownership, digest/buildFingerprint da imagem, HEAD/CI, baseline de versão/configuração e estado dos recursos próprios. Não tomar concordância de produto como validação técnica.
2. Inspecionar metadados de migração do Archive e presença real dos entrypoints de leitura. Se faltar código/schema, preparar upgrade aditivo separado que preserve o MCP manual, captura, rotas, dados, vars e secrets. Não aplicar migrações da assistente no Archive. Depois de qualquer upgrade ou provisionamento, obter um baseline novo para o delta final.
3. Criar somente o D1/R2 novos e aplicar migrações aditivas de `assistant/migrations`. IDs existentes divergentes não autorizam apagar/recriar nem escolher outro namespace para contornar incerteza. DOs são provisionados pelo deploy com migrações; não transferir namespaces do laboratório.
4. Implantar o parser isolado, construir pelo Flue oficial com config validada e publicar a assistente ainda inerte. Registrar versão, IDs, hashes e resultado; esses atos não iniciam observação funcional.
5. Preparar a chave de ponte por comando explícito e provisionar seletivamente os nomes corretos nos dois Workers. Secrets ficam fora D1/Git. O ambiente privado da assistente recebe somente sua API key de modelo autorizada, chave de ponte/afinidade e os demais secrets necessários; a existência de OPENAI_API_KEY no laboratório não transfere seu valor.
6. Usar o named RPC `CaptureReader.installationAffinity({secret})` com a chave nova. Ele valida segredo antes de resolver RuntimeDB e revalida segredo, manutenção e fence depois; devolve somente epoch/generation. Não há URL pública de bootstrap nem corpo/telefone/token de fornecedor. O executor deve capturar a resposta por canal privado do binding conhecido, em arquivo 0600, sem imprimir os valores.
7. Fixar a afinidade privada na configuração da assistente, verificar novamente por RPC e selar RetentionAuthority a partir do inventário canônico comprovado. Um banco supostamente vazio não prova ausência de tombstones. O selo externo não é resetado por restore.
8. Revisar/aplicar apenas o delta ASSISTANT_* do Archive contra o baseline exato pós-upgrade/pós-secrets. Preservar todos os outros bindings, rotas, settings e secrets; o artefato não é uma substituição de wrangler.jsonc legado. Não alterar MAINTENANCE/captura do Archive para pausar a assistente. O cron existente entrega outbox durável; cursor/ACK perdido não autoriza reset de sequência.
9. Conferir saúde privada, migrações e bindings reais; observar disparo real de cron na Cloudflare com a VPS desligada/desconectada. Metadados de schedule e um teste local de scheduled não provam essa fronteira. Publicar um callback Telegram próprio exige etapa separada de routing/ownership/segredo, mantendo default403 e sem mudar Access/MCP/Elo; só então configurar webhook e homologar vínculo.
10. Antes de habilitar rotina sombra, conferir orçamento global, checkpoint/restore, cobertura e gates de #57. Ativar rotina shadow e remover pausa é mudança explícita e auditada de flags após os gates. As flags não habilitam envio WhatsApp nem delegam escrita Calendar; gestão reativa da agenda exige o pedido autenticado e seu perfil/grant próprio.

[Cloudflare: Vite gera configuração de deploy](https://developers.cloudflare.com/workers/vite-plugin/reference/migrating-from-wrangler-dev/). [Containers: política de agendamento](https://developers.cloudflare.com/containers/configuration/scheduling-policy/).

## Chave privada e afinidade sem rotação cega

```sh
node scripts/assistant-install.mjs prepare-bridge --manifest /caminho/privado/manifest.json --output local/assistant-build/install
node scripts/assistant-install.mjs pin-affinity --manifest /caminho/privado/manifest.json --input /caminho/privado/rpc-affinity.json --output local/assistant-build/install
```

Esses comandos não provisionam Cloudflare. O primeiro cria uma chave nova apenas se não houver estado anterior e grava aliases privados: BRIDGE_SECRET no host; ASSISTANT_READER_SECRET e ASSISTANT_BRIDGE_SECRET no Archive. Repetição reencontra a mesma chave; estado parcial exige reconciliação, nunca geração substituta automática. `pin-affinity` aceita somente a resposta estreita disponível, conserva valores em arquivo privado e emite apenas hash/estado. O CLI registra honestamente que um arquivo fornecido não prova sozinho execução do binding: a verificação live do coordenador continua obrigatória. Epoch/generation diferente não sobrescreve o pin. Rotação ou nova geração exigem plano próprio e preservação das tentativas incertas.

## Bootstrap operacional por serviço nominal

Após revisar CI, versão e bindings reais do Worker próprio já publicado, o operador local pode chamar três comandos estreitos. O arquivo instalado fornece somente installationId/generation esperados; sourceEpoch ainda não precisa existir para esta primeira prova. O segredo da ponte permanece no ambiente do Worker: o comando affinity nunca recebe uma chave no corpo.

```sh
node scripts/assistant-install-ops.mjs affinity --installedconfig /caminho/privado/assistant.wrangler.jsonc --output /caminho/privado/rpc-affinity.json
node scripts/assistant-install.mjs pin-affinity --manifest /caminho/privado/manifest.json --input /caminho/privado/rpc-affinity.json --output local/assistant-build/install
node scripts/assistant-install-ops.mjs plan --installedconfig /caminho/privado/assistant.wrangler.jsonc --output /caminho/privado/retention-plan.json
# Provisionar seletivamente RETENTION_BOOTSTRAP_SEAL com o seal observado, por canal privado.
node scripts/assistant-install-ops.mjs bootstrap --installedconfig /caminho/privado/assistant.wrangler.jsonc --output /caminho/privado/retention-bootstrap.json
```

O plano usa o inventário D1 vivo de todas as gerações, sem ler corpos de fontes. O helper existente revalida o plano antes de selar; schema/autoridade indisponíveis nunca significam inventário vazio. Bootstrap exige FLUE_EPISODES_ENABLED=shadow, ROUTINES_ENABLED=off, ROUTINES_PAUSED=true, TELEGRAM_SUMMARIES_ENABLED=false e o selo externo de64hex configurado. Uma autoridade nova ainda unsealed é o estado esperado, não um pré-requisito circular. Este comando não ativa geração, scheduler, captura, modelo ou envios.

O CLI inicia Worker local em loopback/porta aleatória com token fresco em arquivo0600 e validade de até15min. Ele recebe somente o binding SERVICE remoto OwnerAssistant do serviço fixo personal-assistant-shadow, sem DO/D1/R2 ou URL de destino arbitrária. O RPC installation não é exposto como tool MCP, HTTP público ou capacidade de conteúdo. Resultados exatos, inclusive plano/afinidade e respostas incertas, ficam somente no novo arquivo0600 sob diretório privado; stdout contém apenas estado/hash. O resultado affinity alimenta diretamente pin-affinity. Output existente recusa sobrescrita. Após timeout, inspecionar a mesma instalação e selo; não trocar geração/namespace/selo para ocultar incerteza.

O diagnóstico Wrangler persiste em `<output>.worker.private.log`, criado exclusivamente em0600, limitado aos últimos32KiB de bytes e fsync antes de fechar. Arquivo existente/symlink é recusado; o log não é removido com os arquivos efêmeros e nunca é impresso. Readiness exige GET local sem token/corpo em `/command` respondendo403/denied com os headers do handler, dentro de45s. A presença de uma URL no log não prova que o listener está pronto. Esse GET retorna antes de qualquer OWNER RPC; só o comando escolhido é tentado uma vez após a prova local.

O comando usa `wrangler dev` com remote:true apenas no SERVICE. Não passar `--local`: ele desabilita os bindings remotos. Não passar `--remote`: ele publica o operador em preview. A correção também vale para o CLI de retenção #55. DO remoto não é usado pelo processo local; o serviço Worker remoto chama seus próprios DOs. [Limites de desenvolvimento local Cloudflare](https://developers.cloudflare.com/workers/local-development/).

Validação local do codec, guards e transporte simulado é separada da homologação cloud: a execução real desse operador, os bindings e a ausência de capacidades de envio ainda precisam de prova na instalação publicada.

## Saúde, pausa e recuperação

`GET /health` continua mínimo e não revela dados de instalação. A consulta autenticada `assistant.health` verifica metadados D1/tabelas necessárias, afinidade por named RPC, afinidade ARTIFACTS dos dois marcadores privados, head de objeto sentinela no prefixo próprio assistant-artifacts/v1 e estado sealed da autoridade externa. Não lê corpo de arquivo/mensagem, não chama modelo, não aquece Container e não faz refresh OAuth. Marcadores ausentes ou diferentes impedem a sonda R2 e mantêm infraestrutura pending. Marcadores coincidentes não atestam a identidade real do bucket: conferir binding pela API Cloudflare. Inventário de tabelas é distinto da prova completa de migrações. Recibo do host scheduler também é distinto de cron cloud homologado. Ausência de evento novo não é falha, e zero eventos não vira 100% de cobertura.

Pausa global da atuação: manter ROUTINES_PAUSED=true; para interromper o scheduler por incidente, ROUTINES_ENABLED diferente de shadow. A captura autorizada do Archive continua. Resumos Telegram e contexto de mídia têm flags próprias; off conserva pendências/lacunas. Orçamento bloqueado não apaga recibos nem reservas. OAuth de Calendar tem marker de geração privado que restore não atualiza automaticamente; [contrato e consentimento](evidencias/51-calendar-oauth.md).

Rollback de Worker/configuração pode reaplicar uma versão compatível anterior e desligar gates. Não promete desfazer migrações D1, apagar efeitos remotos ou liberar operações incertas. Não destruir DOs, limpar ledger, regressar checkpoint, trocar alias ou geração como retry. Antes de parar Container, confirmar checkpoint da revisão atual; recovery usa candidato exato, sem start vazio. Export JSON paginado ao vivo não é snapshot consistente; backup/restauração exige procedimento próprio #55, incluindo tombstones externos, gerações, custos agregados e objetos privados. R2 ARTIFACTS é próprio para artefatos/backups deliberados, sem transformar export live em backup atômico.

### Preservação de runtime ao publicar código ou configuração

Antes de alterar código, vars ou secrets, capturar o deployment ativo e os recursos de sua versão, além de settings, cron, exposição e hashes dos módulos. Preservar explicitamente `resources.script_runtime.containers`, incluindo alias e imagem imutável: conferir apenas bindings/settings não detecta a perda desse mapa. Uma atualização anterior de secrets removeu o mapa, e o bootstrap recusou; a recuperação manteve os recibos e não repetiu a ingestão incerta.

Upload versionado deve reter os bindings existentes no servidor, sem extrair/copiar secrets, e enviar o runtime completo. Conferir o candidato antes de promover100% e repetir as comparações depois. Durante a configuração pública GitHub, GETsettings passou a refletir a única binding nova logo após upload; a comparação inicial recusou, sem promoção. A reconciliação releu a mesma versão candidata, conferiu exatamente o delta autorizado e preservação dos demais recursos, e só então a promoveu. Não repetir upload ou criar outra versão por falha de observação. Deployment/versão ativa, módulos e chamada funcional constituem provas distintas.

## Orçamento e dependências

Teto autorizado de testes pagos: US$10. O executor deve consultar todos os períodos/gerações/instalações anteriores e reservas incertas antes de configurar novo cap insert-only. O handoff registrava 48.405 microUSD comprometidos, incluindo 40.000 incertos; isso é referência histórica, não saldo atual. O instalador não cria cap de US$10 por geração/dia nem um ledger paralelo. Container/infra têm custo separado de inferência; não inferir mensalidade por amostra sintética.

Cliente MCP, vínculo Telegram, credencial GitHub própria e consentimento Google de gestão foram homologados nas evidências dos marcos46/47/48/51/144. O app Google continua External/Testing, com renovação de consentimento necessária conforme a validade desse perfil; não prometer credencial Calendar permanente. A credencial GitHub foi configurada sem expiração, permanecendo revogável pelo dono/provedor.

Observação contínua continua pausada: antes de ativá-la, definir escopo/corpus representativo, medir recuperação e conferir orçamento. Avaliação longitudinal e benefício humano são medidos durante o piloto; não podem ser preenchidos pelo executor a partir de cliques, entrega ou fixtures.

## Uso reativo no Telegram

O diálogo autenticado funciona com `TELEGRAM_OWNER_DIALOGUE_ENABLED=shadow` mesmo com `ROUTINES_PAUSED=true`. Não remover a pausa para responder ao dono. Consulte as provas de [agenda](evidencias/144-calendar-telegram.md), [GitHub](evidencias/144-github-telegram.md), [WhatsApp](evidencias/144-whatsapp-telegram.md) e [memória/políticas](evidencias/144-memory-controls-telegram.md).

- Notas: `Anote: …`; pergunte sobre o que ensinou; `Corrija a nota “título completo” para: …`; `Esqueça a nota “título completo”`.
- Políticas: `Acompanhe em sombra o grupo “nome completo”`; `Ignore o grupo “nome completo”`; `Exclua a conversa “nome completo” do assistente`. Configurar observação não executa a rotina pausada. Exclusão não habilita reativação implícita.
- GitHub: pergunte sobre um repositório próprio explicitamente citado. Consulta a branch padrão e até cinco arquivos; caminhos, código e README não provam deployment ou execução.
- WhatsApp: indique pessoa/grupo e o que procura. Consulta até três mensagens atuais da captura, com cobertura limitada; texto de legenda não equivale a analisar imagem. Captura atrasada, fonte alterada/excluída ou nome ambíguo podem impedir a resposta. Uma passagem limitada do materializador atualiza a inbox já autenticada antes da leitura; não drena todo o passado nem chama IA para capturar.
- Agenda: títulos, horários e CRUD de eventos únicos na agenda principal própria, organizados pelo dono e sem convidados. Séries/convites não fazem parte desse primeiro caminho. Após resultado incerto, consultar a agenda; não repetir o comando como tentativa de corrigir timeout.

Pedidos devem trazer alvo e dados necessários; não pressupor contexto implícito de uma pergunta anterior ou identidade por pronome. Nova tentativa humana recebe novo frame; o executor nunca renova uma autorização expirada ou repete uma fase paga incerta automaticamente. GitHub e WhatsApp fornecem respostas sustentadas pelos documentos efetivamente lidos, sem alegação de entendimento global do acervo.
