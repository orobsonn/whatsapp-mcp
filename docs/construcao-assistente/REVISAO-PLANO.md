# Revisão adversarial da construção — 25/10/2026

Revisor independente `build_adversary`, papel explícito advogado do diabo; inspeção do código atual e evidências R6. Nenhum bloqueio de produto encontrado. Correções obrigatórias no plano:

1. Worker sombra separado: o Worker MCP atual importa ações/grupos e recebe Z-API. Ocultar ferramentas não remove capacidade. Telegram tem somente destino dono vinculado; é efeito real.
2. Outbox transacional para cada mutação material: mensagem, edição/exclusão, transcrição, purga, retenção e acesso. Cursores localmente monotônicos; timestamp do fornecedor não é sequência.
3. Webhook atual ignora `DeletedCallback` embora normalizador o reconheça. Testar e corrigir na fronteira de recepção; não declarar homologação do fornecedor por fixture.
4. Política de arquivo e política de acompanhamento distintas. Grupo ignorado pela assistente não precisa perder arquivo; filtro anterior ao modelo cobre backfill e derivados.
5. Revogação invalida sessões Flue, resultados prontos e propostas. Notificação já publicada tem ciclo de retirada próprio; exclusão D1 não apaga Telegram.
6. Cognee nunca concede identidade/ACL. Toda origem/versão e campo auxiliar revalidado. Extração sem capacidade administrativa.
7. Snapshot verificado por imagem/schema/geração/hash/watermark; aplicar tombstones atuais. Testar rebuild sem snapshot. Sem endpoints diagnósticos ou instalação dinâmica de laboratório em produção.
8. Orçamento antes de todas inferências/mídias, incluindo incertas. Lease vencido não publica; não equivale a cancelamento no provedor.
9. Escala R6 de 24 fontes não prova escala real. Medir corpus ampliado, expor cobertura desconhecida e limite, evitar bloqueio global.
10. Diário sombra inclui silêncio, falha, incompleto e não avaliado. Simulação não encerra compromisso real nem vira história factual.

Todos incorporados no PRD e roadmap. Gates de piloto: autenticação/capacidades publicadas, captura integrada, mudanças/derivados, replay/concorrência/restore/rebuild, orçamento e proveniência, Telegram/MCP vinculados, jornada completa. Observação longitudinal de 14 dias só começa depois da prontidão; não substitui testes de engenharia.
