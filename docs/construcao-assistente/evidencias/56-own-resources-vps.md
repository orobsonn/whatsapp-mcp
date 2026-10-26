# #56 — recursos próprios e preparação na VPS

26/10/2026. Registro parcial de instalação; a assistente ainda não está homologada. Complementa `56-archive-readers-vps.md`, sem transformar recurso criado ou build aprovado em piloto pronto.

## Parser isolado

O Worker novo `personal-assistant-pdf-parser` foi instalado a partir do commit `171ec55979f6f71d9aaec8754a963af3ed8aa82e`, [CI exata aprovada](https://github.com/orobsonn/whatsapp-mcp/actions/runs/40374681968). Fonte oficial `assistant/pdf-parser/index.ts`, build/deploy Wrangler, versão ativa `ec10c8ee-f223-4a7d-b77a-f00a67c4a593`. Download do módulo conferido byte a byte com o dry-run: 866.338 bytes, SHA-256 `93cf6ae9a0f1aca323b83e1c3ab376063ba862f948b621faa3885443f51318c8`.

Metadata confirmou **zero bindings**, limite `cpu_ms=100`, `workers.dev` e previews desativados, entrypoint `MediaPdfParser.admitPdf`. A rota pública do código recusa acesso. Isso comprova o isolamento configurado e o código publicado; a chamada RPC com PDF sintético pelo binding da assistente permanece pendente.

## Banco e chave de leitura

O D1 novo `personal-assistant-shadow-state` foi conferido pelo nome/UUID e schema inicialmente vazio. Aplicadas apenas as 24 migrações do mesmo commit `171ec55`, de `0001_sources.sql` a `0024_retention.sql`. Nomes aplicados e hashes dos arquivos preservados no journal privado. A migração 0025 da restauração não foi aplicada: ainda recebe correções e revisão. Nenhuma conta de orçamento foi configurada ou reiniciada e nenhum corpo de conversa foi importado por essa etapa.

`prepareBridge` criou uma chave aleatória nova em arquivos privados. Depois da comparação do baseline e ausência do nome, uma única chamada provisionou **somente** `ASSISTANT_READER_SECRET` no arquivo próprio. ACK e comparação posterior confirmaram código idêntico, bindings anteriores e configurações preservados; versão do arquivo após o secret `7f24b5f5-a97e-47be-9296-c04980f3e315`. Não se leu nenhum segredo prévio do fornecedor. Não foi provisionado `ASSISTANT_BRIDGE_SECRET`, nem adicionado `ASSISTANT_INGRESS`, portanto não se habilitou o transporte contínuo.

Arquivos0600, diretórios0700 e journals ficam em `local/assistant-build/personal-shadow-stage/`, fora do Git: `parser-171ec55-v1/`, `schema-171ec55-v1/` e `bridge-v1/`. Chave de leitura, época, gerações de conexão e valores de secrets não aparecem nesta evidência.

## Pendências de integração

`personal-assistant-shadow` ainda não foi publicado nesta etapa. Faltam migração0025 final, CI do conjunto final, Worker/DOs próprios, chamada nominal de afinidade, selo externo de retenção, saúde e cron, configuração financeira conservando o histórico, comandos MCP novos no cliente e homologação dos canais. O banco não equivale a esses gates.

Nenhum envio de WhatsApp, escrita Calendar, alteração em Access ou no Elo. **Nenhuma nova chamada paga de modelo**: o ledger do laboratório continua com US$0,049053 comprometidos, incluindo US$0,040000 antigos incertos. Custos operacionais Cloudflare destas etapas ainda não foram reconciliados com a fatura; não são declarados zero. As evidências e o teto total autorizado de US$10 continuam preservados.
