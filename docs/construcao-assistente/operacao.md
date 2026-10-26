# Instalação sombra da assistente — #56

Este runbook descreve artefatos e etapas de instalação. Renderizar configuração, ter CI verde e observar um binding não equivalem a homologação do piloto. #57 exige a jornada cloud integrada e os negativos. Nenhum comando abaixo concede WhatsApp automático ou escrita Calendar.

## Estado observado na retomada VPS

Consulta Cloudflare somente leitura em 26/10/2026 confirmou o domínio `whatsapp.robsonlins.com` no Worker próprio `whatsapp-mcp`, com D1/R2/KV/AI e cron por minuto. Não havia bindings ASSISTANT_* no deploy observado. O Worker `personal-assistant-shadow` retornou 404. `assistant-build-check` e `assistant-media-pdf-check` existiam como laboratórios sem cron. Esse inventário examinou nomes/tipos e configuração pública permitida; não recuperou valores de secrets nem acessou recursos do Elo. Revalidar no momento da instalação.

Recursos novos do produto: Worker `personal-assistant-shadow`, D1 `personal-assistant-shadow-state`, bucket privado `personal-assistant-shadow-artifacts` e parser `personal-assistant-pdf-parser`. Não usar o banco, bucket, namespaces ou estado do laboratório/Archive como se fossem instalação nova. O instalador recusa os IDs conhecidos desses bancos. O digest deve usar o registry da mesma conta e um asset com prefixo assistant; outra conta ou nome apenas contendo assistant são recusados. A imagem Cognee pode reutilizar o digest comprovado do build próprio; o Container/DO e seu namespace de dados são novos. Não há build Docker improvisado quando a VPS não tem Docker.

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

`plan` não escreve nem chama rede. `render` escreve somente arquivos locais 0600 em diretório 0700 dentro de `local/` ou `/tmp/assistant-install-*`: configuração da assistente, parser, delta Archive, plano e recibo de revisão. Mesmo conteúdo pode ser reencontrado; mudança do plano recusa overwrite e pede outra pasta de revisão. O CLI não contém apply/deploy/migrate cloud. O caminho de build é `ASSISTANT_INSTALL_CONFIG` no ambiente do processo `npm run build:assistant`; Vite valida destino, recursos, capacidades e caminhos antes de usar a configuração privada. Deploy posterior deve usar o wrangler.json gerado em `dist/assistant/personal_assistant_shadow/`, conservando as classes oficiais Flue.

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
10. Antes de habilitar rotina sombra, conferir orçamento global, checkpoint/restore, cobertura e gates de #57. Ativar rotina shadow e remover pausa é mudança explícita e auditada de flags após os gates; flags nunca habilitam WhatsApp ou Calendar write porque essas capacidades não são instaladas.

[Cloudflare: Vite gera configuração de deploy](https://developers.cloudflare.com/workers/vite-plugin/reference/migrating-from-wrangler-dev/). [Containers: política de agendamento](https://developers.cloudflare.com/containers/configuration/scheduling-policy/).

## Chave privada e afinidade sem rotação cega

```sh
node scripts/assistant-install.mjs prepare-bridge --manifest /caminho/privado/manifest.json --output local/assistant-build/install
node scripts/assistant-install.mjs pin-affinity --manifest /caminho/privado/manifest.json --input /caminho/privado/rpc-affinity.json --output local/assistant-build/install
```

Esses comandos não provisionam Cloudflare. O primeiro cria uma chave nova apenas se não houver estado anterior e grava aliases privados: BRIDGE_SECRET no host; ASSISTANT_READER_SECRET e ASSISTANT_BRIDGE_SECRET no Archive. Repetição reencontra a mesma chave; estado parcial exige reconciliação, nunca geração substituta automática. `pin-affinity` aceita somente a resposta estreita disponível, conserva valores em arquivo privado e emite apenas hash/estado. O CLI registra honestamente que um arquivo fornecido não prova sozinho execução do binding: a verificação live do coordenador continua obrigatória. Epoch/generation diferente não sobrescreve o pin. Rotação ou nova geração exigem plano próprio e preservação das tentativas incertas.

## Saúde, pausa e recuperação

`GET /health` continua mínimo e não revela dados de instalação. A consulta autenticada `assistant.health` verifica metadados D1/tabelas necessárias, afinidade por named RPC, head de objeto sentinela no bucket privado e estado sealed da autoridade externa. Não lê corpo de arquivo/mensagem, não chama modelo, não aquece Container e não faz refresh OAuth. Inventário de tabelas é distinto da prova completa de migrações. Recibo do host scheduler também é distinto de cron cloud homologado. Ausência de evento novo não é falha, e zero eventos não vira 100% de cobertura.

Pausa global da atuação: manter ROUTINES_PAUSED=true; para interromper o scheduler por incidente, ROUTINES_ENABLED diferente de shadow. A captura autorizada do Archive continua. Resumos Telegram e contexto de mídia têm flags próprias; off conserva pendências/lacunas. Orçamento bloqueado não apaga recibos nem reservas. OAuth de Calendar tem marker de geração privado que restore não atualiza automaticamente; [contrato e consentimento](evidencias/51-calendar-oauth.md).

Rollback de Worker/configuração pode reaplicar uma versão compatível anterior e desligar gates. Não promete desfazer migrações D1, apagar efeitos remotos ou liberar operações incertas. Não destruir DOs, limpar ledger, regressar checkpoint, trocar alias ou geração como retry. Antes de parar Container, confirmar checkpoint da revisão atual; recovery usa candidato exato, sem start vazio. Export JSON paginado ao vivo não é snapshot consistente; backup/restauração exige procedimento próprio #55, incluindo tombstones externos, gerações, custos agregados e objetos privados. R2 ARTIFACTS é próprio para artefatos/backups deliberados, sem transformar export live em backup atômico.

## Orçamento e dependências

Teto autorizado de testes pagos: US$10. O executor deve consultar todos os períodos/gerações/instalações anteriores e reservas incertas antes de configurar novo cap insert-only. O handoff registrava 48.405 microUSD comprometidos, incluindo 40.000 incertos; isso é referência histórica, não saldo atual. O instalador não cria cap de US$10 por geração/dia nem um ledger paralelo. Container/infra têm custo separado de inferência; não inferir mensalidade por amostra sintética.

Pendências humanas: homologação/login no cliente MCP; credenciais próprias de provedores que não estejam disponíveis por canal privado; vínculo e autorização Telegram; client/consentimento Google somente leitura. Roteamento, imagem, migrações, bootstrap, deploy, cron e integração são trabalho de engenharia. Até a prova cloud/cliente, declarar infraestrutura preparada/configurada separadamente da prontidão funcional #57 e da avaliação longitudinal do piloto.
