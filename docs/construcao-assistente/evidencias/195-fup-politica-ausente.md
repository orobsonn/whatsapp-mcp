# FUP privado sem política própria

Data: 01/11/2026. Pedido explícito do dono: permitir registro privado sem ativar conversa, observação, resposta, captura, mandato ou envio; não recriar o FUP da Balloon nem restaurar sua nota retirada.

## Diagnóstico publicado

Gateway observado: v0.52.3, versão `c16b9fc5-b9d4-4169-a02c-8038ac67afc9`; assistente: `f5c8b716-e3f8-4fec-b45b-718919b2ddc8`. A tentativa controlada com revisão 0 foi recusada como `control_policy_required`, campo `policyRevision`, antes de qualquer escrita. A versão local citada pelo dono estava defasada: o schema atual já aceita 0, mas a execução o bloqueava sem outgoing. O catálogo exigia revisão positiva e a skill publicada permitia ausência com 0, sem delimitar corretamente os dois fluxos.

## Correção e invariantes

- Sem política e sem outgoing, revisão 0 é admitida apenas para lembrete privado do dono, suportado por nota privada atual, sem conversationId nem candidate. A fonte continua estrita em `{id, revision}`; versão/hash são derivados pelo servidor.
- Ausência, namespace corrente, conversa observada/disponível, pausa, quarentena e retenção entram no mesmo ledger da escrita. Nenhuma política é criada. Se falta observação válida, o erro aponta conversationId; não se habilita captura para contornar.
- A proveniência recebe marcador interno `ownerReminder={policyRevision:0}`. Prazo, claim e publicação revalidam esse marcador: uma política posterior não pode cair no ramo legado e conceder permissão ao registro antigo.
- Revisões positivas continuam exigindo política atual correspondente e respeitam exclusão, ignore e pausa. Fonte, contexto de conhecimento e autoridade de grupo não são relaxados.
- Diagnósticos de policyRevision/source/conversationId são fechados e sem conteúdo privado; não atribuem falha de política a data/fuso.

## Revisão adversarial

A revisão identificou e exigiu corrigir uma janela no runtime legado: um job admitido sob ausência poderia capturar uma política nova no preparo do episódio. O mesmo guard do marcador foi incluído no claim e publicação. Sem namespace nominal, apenas esse novo caminho falha fechado; formatos serializados legados não foram alterados.

## Verificação planejada

- Reproduzir ausência, revisão divergente, política concorrente/posterior, exclusão, ignore, pausa, quarentena, retenção, fonte vinculada/retirada e extras version/hash.
- Provar evento privado no runtime nativo sem autoridade WhatsApp ao grupo, além do claim/publicação legados.
- Reconciliar catálogo, documentação e skill efetivamente publicada, preservando identidade, conexão e público do plugin.
- Publicar preservando integralmente recursos e configurações ativos; validar com nota nova e FUP controlado fora da Balloon, releitura e replay; cancelar o teste e retirar somente sua própria nota. Comparar políticas antes/depois. Nenhum envio como parte do teste.
