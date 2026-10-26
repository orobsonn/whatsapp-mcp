# #53/#56 — handler agendado no bundle oficial

26/10/2026. A conferência real dos metadados do backend2055 identificou somente `fetch` em `resources.script.handlers`. O código-fonte possuía `assistant/index.ts.scheduled`, mas o build oficial Flue não o exportava. Adicionar uma agenda não resolveria essa ausência.

A implementação instalada de `@flue/vite`2.3.0 gera o default a partir dos handlers de `assistant/cloudflare.ts` e acrescenta seu próprio `fetch`. A correção exporta nesse ponto somente `scheduled: assistant.scheduled`. Named exports, HTTP da aplicação, runtime e código do SDK são conservados; nenhum vendor foi alterado.

O teste novo `assistant-scheduled-runtime.test.ts` constrói o bundle oficial, carrega seus módulos no Miniflare e despacha dois `ScheduledEvent` no entrypoint gerado. Usa D1 real com as25 migrações e a configuração pausada. Não chama `AssistantScheduler.tick` nem o handler-fonte diretamente.

Execuções do Root:

- RED:1/1 falhou em7,92s, depois de build/migrações bem-sucedidos. O runtime declarou handler ausente e os dois eventos retornaram `exception`, em vez de `ok`.
- GREEN após as duas linhas de produção:1/1 aprovado em9,08s. Confere `ok`, um ciclo por minuto natural, uma revisão no período, pausa/budget não configurado, health HTTP,13 tabelas de efeitos vazias e zero outbound.
- TypeScript e `git diff --check` aprovados. Inclusão somente na suíte nativa, com exclusão do pool D1 padrão para evitar execução duplicada.

O teste tolera somente a passagem real de minuto entre os dois eventos: pode haver um ciclo em cada minuto, nunca dois no mesmo. Não muda relógios ou prazos de produção, não dorme para fabricar janelas distintas e não afirma latência cloud.

Houve uma tentativa anterior de um agente com perfil antigo, terminada em `spawnSync npm EPERM`, seguida de uma espera de aprovação por923s sem processo de teste vivo. Foi interrompida; não conta como RED. O Root executou os comandos acima com o acesso já autorizado, sem nova aprovação humana. Revisão independente posterior conferiu código, teste/configs e os logs reais do Root, sem bloqueador.

Isso é prova nativa do artefato oficial. CI no commit integrado, novo deploy/readback com `scheduled` anunciado e dois ciclos reais de nuvem continuam gates antes de habilitar/declarar a agenda própria homologada. O cron na Cloudflare permaneceu desligado durante esta correção. Sem chamada paga de modelo, envio WhatsApp, escrita Calendar ou alteração Elo.
