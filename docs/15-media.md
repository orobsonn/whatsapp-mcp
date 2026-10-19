# Mídia privada e transcrição — issue #3

19/10/2026. Implementação e ensaios exclusivamente sintéticos em workerd, D1 e R2 locais. Nenhuma instância Z-API, credencial, implantação ou chamada real de IA utilizada.

## Integração

O módulo `src/media.ts` é interno. O router deve autenticar o dono atual antes de chamar upload, metadados, bytes ou transcrição. `assertActive`/epoch/geração do módulo são fences operacionais, não substituem autenticação. Nenhuma função pública do MCP recebe URL de download, chave R2 ou source_url.

- `uploadMedia(env, chatId, {bytes: Uint8Array, mime, filename?, durationSeconds?})` → `MediaView`. Corpo HTTP deve ser lido com limite de 2 MiB pelo router antes da conversão. Chat precisa existir na instalação/geração correntes; upload não libera captura.
- `getMedia(env, id)` → `MediaView`: id, chatId, kind, mime, size, sha256, filename, state, version e durationSeconds. Inclui pendência/falha para explicar cobertura; exclui origem, chave e endereço externo.
- `readMedia(env, id)` → `{metadata: MediaView, bytes: Uint8Array}`. Exige ready, D1 visível, objeto existente e hash/tamanho íntegros; reconsulta a visibilidade após ler R2. O router decide bloco MCP limitado ou download autenticado, com MIME identificado, nosniff e filename escapado.
- `processMediaJobs(env, fetcher = fetch)` → `{processed, ready, failed}`. Cron deve chamá-la; captura já persiste mensagem e download job antes do sucesso do callback. Contagem failed inclui tentativa que continuará com backoff. Não transcreve no cron.
- `transcribeMedia(env, id)` → `{id, mediaId, text, untrusted: true}`. Exige binding AI e `TRANSCRIPTION_ENABLED=true`, áudio ready e duração declarada permitida. Reutiliza derivado já publicado; texto é dado não confiável e não autoriza ferramenta alguma.

Não foi necessária migration. O token do claim é o par durável `(attempts, lease_until)` da linha única de trabalho. `attempts` cresce atomicamente a cada claim; comparação exata do par impede que um worker com lease antigo publique ou finalize o trabalho retomado por outro.

## Bytes e publicação

Arquivos têm até 2 MiB. Assinaturas/conteineres reconhecidos: PNG, JPEG, WebP, PDF, Ogg Opus/Vorbis, WAV, MP3 e M4A/M4B. MIME declarado/HTTP e tipo da mensagem devem concordar com os bytes; aliases WAV/MP3/M4A são normalizados. Nome com caminho, controle, dois-pontos ou extensão incompatível é recusado. Nome sem extensão pode permanecer. Assinaturas não equivalem a decodificação completa, antivírus ou ausência de conteúdo ativo em PDF; não há OCR, parsing geral de documento ou execução de conteúdo.

Cada gravação usa chave R2 aleatória e imutável, privada; hash SHA-256 fixa o conteúdo. O upload copia os bytes após conferir o limite para impedir alteração pelo chamador enquanto há awaits. D1 fica pending antes da gravação e só publica ready após fence condicional.

Publicação de original e derivado verifica epoch, geração, versão da mídia, versão e existência da mensagem, chat correspondente, ausência de tombstone e ausência de `unavailable_reason`/tipo incompatível. Perder o fence remove o objeto privado recém-gravado; não publica o resultado. Objetos anteriores apagados/antigos ficam inacessíveis imediatamente por D1; limpeza física e órfãos após queda do processo pertencem à operação. Nenhuma transação fica aberta durante rede ou IA. Uma exclusão não pode recuperar bytes já transmitidos.

## Download e recuperação

Somente `source_url` previamente persistida pelo backend é usada. `MEDIA_HOSTS` é uma lista separada por vírgulas de nomes DNS exatos, específicos e confiáveis administrados pelo operador; vazia bloqueia download. Sem wildcard, IP literal, localhost/domínio local, porta explícita (inclusive 443), userinfo, fragmento, whitespace ou backslash. Somente HTTPS; redirect manual e qualquer 3xx recusado. Nenhum token Z-API, Authorization, Client-Token ou cookie é anexado à chamada.

A compat flag `global_fetch_strictly_public` força roteamento de fetch como Internet pública; sua documentação não prova, sozinha, uma política completa contra DNS privado/rebinding. A allowlist não pode conter domínio controlado por remetente nem um host genérico escolhido pelo conteúdo. Não houve teste de resolução DNS/rebinding em infraestrutura real nesta entrega; validar os hosts operacionais reais faz parte da ativação. O teste de URL/redirect local não substitui essa prova.

São até cinco candidatos por tick, lease de 120 segundos e três tentativas. Rede tem deadline total de 15 segundos incluindo streaming, AbortController e cancelamento explícito do reader; limite real de bytes independe de Content-Length. Falha transitória usa backoff exponencial (2s/4s; terceira terminal). Redirecionamento, origem, formato, nome e MIME inválidos são terminais. Erro salvo é código sanitizado, sem URL/resposta externa. Último lease expirado vira falha; jobs de mensagens invalidadas são cancelados. Repetir callback não recria download concluído.

## Processador de áudio

Binding Workers AI: `env.AI.run('@cf/openai/whisper', {audio: Array.from(bytes)}, {signal})`. Original permanece intacto; derivado textual separado e identificado por mídia/versão/fence. Claim exclusivo e publicação condicional impedem duplicação local e ressurreição depois de exclusão/edição. Deadline de IA de 45 segundos, saída de até 32 mil caracteres e entrada de até 2 MiB. Áudio com duração declarada acima de 120 segundos é recusado; esse campo não mede a duração real. Não existe decoder para aferir duração nem transcrição em massa.

Abort/timeout não prova cancelamento de cobrança/processamento no provedor. O cron nunca retoma transcrição automaticamente; uma nova chamada explícita pode tentar novamente depois do backoff, até três claims. Um resultado tardio de execução expirada não publica. Não há garantia de custo exatamente uma vez na rede externa. Processor/opt-in permanecem desabilitados por padrão até configuração expressa.

## Evidência local

TDD: os 19 comportamentos iniciais falharam por implementação ausente; GREEN 19/19. Regressão de indisponibilidade foi reproduzida (getMedia expunha metadados após message unavailable) e corrigida. Nome com extensão enganosa e cancelamento de corpo paralisado também falharam antes da correção. Suíte expandida valida lease retomado, deadlines rede/IA, exclusão em voo, claim/cache de transcrição, origem/MIME/limite e R2 privado. `npm test -- tests/media.test.ts`: 30/30 após essas correções e inclusão de pequenos arquivos sintéticos codificados JPEG/WebP/Ogg/MP3/M4A/PDF. Typecheck e suíte integrada são registrados pelo coordenador no HEAD final, pois outros módulos estavam sendo escritos simultaneamente.

Fontes atuais consultadas: [Whisper Workers AI](https://developers.cloudflare.com/workers-ai/models/whisper/), [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) e [global fetch strictly public](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public). Assinatura e opção `signal` conferidas nos tipos instalados `@cloudflare/workers-types` 5.20261019.1. As fontes provam o contrato documentado, não homologação deste projeto com fornecedor ou cliente externo.
