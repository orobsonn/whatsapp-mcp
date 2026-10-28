# Perguntas sobre WhatsApp pelo Telegram — 28/10/2026

O diálogo do dono já usa a captura canônica para buscar mensagens e produzir uma síntese em português, com referências. É uma consulta reativa e somente leitura. Não habilita envios no WhatsApp, participação automática em grupos ou rotinas contínuas.

## Resultado integrado

O grupo12319775 recebeu resposta útil: quatro pontos de síntese, oito citações literais válidas e IDs restritos aos três documentos enviados. Resposta91 `sent`, uma tentativa; Flue `settled`, job `shadow_completed` e um recibo. Renderização reproduzida pelo código corresponde exatamente aos1187caracteres enviados. Corpos/hashes/direção das três fontes foram conferidos na captura atual, com política `ignore`, exclusão0 e sem quarentena.

A amostra selecionada continha uma mensagem textual e duas transcrições previamente capturadas. Não eram os mesmos três itens inicialmente usados para escolher o grupo. Não houve nova transcrição, OCR ou análise visual nesse ensaio. A revisão posterior acrescentou `sourceKind/contentKind`, rótulos de transcrição/derivado e instrução para distinguir remetente de pessoa que fala; esses dados só entram em novos payloads. Os contextos antigos continuam imutáveis. O novo canário12319777 enviou resposta95/1477caracteres, uma tentativa e Flue `settled`, com rótulos de transcrição presentes. Nenhuma nova análise de mídia foi executada.

O canário intermediário12319776 tinha três afirmações sustentadas e uma citação inválida; o comportamento anterior descartou o conjunto inteiro. A apresentação passou a validar cada afirmação separadamente: omite toda a afirmação inválida, conserva somente referências dos pontos sustentados e avisa quando a resposta é parcial. Zero afirmações válidas conserva o fallback; uma resposta sem evidência pode explicar a lacuna. Condições/negações continuam obrigatórias, sem correção aproximada de quotes ou remapeamento de IDs. O caso foi reproduzido offline com o corpo real, além da regressão de quote curta e do limite total Telegram.

O privado12319761 também confirmou sua conclusão histórica depois da correção de hash: Flue `settled`, job `shadow_completed`, um recibo e uma tentativa, sem reenviar a resposta. Isso valida a correção da liquidação separadamente da qualidade do texto.

## Provas reais

O canário privado12319761 consultou três mensagens atuais. O modelo produziu duas explicações com seis citações literais verificadas; resposta65 enviada uma vez. O texto respondeu ao assunto consultado, sem despejar os trechos. Fonte, revisão, hash, watermark e direção `fromMe` foram conferidos na captura. Os dois recibos de modelo completaram, sem duplicação, somando1016microUSD. Os nomes e textos permanecem nos recibos privados.

O canário privado anterior12319758 enviou resposta60, mas era uma mensagem de insuficiência de contexto; não foi contado como resposta útil. A verificação de citações rejeitava diferença somente de espaço. O ajuste aceita equivalência NFC/espaçamento, preservando palavras, ordem, números e negações.

Grupo12319762 expirou antes da fase de resposta. Após remover a duplicação de contexto no episódio, o novo canário12319763 completou intent e resposta do modelo, mas não publicou Plan/outbox antes do prazo. Medição offline descartou os limites de tamanho de JSON/SQL; uma SELECT remota com o guard combinado reproduziu HTTP400/código7500, `Expression tree is too large (maximum depth 100)`. Os guards isolados executavam. O ajuste reduziu o recorte de seis para três fontes textuais, preservando todos os guards e indicando a cobertura limitada. A SELECT combinada com três fontes executou normalmente no D1 remoto; não foi acrescentado outro motor de consulta.

Também foi identificada uma janela incompatível: episódio/turno tinham teto de120segundos, enquanto o perfil nativo do diálogo limitava a execução a60. O perfil foi alinhado a120, mantendo uma tentativa e os prazos imutáveis do frame/lease. Isso corrige um segundo limite real, sem atribuí-lo como causa exclusiva da falha anterior ou reabrir qualquer pedido expirado.

Grupo12319765 enviou somente aviso de ausência de evidência atual. A investigação confirmou atraso de watermark entre Source e cópia local; a captura continuava ativa, inclusive com rotinas pausadas. O leitor passou a fazer uma única passagem `CaptureMaterializer.drain(10)` na inbox já autenticada, sob check antes/depois; não repete chamadas pagas, não puxa acervo arbitrário e não garante eliminar todo atraso.

O grupo12319770 completou as duas fases e o envio, mas recebeu fallback: uma citação tinha ID inexistente, embora seu texto estivesse no pacote. Não foi contado como resposta útil. O schema por chamada passou a restringir IDs aos documentos efetivamente enviados, conservando o renderer estrito e sem remapear citações automaticamente. O ensaio positivo12319775 é posterior a essa correção.

## Limites e pendências

Busca lexical e texto recente, com até três fontes textuais e recorte limitado; não comprova busca semântica de todo o arquivo. Nome ambíguo exige esclarecimento. A leitura do dono pode consultar grupo em `ignore`, mantendo a política automática intacta; exclusão explícita ou quarentena continuam bloqueando. Uma conversa ativa pode mudar durante a consulta; o guard conserva a recusa de fonte/contexto desatualizado.

A divergência do hash privado foi reproduzida somente por leitura: o Plan não aplicava schema/deduplicação/ordenação da outbox. Um helper canônico compartilhado e a inspeção histórica do envelope persistido corrigiram a liquidação, preservando o Plan original, recibos nativos/modelo/orçamento e ausência de reenvio.

A homologação comprova estes recortes reativos; o marco final reúne CI, versão e release próprias. Ampliar/medir corpus representativo é pré-requisito de observação contínua posterior. Avaliação longitudinal e benefício humano permanecem trabalho do piloto, sem serem inventados a partir destes ensaios.
