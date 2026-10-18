# Mapa verificável do Elo

Fonte local: `../../elo/` a partir deste documento. Snapshot: `ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7`. O [manifesto](../referencias/elo-snapshot.json) tem hash, tamanho em linhas e permalink de cada referência. Os links abaixo fixam esse commit; não apontam silenciosamente para uma versão futura de main.

## Código a estudar antes de adaptar

| Arquivo | Para quê / cuidado |
|---|---|
| [src/auth.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/auth.ts) | OAuth MCP + Access, vínculo do dono, state/nonce, refresh e revogação; não copiar suas chaves/grants. |
| [src/zapi.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/zapi.ts) | Cliente HTTP, status/aparelho, configuração cifrada, envio de texto e agenda; não tem mídia/grupo implementados. |
| [src/capture.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/capture.ts) | Normalização, dedup, direção, status/edição/exclusão e busca. Descarta grupos; precisa remodelagem. |
| [src/actions.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/actions.ts) | Preparação/claim/cancelamento/resultado incerto; contrato atual é texto individual. |
| [src/directory.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/directory.ts) | Nome normalizado, paginação, cursor, quota, aparelho e fence de geração. |
| [src/core.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/core.ts) | Erros seguros, limites de corpo, hash/cifra/IDs e SQL; confirmar parâmetros e permissões antes de copiar. |
| [src/index.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/index.ts) | Roteamento/origem, webhook e cron; webhook tem autenticação independente do login. |
| [src/identity.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/identity.ts) | Associação explícita de identidades e revisão de atribuição; não fundir nomes. |
| [src/mcp.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/mcp.ts) | Catálogo/schema e projeções tipadas; referências de consulta/ação, não API genérica. |
| [src/extraction.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/extraction.ts) | Fila/reserva, blocos, limites/retry e inferência; referência opcional, não núcleo obrigatório novo. |
| [src/memory.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/memory.ts) | Fontes, autoria, dúvida/conflito e escrita protegida; regras de relacionamento são próprias do Elo. |
| [src/operations.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/operations.ts) | Revisão/atenção/exportação/exclusão/diagnóstico; olhar limitações e cobertura de consulta. |
| [src/setup.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/setup.ts) | Configuração protegida de provedor; única tela do Elo, não interface pronta de arquivos/grupos. |
| [src/env.ts](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/src/env.ts) | Contrato de ambiente; criar nomes/recursos próprios, não reutilizar bindings operacionais. |
| [scripts/provision-access.mjs](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/scripts/provision-access.mjs) | Provisionamento retomável sem usuário transportar segredos pelo chat. |
| [scripts/restore-database.mjs](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/scripts/restore-database.mjs) | Migrações e limpeza/segurança após restore; não executar no Elo para testar novo projeto. |
| [scripts/smoke.mjs](https://github.com/orobsonn/elo/blob/ac2111ed8a89e50dcb1f995ebea5a9dd22992cd7/scripts/smoke.mjs) | Prova do endpoint/versão publicada e rotas privadas; não confundir upload com deploy ativo. |

## Testes a portar conceitualmente

| Referência | Comportamento importante | Novo caso necessário |
|---|---|---|
| `actions.test.ts` | Claim concorrente único, expiração, cancelamento, timeout, vínculo alterado | Grupo + imagem/PDF/hash/legenda e estado por participante |
| `capture.test.ts` | Replay, status antes do corpo, direção, edição/exclusão, conteúdo tardio | Grupo com vários autores, citação, mídia e namespace de ID |
| `directory.test.ts` | Paginação, homônimos, busca, quota, troca de conexão e recadastro | Grupos homônimos/renomeados e participantes sem telefone resolvido |
| `auth.test.ts`, `http.test.ts` | Autenticação/CSRF/callback, origem alternativa, refresh e epoch | Novo cliente/instalação e autorização também em download/objeto |
| `zapi.test.ts` | Request válida no workerd e redirect sem vazamento | Upload/download bounded, MIME/tamanho e destinos proibidos |
| `identity.test.ts`, `isolation.test.ts` | Não misturar identidades/fontes | Mesma pessoa em grupos distintos, caches/índices/objetos por escopo |
| `operations.test.ts`, `review-load.test.ts` | Cobertura/versionamento e custo de consultas | Retenção/arquivo distintos e busca paginada por conversa/participante/tipo |
| `extraction-blocks.test.ts` | Reserva atômica, subdivisão, contexto/evidência/versão | Se houver transcrição/resumo, não misturar autores ou processar duas vezes |
| `restore-database.test.mjs` | Recuperação isolada e ações antigas bloqueadas | Objetos/derivados/checkpoints coerentes com snapshot |

A tabela descreve testes do Elo para leitura, não asserts já aprovados no projeto novo. Criar novos testes que observem o comportamento requerido; não apenas mudar nomes de fixtures individuais para grupo.

## Documentos que economizam investigação

- `docs/implementacao/auth.md`: diferenças entre mocks e login real, claims OTP, CSP/Origin, refresh/rotação e limitações de revogação.
- `docs/implementacao/recebimento-e-memoria.md`: caminho completo do evento à memória, limitações de diagnóstico/cobertura, cota versus captura.
- `docs/implementacao/fontes-indisponiveis-1710.md`: incidente das 11 fontes e preenchimento tardio; não há recuperação mágica de mídia.
- `docs/implementacao/agenda-whatsapp.md` e prova JSON: sincronização real sem histórico, 935 contatos, quota/cursor/aparelho e esquecimento.
- `docs/implementacao/blocos-extracao-1810.md`: por que passar de chamada por mensagem para bloco; não herdar limite/LLM automaticamente.
- `docs/implementacao/homologacao-chatgpt.md` e `homologacao-skills-claude.md`: cliente real, escopo, falhas observadas e distinção de pacote instalado versus ferramenta executada.
- `docs/operacao/recuperacao.md`: manutenção/epoch externo/migrações e ensaio isolado.
- `skills/approve/SKILL.md` e `skills/configurar-elo/SKILL.md`: proposta concreta e resolução segura de agenda. São instruções, não enforcement independente da fala humana.
- `docs/demonstracoes/evidencias/verificacao-1810.json`: prova posterior de uso/entrega e limites dos vídeos; IDs internos não são token de acesso.

As versões documentais antigas podem reportar estados/cotas substituídos. Conferir data, commit e código final; não repetir no novo projeto que agenda está ausente ou o limite ainda é 50 chamadas.

## O que não levar

Não copiar diretório inteiro, configurações de conta, credenciais, IDs de recursos operacionais, URLs de webhook secretas, `fontes/privadas`, histórico de clientes, dumps/backups, fotos/screenshots de sessão, `.pi`, dependências vendorizadas ou grandes vídeos. O objetivo é carregar conhecimento útil, não acoplar instalações nem publicar dados pessoais.

O projeto do dono não possui licença raiz identificada nesta inspeção. Autoria/permissão de código próprio e de terceiros precisam ser conferidas antes de cópia literal. Esta pasta não declara o Elo open source nem transplanta sua implementação. A referência de versões de pacotes está em [dependências](../referencias/dependencias-elo.json); verificar lockfile, licenças e compatibilidade no início da implementação, sem instalar automaticamente versões antigas.
