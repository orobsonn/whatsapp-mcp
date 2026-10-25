# Issue 28 — fronteira sombra

Worker/entrypoint próprios. GET /health declara mode shadow, whatsappSend=false e calendarWrite=false; demais caminhos recusam com shadow_only. Env sem credenciais/bindings. Nenhum handler alternativo scheduled/queue/RPC. Configuração sem rotas públicas ou recursos.

RED: handler deny-all recusava saúde esperada. GREEN: 11 testes, incluindo dez caminhos/métodos de ação com zero fetch. Check e build próprio aprovados; bundle 0,57 KiB e No bindings found. Revisão independente build_adversary confirmou imports/configuração/rotas sem bloqueantes. Build próprio acrescentado ao CI e arquivos assistant ao check TypeScript.

Limite: fronteira local compilável, sem instalação ou piloto operacional. Tipo Env não é ACL de runtime nem bloqueio geral de rede; próximas integrações precisam preservar ausência de segredos/bindings/rotas com poder de envio. Telegram futuro tem somente destino dono autenticado.
