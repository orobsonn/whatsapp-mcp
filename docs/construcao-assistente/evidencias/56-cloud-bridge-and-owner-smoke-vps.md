# #46/#52/#56 — ponte contínua e serviços reais

26/10/2026. Continuação da [afinidade e gateway candidato](56-runtime-access-vps.md). Evidência parcial de instalação e integração; nenhuma issue adicional foi fechada.

## Ponte

O código do Archive continua no recorte `3f6fefafb4db0691ed8b07ff5592aa8ac6359495`, módulo SHA-256 `7218f844cf7741b4f376515b5d8f55fd74e94ffb51d4469fa56c8699c1db3635`. Um PUT de `ASSISTANT_BRIDGE_SECRET` teve ACK e leitura posterior, versão `c27abf2c-bb1a-4a78-9c19-5c01c5c9a4d3`. O valor preparado foi comparado somente em memória com as chaves da leitura nominal e do receptor; nenhum valor foi publicado.

Depois, um único upload dos mesmos bytes acrescentou `ASSISTANT_INGRESS`, serviço default → `personal-assistant-shadow/production`, versão `c69d4cce-445d-413a-b973-6d3c7c46af1d`. Foram conservados os sete tipos existentes de binding, inclusive os serviços nominais e secrets. GET posterior confirmou29 bindings exatos, código, readers, runtime, cron, rotas e domínio; sem mudança de Access/Elo. Helper privado com7 contraprovas Node e revisão independente, incluindo o prepare real.

O cron já existente do Archive realizou a entrega sem chamada manual de `deliverCaptureChanges`: observação D1 posterior confirmou cursor positivo e avanço correspondente no stream/inbox do receptor. O protocolo só avança o cursor após o recibo de sequência/hash. Os agregados privados conferem que o cursor não está à frente da origem nem do receptor; saltos de sequência não foram usados como contagem de lacunas. Nenhum corpo, chat, participante, ID ou contagem de uso pessoal foi versionado como prova.

Nesta fase o transporte é **somente de metadados**. O Worker receptor conserva `ROUTINES_ENABLED=off`, pausa ativa, sem orçamento configurado, mídia/resumos desabilitados e cron vazio. Materializar originais na D1 é uma fase separada; ligá-la pausada não autoriza episódio, modelo ou envio.

## Smoke na capability nominal e no parser

Backend instalado `2055d047eb4002d9eda6256756b5b31a4077ffd2`, versão `f4961a61-2b0a-41f0-99a7-4f758fc44d07`; três módulos, cinco namespaces, imagem, bindings, afinidade/autoridade e configuração foram conferidos antes do teste. O parser próprio `ec10c8ee-f223-4a7d-b77a-f00a67c4a593` teve novamente código, isolamento e configuração verificados por API.

**32 passos reais passaram**, em quatro sessões locais transitórias com bindings remotos `OwnerAssistant` e `MediaPdfParser`, sem deploy do operador:

- Projeto criado, repetição devolvendo o recibo conhecido e CAS antigo recusado.
- Nota sintética privada com instrução hostil inerte, armazenada e consultada como texto literal, sem executar seu conteúdo.
- Política de conversa fictícia, missão/mandato em draft e FUP sem destinatário/prazo aguardando aprovação; consulta de estados e proveniência.
- PDF de uma página aceito pelo parser remoto; entrada inválida recusada. Não houve OCR nem modelo nesse teste.
- FUP cancelado, mandato revogado, missão cancelada, política excluída e fonte retirada por último. Consulta final não liberou a fonte; recibos originais continuaram recuperáveis sem novo efeito.

O cenário deixou projeto, ledger e histórico sintéticos preservados. Cada operação teve journal anterior, observação/ACK privados e parada em resultado incerto. As9 contraprovas Node do operador são separadas dos32 passos na nuvem. As precondições externas foram conferidas pelo Root; saúde isoladamente não prova cron nem identidade de binding.

Isso comprova a capability e o parser em recursos reais. **Não comprova os novos comandos no cliente MCP autenticado**: o catálogo da conversa ainda não os expõe. A #46 e o PR125 permanecem pendentes dessa homologação. Também não comprova OCR/compreensão em PDF/imagem ou transcrição real da #52.

## Falhas de integração encontradas antes de ativar a agenda

Os metadados do Worker instalado anunciam somente `fetch`, sem `scheduled`. A investigação no gerador oficial Flue2.3.0 confirmou que o handler de `assistant/index.ts` não é propagado pelo default de `assistant/cloudflare.ts`. Cron/flags sozinhos não corrigem isso; o cron próprio continua desligado enquanto a correção e a regressão sobre o bundle oficial são produzidas. Não substituir a prova de agenda por uma chamada manual ao scheduler.

Também foi constatado que `Relations.publish` é usado apenas nos testes: a extração generativa ainda não publica candidatos canônicos no fluxo automático. O gap `canonical_relations_unpublished` continua correto. A integração estreita prevista em PRD6/#57 está em construção, com catálogo de IDs explicitamente vinculados, broker/orçamento, recibo imutável e guards finais. Cognee/Flue isolados não substituem essa etapa.

## Custos e limites

Nenhuma nova inferência paga foi feita. Orçamento/recibos históricos permanecem **49053microUSD comprometidos**, incluindo **40000 incertos**; o novo Worker ainda não tem conta de inferência. A verificação D1 própria confirmou zero novos modelos, reservas, episódios, jobs, recibos de mídia ou notificações Telegram nesse smoke. Isso não equivale a fatura Cloudflare zero.

Seguem pendentes correção/CI/deploy do handler e prova de ciclos reais, materialização pausada, integração de extração, modelos e cadeia completa, mais as homologações dos canais/clientes. Nenhum envio WhatsApp ou escrita Calendar foi habilitado. Recibos completos ficam em `local/assistant-build/personal-shadow-stage/`, privados e ignorados.
