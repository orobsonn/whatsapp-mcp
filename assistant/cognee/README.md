# Serviço Cognee restrito — issue #39

Índice derivado, por instalação/geração, em um Container Linux amd64. Cognee **1.6.5**, Ladybug e LanceDB nativos. Estado canônico, ACL, mandatos, orçamento e credenciais ficam no Worker. A porta 8080 é privada e só pode ser alcançada pelo Durable Object autenticado; este servidor não é uma API pública nem inclui autenticação de canal.

O host inicia com `ASSISTANT_INSTALLATION_ID` e `ASSISTANT_GENERATION`, sem propagar seu ambiente. Modelos usam exclusivamente `http://broker.internal/v1`, com chave-placeholder sem autoridade. O host bloqueia rede externa e injeta a autorização de inferência no interceptador do broker. O Container não escolhe esse permit. A URL/modelos são constantes no código; payloads não aceitam URL, SQL, caminho ou ferramentas.

## Contrato HTTP

`GET /health` retorna `{ready,poisoned,busy,cognee,namespace,mode:"shadow"}`.

Demais rotas usam POST/JSON estrito. Sucesso: `{ok:true,result}`. Falha: `{ok:false,error:"codigo_constante"}`; sem erro original do provedor.

| Rota | Entrada | Resultado |
| --- | --- | --- |
| `/ingest` | `{operationId,source:{id,version,hash,text,occurredAt,authorId?,projectId?}}` | `{id,version,hash,state:"completed",chunks,relations,nodes,edges}` |
| `/search` | `{operationId,query,allowedSources:[{id,version,hash}],limit}` | `{candidates:[{id,version,hash,via:["chunks"|"graph"],relationCount}],missing:[{id,version,hash}]}` |
| `/inspect-source` | `{id,version}` | `{state,source}` ou `{state:"not_found"}`; original/hash conferidos, não é prova de aplicação canônica |
| `/operation` | `{operationId}` | `{state,payloadHash,result?}` ou `{state:"not_found"}` |

IDs opacos ASCII até 128 caracteres, versões inteiras 1–2147483647, texto original até 32768 bytes UTF-8, hash SHA256 exato do original, corpo/resposta até 65536 bytes, consulta até 2048 bytes, pacote permitido até64 referências distintas e limite1–10. Namespace é fixado no boot, sem override no pedido. Há no máximo128 versões indexadas e256 IDs de operação por instância; a capacidade é explícita e não implica benchmark nessa escala.

Um loop asyncio e um lock serializam pipelines. Health, operação e inspeção permanecem observáveis durante a execução. Payload igual com outro `operationId` não chama novamente o motor. Payload alterado sob o mesmo ID conflita; fonte/versão é imutável. Operação incerta não é repetida. Após erro/timeout ou interrupção de ingestão, o índice fica `poisoned`/não pronto até restore/rebuild explícito (#40); não existe rollback fictício. Erro de busca mantém apenas sua operação incerta.

Buscas conferem as referências concluídas e a presença de chunks reais antes da inferência. Qualquer referência ausente produz pacote vazio com `missing`, sem embedding. Chunk scoring nativo por IDs permitidos ocorre antes de top-k; a lane de relações usa proveniência nativa filtrada por referências exatas antes da pontuação e ordena conexões deterministicamente. Não há ranking semântico global do grafo. O resultado contém referências, não texto do grafo. O host deve reler a fonte e seus fences antes de entregar qualquer contexto. `completed` descreve somente ingestão no índice derivado.

A revisão local do índice entra na chave de busca: outro ID pode refazer uma busca antes incompleta após ingestão nova. Reutilizar um ID antigo após avanço da revisão pode conflitar; `/operation` permite recuperar seu recibo antigo. O host invalida contexto ao mudar revisão canônica/de indexação.

## Verificação local

```sh
docker build --platform linux/amd64 -t assistant-cognee:issue39 assistant/cognee
docker run --rm --platform linux/amd64 --network none \
  --add-host broker.internal:127.0.0.1 \
  --mount type=bind,src="$(pwd)/assistant/cognee",dst=/tests,readonly \
  --env PYTHONPATH=/app assistant-cognee:issue39 \
  python -m unittest discover -s /tests -p 'test_*.py'
```

O teste integrado executa Cognee/Ladybug/LanceDB reais, com respostas HTTP sintéticas determinísticas de LLM/embeddings no loopback. Usa pipeline e scoring de vetores nativos, não semeia o grafo, não usa fontes antigas do laboratório e não mede qualidade semântica. Não requer chave nem API paga. O Dockerfile verifica hashes das dependências e das ferramentas de build; tokenizers são baixados somente no build. Nenhum segredo deve ser fornecido ao build ou ao teste.

Cognee compartilha chunks por hash do conteúdo. O envelope contém fonte/versão/hash e os chunks carregam metadata de origem, mas isso não prova recall completo nem isolamento físico de cada chunk. O índice permanece descartável: IDs candidatos precisam de validação canônica no host; escalabilidade além do pequeno corpus exercitado e checkpoint/restore pertencem às próximas entregas.
