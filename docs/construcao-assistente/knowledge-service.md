# Serviço privado de conhecimento nativo — P1

`assistant/cognee/knowledge_service.py` expõe exclusivamente o `NativeKnowledgeStore`.
Reutiliza o `CogneeBackend` fixado no projeto para abrir e fechar Ladybug/LanceDB;
não executa ingestão, extração, embeddings ou chamadas de modelo. O startup chama
`CogneeBackend.initialize()` e `NativeKnowledgeStore.initialize()`, sem importar
o manifesto nem os limites do protótipo HTTP em `server.py`.

## Processo e configuração

Rodar no ambiente Python com as dependências fixadas de `assistant/cognee`:

```sh
python assistant/cognee/knowledge_service.py \
  --root /var/lib/assistant-knowledge \
  --installation-id synthetic-install \
  --generation knowledge-v1 \
  --token-file /run/secrets/knowledge.token \
  --port 8981
```

O bind é fixo em `127.0.0.1`; a porta padrão é `8081`. O namespace é imutável no
processo: `generation` é a geração estável do espaço de conhecimento, independente
da geração operacional do bot/Source. Clientes bot, curador e MCP devem compartilhar
essa mesma configuração. Mudá-la cria outro domínio de IDs; não é procedimento
de restart ou rotação de token.

O token é um arquivo regular, sem symlink, pertencente ao UID do processo, com
permissão exata `0600`. Aceita de 32 a 256 caracteres ASCII `[A-Za-z0-9_-]`, com
uma quebra de linha final opcional. Gerar com fonte criptográfica, fora do Git e
do chat. O segredo serve apenas ao canal Own↔Cognee; não usar chave de provider,
OAuth, Z-API ou segredo de outro serviço. Rotação requer atualizar o arquivo e
reiniciar o serviço e seu cliente coordenadamente; não há endpoint de configuração.

Somente uma instância deste serviço pode abrir o mesmo root: um lease `flock`
permanece adquirido desde antes de abrir os motores até seu fechamento. O lease
protege contra outro wrapper; o servidor legado e scripts nativos não participam
dele e devem permanecer parados para esse root. Não iniciar outro writer nem
consultor nativo independente em paralelo sobre os mesmos arquivos Ladybug.

O `HTTPServer` atende uma chamada por vez no mesmo thread que inicializou os
motores, com um único event loop asyncio persistente. O backlog de conexão é 16;
health/status podem esperar uma operação em andamento. O processo não cria filas
duráveis de transporte: recibos e reconciliação pertencem ao `NativeKnowledgeStore`.
SIGTERM/SIGINT param novas chamadas após o trabalho atual, fecham os motores e
executam o flush/checkpoint do backend. O supervisor deve permitir esse fechamento;
um kill forçado exige reconciliar recibos pelo mesmo `operationId` depois do restart.

## Canal e contrato

Todas as rotas, inclusive health, exigem `Authorization: Bearer <token>`. A
comparação usa tempo constante e ocorre antes da leitura/parse do corpo ou de
qualquer trabalho nativo. Não há access log com corpos, nomes, caminhos pedidos ou
erros de dependência. Exceções não entram na resposta.

O cliente remoto precisa de TLS autenticado ou rede privada verificada terminando
no loopback. O wrapper sozinho não instala túnel/TLS nem deve ser exposto por
redirecionamento de porta pública. Não transferir chaves de modelo para a VPS;
este caminho é somente grafo. O ambiente do backend mantém os placeholders fixos
sem autoridade de inferência do projeto.

`GET /health`, autenticado, retorna:

```json
{"ok":true,"namespace":{"installationId":"synthetic-install","generation":"knowledge-v1"},"result":{"ready":true}}
```

`POST /knowledge`, com `Content-Type: application/json`, recebe:

```json
{"namespace":{"installationId":"synthetic-install","generation":"knowledge-v1"},"method":"query","input":{"entityId":"person:synthetic","limit":20}}
```

| method | input |
| --- | --- |
| `remember` | `{operationId,input:{entities,relations,origin}}` conforme `NativeKnowledgeWrite` |
| `status` | `{operationId}` |
| `query` | `{entityId?,predicate?,classification?,after?,limit?}` |
| `withdraw` | `{operationId,sourceRef:{id,revision,version,hash}}` |
| `get_entity` | `{id}` |
| `find_entities` | `{query?,kind?,after?,limit?}` |

O dispatch é explícito; não há acesso por nome arbitrário a métodos nativos. Os
objetos aceitam apenas os campos do contrato, inclusive entidades, relações,
evidências e referências aninhadas. O motor mantém as validações semânticas e de
proveniência. Namespace divergente retorna `403`; campo extra/JSON inválido retorna
`400`. Não existe SQL, URL de provider, configuração, ingestão ou administração
como ferramenta do serviço.

Sucesso sempre inclui `{ok:true,namespace,result}`. Recibos `uncertain`, `partial`
e `conflict` são resultados nativos, preservados integralmente; HTTP `200` não
transforma esses estados em conhecimento pronto. Uma exceção após tentativa de
`remember`/`withdraw` retorna `503` com `operation_uncertain`, sem repetir a
mutação. Consultar `status` com o mesmo `operationId` para reconciliar. Outras
exceções retornam `503` com `service_unavailable`. Falhas de validação e transporte
usam `{ok:false,error:<codigo_fixo>}`.

Cada chamada tem limite técnico de 262144 bytes no corpo de entrada e de 4 MiB
na resposta JSON serializada em UTF-8, compatível com o cliente TypeScript e com
o cálculo de bytes do store nativo, sem expansão de acentos em escapes ASCII. Os limites são
independentes: uma consulta pode retornar mais bytes de evidência que a escrita
de uma única fonte, inclusive os suportes completos de cada afirmação. Há timeout
de leitura inativa de 5 segundos e conexão fechada após a resposta. Não há
streaming, chunked, compressão ou `Expect`; `Content-Length` duplicado, ambíguo,
negativo ou ausente é rejeitado antes do corpo. Chaves JSON duplicadas e valores
não finitos são rejeitados. Os limites são por chamada: não há limite deste
wrapper sobre tamanho do acervo ou quantidade histórica de operações. A paginação
nativa continua obrigatória; resposta acima de 4 MiB retorna `503` com código
fixo `response_unavailable`, sem remover quotes, premissas ou grupos de suporte.
O wrapper não trunca nem inventa cursor; a paginação semântica pertence ao store.

As relações retornadas continuam candidatas. O host é responsável por SourceAccess,
revisão/retirada, permissões, resolução de entidade, origem e revalidação dos
originais antes de qualquer exposição ou ação.

## Persistência e restore

Snapshot deve ser feito com o serviço parado após fechamento normal, incluindo
**todo o root**: grafo/vetores em `system/`, metadados relacionais, `data/` e
`knowledge/<hash-do-namespace>/operations.sqlite3`, com seus eventuais arquivos
journal/WAL/SHM. O journal de conhecimento contém recibos, suportes esperados e
fences de retirada; copiar só Ladybug não preserva o contrato de idempotência.

Restaurar os arquivos coerentes no mesmo namespace e no mesmo conjunto de versões
nativas. Não restaurar/reiniciar o grafo sem o journal correspondente, não zerar
recibos para contornar operação incerta e não executar replay pago. O arquivo de
token fica fora do snapshot do conhecimento e é provisionado separadamente.

## Verificação local sem dependências nativas

```sh
python3 -m unittest discover -s assistant/cognee -p test_knowledge_service.py -v
```

A suíte usa servidor HTTP real em loopback com porta efêmera e doubles somente
na fronteira do store/backend. Cobre autenticação antes do corpo, health, namespace,
seis operações, formato/limite/framing/timeout, erro incerto sem vazamento,
exclusão do segundo writer, startup com falha, event loop persistente e shutdown
durante trabalho em andamento. Não importa Cognee, não abre grafo real e não faz
chamadas externas ou pagas. Teste nativo, restart e restore no ambiente alvo são
evidências adicionais, não uma conclusão desta suíte de transporte.
