# Curadoria: erros de modelo e recuperação nativa de contexto

Data: 30/10/2026. A diária das 03:00 America/Fortaleza falhou depois de duas chamadas completas. Esta falha é distinta da continuação anterior, concluída e parcial na evidência173.

## Evidência real e limites do diagnóstico

Run `4c5d5c80-95b9-4720-a2f6-87f1b34e00fb`, submission `sub_ik_65d6b477c4ab12276d4f9a807d72a4ad`, SDKfailed/Connection error. O join independente dos turnIds no ledger encontrou duas chamadas completas (125324microUSD) e quatro incertas (68012microUSD cada,272048 ao todo). Nenhuma reserva foi liberada ou reprecificada. Contabilidade:100presented,150pending,355skipped_policy,4superseded,213withdrawn;205capturePending separados. Presented não comprova avaliação. O alerta144 foi aceito pela API Telegram.

O adaptador rejeitava qualquer HTTPnão200/incompletude e lançava erro dentro de fetch. O cliente OpenAI convertia isso em Connection error, e Flue repetia com novos turnIds. A proteção pelo mesmo turnId não impedia essas novas tentativas. Três testes RED reproduziram: overflowHTTP400 mascarado; erro ambíguo classificado como transitório; contexto sem espaço ainda fazendo transporte/reserva.

As quatro reservas68012 correspondem ao teto com16tokens de saída. Pi aplica margem4096; a configuração Flue reserva2048 e verifica compactação depois de o loop ficar ocioso. Um loop de ferramentas pode atravessar essa margem. Isso prova o caminho de falta de espaço; o status/corpo HTTP histórico foi descartado e **não pode ser reconstruído como causa confirmada**.

## Correção

O adaptador usa o clamp público do Pi para comparar espaço disponível com a saída originalmente desejada e limitada pelo host. Autoridade, recibo conhecido e reserva prévia são consultados antes desse sinal. Falta de espaço pede recuperação de overflow do Flue antes de reserva ou transporte. O SDK conserva e compacta sua própria conversa; nenhum recorte/corte de acervo foi criado e o perfil não mudou.

Uma rejeiçãoHTTP400 com código estruturado exato context_length_exceeded gera sinal sanitizado para compactação. Mensagens livres do provedor nunca decidem isso. O corpo de erro é limitado/cancelável. Outros erros retornam409/native_model_uncertain constante, sem causas ou textos privados. Flue deixa de interpretá-los como conexão temporária. As duas escritas financeiras são tentadas separadamente; falha de registro conserva reserved/attempting e diagnóstico fixo, sem provocar nova inferência. O claim atômico e o teto global permanecem.

Revisão adversarial encontrou e corrigiu ordem importante: recibo conhecido não pode ser transformado em overflow quando a visão posterior do mesmo turno fica cheia. Dois casos adicionais protegem complete/uncertain com espaço posteriormente esgotado. Sem Critical/Important restante após revisão; aprovação condicionada à prova CF abaixo.

## Validação

27 testes dirigidos do adaptador passaram; tipos e buildOwn passaram. A suíte completa permanece responsabilidade da CI do marco, sem repetição local pesada.

Prova **na Cloudflare**, Worker descartável já existente, Flue/Pi e adaptador de produção, SSE controlado e nenhuma chave OpenAI. Versão `a69bf9c9-15b8-4b38-ab66-cd9edb6b03c1`. Prova privada0600 `native-model-recovery-cf-proof-1793355653494.json`:

- uncertain: um transporte, um recibo incerto; releitura e redispatch idêntico não criaram nova tentativa;
- overflow: chamada original completa, rejeição preservada como incerta, compactação nativa em turno próprio e continuação completa; quatro transportes controlados, uma compactação;
- headroom: a chamada sem espaço teve zero transporte e nenhum recibo pago; compactação em turno próprio e continuidade concluídas; três transportes controlados, todos completos.

O primeiro cenário de headroom falhou porque o fixture não oferecia corte válido ao SDK. O histórico controlado foi ajustado para uma divisão de turno real; nenhum dado ou limite de produção foi alterado para fazer o teste passar. Esta é prova do protocolo, não da qualidade do julgamento ou da disponibilidade do provedor real.

## Operação real pendente neste registro

A publicaçãoOwn e a continuação explícita da mesma diária serão registradas após leitura externa. Não há alegação de recuperação real antes desses recibos. Autonomia WhatsApp permanece desligada; Source, infraestrutura e migrações não mudam nesta correção.
