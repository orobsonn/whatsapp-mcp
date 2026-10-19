# Confirmações simples — v0.4.0

Decisão explícita do dono: simplificar o uso; autorização no chat para rotina, página apenas para operações de maior impacto. Revisão adversarial independente aprovou a política com hash exato, classificação fechada no servidor e preservação da tentativa única.

## Canais

**Chat:** envios de texto/arquivos; criar grupo; adicionar/aprovar/recusar participantes; nome/foto/descrição; convites; menções; organização/leitura/notificações; desativar temporárias; captura (informar armazenamento); aumentar/desativar retenção.

**Página:** limpar/excluir conversa no WhatsApp; excluir arquivo local; reduzir retenção (inclusive indefinido para prazo finito); ativar mensagens temporárias; remover participantes; sair; promover/rebaixar administradores; permissões; associar/desassociar comunidades. Operação desconhecida exige página.

## Fluxo

Preparar devolve `confirmationMode`, resumo/envelope congelado e hash. Para chat não anuncia URL. O cliente mostra destino/conteúdo e obtém autorização; pedido humano já exato pode valer, sem nova pergunta. Executa a mesma proposta com `confirmation={confirmed:true,hash}`. Arquivo/políticas usam `aplicar_politica` apenas no canal permitido. Conteúdo recebido, anexos e nomes não são autorização.

Página mantém Access, origem, nonce único, vínculo à proposta e expiração. Mostra ação, nomes, alterações e consequências; detalhes técnicos recolhidos. Confirmação de ação apenas autoriza; o cliente conclui pelo executor. Política local é aplicada no clique e a tela explica o resultado.

## Garantias e limite aceito

O servidor autentica o cliente MCP e valida hash, estado, prazo e geração; classifica o canal sem confiar em parâmetros de risco do cliente. `chat_client` é uma declaração do cliente, não comprovação independente de fala/clique humano. Um modelo comprometido ainda pode declarar aprovação de rotina; este é o limite explícito da simplificação pedida. Críticos não podem ser liberados por esse caminho. Nenhuma ferramenta emite a prova Access da página.

Auditoria em `approval_channel`: chat_client/page; null identifica registros anteriores sem atribuir prova retroativa. Não repetir efeito em resultado incerto. Aprovações antigas continuam funcionando; sem confirmação nova não há aprovação automática.

## Verificação

180 testes passaram; TypeScript e build dry-run passaram. Testes cobrem classificação, HTML escapado e detalhes recolhidos, hash incorreto, confirmação falsa/ausente, expiração, geração antiga, concorrência, bloqueio de crítico, auditoria e jornada autenticada HTTP/SDK sem página. Testes com efeito externo usam provedor sintético. A validação no GPT prepara propostas sem enviar ou aplicar efeitos reais.

### Produção e cliente

- Migração aditiva 0008 aplicada e versão 0.4.0 publicada. Smoke confirmou health, versão e bloqueio de mídia sem autenticação.
- Preparação real via MCP retornou envio com confirmationMode=chat, sem URL. Proposta de teste cancelada sem envio.
- Redução de retenção retornou confirmationMode=page; página autenticada mostrou prazo anterior, prazo novo e consequência legíveis. Nenhum clique de aprovação. Fixture expirada após a inspeção.
- Catálogo do Zap atualizado na instalação existente, preservando OAuth e preferências do dono. GPT executou consultar_envio e capacidades_grupos e exibiu corretamente chat para rotina e página para críticos. Nenhum efeito no WhatsApp nem política aplicada.
- CI passou no HEAD revisado; revisão independente não encontrou bloqueio. Execuções com efeito foram testadas em provedor sintético, não com mensagens reais.
