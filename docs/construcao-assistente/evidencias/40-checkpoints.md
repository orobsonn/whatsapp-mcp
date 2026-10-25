# #40 — Recuperar o índice após perda do container

O host mantém um manifesto fora do filesystem descartável, vinculado a instalação, geração, imagem, configuração, build, época do índice e fontes atuais. O processo fecha os bancos nativos, faz checkpoint do SQLite e sincroniza os arquivos antes da captura. Só confirma um snapshot após destruir a instância, restaurar em processo novo e verificar originais, chunks, vetores e proveniência. Mudança de fonte, imagem/configuração incompatível, snapshot expirado ou incompleto deixam recuperação pendente, sem índice vazio declarado pronto.

## Fronteira real na Cloudflare

[Registro sintético da execução](40-checkpoint-cloud.json). Worker isolado, versão `5ba84e2d-dd09-4b24-9b0d-0e42c12a82e5`; nenhum dado real ou envio de mensagem.

- Duas fontes foram extraídas novamente por Cognee 1.6.5 no container; busca retornou ambas com relações e hashes.
- Captura, destruição, restauração e verificação concluíram em 19,16 s. Snapshot: 2.978.146 bytes.
- Uma segunda parada explícita seguida de restauração concluiu em 13,65 s. A busca reapresentou o mesmo recibo, agora com índice confirmado; a verificação nativa de restauração já havia conferido os bancos reabertos.
- As 79 chamadas de modelo e o encargo conservador de 1819 microUSD (US$ 0,001819) ficaram iguais antes/depois das duas restaurações. Não representa fatura do provedor. O container foi parado ao final.
- O orçamento desta geração descontou todos os encargos anteriores, inclusive reservas incertas. Nenhum ledger foi resetado para realizar o teste.

## Contraprovas

68 testes TypeScript abrangem controlador, host, probe e runtime. Quinze testes Python incluem Cognee real com respostas de modelo sintéticas: fechamento dos três bancos, cópia de filesystem e abertura em processo novo, conferência de vetores de 1536 dimensões e dois originais, sem novas chamadas após restauração. Há contraprovas para perda de ACK, candidato persistido, concorrência, timeout, mudança de fonte, fingerprint, proveniência/vetores ausentes, expiração e limite diário de capturas.

O root revisou a fronteira de captura/restore e homologou a sequência completa no serviço real. Manifesto confirmado anterior é preservado quando uma captura nova falha; captura incerta não é repetida automaticamente. Snapshot tem validade limitada e restauração renova a referência observada; não é backup permanente.

## Limites e continuação

Esta entrega prova recuperação de snapshot, não reconstrução universal. A #91 cobre materialização em índice novo usando somente recibos completos existentes e expõe divergência ou falta de cache. Índice atual tem capacidade limitada; versões obsoletas podem exigir reconstrução. Persistência dos jobs/recibos canônicos continua no D1. Não demonstra qualidade estatística, volume real, integração completa Flue/Telegram nem prontidão do piloto.

O diff ultrapassa o alvo de 400 linhas porque captura consistente exige controlador, exclusão do host, fechamento de bancos Python, identidade do build e prova de restauração na mesma fronteira. Rebuild e operação de agentes permanecem em issues separadas.
