# Crescimento e recuperação do grafo nativo

30/10/2026. Ensaio real no serviço sintético da VPS, separado do serviço pessoal, sem modelo, embeddings ou extração. O objetivo foi atravessar as antigas cardinalidades64/128/256 e conferir dados após reabertura/restauração. As302operações planejadas têm fontes, relações e IDs próprios; nenhuma mensagem foi enviada pelo WhatsApp ou Telegram nesse ensaio.

## Defeitos encontrados

Ladybug0.19.0, dependência Linux do Cognee1.6.5, deixou a operação62 incompleta: cinco nós com proveniência, nenhuma aresta. O recibo permaneceuuncertain. Na continuação, o processo caiu comSIGSEGV dentro de `_lbug`; após reinício, a operação127 foi consultada pelo mesmo ID e permaneceuuncertain. Não se repetiram essas mutações nem se reclassificou resultado sem prova.

Um processo novo com uma thread efetiva, mesmas entradas/ordem e cópia exclusiva de baseline fechado reproduziu a falha após62ready/1uncertain, ao tentar63. Kernel e ausência do processo confirmaram o término; SSH255 sozinho não foi tratado como prova. A baseline original e os estados incertos continuam preservados. O canário preventivo descrito abaixo não reparou as operações62/127 do original.

## Correção medida em cópias

Ladybug0.22.1, mantendo Cognee1.6.5, duas threads e demais parâmetros, completou302/302ready. A reabertura conferiu302relações,604entidades,302fontes, suportes, evidências, citações/hashes e302recibos. Nove páginas de37 preservaram o conjunto inteiro. A cópia fechada restaurada foi servida de fato na porta sintética e consultada pela Cloudflare: nove páginas, manifesto integralmente igual. Supervisor externo ao processo nativo restaurou o serviço sintético original; PID do serviço pessoal permaneceu igual. Nenhum banco convertido foi aberto pela versão antiga.

O contrato nativo completo encontrou outro problema: na configuração64MiB, o corpus acumulado com evidências longas esgotou o pool, retornando `Buffer manager exception: Unable to allocate memory`. O caso isolado passava; o conjunto completo preservado permitiu diagnosticar a falha. Com128MiB, o contrato completo passou em53s, inclusive processos independentes, retirada, temporalidade, origens e paginação por bytes. Executado com rede desabilitada. Pico RSS medido de processo filho:625266688bytes. O esgotamento tratado em0.22.1 e oSIGSEGV em0.19 são resultados distintos, sem atribuição a uma correção upstream específica.

## Dependências e instalação

Cognee1.6.5 declara Ladybug0.19.0 no Linux; não se afirma suporte upstream à combinação nova. O serviço nativo usa um override explícito e testado da aplicação, mantendo a metadata original. `install_native_environment.py` cria somente destino novo, instala as dependências originais com hashes e sem isolamento de build, aplica o único overlay de `native-overrides.lock` e verifica versões/caminhos do módulo nativo. Pip24.0 também é fixado por hash. Execução isolada e limpeza dos destinos pip/Python herdados evitam instalar no ambiente antigo.

`check_native_environment.py` aceita exatamente a divergência conhecida Cognee/Ladybug; qualquer outra incompatibilidade ou erro reprova. Não altera wheel nem apresenta `pip check` como livre de divergências. A nova instalação real terminou com essa verificação aprovada; ambiente antigo e serviço pessoal ainda preservados nessa etapa. Os174pacotes do lock original coincidiam com o ambiente do canário, sem substituições além do Ladybug.

A memória de execução passa a128MiB; tamanho de banco, páginas e conteúdo permanecem iguais. A imagem legada mantém seu lock original; este overlay pertence à instalação separada do serviço nativo. Nenhuma infraestrutura nova foi contratada ou ativada.

## Pendência antes da promoção pessoal

Comparar o manifesto completo de uma cópia fechada das seis relações pessoais e seus recibos no ambiente novo. Só depois promover o serviço com backup anterior preservado, conferir a leitura pelo MCP e documentar o resultado. Esta evidência não fecha a issue146 nem substitui a validação humana do envio aprovado.
