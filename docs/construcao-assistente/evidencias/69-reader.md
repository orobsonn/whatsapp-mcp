# #69 — leitura restrita da captura

Nove testes D1 passaram e check aprovado. A classe CaptureReader extends WorkerEntrypoint expõe apenas readSnapshot e exige segredo exclusivo. Configuração ativa é resolvida pelo mesmo mecanismo criptografado do arquivo; geração bruta pending não substitui a ativa. Índice por namespace/conversa/sequence apoia o watermark.

A mesma consulta identifica privado/grupo, evitando uma segunda leitura inconsistente. Uma consulta reúne mensagem, mídia, derivado, captura e watermark da conversa. Retirada, privacidade, chat incompatível, versão divergente e material indisponível não retornam texto. Corpo acima de 32 KiB é bloqueado explicitamente, sem truncar. O retorno não contém URL de transporte, chave R2 ou credenciais. Identificador opaco e hash de mídia não concedem acesso ao arquivo.

Revisão independente sem bloqueantes. Classe real chamada localmente; o binding RPC entre Workers e a configuração real ainda serão homologados na integração. Um snapshot é observação, não autorização nem transação entre bancos. Materialização e conferência atual antes do modelo/publicação pertencem a #70 e ao controlador integrado.
