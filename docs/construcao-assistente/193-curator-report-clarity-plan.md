# Correção do relatório de curadoria

Escopo aprovado: formato com emojis, aprendizados por contexto/instância, descarte separado de falta de evidência, pendências com próximo passo e pedido ao dono somente quando houver ação concreta. Não instalar harness, importar histórico nem criar suporte a formatos novos.

1. Reproduzir relatório antigo e investigar os 209 eventos em produção por identidade completa. Evidência privada fora do Git; distinguir momento do envio e consulta atual.
2. Adaptar teste real da notificação e acrescentar um cenário agregado para eventos repetidos/escopo. Adicionar contexto opcional no JSON de decisão (sem migração) e diagnóstico agregado de gaps, sem inferir conteúdo perdido.
3. Renderizar exemplos limitados por categoria, escapar campos livres e manter orçamento Telegram. Confirmação learned permanece recibo do host. Não reenviar notificação automaticamente.
4. Tipos, testes afetados e suíte existente; revisão e publicação direta com checagem, preservando configuração/modelo e versão mais recente de produção.

Revisão adversarial: não chamar eventos de arquivos, não inferir causa de message_unavailable, preservar epoch/generation em joins, retry somente com next_retry_at, agrupar contexto apenas quando explícito e preservar limite de Telegram.
