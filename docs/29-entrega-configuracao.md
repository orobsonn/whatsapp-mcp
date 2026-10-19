# Configuração privada — v0.3.0

Pedido: dono já possui instância; preencher credenciais em página privada e conectar GPT depois.

Página: https://whatsapp.robsonlins.com/setup. Plugin privado: https://chatgpt.com/plugins/plugins_6ad6558a72448191b0e9b187af951d7f. Origem MCP: https://whatsapp.robsonlins.com/mcp. Criado pelo Plugin Creator preservando servidor e OAuth/DCR existentes; nenhum dado de conexão dentro do pacote.

## Verificação

- Suite completa: 143 testes, 13 arquivos, sem falhas; check e build dry-run passaram.
- Testes novos cobrem cifragem/epoch/restore, runtime fechado, concorrência, recuperação após mais de três falhas, callback estrangeiro/parcial, nonce/purpose/Origin/body bounds, UI de erro e roteamento.
- Revisão adversarial independente: nenhum P1/P2 aberto após correções. Primeira conexão é imutável; não existe hot rotation.
- UI sintética inspecionada em 390px e 1365px, sem overflow. Formulário com inputs privados, sem eco de valores.
- Migrations aplicadas somente no banco novo exclusivo. Nenhum banco/token/dado do Elo foi usado.
- Deploy direto de primeiro uso concluído; versão ativa `97f5544c-a44a-4b07-bf4e-c568e1894da5`.
- Smoke remoto: health 200/version0.3.0/maintenance=true/connectionConfigured=false; setup/status redirecionam ao login Access; MCP sem bearer retorna401; descoberta OAuth200 com PKCE S256 e DCR.

## Recursos não secretos

Conta: Robson Lins. Worker whatsapp-mcp; D1 whatsapp-mcp-private; R2 whatsapp-mcp-private-media; KV WHATSAPP_MCP_OAUTH. Bindings exclusivos. Access app nova permite somente dono pré-provisionado nas páginas humanas. MCP/OAuth/webhooks não são cobertos pela tela de login Access, pois possuem autenticação própria. workers.dev e previews desabilitados.

## Pendente de ação do dono

Preencher ID/token/client-token na página e confirmar exclusividade; configuração valida status/device/me, aplica callbacks próprios e faz readback antes de active. O botão de GPT abre o plugin privado; instalação/login/consentimento precisam ocorrer na conta do dono. Só declarar conexão GPT concluída após ferramenta real autenticada. O download de mídia recebida depende da validação dos hosts reais e do primeiro teste; transcrição permanece opt-in.

Não houve envio de mensagens ou leitura de conversas reais no provisionamento. Valores dos segredos não foram emitidos por ferramentas nem versionados. O pacote local está em plugin/whatsapp-pessoal e a issue de implementação é #12.
