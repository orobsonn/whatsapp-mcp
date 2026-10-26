# #56 — artefatos e diagnóstico da instalação sombra

Implementação de engenharia em 26/10/2026 sobre a integração preservada ab25665, na branch `codex/assistant-installation-artifacts`. Esta rodada não criou recursos Cloudflare, não publicou Worker, não provisionou credenciais reais e não ativou cron/ponte/canais. O inventário CF foi somente leitura e limitado aos nomes próprios previstos; mostrou domínio/MCP atual, ausência do Worker produto e dos bindings ASSISTANT_* no Archive. Nenhum recurso do Elo foi consultado/modificado.

## Fronteiras implementadas

- `CaptureReader.installationAffinity({secret})` é named RPC privado, fora do catálogo MCP/HTTP público. O guard constante de ASSISTANT_READER_SECRET precede RuntimeDB; segredo, manutenção e fence são revalidados depois. Resposta contém somente observação/estado/fence ou indisponibilidade. Conexão live substitui raw pending; nenhuma credencial de fornecedor, telefone, corpo ou URL é devolvida. Source epoch/generation são fixados privadamente, sem rotação automática.
- Manifest estrito/CLI local plan/render produzem configs de recursos novos, grafo de bindings read-only, parser isolado, classes DO e imagem por digest. Vite valida o override host-only e continua usando o bundle oficial Flue. CLI não tem apply/deploy/migrate cloud. Database IDs conhecidos do Archive/labs, destinos arbitrários, tags móveis, default Archive Fetcher, rotas públicas e credenciais extras são recusados.
- Preparação explícita de ponte grava aliases em arquivos 0600/diretório 0700, não imprime valores e recupera a mesma chave. Estado parcial não gera chave substituta. Pin de afinidade conserva valores em arquivo privado, recusa mudança e normaliza a ordem dos campos. Um arquivo fornecido não prova sozinho o RPC live; o recibo declara essa limitação.
- Health autenticada lê somente metadados D1, verifica afinidade por named RPC, head sentinela R2 e seal da autoridade externa. Não aquece índice, não chama modelo, não lê corpo e não faz refresh OAuth. Inventário de tabelas não se apresenta como prova completa de migrações. Pausa reflete exatamente o gate do scheduler; ausência da flag é explícita.
- O delta Archive contém somente nomes ASSISTANT_* e baseline exato, sem substituir configuração legada ou copiar secrets. O coordenador ainda deve revisar/aplicar esse delta e revalidar versão/settings depois dos pré-requisitos. Cron real, routing Telegram e jornada funcional permanecem verificações cloud distintas.

## Revisão adversarial e validação

O coordenador revisou previamente: novos recursos/namespace; ausência de capacidades de envio; imagem com digest/build comprovados; Vite oficial; cron inicialmente inerte; delta aditivo com baseline; R2 próprio; exports live distintos de snapshot; autoridade de retenção externa; bootstrap sem copiar valores do setup. Incorporados. A revisão final independente e integração/CI do commit ainda são gates antes de deploy/fechamento.

- RED controlado do handshake: classe do HEAD anterior não possuía installationAffinity; a contraprova falhou 1/1, 10 pulados. Implementação restaurada em seguida.
- GREEN dirigido: 31/31 em 3 arquivos (install/source-reader/evaluation), 24,53s, D1/workerd. Verificou manutenção, segredo inválido, mudança durante recheck, geração cifrada live, sigilo da resposta, IDs proibidos, capacidades extra e diagnóstico sem wake/refresh.
- Checks Node: 3/3, 1,04s. Render privado/idempotente, conflito sem overwrite, preparação/recovery da mesma chave, pin sem autorrotação, ordem de campos, recusa de apply e ausência de segredo no stdout.
- TypeScript passou usando dependências fixadas da integração; não houve mudança de dependências/lockfile. Os checks Node entram sequencialmente na CI.

A inspeção final alinhou `ROUTINES_PAUSED === 'true'` ao runtime #53 e acrescentou pauseConfigured. O teste pontual passou 1/1 (8 pulados), em 8,70s. TypeScript foi novamente verificado depois desse ajuste.

Build oficial Flue com configuração privada sintética passou: 1.630 módulos, artefato gerado com cinco DOs (owner/interlocutor + Cognee/CalendarOAuth/RetentionAuthority), DB/R2 próprios, readers nomeados e gates inicialmente inertes. Não comprova digest ou recurso live. O primeiro build teve erro apenas de log fora da sandbox, exit0; repetido com WRANGLER_LOG_PATH privado passou sem esse erro. Avisos de extensão de import futuro do Vite e diretiva use agent foram preservados, sem esconder diagnóstico.

Revisão de segurança posterior fixou o registry na conta própria e exigiu asset assistant/assistant[-._]suffix. Contraprova com schema anterior aceitou account estrangeiro e falhou o teste dirigido; schema corrigido passou 1/1 (8 pulados), Node 3/3 e TypeScript verde. O digest ainda exige prova live de imagem/buildFingerprint.

## Pendências reais

Executar o plano de infraestrutura com preflight live, recursos, migrações, imagem/buildFingerprint, secrets privados, baseline atualizado e bridge atual. O CLI prepara artefatos, não é prova desses efeitos. Homologar cron fora da VPS, MCP cliente, Telegram e Google com credenciais/consentimento próprios. A existência de uma API key no laboratório não a transfere ao produto. Falta de chave não impede health/headless e não autoriza extrair OAuth do Codex.

Sem conta financeira criada/resetada. Cap futuro deve descontar todo comprometido anterior, incluindo reservas incertas e demais gerações/períodos/instalações; o teto US$10 não se renova por conta. Custo incremental de inferência desta rodada: US$0. Custos Cloudflare de leitura não foram tratados como inferência nem como fatura final.

Runbook: [operação](../operacao.md). Não declarar #56/#57 prontas por este commit local; release/CI, deploy e homologação têm fronteiras próprias.
