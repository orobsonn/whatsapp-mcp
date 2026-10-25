# Geração de áudio com voz própria — Fish Audio

21/10/2026. A entrega inicial foi limitada a código e testes sintéticos. Depois, o dono autorizou guardar a chave, publicar, gerar prévias gratuitas e usar sua voz cadastrada. Por último, pediu enviar uma declaração e dispensou confirmação adicional após geração; a política atual está em “Uso”. Os ensaios e suas limitações estão registrados ao final. Não houve autorização de consumo pago.

## Desenho e plano de execução

Objetivo: texto → Fish na nuvem → MP3 privado → escuta no navegador → proposta e aprovação de envio existentes. Não há modelo, servidor de voz ou inferência no computador do dono.

Decisões de engenharia: um adaptador REST fixo, sem SDK/retries implícitos, filas ou abstração de fornecedores. Registro persistente D1 antes da rede, deduplicação por identidade derivada do conteúdo/voz/modelo/conversa dentro da instalação/conexão. Claim não é retomado: uma queda ou timeout pode ter consumido saldo. A prévia usa Cloudflare Access, com player e bytes na mesma origem; bearer MCP não autentica navegador. Reprodução real depende do login Access nesse navegador e exige homologação posterior.

1. Escrever e observar falhas dos testes de geração, erros, streaming, isolamento e concorrência; implementar `src/tts.ts`, migration D1 e configuração tipada. Reusar `uploadMedia`.
2. Escrever testes da rota privada com JWT Access sintético, cookie, usuário errado, ranges, escape/CSP e mídia alterada; implementar página e resposta inline sem tocar no download existente.
3. Integrar `gerar_audio` e consulta de geração ao catálogo MCP. Testar contrato e jornada com aprovação independente do envio, hash final/destino e proteção contra reenvio.
4. Redigir conteúdo nas exclusões locais; testar exclusão durante geração. Rodar suíte, tipagem e build dry-run; revisar diff adversarialmente e registrar resultados observados.

Restrições: geração exige configuração explícita, texto limitado e MP3 até 2 MiB; conteúdo do texto é privado e vai ao Fish. Chave só em Worker secret. Voz previamente cadastrada é etapa separada, nunca coletada de mensagens.

## Fontes oficiais consultadas

- [Contrato REST TTS](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech): POST fixo `/v1/tts`, Bearer, header `model`, JSON com `text`, `reference_id` e `format=mp3`.
- [Modelos e uso](https://docs.fish.audio/features/text-to-speech): `s2.1-pro` recomendado na consulta de 21/10/2026; `s2-pro` disponível. O adaptador requer escolha explícita e recusa valores fora da lista, pois valores desconhecidos podem cair no modelo padrão do provedor.
- [Cobrança API](https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits): consumo de API independente de assinatura do site; cobrança por bytes UTF-8 do texto. Sem preços fixos no código, sem dependência de Plus. Consultar saldo/preço vigente antes de autorizar teste real. US$5 não é autorização.
- [Workers](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): secret binding e leitura limitada de streams.

## Revisão adversarial e decisões adotadas

A revisão independente atacou custos, concorrência, exclusão em voo, autenticação e aprovação:

- Identidade derivada de instalação + geração da conexão + conversa + texto exato + voz + modelo + parâmetros MP3. Não há chave arbitrária externa nem aliases incompletos. Mesmo conteúdo retorna o registro anterior, inclusive em erro/incerteza; texto alterado é uma nova geração potencialmente cobrada. Não mudar o texto apenas para contornar um resultado incerto.
- Mídia gerada fica em staging invisível até o CAS final da geração. Publicação, listagem, leitura e preparo de envio conferem o vínculo com a geração pronta. Perder o CAS invalida o upload. Exclusão local redige texto/voz e impede publicação tardia.
- Timeout de 45 segundos cobre fetch e corpo, com abort/cancel sem esperar cancelamentos que podem travar. Lease não é renovado ou retomado. Queda pode causar cobrança sem arquivo; não existe transação distribuída nem promessa de cobrança exatamente uma vez.
- HTML e MP3 exigem Access separadamente; URL contém apenas identificador, nunca token. A anotação MCP informa acesso externo. A exigência inicial de autorização adicional após gerar foi substituída pela decisão posterior do dono registrada ao final; a proposta continua vinculada ao arquivo final e destinatário.

## Configuração futura — somente após autorização

A entrega inicial manteve `TTS_ENABLED=false`, sem secret do Worker ou configuração Cloudflare remota. A gravação posterior autorizada da chave está registrada abaixo. Não cole credenciais no chat.

1. Separadamente, cadastrar/clonar **sua própria voz** no Fish e confirmar o identificador da voz pronta. A ferramenta não cadastra vozes, não envia amostras nem busca áudio em conversas.
2. Conferir acesso de API por consumo e saldo/preço vigente. Assinatura Plus do site não é requisito da integração nem substitui saldo de API.
3. Um operador autorizado guarda `FISH_API_KEY` como **secret do Worker**, fora de D1/Git/URLs/logs. Após autorização, o comando interativo é `npx wrangler secret put FISH_API_KEY`; ele não foi executado nesta entrega.
4. Configurar variáveis controladas do Worker:

   | Variável | Valor/uso |
   |---|---|
   | `TTS_ENABLED` | `true`, somente na ativação autorizada |
   | `FISH_VOICE_ID` | ID da sua voz já cadastrada, nunca URL |
   | `FISH_VOICE_NAME` | Nome legível, por exemplo “Minha voz”, até 120 caracteres |
   | `FISH_TTS_MODEL` | `s2.1-pro` recomendado na consulta atual; `s2-pro` e `s2.1-pro-free` também admitidos. Sem fallback silencioso |
   | `FISH_API_KEY` | Secret; chave paga por consumo, não uma variável pública |

5. Aplicar a migration `0011_tts.sql` **antes** da versão de código que depende da coluna nova em mídia. A aplicação remota e o deploy precisam de autorização posterior. O build usa somente dry-run.
6. Preservar o Access já existente para estas rotas: `/audio/*`, `/media/*`, `/upload/*`. Não modificar a aplicação Access para abrir acesso público. HTML e bytes fazem verificação criptográfica de dono, issuer, audiência e expiração. O MCP mantém OAuth próprio.
7. Após deploy autorizado, atualizar ferramentas da conexão MCP se o cliente não renovar seu catálogo. Fazer a homologação abaixo antes de anunciar funcionamento real.

Configuração incompleta ou modelo fora da lista torna a geração indisponível e retorna orientação. Consultar áudio já gerado não faz nova chamada paga. Desabilitar TTS bloqueia novas gerações; não é um comando de exclusão dos arquivos existentes.

## Uso

`gerar_audio({chatId, text})` recebe só conversa e texto: até 2.000 unidades UTF-16/8.000 bytes UTF-8; não recebe chave, URL, voz, modelo ou destinatário bruto. A conversa precisa existir na instalação/conexão ativa. Texto exato enviado ao Fish não é logado. O retorno inclui estado, texto, nome da voz, metadados/hash do MP3 e `previewUrl` quando pronto. Sem destinatário resolvido, localizar a conversa primeiro; geração não envia nem prepara uma ação automaticamente.

`consultar_audio_gerado({id})` consulta o mesmo registro. Se a resposta MCP se perdeu, repetir `gerar_audio` com os mesmos argumentos recupera a mesma identidade, sem nova submissão. `attempting` significa aguardar/consultar; `uncertain` significa que pode ter havido consumo sem resultado confirmado. `failed` indica rejeição/arquivo inválido, não um convite a repetir. HTTP 200 ainda precisa passar validação de MIME, assinatura e limite; não prova qualidade da voz.

A prévia apresenta conversa, texto, voz e arquivo. O player é HTML nativo, com reprodução manual e `preload=none`; baixa pela mesma origem autenticada, suporta Range único e verifica integridade antes de entregar bytes. O download antigo `/media/:id` continua attachment. Nem prévia nem download usam URL pública R2 ou credencial na query string.

O áudio só é enviado com pedido explícito do dono para aquele conteúdo e destinatário. Esse pedido pode acompanhar a geração (“gere e envie”) ou autorizar a composição de uma mensagem e seu envio direto. Não é necessária uma segunda pergunta depois de gerar; a prévia continua disponível para quem quiser revisar. Pedir apenas geração não autoriza envio, e uma autorização não vale para futuros áudios ou outros destinatários.

O cliente reutiliza `preparar_envio({kind:"audio", chatId, mediaId, mediaHash})` e `executar_envio` com o hash da proposta e `confirmation={confirmed:true,hash}` somente quando existir aquele pedido de envio. O hash cobre destino e arquivo final. Outro arquivo/destino exige nova proposta e autorização que cubra a mudança. O executor não aprova nada automaticamente; a confirmação no chat continua sendo uma declaração do cliente, conforme política existente. Conteúdo recebido jamais autoriza ações. A geração não cria propostas nem executa envios por conta própria.

## Armazenamento e recuperação

D1 guarda registro privado e R2 guarda MP3 privado imutável de até 2 MiB. MIME HTTP deve ser `audio/mpeg` ou alias `audio/mp3`; os bytes precisam ter assinatura MP3 compatível com o validador de mídia existente. Não há decoder local, conversão de WAV, antivírus ou prova automática de qualidade/identidade vocal.

A identidade persistente impede chamadas concorrentes repetidas, inclusive após reinício. Não se apagam tombstones para “liberar” novas tentativas. Sem arquivo pronto, texto e nome de voz são removidos ao falhar, ficar incerto ou expirar. O cron existente redige até dez gerações abandonadas/antigas por execução e marca até dez uploads de staging inacessíveis para a limpeza física já existente. Resultados prontos seguem a conservação de uploads: exclusão local da conversa redige texto/voz junto com a mídia. Não há TTL novo para uploads prontos nem importação retroativa.

Perda de D1 antes de gravar resultado pode deixar `attempting` até a consulta/cron classificá-lo como incerto. Se o Worker cair entre gravar um objeto e persistir sua chave, pode sobrar objeto R2 órfão; limpeza de órfãos sem referência continua sendo limitação operacional existente. Nunca fica publicamente legível. O sistema não consulta Fish para recuperar áudio perdido nem repete por conta própria.

## Limites da entrega inicial com mocks

Tudo nesta entrega é código e ensaio com mocks, D1/R2 locais e identidades sintéticas. Nenhuma API paga, voz real, Access real, deploy ou WhatsApp real foi usado.

Após aprovação específica: conferir voz/modelo/saldo, gerar um texto curto não sensível, ouvir em navegador autenticado pelo Access real (incluindo pedido de bytes/Range), verificar qualidade MP3 e hash, autorizar um destinatário de teste e conferir o resultado do envio sem tratar aceitação como entrega/leitura. Reprodução em navegador e compatibilidade de cliente MCP exigem esse ensaio; JWT sintético prova o código de autenticação, não a política Access da infraestrutura real.

## Atualização do dono durante a implementação

O dono informou que criou a conta Fish, aberta no Chrome, e mencionou 8.000 créditos gratuitos; autorizou conferência posterior da conta/API para ensaio gratuito. Isso ainda precisa distinguir créditos do site e disponibilidade da API. `s2.1-pro-free` foi incluído como opção explícita de configuração, sem trocar o modelo automaticamente. A documentação oficial distingue esse modelo gratuito (sem garantias de TTFA/DPA); conferir os termos vigentes antes de transmitir texto real. Não implica autorização para consumo pago, deploy ou envio de WhatsApp.


## Evidências finais da implementação

- Base conferida: `orobsonn/whatsapp-mcp`, branch inicial `main`, commit `4199916`, árvore limpa; implementação isolada na branch `codex/fish-audio`.
- RED inicial: módulo de geração ausente; RED de prévia/catálogo: quatro falhas comportamentais (404, ausência de autenticação e ferramenta ausente). Regressões adicionais provaram falha de CAS, limpeza ausente e submissão após deadline vencido antes das respectivas correções.
- `npm run check`: exit 0.
- `npm test`: **260/260**, 20 arquivos, exit 0. Destes, 32 testes novos exercitam geração (28) e prévia/MCP (4). D1/R2 e autenticação criptográfica são reais no runtime local; Fish/Z-API e identidades são sintéticos.
- `npm run build`: exit 0, `wrangler deploy --dry-run`, sem publicação.
- `git diff --check`: exit 0.
- Smoke local existente: `node scripts/smoke.mjs http://localhost:8797`, exit 0, versão 0.6.0, manutenção ativa e arquivo privado recusado. Nenhum endpoint de IA/Fish/Z-API foi chamado pelo smoke.
- Avisos das dependências: Node `punycode` deprecated e sourcemaps do SDK apontando fontes ausentes; não impediram os checks.
- Revisão independente final: correções de cancelamento, orientação específica da proposta e anotação de processamento externo verificadas; nenhum P1/P2 identificado pelo revisor.

A inspeção de conta solicitada depois pelo dono e a autorização de criar uma chave sem expiração não configuraram o Worker nem autorizaram consumo pago. Não há valores de credenciais ou dados financeiros da conta neste repositório. Cadastro da voz e homologação real permanecem separados.


## Configuração posterior autorizada — 21/10/2026

Após a entrega, o dono autorizou explicitamente guardar a chave Fish como secret para preparar os testes. A API Cloudflare confirmou a presença do binding `secret_text`, mas essa conferência não validava a autenticação Fish. A primeira transferência estava incorreta; a primeira chamada real recebeu HTTP 401 e não produziu mídia. O registro de falha foi preservado, sem submissão automática repetida.

A operação atualizou somente o secret do Worker existente. O código novo de TTS, a migration e a ativação da geração não foram publicados nesta etapa. Não houve geração Fish, consumo de saldo ou envio de WhatsApp. A voz própria ainda depende do cadastro separado do dono.

## Publicação e ensaio gratuito autorizados — 21/10/2026

Posteriormente, o dono autorizou publicação e prévia gratuita. A migration `0011_tts.sql` foi aplicada antes do código. A versão `2768c982-6280-48bf-a281-bdd901387c1c` foi promovida a 100%; após substituição da chave de teste com a mesma finalidade e duração autorizadas, a versão ativa passou a `b11cc6db-6a56-43e2-9520-6c2dc099789e`. O secret correto foi transferido por arquivo temporário protegido, fora do repositório, e validado pela geração real. Nenhuma chave ou token foi incluído no Git/D1/URLs.

Configuração do ensaio: `TTS_ENABLED=true`, modelo explícito `s2.1-pro-free`, voz pública de demonstração do exemplo oficial Fish (`933563129e564b19a115bedd57b7406a`). Sem fallback pago. A voz do dono não foi clonada nem usada.

O catálogo antigo da conexão não oferecia a ferramenta nova. Um único cliente OAuth temporário de homologação, autenticado pelo fluxo normal do dono, foi usado para chamar o MCP publicado. A conexão original do ChatGPT não foi substituída. Após a rejeição definitiva 401, foi gerado o texto sintético originalmente solicitado, “Oi testando criacao de audio com mcp”; não se alterou texto para contornar resultado incerto.

Evidências reais:

- `gerar_audio` retornou `ready`, MP3 `audio/mpeg`, 52.243 bytes, com hash persistido e prévia privada. A chamada usou o modelo gratuito explicitamente configurado.
- A página autenticada exibiu texto, voz, arquivo e aviso de que nada havia sido enviado. O player Chrome chegou ao fim: duração 3,265188 segundos, `readyState=4`, sem erro de mídia. Isso confirma reprodução com o Access real nesse navegador, sem expor R2 ou credencial na URL.
- Requests sem autenticação para HTML e bytes receberam HTTP 403.
- Smoke após a publicação: exit 0, manutenção desativada, recurso privado recusado sem autenticação. O diagnóstico pela conexão original continuou respondendo e a captura recebeu callbacks durante o ensaio.
- Pré-publicação: tipagem e suíte completa passaram, **260/260 testes em 20 arquivos**. Erros, concorrência, timeout incerto, exclusão em voo e vínculo da aprovação continuam validados com mocks; não foram provocados contra Fish/Z-API reais.

Não houve `preparar_envio` ou `executar_envio` para este áudio, nem envio WhatsApp. A aprovação posterior deve identificar o MP3 final e o destinatário. Permanecem pendentes: revisão auditiva do dono, voz própria, homologação de envio especificamente autorizada e comportamento em outros navegadores/clientes.

## Qualidade rejeitada pelo dono — 21/10/2026

O dono ouviu a prévia e relatou áudio estranho. Isso invalida qualquer interpretação de que a homologação técnica aprovou a qualidade da fala. O ensaio acima verificou geração, integridade e reprodução; não validou naturalidade, pronúncia ou adequação da voz.

A inspeção do MP3 já existente, sem nova síntese, confirmou hash igual ao persistido, 52.243 bytes, mono/44.100 Hz/128 kbps e 3,265188 segundos. A decodificação completa pelo FFmpeg terminou sem erros. Esses resultados não excluem artefatos na síntese nem problema no dispositivo de reprodução.

A voz de exemplo escolhida (`933563129e564b19a115bedd57b7406a`) é apresentada pelo [Fish como “English Sarah”](https://fish.audio/developers/). Não foi selecionada uma voz brasileira. Sotaque/pronúncia inadequados são uma hipótese a distinguir de cortes, aceleração ou chiado relatados pelo dono; não uma causa já comprovada. A documentação descreve `s2.1-pro-free` como o mesmo modelo de `s2.1-pro`, portanto o resultado ruim não foi atribuído automaticamente ao plano gratuito. Não houve nova geração, consumo adicional ou envio durante esta inspeção.

## Voz própria selecionada pelo dono — 21/10/2026

O dono cadastrou sua voz separadamente e forneceu o link do modelo Fish, autorizando seu uso para gerar a mesma mensagem de teste. A página conferida identifica “Jovem simpático”, por Robson Junior, idioma `pt`. Foram alterados somente `FISH_VOICE_ID` e `FISH_VOICE_NAME` na configuração controlada; `s2.1-pro-free` permaneceu explícito, sem fallback pago. A integração não enviou amostras nem coletou áudio de conversas.

A versão `e90ab8ad-2ddc-4956-9cde-87fbc5440c64` foi publicada a 100% após tipagem, **260/260 testes** e build dry-run passarem. A conferência da versão preservou os secrets; smoke após publicação passou. A geração real pelo MCP retornou `ready`, voz “Robson — Jovem simpático”, modelo gratuito e MP3 de 40.541 bytes. A prévia autenticada exibiu a nova voz e o mesmo texto de teste. A avaliação de naturalidade e semelhança cabe à revisão auditiva do dono; reprodução técnica não comprova essas qualidades. Nenhuma proposta ou execução de envio WhatsApp foi feita.

## Pedido de envio sem confirmação adicional — 21/10/2026

Após pedir uma declaração e envio direto, o dono determinou: “o áudio por si só será enviado somente quando eu pedir”, dispensando a pergunta adicional. Essa decisão substitui a revisão pós-geração obrigatória do escopo inicial. A revisão adversarial confirmou o limite por pedido/conteúdo/destinatário e recomendou preservar executor, hash, isolamento e tentativa única. Foram atualizadas apenas orientações de geração, proposta, catálogo MCP e página, mais testes e documentação. Não foi criado envio automático, aprovação automática ou autorização permanente.

Os testes de contrato foram observados falhando em três pontos com a política anterior antes da correção. Permanecem os testes de geração sem criar ações, confirmação ausente recusada, hash de outro destinatário recusado, alteração de arquivo e envio sem repetição.

Validação da mudança: tipagem, build dry-run, `git diff --check` e suíte completa **260/260, 20 arquivos, exit 0**. Revisão adversarial final sem P1/P2; revisor também executou os 32 testes específicos. Publicação a 100% da versão `9e8af270-cda1-4670-ae93-3ed9bb035e19`, secrets preservados e smoke remoto aprovado. A consulta MCP real de proposta retornou a orientação nova sem exigir segunda pergunta.

O envio da declaração já gerada foi executado uma única vez com a proposta/hash existentes, conforme pedido explícito do dono, sem nova síntese Fish. A integração retornou `accepted`, confirmado pela consulta da mesma ação. Esse estado comprova aceitação do provedor, não entrega ou leitura; não houve repetição para tentar obter outro status. Áudio e informações privadas do destinatário não foram versionados.
