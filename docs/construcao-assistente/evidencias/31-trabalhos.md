# #31 — missões, FUPs e trabalhos

Seis testes D1 RED→GREEN e check aprovados. Quatro tabelas separam missão, FUP versionado, ocorrência e job. FUP pode existir sem missão; ocorrência única por FUP/versão/data; job tem dedupe, lease e tentativa próprios. Consulta limitada executada com EXPLAIN confirmando índice de vencidos.

Revisão adversarial sem bloqueantes no DDL. Conclusão simulada não fecha compromisso real. Controladores posteriores devem escolher versão vigente, invalidar ocorrências antigas, conferir fonte/mandato e validar fuso/janela. Schema armazena esses campos, sem executar rotina ou provar autorização. Sem migração em produção.
