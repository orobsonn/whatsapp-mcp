# Prévia de mídia e aviso da curadoria

Data: 29/10/2026. Correções do runtime nativo após revisão adversarial do marco.

## Mídia recebida no WhatsApp

A revisão anterior admitia somente texto/transcrição e bloqueava propostas ancoradas em imagens/PDFs, embora o agente pudesse interpretá-los. A prévia agora reconhece o tipo exclusivamente pela observação autenticada do Source, confere hash e corpo canônico e mantém o SourceRef original.

A prévia mostra `Imagem recebida` ou `PDF recebido`, a legenda verificável e o resumo da IA separado. Ela informa que o anexo não é exibido ali. Não apresenta metadados JSON como mensagem original, nem interpretação visual como citação literal. JSON escrito pelo remetente continua texto.

A legenda de uma âncora de mídia exige correspondência de mensagem, versão, autor e identidade completa da mídia com a mensagem pai. O hash da revisão inclui tipo/legenda e é reconstruído no callback. Mudança de legenda ou mídia invalida a aprovação; a mesma ação Source conserva tentativa única e reconciliação de replays. Mídia sem legenda também pode receber sugestão pedindo esclarecimento.

## Aviso do curador

O cancelamento do SDK atravessa `curator_finish`, o binding nativo e o host. A revisão remota completa acontece antes do transporte; o callback final conserva escopo, autoridade, eventos da coorte, vínculo Telegram, restore/hold e o predicado local sobre todas as fontes expostas. O fetcher combina cancelamento da tarefa e prazo da API. Nenhuma notificação incerta é repetida.

## Validação

- RED: quatro casos de imagem/PDF bloqueados na revisão anterior; dois casos de aviso reproduziram revisão saudável acima de 10s recusada e cancelamento ignorado.
- GREEN: 118 casos em três arquivos, incluindo o contrato original de prazo Telegram, envio Source único e replays, prévia tipada e cancelamento do aviso.
- Verificação adicional dirigida: pausa depois da revisão remota deve bloquear o transporte, mesmo liberando a revisão; nova chamada apenas reconhece o aviso já reivindicado.
- TypeScript e build do Worker passaram. Revisão adversarial: nenhum Critical/Important restante nas duas alterações.

Os testes usam D1/Source reais no runtime local Cloudflare com provedores sintéticos; não substituem confirmação de mensagem entregue ao WhatsApp nem do aviso pelo Telegram em produção.
