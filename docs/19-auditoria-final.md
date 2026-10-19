# Auditoria final do software

19/10/2026. Revisor independente `final_adversary`, gpt-6-astra/high, somente leitura. Escopo: PRD, contratos, migrations e implementação completa no commit `cdcd974`. O revisor não repetiu a suíte geral; reproduziu bugs com funções reais compiladas em memória e migrations em SQLite em memória. Isso é ensaio controlado, não workerd ou prova real Z-API.

## Achados e correções

1. P2: status alto perdido quando dois callbacks liam a mesma ação accepted. Correção: correlação única e comparação de rank em um único UPDATE atômico D1. Regressão com barreira de leitura observou delivered no lugar de read antes da correção; ambas as ordens agora preservam read.
2. P2: READ antes do retorno não atualizava ação em chat sem captura. A primeira correção só cobriu conversa exata; re-review reproduziu a lacuna sem `phone`, que foi corrigida também. Conciliação agora usa evidência durável de `pending_statuses`/`messages`, unicidade dos chats conhecidos e atualização monotônica no mesmo snapshot atômico. Sem conversa só aplica com um único chat possível; caso ambíguo permanece pendente. Regressões com/sem conversa e dois destinos de mesmo ID passaram sem habilitar captura.
3. P2: WAV arquivável/transcritível era aprovado para envio, mas rejeitado antes do POST pelo adaptador, produzindo falsa incerteza. Correção: whitelist de envio compartilhada entre adaptador e validação de mídia da ação, conferida na preparação e antes de claim. Regressão falhou por permitir proposta WAV, depois passou sem criar tentativa; WAV continua legível no arquivo.
4. Defeito operacional confirmado: diagnóstico ignorava jobs retry/processing, pois consultava leased. Regressão falhou 0/1, depois passou com estados reais.
5. Melhoria menor incorporada: reservar orçamento por categoria da limpeza. Antes, 50 mensagens vencidas impediam remover objeto e nonce no mesmo tick. Regressão reproduziu e passou após reserva (até 25 mensagens, 10 objetos, 5 nonces, 3 propostas, 3 jobs, 2 status e 2 payloads; 50 unidades totais).
6. Limite de retenção de uploads sem mensagem explicitado no manual: duram até exclusão do chat, não expiram pela política de idade das mensagens. Não se afirma exclusão automática desses uploads.

## Evidência da wave de correção

- RED: `npm test -- tests/actions.test.ts tests/operations.test.ts`: 3 falhas esperadas de status/diagnóstico; WAV e backlog de limpeza também falharam nos testes adicionados antes do fix.
- GREEN: `npm run check` exit 0; `npm test`: 7 arquivos, 89 testes, zero falhas no HEAD da correção. Logs locais sanitizados em `/tmp/whatsapp-mcp-final-suite.log`; registros permanentes resumidos nesta pasta, sem payload real.
- Testes cobrem comportamento e risco; não foram criados testes de espelho para documentação ou configuração trivial.
- Warnings de punycode e sourcemaps ausentes vêm das dependências; não são falhas/omissões de teste. Auditoria npm de dependências de produção: zero vulnerabilidades reportadas.

## Limites permanentes desta prova

Sem instância separada, login Access real, callback real de exclusão comprovado, ensaio de DNS/hosts operacionais, processamento Workers AI real ou ferramenta executada em ChatGPT/Claude finais. Backend SDK local não é prova desses serviços. Revisão não encontrou bypass concreto de autenticação/confirmação no escopo inspecionado; isso não promete ausência universal de vulnerabilidades.

Revisão da wave, CI no HEAD e release serão registrados em `10-entrega.md` antes de encerrar o marco.

Re-review da primeira wave considerou todos os outros achados corrigidos e exigiu a complementação acima; não foi apresentado como aprovação. A complementação observou RED no callback sem conversa, seguido de GREEN15 ações +2 jornada e typecheck, antes de nova revisão focada.

Veredito final independente sobre `fd127ec..40ce77f`: **ADDRESSED; sem bloqueadores remanescentes para merge no escopo revisado**. O revisor confirmou correlação, evidência e progressão no mesmo UPDATE, incluindo status sem conversa e recusa de ambiguidade. Não repetiu testes; os comandos de validação foram executados pelo coordenador. A decisão não estende a prova à homologação externa.

Validação integrada após a complementação e bump 0.1.0: `npm run check`, suíte **91/91**, build dry-run e audit de produção (zero vulnerabilidades) com exit 0. Smoke local da versão 0.1.0 em manutenção recusou download sem login. CI do HEAD da PR aprovado; merge fechou as seis issues. O registro GitHub em `10-entrega.md` é a referência de integração.
