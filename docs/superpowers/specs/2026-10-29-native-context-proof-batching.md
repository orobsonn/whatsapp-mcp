# Provas de contexto em lote — complemento de engenharia

Data:29/10/2026. Escopo: dimensionamento já aprovado do contexto nativo; não muda identidade de conversa, poderes, modo de envio ou MCP. Revisão adversarial concluída antes de implementar; as condições abaixo incorporam seus ajustes.

## Evidência e finalidade

Dezenove verificações reais dos mesmos166 fences de origem terminaram correntes em7515–32598ms. A implementação faz aproximadamente2N consultas Own eN RPCs Source por assertion; o mesmo trabalho reaparece em abertura de contexto, ferramentas e publicação.

Isso é custo estrutural comprovado. A causa da falha anterior `conversation_context_unavailable` permanece desconhecida. Não atribuir a mudança a quota nem anunciar que ela corrige uma causa física ainda não reproduzida. SDK/recibos antigos não serão reabertos ou redisparados para medir desempenho.

## Decisão

1. Compartilhar a normalização estrita do snapshot e seu digest entre Origin e Source. Preservar exatamente ordem/omissão de campos, null, limites e hash de `[sourceVersion ?? null, access, content]`. Não introduzir ordenação alfabética ou equiparar sourceVersion à revisão canônica Own.
2. Acrescentar RPC privado `CaptureReader.readSnapshotProofs`, autenticado como o leitor existente, para uma página de até64 referências. A página é unidade de execução/bytes, não limite do acervo. A entrada contém identidade de fonte; nenhum hash esperado é recebido ou devolvido por eco.
3. Usar as mesmas consultas/projeções do snapshot singular em `D1.batch`, com resolução de configuração compartilhada. O lote devolve identidade completa, estado/motivo fechado, hash recém-computado e metadados necessários; não devolve corpos de mensagens/documentos.
4. Após consultas e hashes, comprovar que a configuração dinâmica Source continua vigente: `runtimeConnectionGuard` capturado e SQL final sobre versão/cifra/estado, ou segunda resolução total por lote. `assertActive` repetido na mesma cópia de env não comprova rotação/desativação.
5. Own confere fences em consulta set-based antes/depois do RPC, mantendo o predicado de acesso e o mapper atuais. Projetar canonical_id explicitamente para mapear resultados. Não confiar na posição: identidade completa deve corresponder ao esperado; duplicados, ausentes, extras, estados bloqueados e erros impedem `current`.
6. Retenção continua paginada e confere o predicado final sobre **todas** as dependências. Cancelamento é conferido entre awaits e antes de nova página; resposta tardia não publica nem inicia trabalho novo. Falha de transporte/protocolo não é prova de retirada e não deve provocar purga por si.
7. Fallback singular apenas para adapter comprovadamente sem a capacidade. Não repetir o caminho singular depois de timeout, erro ou resultado parcial do lote. Proxy RPC pode aparentar ter método sem a versão remota o implementar; rollout e readback Source precedem Own.

`readSnapshot()` singular conserva formato/comportamento. A mudança não autoriza escrita no Source, SQL livre no MCP, indexação de novas conversas ou acesso de terceiros. Restore/hold e origem/geração permanecem vigentes. Não há cache de autorização entre operações.

## Fronteiras e dimensionamento

Manter limite pré-parser de bytes por snapshot e limite de entrada/saída do envelope agregado. Materializar64 originais ainda consome memória/CPU no Source; medir antes de afirmar capacidade. `D1.batch(64)` reduz viagens, mas não transforma64 consultas em uma nem zera cobrança de leitura. O ganho esperado é reduzir RPCs e roundtrips, preservando trabalho proporcional ao acervo.

O prazo do lote deve considerar medição real; não supor que um lote de64 fontes cabe automaticamente no prazo de uma fonte. Usar páginas menores como mecanismo operacional, sem excluir fontes ou declarar cobertura completa de resultado parcial.

## Implementação e provas necessárias

- [x] Extrair contrato/normalizador compartilhado e comprovar digest idêntico ao caminho atual: campos opcionais/null, todos os kinds, derivados, legenda, limite de bytes e versões distintas.
- [x] Compartilhar projeção/consulta do leitor Source; implementar batch autenticado/hash-only, com configuração desativada/rotacionada durante o hash bloqueando a prova.
- [x] Implementar fences Own set-based e correspondência explícita; respostas reordenadas, duplicadas, ausentes ou extras não podem produzir prova corrente indevida.
- [x] Integrar ao scan de retenção sem mudar purga, recibos, sessões ou autoridade; testar retirada da primeira fonte durante o último lote e cancelamento sem purga/publicação tardia.
- [x] Tipos/build e testes dirigidos; revisão adversarial do diff. Não repetir suítes pesadas sem mudança/falha nova.
- [x] Verificar a base Source publicada e preservar trabalho/configuração mais recentes. Publicar Source primeiro com bindings existentes e readback da capacidade; publicar Own depois, sem ampliar superfície pública.
- [x] Comparar os mesmos166 fences na Cloudflare: resultado, duração e número de RPCs, sem nova inferência nem conteúdo nos logs. Registrar CPU/memória quando disponíveis e não transformar ausência de métrica em custo zero.

Uma passagem diária efetivamente concluída e o envio WhatsApp após aprovação real continuam critérios separados. O aviso de interrupção já aceito não substitui esses critérios.
