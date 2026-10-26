# #52 — contexto de mídia com original preservado

Implementação local em 26/10/2026. Sem chamada a modelo real, deploy, ativação de canal ou leitura de WhatsApp real nesta entrega. A homologação de qualidade/custo e dos limites do parser na Cloudflare permanece com a sessão principal; os testes abaixo não a substituem.

## Contrato entregue

- `MediaContext.interpret(actor, canonicalId)` recebe identidade do host e ID canônico. Texto/modelo não escolhe ator, namespace, URL, object key ou função de ação.
- Áudio: reutiliza fonte `derivative` / `transcript` já materializada. Ausência de transcrição permanece pendência. Não dispara ASR novo nem afirma duração aferida nos bytes.
- Imagem/PDF: uma mídia capturada por operação, até 2MiB, reader nominal #114, versões de mensagem/mídia, hash dos bytes e watermark conferidos novamente no receptor.
- PNG/JPEG/WebP: cabeçalhos estruturais e dimensões até4096 por eixo/12MP. Isto não equivale a decodificação completa da imagem. WebP animado indicado pelo cabeçalho é rejeitado.
- PDF: somente serviço nominal `MediaPdfParser.admitPdf({bytes})`, separado do Worker principal. Parser real pdf-lib1.17.1, 1–4páginas; criptografia, erro, resposta inválida ou indisponibilidade resultam em pendência antes de qualquer reserva/modelo.
- Saída: observações, texto literal e cobertura por página, até32KiB, schema estrito, 2048tokens de saída. Recusa/incomplete/truncamento/schema inválido não publica leitura parcial como resultado completo. Páginas ilegíveis aparecem na cobertura mesmo com recibo concluído.

## Parser e isolamento de recurso

`assistant/pdf-parser/wrangler.jsonc` é configuração separada, sem DB/R2/segredos/bindings; HTTP público retorna403. LimiteCPU100ms configurado, sujeito ao comportamento documentado de burst/enforcement da plataforma. Memória128MiB é limite por isolate, compartilhado entre suas requisições concorrentes; não é quota por arquivo. O timer5s do chamador limita espera cooperativa, não interrompe CPU síncrona.

O host persiste claim `parsing` antes do RPC. Um crash/timeout/erro não abre outra tentativa automática do mesmo original/configuração. O Worker do parser pode perder disponibilidade diante de PDF hostil; o host não faz fallback de `PDFDocument.load` em seu próprio isolate.

Contraexemplo benigno usado no RED: PDF com8613bytes comprimidos e ObjStm/N0 que expande8MiB. O parser antigo no host retornava1página depois de expandir. O novo contrato exige o binding, e falha de recurso deixa pendência durável, zero reserva e zero chamada ao modelo. Não foi executado teste capaz de esgotar memória do computador. A chamada RPC entre dois Workers locais admitiu PDF textual2p, escaneado2p e o contraexemplo1p; isto prova o contrato RPC, **não** enforcementCPU na Cloudflare.

## Orçamento e recibos

Sem count API, Files API, URL externa ou Container. Responses fixo `gpt-6-luna`, `service_tier:default`, `reasoning:none`, `store:false`, sem tools, arquivos inline pelo host. Request até4MiB, resposta até256KiB, timeout45s, sem retry automático.

Reserva conservadora530000microUSD sob #37 antes da tentativa. Modelo/contexto, admissão e tarifa superior são versionados no configHash. A documentação consultada informa contexto1,05M, máximo de entrada922000tokens. A tarifa superior escolhida é US$0,50/Mentrada eUS$1,00/Msaída; cobre também o preço publicado para prompt longo no tierStandard. `actual_units` guarda uso observado precificado por essa tarifa superior, não uma fatura do fornecedor. Não se deve chamar esse número de cobrança exata.

Chave dedup inclui namespace, pai id/revision/version/hash, blobHash e configHash; requestHash fixa o payload. Estados `parsing → prepared → attempting → response_ready → complete`, com `blocked/uncertain` preservados. ReservaCAS e admissãoCAS+SourceAccess.guard precedem a única chamada. ACK perdido na admissão não autoriza rede; timeout/uso desconhecido retém o teto. Uso conhecido é liquidado mesmo se a origem foi retirada. ACK perdido na liquidação/publicação recupera recibo/artefato, sem nova inferência.

## Evidência dependente e contexto

A migração0020 mantém recibos e artefatos no D1 do assistente. O artefato é imutável e aponta para o original, sem ACL independente, sem modificar original/hash e sem virar nova fonte autônoma. Publicação usa INSERTSELECT com SourceAccess.guard na mesma mutação; leitura/cache-hit exige pai e origem atuais. Revalidação entre Workers não promete revogação instantânea ou retirada do corpo já enviado ao modelo.

- #100: texto derivado participa do score lexical; refs/hash/config/blob entram no fingerprint. Chegada de artefato invalida SearchFence anterior. OCR não entra automaticamente no Cognee: cobertura contém `media_semantic_unsearched`.
- #42: conserva o original integral, copia o anexo, valida hash/parent e soma seu payload ao cap. Não substitui o JSON original por OCR sob o mesmo hash.
- #44: compara anexo com artefato canônico antes do binding; mensagem do episódio inclui anexo como extração de modelo. Citação original continua compatível. Citação derivada exige `media:{id,hash,configHash}`, onde `hash=textHash` do derivado, mais pai original id/revision/version/hash exatos. Quote deve existir no derivado. O host carimba `attribution:model_extraction`; não atribui OCR como fala humana literal nem fato verificado. Referência errada não cai em fallback de citação original.
- Retirada/ACL/configuração nova/fingerprint novo bloqueiam callback/publicação através das fences existentes. Nenhum poder de WhatsApp/Calendar/Telegram/administração foi acrescentado.

## Validação local

Testes novos em `tests/assistant-media.test.ts`: arquivos e limites; parser criptografado/malformado; PNG/JPEG/WebP sintéticos; schema/cobertura; reserva zero; concorrência; timeout e ausência de retry; ACK de liquidação/publicação; retirada durante inferência; privacidade antes da rede e em cache; bytes corruptos; correção de pai; transcrição existente com negação; busca só no derivado; invalidação de busca; citação OCR-only, referência ausente/forjada e retirada após callback; falha de recurso do parser durável antes de custo.

Resultado final após a correção adversarial: check sem erros; suíte719/719 em46arquivos; runtime39/39 em2arquivos; buildsroot/assistente/parser verdes; diffcheck limpo. A suíte emite warnings de sourcemapSDK e erro interno workerd em cenário existente, com exit0 e todos os casos aprovados. Contraprova independente30/30, incluindo revogação pré-rede, revogação no cache e artefato forjado com hash recomputado.

Comandos de verificação:

```sh
npm run check
npm test
npm run test:assistant-runtime
npm run build
npm run build:assistant
npx wrangler deploy --dry-run --config assistant/pdf-parser/wrangler.jsonc --outdir /tmp/media52-parser-build
```

Fixtures provam protocolo, recuperação e autorização. Não provam OCR/compreensão em imagem/PDF real, qualidade de nova transcrição, custo faturado nem disponibilidade diante de todo PDF comprimido. O pacote do parser em dry-run tem aproximadamente836KiB, gzip217KiB, sem bindings. Nenhum binding cloud é ativado por estes arquivos.

## Revisão adversarial final

O revisor independente encontrou P1 reproduzível: revogar um mandato durante o await da checagem de origem ainda permitia enviar bytes ao modelo ou liberar o cache, pois a ACL local era checada somente antes do await. A correção repete SourceAccess.revalidate com relógio atual **depois** da checagem remota, antes do efeito/retorno. Duas regressões reais com mandato versionado e readSnapshot ficaram RED antes e GREEN depois. A contraprova independente de artefato forjado com texto+hash recomputados também foi barrada pela comparação canônica no prepare44.

A revisão não transforma validação local em prova de OCR ou enforcementCPU cloud. A sessão principal ainda precisa executar essas homologações isoladas.

## Próxima prova isolada

Plano e fixtures sintéticos preparados somente em `/tmp/assistant52-cloud-probe-plan.md` e `/tmp/assistant52-cloud/` para a sessão principal: R2/D1 de captura descartáveis, readers reais #69/#114, bridge/materializador reais, PNG/JPEG/WebP com negação/condição/instrução hostil citada, PDF textual e PDF composto só de imagens, gold separado. Não versionar segredos ou material real. Compor o Worker de validação privado existente, preservar reservas anteriores e elevar apenas o cap autorizado se necessário. Exigir repetição sem chamada nova e retirada durante rede sem liberar evidência.

## Fontes primárias

- [GPT-6Luna: contexto, modalidades e preço](https://developers.openai.com/api/docs/models/gpt-6-luna).
- [Responses: arquivos inline](https://developers.openai.com/api/docs/guides/file-inputs).
- [PDFDocument: parser real e contagem de páginas](https://pdf-lib.js.org/docs/api/classes/pdfdocument).
- [Cloudflare: memória por isolate e limitesCPU](https://developers.cloudflare.com/workers/platform/limits/).
- [Cloudflare: serviços separados e RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
