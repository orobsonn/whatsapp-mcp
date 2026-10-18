# Revisão adversarial do handoff

Data: 18/10/2026. Revisão independente com papel explícito de advogado do diabo e leitura como futuro implementador. A leitura dos documentos finais foi concluída: handoff utilizável, sem bloqueador documental. Isso não é aprovação de arquitetura nem teste de implementação.

## Achados iniciais já incorporados

1. **“Todo WhatsApp” não prova cobertura:** separar ambição, contrato, captura efetiva e backfill; matriz por origem/tipo e limites em cada consulta.
2. **Grupo não é uma pessoa:** modelar conversa, participante e autor separadamente; admin do grupo não é dono do MCP.
3. **Privacidade não se resume a ID:** texto, voz, PDF, nome de arquivo, OCR e logs podem expor dados. Mapear o que sai por operação e não enviar tudo como fallback.
4. **Flexibilidade não é exfiltração automática:** atender o pedido com dados necessários e escopo claro; não criar aprovação repetida para toda leitura, mas não ampliar finalidade/processador silenciosamente.
5. **Mídia hostil e SSRF:** referências autorizadas, streaming com limite, host/redirect/DNS/tipo real e vínculo de bytes; imagem/arquivo não é instrução nem autorização.
6. **Envio pode ficar incerto:** ação imutável inclui destino/conteúdo/anexo/opções; uma execução, reconciliação e sem retry cego. Estado agregado de grupo não prova entrega/leitura de todos.
7. **Escalabilidade sem fantasia:** não exigir embeddings/OCR/transcrição em massa para primeiro uso. Limites/checkpoints e medir custos/volume; Workers/D1/objetos são candidatos.
8. **Evidência e reuso:** fixar commit/hash e distinguir teste controlado/real/documentação. Conferir autoria/permissão antes de copiar código. Sem mover instância, webhook ou chaves do Elo.

Recomendação do agente principal: usar essas correções no primeiro desenho e manter abertas as decisões de provedor, retenção, política de ações e processamento de áudio. Elas não impedem preparar a pasta agora nem exigem uma rodada extensa de decisões técnicas com o dono.

## Conferência final

O revisor independente leu README, BRIEF, AGENTS, CONTEXT, os oito documentos e os dois manifestos. Conferiu os hashes e contagens das 42 referências iniciais contra o commit fixado, sem divergência. Considerou possível retomar objetivo, fronteiras, primeira sequência, evidência e decisões abertas sem inventar autorização.

Duas correções editoriais foram incorporadas: registrar o estado final desta revisão e incluir `tests/review-load.test.ts`/`tests/restore-database.test.mjs` no manifesto. O manifesto agora tem 44 arquivos; os dois adicionais foram conferidos pelo agente principal. Nenhum código, serviço ou conta foi operado para essa revisão.
