# #114 — reader binário restrito

## Entrega local

`CaptureMediaReader.readBoundedMedia` é exportado nominalmente pelo Worker do arquivo. Recebe somente segredo, namespace/chat/mídia e versões/hash esperados; não recebe URL, object key, SQL, papel ou ferramentas. Reusa `ASSISTANT_READER_SECRET` e a função de snapshot extraída de #69, sem copiar as regras de acesso. Nenhuma configuração/binding cloud foi ativada.

Snapshot corrente antes/depois de R2 exige mídia disponível, captura/privacidade, mensagem/versões e hash atuais. A comparação integral também inclui o watermark da conversa: até outra mensagem recebida durante a leitura bloqueia conservadoramente. `readMedia` verifica objeto/tamanho/SHA e a mesma versão; seu novo argumento opcional de cap é host-only, inteiro positivo, usado na admissão e no consumo do stream, sempre limitado pelo teto do tipo. O padrão dos chamadores existentes foi preservado.

Somente imagem PNG/JPEG/WebP ou PDF declarado, com tamanho positivo até 2 MiB. O sucesso contém envelope literal e Uint8Array, sem nome de arquivo, autor, URL, object key ou segredo. Falha/retirada não contém bytes; exceções de armazenamento viram código fixo. A função não chama AI, downloader, transcrição ou escrita no arquivo.

## TDD e verificação

- RED inicial observado: 18 testes falharam por ausência do export nominal e do cap opcional efetivo. Log local `/tmp/assistant114-red.txt`.
- Primeira implementação: 26/27 passaram com #69; a fixture restante alterava chat.name, que não gera watermark. A contraprova foi corrigida para inserir outra mensagem real no mesmo chat; não houve mudança de produção para esse caso.
- Dirigido: 69/69 passaram em reader binário, #69, mídia e transcrição. Foram acrescentadas contraprovas de áudio disponível, corrupção com mesmo tamanho, D1 indisponível e cap maior incapaz de elevar o limite do tipo. Reader final: 21 casos.
- Final: `npm test`, 45 arquivos e **683/683 testes**, exit 0; `npm run check`, exit 0; `git diff --check` limpo. Logs locais `/tmp/assistant114-full.txt` e `/tmp/assistant114-check.txt`.
- O runner apresentou avisos de sourcemap/depreciação de dependências e uma mensagem interna workerd `broken.inputGateBroken`; Vitest terminou sem testes falhos ou relatório de erro não tratado. Não foi atribuída causa a essa mensagem.

D1/R2 locais reais, com suspensão somente na fronteira get/stream de R2 para alterar estado durante o await. Casos: segredo/config/ns incorretos; propriedades extras; refs/versões/hash/chat divergentes; tipos/tamanhos não admitidos; limite exato 2 MiB; objeto maior/corrompido/ausente; cancelamento de stream excedente; privacy/capture/version/delete/watermark durante leitura; entrada mutada depois da chamada; manutenção/owner ausente; erro D1/R2; geração ativa resolvida do banco criptografado e conexão retirada durante leitura. Regressões #69 e consumidores antigos de readMedia preservadas.

## Limites e integração

Transporte não comprova decodificação, legibilidade, OCR, contagem de páginas nem compreensão. Fixtures que declaram JPEG/WebP/PDF exercitam somente o contrato binário; não são prova semântica. Parser e admissão real antes de inferência pertencem a #52.

Classe real executada localmente; o novo binding RPC entre Workers ainda precisa de homologação na integração. O chamador continua responsável por SourceAccess/OriginGuard/purpose e revalidação antes do modelo/publicação. Snapshot é observação e não garante revogação instantânea entre Workers após o retorno. Nenhum modelo pago, recurso, segredo, deploy, commit ou envio foi realizado pelo implementador.

O diff da extração de #69 contém movimentação/dedentação do corpo existente, além de trocar this.env pelo argumento rawEnv; SQL e regras permanecem compartilhados. Revisão independente e release ficam com o coordenador.

## Revisão independente

O revisor adversarial independente conferiu o diff e as contraprovas sem achado acionável. O coordenador repetiu reader binário + #69: 30/30 testes passaram (`/tmp/assistant114-root-tests.txt`). A homologação RPC cloud, decodificação e interpretação continuam no escopo de #52/#56. CI do commit ainda será conferida antes do merge.
