# #39 — Container Python: evidência parcial

Registro da primeira etapa local. A integração posterior está em [runtime39](39-runtime.md), com homologação cloud e API real; as medições abaixo continuam sendo da etapa Python controlada. Detalhes executáveis: [README do serviço](../../../assistant/cognee/README.md); hashes e resultado controlado: [JSON desta evidência](39-cognee-python.json).

- Docker Linux amd64, Python/base por digest; Cognee1.6.5 e dependências transitivas com hashes. Ferramentas de build também fixadas; build de fontes sem instalar dependências implícitas. Tokenizers preparados no build, execução sem rede externa. Imagem local aproximadamente1,60GB; não é medição de RAM nem limite de custo cloud.
- RED registrado antes do servidor existir; GREEN final: **11 testes Python**, incluindo Cognee/Ladybug/LanceDB reais; `npm run check` passou. O teste usa dois originais sintéticos novos nas versões47/48, LLM/embeddings HTTP determinísticos e armazenamento nativo. Não reutiliza grafo/resultados da rodada5 nem demonstra qualidade semântica.
- Original/hash, provenance de relações, IDs opacos/versões reais, rejeição estrita, conflito, uncertain sem replay, lock/poll, poison após falha mutável, persistência da quarentena, resposta de erro constante e replay com outro job ID foram exercitados. O broker devolveu somente o JSON mínimo acordado; Cognee aceitou.
- Contraste real de vetores controlados: top1 global escolheu o chunk privado mais próximo. Scoring nativo restrito por IDs permitidos antes de top-k recuperou a fonte permitida com seu hash. Outro teste acrescentou1000 relações privadas e demonstrou que não alteram contagem/ranking permitido. A lane de relações contém apenas provenance permitida, ordenada deterministicamente; não anunciamos busca semântica global de grafo.

## Fronteira do aceite

| Critério | Evidência nesta parte | Ainda pendente |
| --- | --- | --- |
| ac8.131 | Container local real ingere originais e consulta candidatos com relações provenientes | integração Worker/DO e configuração cloud isolada |
| ac8.132 | inspeção confere original e SHA256 | host relê canônico antes de liberar contexto |
| ac8.133 | imagem recebe URL fixa/placeholder; nenhum segredo de canal foi usado | provar whitelist do ambiente no host real |
| ac8.134 | outro operation/job ID com payload igual não reingere nem chama modelo no mesmo índice | idempotência/orçamento persistentes no broker mesmo após perda do Container |
| ac8.135 | erro do stub upstream vira resposta constante, sem corpo original | manter regra no adaptador/host integrado |

O índice guarda até128 versões e256 IDs de operação por instância: precisa retenção/rebuild da #40 para uso contínuo. Depois de falha de ingestão, `/health` fica não pronto/poisoned, e novas ingestões/buscas param até restore/rebuild explícito; `/operation` e `/inspect-source` mostram estado sem alegar aplicação atômica canônica. A ausência de fonte no manifesto ou no snapshot real retorna `missing` e candidatos vazios, sem embedding. Nenhum requisito foi removido: a integração restante continua na #39 e a recuperação/retention é #40.

APIs consultadas: [Cognee1.6.5](https://pypi.org/project/cognee/1.6.5/), [DataItem literal_text/external_metadata](https://github.com/topoteretes/cognee/blob/v1.6.5/cognee/tasks/ingestion/data_item.py), [DocumentChunk e metadata](https://github.com/topoteretes/cognee/blob/v1.6.5/cognee/modules/chunking/models/DocumentChunk.py), [API direta de Containers](https://developers.cloudflare.com/containers/api/durable-object-container/). As referências orientam implementação; os testes novos acima são a prova local.

Revisão do coordenador: 11 testes passaram após reconstruir a imagem. A contraprova de ValueError do backend exigiu classificação como operation_failed (500), em vez de invalid_input (400); a lista de erros permitidos já impedia exposição do texto externo. Não se atribui vazamento a essa contraprova. Hashes e imagem atualizados no JSON.
