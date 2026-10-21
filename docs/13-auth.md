# Acesso e confirmação humana — issue 4

Implementação local em 19/10/2026. Sem instância, login Cloudflare real, deploy ou cliente externo homologado. O fluxo OAuth foi exercitado com a biblioteca real, KV/D1 locais em workerd e chaves/identidades exclusivamente sintéticas.

## Fronteiras

- `createOAuthProvider(apiHandler, defaultHandler?)` compõe um único Worker. Biblioteca `@cloudflare/workers-oauth-provider` 1.2.3 atende descoberta, registro, token e validação bearer para `/mcp`. O handler humano de `/authorize` é separado; demais páginas seguem para `defaultHandler`.
- `requireOwner(request, env)` verifica criptograficamente o JWT Access do header `Cf-Access-Jwt-Assertion` ou cookie `CF_Authorization`, com JOSE e JWKS derivado exclusivamente do issuer HTTPS configurado. Exige assinatura RS256, expiração, `iat`, issuer/audience/subject fixos. `email_verified` não é requisito; e-mail/header textual ou bearer MCP nunca substituem Access.
- `requireMcpOwner(props, env)` exige subject e epoch atuais. O wrapper faz essa verificação em cada request autenticada; o callback de troca/refresh também a faz. Manutenção ou configuração ausente falham fechadas. `MAINTENANCE` deve ser exatamente `false` para autorizar.
- Access logout isolado não promete revogação imediata de tokens MCP. Access tokens MCP duram cinco minutos; refresh grants têm prazo fixo de 24 horas, sem extensão por atividade. Rotacionar `INSTALLATION_EPOCH` bloqueia imediatamente as próximas autorizações verificadas pelo Worker, incluindo refresh. Restore exige rotação fora do banco restaurado.
- `PUBLIC_ORIGIN` é obrigatório e deve ser origem HTTPS sem caminho, query ou credenciais. HTTP em localhost/127.0.0.1/::1 requer `DEVELOPMENT=true` explícito. Redirects de clientes seguem a mesma regra; não há URI scheme privado, CIMD ou busca arbitrária de metadados/JWKS externos. DCR aceita até dez callbacks registrados, sem `jwks_uri`, `sector_identifier_uri`, `request_uris` ou `software_statement`. Corpos de registro/token são limitados a 16 KiB.
- PKCE S256 é obrigatório na autorização, com challenge válido. O scope `mcp` é obrigatório no consentimento e efetivamente exigido no acesso à API: a configuração `requiredScopes` da biblioteca apenas o anuncia, não o impõe. Tokens reduzidos sem esse scope são recusados.

## Confirmação

`humanConfirmation(request, env, proposal, confirmed)` aceita propostas dos propósitos fechados `send`, `capture-policy`, `retention` e `delete`. `proposal` contém `resourceId`, `envelope` e `summary`. GET apresenta envelope escapado, resumo, SHA-256 e botão; não executa efeito. POST exige Access novamente, origem exata e form-urlencoded limitado a 512 bytes. `Origin: null` é recusado.

O nonce aleatório de 256 bits aparece somente no corpo do formulário. D1 guarda seu hash com subject, epoch, propósito, recurso, hash do envelope, expiração de dez minutos e consumo. O `UPDATE ... WHERE ... consumed_at IS NULL RETURNING` é o claim atômico: concorrência, repetição, mudança de envelope, epoch antigo e nonce vencido não chegam ao callback. OAuth usa o mesmo vínculo e armazena a requisição já validada em D1, evitando transportar parâmetros OAuth no POST/URL de confirmação.

O callback recebe `{ sub, epoch, purpose, resourceId, envelopeHash }`. O módulo de ações continua responsável por comparar esse hash com o snapshot imutável e fazer seu próprio claim antes de qualquer efeito. `hashEnvelope(value)` fornece a serialização JSON canônica (chaves ordenadas recursivamente) e o SHA-256 hexadecimal compartilhados. Consumir nonce e executar efeito externo não são uma transação: falha posterior mantém o nonce consumido e o módulo dono da operação deve expor o resultado recuperável. Não repetir envio por timeout.

HTML usa escape para todas as strings externas, `default-src 'none'`, `form-action 'self'`, `frame-ancestors 'none'`, `base-uri 'none'`, `no-store` e `nosniff`. `Referrer-Policy: same-origin` suprime referrer externo preservando a origem do POST; `no-referrer` causou `Origin:null` no ensaio histórico do Elo, por isso não se relaxa CSRF para aceitar `null`. Redirecionamento OAuth é resposta HTTP separada com `no-referrer`, sem wildcard CSP.

A migração `0002_auth.sql` só guarda metadados e hashes; nenhum JWT Access/token MCP é persistido nela ou exposto em logs. Registros expirados podem ser removidos por limpeza operacional via `expires_at`; nunca se reutiliza nonce consumido.

## Evidência local

- RED, `npm test -- tests/auth.test.ts`: cinco falhas comportamentais com interfaces ainda sem implementação (identidade válida recusada, formulário ausente e confirmação indisponível).
- GREEN inicial: onze testes workerd verificaram JWT sintético válido versus issuer/audience/subject/expiração incorretos ou ausentes, cookie versus bearer, epoch/manutenção, escape, GET sem efeito, origem exata, alteração de envelope, replay e expiração do nonce.
- Fluxo com biblioteca real: registro → GET Access/consentimento → POST nonce → código PKCE → token → handler MCP; rotação de epoch bloqueia bearer existente e refresh com `invalid_grant`. Cadastro inseguro/URL de metadados também é recusado.
- RED adicional encontrou scope reduzido aceito e cadastro de 17 KiB aceito; GREEN após imposição real do scope e limite de corpo.
- Último comando específico: `npm test -- tests/auth.test.ts`, **14 testes passaram**. `npm run check` passou no workspace integrado às 10:03. Uma execução agregada intermediária encontrou regressão na captura própria (`accepted` versus `received`), corrigida pelo responsável por ações/fundação. Reexecução final `npm test` às 10:03:59: **39/39 testes, quatro arquivos, exit 0**.

Ainda pendentes: provisionar política Access/JWKS reais, audiência/subject do dono, origem pública/rotas que deixem OAuth MCP e callback adequadamente acessíveis, TTLs operacionais, testes em navegador real e cliente MCP escolhido. Nenhuma configuração ou dado do Elo foi utilizado.

## Investigação de reconexão — 21/10/2026

O dono relatou reconexões frequentes durante a homologação Fish. A inspeção confirmou os valores atuais de `src/auth.ts`: access token de cinco minutos, refresh grant absoluto de 24 horas e cadastro do cliente de 24 horas. Na biblioteca 1.2.3, a renovação do access token não estende o prazo absoluto do grant. Isso exige novo consentimento diário mesmo com uso frequente; não explica, sozinho, reconexões sucessivas em poucos minutos.

Na observação real, a conexão original ChatGPT permaneceu válida, com grant ainda não expirado, diagnóstico autenticado respondendo e callbacks chegando. A tela extra de consentimento pertencia ao cliente temporário criado para testar o catálogo TTS novo. Falhas de observação do controle do navegador após uma navegação concluída também não foram consideradas prova de logout. Não foi demonstrada queda repetida da conexão original nesse intervalo.

Revisão adversarial independente: sessão fixa de 30 dias reduziria a reconexão diária, mas ampliaria a janela de exposição de um refresh token roubado. Logout Access não revoga sozinho o MCP; epoch continua sendo a revogação comprovada. A recomendação depende de decisão do dono e de testes de renovação após 24h, limite absoluto, cadastro, grants antigos e revogação/manutenção. Só alterar a configuração não prolonga grants existentes: seria necessária uma última reconexão para obter o novo prazo.

Nenhum prazo, epoch, política Access ou credencial da conexão original foi alterado nesta investigação. Não se afirma que aumentar o prazo corrigiria eventuais falhas do cliente ainda não reproduzidas.
