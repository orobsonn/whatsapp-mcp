# Transcrição automática de áudios

## Decisão do dono — 21/10/2026

Transcrever automaticamente áudios novos recebidos em conversas individuais e grupos,
salvando o resultado vinculado à mensagem. Suportar também os casos excepcionais de
até dez minutos. Recuperar um áudio anterior escolhido pelo dono como teste pontual;
isso não autoriza transcrição do histórico inteiro.

## Implementação

- `0010_auto_transcription.sql` fixa o marco de ativação no banco. A seleção usa o
  primeiro `received_at` local da mensagem; replay ou edição não rejuvenescem o passado.
- O cron mantém download e limpeza, depois processa até três transcrições sequenciais.
  Um lease global de seis minutos impede crons simultâneos; não inicia outra chamada
  após três minutos de processamento. Cada chamada tem deadline de 90 segundos e
  preserva o claim por mídia/versão e as três tentativas existentes.
- Cota inicial de 500 tentativas por dia UTC, compartilhada entre chamadas manuais e
  automáticas, reservada atomicamente no D1. Cota esgotada aguarda o próximo dia sem
  consumir tentativa. Timeout pode ter custo externo; não há promessa de cobrança única.
- `@cf/openai/whisper-large-v3-turbo`, entrada base64, tarefa `transcribe`, `vad_filter=true` e
  `condition_on_previous_text=false` para reduzir repetição/alucinação em silêncio.
  Sem vetor numérico gigante para arquivos grandes. Áudio recebido: até 20 MiB e
  duração declarada de até 600 segundos. Imagem/PDF, upload e envio mantêm 2 MiB.
  Não existe decodificador local que comprove a duração real de todo arquivo.
- Original privado no R2; texto em `media_derivatives`, ligado à mídia, mensagem,
  versão, instalação e conexão. Exclusão/edição invalidam o derivado; leitura/busca
  conferem esses vínculos. Não duplicar transcrição em `messages.text`.
- `consultar_mensagens` e exportação incluem `transcription` separado, com status,
  texto, erro sanitizado, `untrusted` e indicação de truncamento. Busca lexical inclui
  o texto derivado. O limite UTF8 da página continua valendo.
- Mensagens enviadas pelo próprio dono e uploads sem mensagem recebida não entram no
  automático. Captura desativada interrompe o processamento automático daquele chat.

## Correção de download

A configuração ativa tinha `MEDIA_HOSTS` vazio. O erro observado foi
`media_source_forbidden`, antes da inferência. A origem observada nos arquivos recebidos
é `f004.backblazeb2.com`; ensaio autenticado de seleção e download HTTPS sem redirects
validou um Ogg com resposta 200. A documentação Z-API define `audio.audioUrl`, mas não
garante esse host: a evidência do host é operacional, não uma garantia documental.
Permitir somente o host exato, preservando HTTPS, recusa de redirects, limite de bytes,
validação do conteúdo e ausência de credenciais da API no download.

## Revisão adversarial

Reutilizar armazenamento e fila existentes, sem novo motor genérico. Não liberar
wildcards nem recuperar todos os jobs antigos. Manter cota, lease, fronteira de ativação
e filtros de privacidade na consulta. Revisão independente apontou status `pending`
enganoso quando processamento estivesse desligado; corrigido para `paused`.

## Verificação

Dados reais e URLs de transporte não são versionados. Testes sintéticos cobrem
automático/cache/busca, concorrência, cota, passado e mensagens próprias, exclusão,
dez minutos declarados, arquivos grandes, limite UTF8 e estado de pausa/falha.
Ensaio real com Workers AI em 21/10: arquivo sintético Ogg de 600 segundos,
727.932 bytes, com três falas conhecidas no começo, meio e fim. Sem VAD, o modelo
repetiu frases inexistentes e omitiu as falas posteriores. Com VAD e sem condicionar
na saída anterior, reconheceu as três falas; retorno informou 600 segundos e levou
6,56 segundos. Isso verifica esse ensaio controlado, não garante reconhecimento
perfeito de todo áudio. Publicação e ensaio da mensagem selecionada ainda pendentes.

Fontes: [Whisper Turbo](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/),
[webhook Z-API](https://developer.z-api.io/webhooks/on-message-received-examples).
