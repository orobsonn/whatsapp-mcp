# Corrigir finalização precoce e downloads recuperáveis

Pedido do dono em 03/11: investigar e corrigir as 197 fontes pendentes e 28 mídias com falha, retomando o recuperável. Sem suporte novo a vídeo/HEIC ou aumento arbitrário de limites.

Evidência: o agente recebeu100, confirmou59, avançou cursor e confirmou10; finish aceitou mesmo com156pending+41presented. As28 URLs ainda respondem200:13JPEG truncados (load estrito falha),1JPEG completo com dados apósEOI,1JPEG declaradoPNG,2JPEG acima2MiB,8HEIC,3MOV acima20MiB. Dados/bytes reais ficam foraGit.

1. Reproduzir confirmação parcial da página e finalização prematura; gate do host antes de finish/notificação. Retorno tipado continue_required aponta menor sequência pendente autorizada. Wrapper não marca efeito concluído. Reusar hook Flue existente, com um lembrete, sem scheduler novo.
2. Usar identificação JPEG estrutural compartilhada para aceitar EOI válido seguido de metadados sem aceitar truncamento. Download recebido pode usar MIME real entre imagens já suportadas; upload continua estrito. Documento de MIME imagem vira imagem, nãoPDF. Testes com fixtures sintéticas representando somente casos reais.
3. Publicar patch, reabrir apenas duas mídias recuperáveis por nova versão e guards exatos. Não zerar tentativas/alterar arquivos prontos. Retomar197 na mesma revisão/sessão via mecanismo explícito existente e recibo predecessor; acompanhar efeitos reais sem duplicar operação incerta ou aviso.
4. Confirmar recibos: revisão realizada ou pendências externas explícitas; mídias prontas somente apósdownload/hash. Os26 casos de arquivo truncado/formato não suportado/limite continuam registrados, sem descarte parazerarcontador.

Adversarial confirmou caminho mínimo e exigiu cursor menor pendente, gate sem efeitos, ausência de corpo classificada com guards, EOI apósSOS (não busca emEXIF), preservar filename recebido, versões/leases/captura na recuperação e não prometer conclusão somente pelo hook.
