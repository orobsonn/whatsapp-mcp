# #38 — relações e afirmações atribuídas

Contrato de publicação de candidatos com fonte/revisão/versão/hash, citação literal e IDs canônicos. Autor vem da fonte, separado da pessoa mencionada. Assertion, suggestion, decision e observation continuam categorias atribuídas: nenhuma altera missão, ACL, mandato ou recibo. A publicação inteira usa uma INSERT SELECT com validação de fonte atual e todas as referências, sem lote parcialmente aceito.

Oito testes D1 passaram. Testes cobrem homônimos, IDs desconhecidos/de outro namespace, citação ausente, campos administrativos, correção anterior ao commit, retirada, leitura privada, idempotência e entrada mutada após a chamada. Citação comprova localização; não comprova verdade nem interpretação perfeita. A extração generativa será testada na integração do motor/linguagem.

Revisão adversarial encontrou leitura sem limite de lotes. A consulta agora lê no máximo 17 para detectar excesso de 16, além do limite de 64 KiB agregado; excesso retorna relation_scope_too_large, sem truncamento silencioso. O teste específico comprova essa lacuna explícita. O fence acompanha candidatos e precisa ser validado pelo controlador antes de consumo/publicação.

Retenção #55 deverá remover essas projeções/citações antes de apagar versões referenciadas; não basta limpar o corpo original. Sem deploy nem chamada paga.
