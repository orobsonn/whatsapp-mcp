# #46/#56 — afinidade, autoridade e gateway na nuvem

26/10/2026. Complementa [a instalação inicial inativa](56-worker-inactive-vps.md); não encerra issue nem declara o piloto homologado.

## Backend próprio

O código instalado continua sendo o commit `2055d047eb4002d9eda6256756b5b31a4077ffd2`, cujos três módulos foram relidos por hash. [CI40383981628](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40383981628):1169 testes gerais,62 nativos,4 OAuth Node,9 quota Node e29 instalação/operadores Node, tipos, builds e audit aprovados.

A correção do CLI usa Node HTTP para o POST local; mantém a recusa dos headers de navegador no servidor. Commit `bb23e0a7e70b14cf862e4b72a734795176b97b3d`, [CI40394916422](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40394916422) aprovada e30 testes HTTP locais aprovados. O código do Worker não precisou mudar para essa correção.

O handshake real `OwnerAssistant.installation` → `CaptureReader.installationAffinity` passou na Cloudflare. Epoch e geração foram fixados por observação do reader, sem inferência a partir do nome do recurso. O plano real de retenção observou zero fontes/tombstones nesse D1 novo; a autoridade externa foi inicializada com o selo preparado e respondeu `sealed`. Valores de afinidade e segredos permanecem privados.

Os quatro segredos da ponte/autoridade tiveram ACK e verificação posterior de código/configuração. `OPENAI_API_KEY` também foi provisionada com ACK e conferência do destino, sem valor em chat, Git, D1, argv, variável de subprocesso ou arquivo local em texto. O transporte entre o laboratório próprio e o Worker próprio usou envelope RSA/AES, tentativa única durável, ACK vinculado ao destino e consumo permanente da operação. O ACK não comprova validade da chave no fornecedor: **a inferência no novo Worker ainda não foi testada**. A chave compartilha faturamento e revogação com a do laboratório; não constitui nova conta nem novo orçamento.

A preparação teve uma recusa403 antes da admissão da transferência: um POST vazio da Cloudflare apresentou stream vazio. A correção aceita somente EOF vazio autenticado com limite absoluto de2s; não aceita corpo, atraso ou origem diferente. Contraprovas antes/depois, revisão independente e recibos das duas versões preservados. Após o ACK, o envelope remoto foi consumido; PEM RSA, envelope local e cópia temporária do token de teste foram removidos. O tombstone permanente e o histórico das tentativas permanecem. Nenhuma nova inferência ou reserva financeira foi gerada nessa transferência.

Terminada a transferência, o laboratório voltou ao bundle v5 exato SHA-256 `2b08743ebcfaa8e4f4f765189fb79142cc7f5a4aac2778e784ce3c44e362033a`, versão `a1814cf5-9915-469a-90eb-22326d4889b7`. Upload único com journal/ACK e leitura posterior confirmaram código, mesmos bindings/namespace/imagem/migration tag, sem migração ou escrita no storage do DO. Nova observação de diagnóstico e D1 confirmou igualdade integral com o estado anterior: Container parado, nenhum episódio ativo, checkpoint confirmado revisão42 com8 fontes, ledger inalterado. A preservação do marcador consumido se apoia no ACK anterior e no mesmo storage conservado; não se inventou nova leitura RPC desse marcador depois de retirar o wrapper.

Worker próprio após provisionar a chave: `f4961a61-2b0a-41f0-99a7-4f758fc44d07`. Mantidos cinco namespaces próprios,25 migrações, imagem imutável, `workers.dev`/previews desabilitados, cron vazio, rotinas `off`/pausadas, mídia e resumos Telegram desabilitados. Não se configurou orçamento de inferência nessa etapa.

## Gateway candidato da #46

Recorte `3f6fefafb4db0691ed8b07ff5592aa8ac6359495`, candidato0.36.0, [CI40381931845](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40381931845) e [CI40388164912](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40388164912) aprovadas no mesmo HEAD. [PR125](https://github.com/orobsonn/whatsapp-mcp/pull/125) continua rascunho.

Upload único do Worker `whatsapp-mcp`, versão `28db3b38-6fa4-4704-bce7-01edfdd40d9f`. `index.js`:2.084.049 bytes, SHA-256 `7218f844cf7741b4f376515b5d8f55fd74e94ffb51d4469fa56c8699c1db3635`. Pré-leitura, journal anterior ao PUT, ACK e verificação GET separados. Helper com11 casos Node e revisão independente, inclusive do snapshot real.

Os24 bindings anteriores foram preservados, inclusive todos os tipos de secrets. Acrescentados somente o serviço nominal `ASSISTANT_OWNER` → `personal-assistant-shadow/OwnerAssistant/production` e os dois identificadores de instalação/geração. Leitura posterior confirmou27 bindings exatos, módulo, exports dos readers, settings, cron, domínio e rotas preservados. Sem binding de ingestão contínua, migração do Archive, segredo de modelo no gateway ou alteração de Access/Elo.

O `diagnosticar` existente foi chamado pelo conector MCP autenticado e respondeu versão0.36.0, sem erro. Isso comprova que o MCP anterior continua acessível. **O catálogo desta conversa ainda não contém `assistente_*`**, portanto não comprova execução dos novos comandos pelo cliente. A busca na gestão de plugins não ofereceu mecanismo de atualização desse catálogo. É necessário atualizar as ferramentas da conexão e homologar os comandos; não extrair tokens da sessão, simular login nem encerrar a #46 com apenas um binding RPC operacional.

## Custos e pendências

Nenhuma nova chamada paga de modelo nessa etapa. Ledger histórico conservado: **US$0,049053 comprometidos**, incluindo **US$0,040000 incertos**; nenhuma conta, reserva ou tentativa foi apagada para repetir operação. Custos Cloudflare seguem separados e não reconciliados com a fatura. Teto autorizado dos testes pagos permanece US$10.

Seguem pendentes configuração financeira do novo Worker, prova de inferência, ponte contínua, cron e fluxo completo. Interação humana quando indispensável: catálogo/execução das novas ferramentas no cliente, token/vínculo/consentimento Telegram e OAuth Calendar próprio. Telegram/Calendar não herdam autenticação de outro conector. Nenhum envio automático WhatsApp ou escrita Calendar foi habilitado. Homologação longitudinal e utilidade com conversas reais pertencem ao piloto.

Artefatos/recibos completos permanecem ignorados em `local/assistant-build/personal-shadow-stage/` e `local/assistant-build/vps-cloud/credential-relay-private/`; não publicar esses diretórios nem dados reais.
