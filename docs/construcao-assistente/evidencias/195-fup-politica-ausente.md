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

## Verificação executada

- Reproduzir ausência, revisão divergente, política concorrente/posterior, exclusão, ignore, pausa, quarentena, retenção, fonte vinculada/retirada e extras version/hash.
- Provar evento privado no runtime nativo sem autoridade WhatsApp ao grupo, além do claim/publicação legados.
- Reconciliar catálogo, documentação e skill efetivamente publicada, preservando identidade, conexão e público do plugin.
- Publicar preservando integralmente recursos e configurações ativos; validar com nota nova e FUP controlado fora da Balloon, releitura e replay; cancelar o teste e retirar somente sua própria nota. Comparar políticas antes/depois. Nenhum envio como parte do teste.

Resultados no commit de código `4464b25`:

- Suíte completa: 121 arquivos, 2.336 testes aprovados. Runtime nativo: 77; OAuth: 13; operador/instalação: 43; calendário: 5; orçamento de índice: 9; outgoing: 1. Typecheck e ambos os builds aprovados; auditoria sem vulnerabilidades.
- Casos de ausência, revisão divergente, política concorrente/posterior, restrições e fonte retirada aprovados. O teste nativo vence o prazo sintético e comprova apenas evento privado do dono, mantendo a autoridade WhatsApp negada para o grupo. O teste legado reprova claim/publicação após política posterior.
- Revisão adversarial final sem bloqueios concretos. Configurações, bindings, segredos herdados e runtime comparados entre base ativa e candidatos antes da promoção; nenhuma migração nem alteração de recurso.

Produção promovida e relida a 100%: gateway `9817dc00-d3dd-4a31-88fd-2e8ce766ae5b`; assistente `98928a95-95fc-4038-ae10-02f37755e746`. Health respondeu v0.52.5, sem manutenção e com conexão configurada.

Homologação autorizada pelo MCP publicado, usando outra conversa existente sem política própria:

- Nota privada nova, sem associação à conversa, e referência somente `{id, revision}`. FUP `scheduled` com prazo futuro foi aceito, versão 1, `native=enrolled`, proveniência `ownerReminder.policyRevision=0`; releitura confirmou o registro.
- Replay exato do mesmo `operationId` retornou o mesmo recibo/versão. Não houve repetição com outro identificador.
- Revisão positiva sem política retornou `control_policy_revision`, campo `policyRevision`, sem alegar data/fuso. Extras `source.version/hash` foram recusados na validação do conector com caminhos explícitos; ambos os registros inválidos permaneceram indisponíveis.
- Teste cancelado com versão esperada; releitura confirmou versão 2, `cancelled` e `native=not_enrolled`. Somente a nota técnica nova foi retirada, com revisão esperada. Prazo real não foi executado; a prevenção de envio foi exercitada nos testes locais. Nenhum envio foi solicitado na homologação.
- Lista completa de políticas idêntica antes/depois; identidade e `captureEnabled` da conversa inalterados. Nenhuma política, mandato ou permissão foi criada para contornar guardas. Balloon não foi recriada nem sua nota restaurada.

Skill efetivamente publicada: Zap 1.0.6, release `pluginrel_6ae7dfa0bab4819183b14cd2f890d1c3`. Releitura confirmou conteúdo igual ao versionado; ambos os manifests mudaram apenas `version`, mantendo identidade, conexão e público privado. `.app.json` foi omitido do overlay e permaneceu presente com o mesmo App identificado pelo plugin. Cache de clientes já abertos não foi apresentado como atualizado.
