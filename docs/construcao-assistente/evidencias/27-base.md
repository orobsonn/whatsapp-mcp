# Issue 27 — preservação da base publicada

Antes: origin/main 4199916; checkout publicado f5ff0f8, com 12 commits históricos pendentes de integração. PR #58 preserva essa história sem deploy nem mudanças no Elo. Exceção ao tamanho alvo do harness: o diff histórico (~1.658 linhas) inclui voz/OAuth já publicados; não foi reescrito ou apresentado como uma feature nova da assistente.

Verificação anterior ao ajuste de dependências: TypeScript, 266 testes/20 arquivos e build dry-run passaram. Revisão independente de build_adversary não encontrou bloqueante concreto. Grant absoluto 30 dias, tokens curtos, erro transitório 503, mídia privada, CAS, consentimento manual e incerto continuam cobertos. Consentimento MCP atestado pelo cliente não é prova independente para futura autonomia.

Consulta somente leitura no banco publicado confirmou migrações 0011_tts.sql, 0010_auto_transcription.sql e 0009_capture_optout.sql aplicadas; zero escrita. Não foram consultadas mensagens nem credenciais.

CI inicial encontrou avisos transitivos publicados depois da base: body-parser 2.3.0 e fast-uri 3.1.8. Atualização restrita no lockfile para 2.4.0 e 3.1.9, respectivamente. Sem mudar APIs/dependências diretas ou desabilitar auditoria.

Referências: https://github.com/advisories/GHSA-27r3-jxmh-p828 e https://github.com/advisories/GHSA-w74x-v6f9-j3xg. A presença da dependência vulnerável não é alegação de exploração observada.

Resultado final e release serão acrescentados depois da verificação do commit integrado. Não se alega nova homologação de voz ou envio WhatsApp.

Após ajuste do lockfile: instalação npm11 limpa; audit produção zero vulnerabilidades; check e build passaram; 277 testes passaram no workspace (266 da base + 11 do componente #28 ainda não incluído neste PR). O CI do PR confirma a árvore exata entregue, sem contar o componente local.
