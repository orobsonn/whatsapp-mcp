# Configuração privada e primeira ativação

Pedido do dono em 19/10/2026: já possui a instância e quer uma página como a do Elo para inserir os três valores e depois conectar o GPT. Autoriza implementar/publicar o fluxo próprio; não copiar credenciais/dados nem modificar Elo. Apenas referência visual/lógica de seu setup foi lida.

## Decisões após revisão adversarial

- `/setup` privado, dono pré-vinculado pela identidade Access consultada na conta autenticada; nenhum cadastro do primeiro visitante. Formulário server-rendered de três segredos, limite 8 KiB, nonce de uso único/purpose setup, Origin exato, CSP, sem scripts/analytics externos/eco de segredo.
- Primeira conexão apenas. Uma conexão ativa não é sobrescrita. Isso evita a troca insegura de configuração sob requests em voo e callbacks remotos atrasados. Retomada usa a mesma tentativa e payload imutáveis.
- Credenciais/generation/webhooksecret cifrados AES-GCM em D1; chave exclusiva em secret do Worker, IV aleatório e AAD vinculada à origem e epoch externo. Restore exige novo epoch; cipher antigo não reativa por fallback.
- Runtime carrega configuração ativa por request/scheduled. Modo database falha fechado para D1/key/cipher ausentes. Fallback estático só para desenvolvimento/teste explícito; produção não usa Z-API do ENV legado.
- Verificação de status/device, leitura completa de callbacks `/me`, recusa de instância usada por outra integração; somente PUTs fechados/idempotentes no host Z-API. Persistir tentativa antes de efeito, reconciliar readback antes de active; pendência não libera ferramentas. Nenhum envio de mensagem na configuração e nenhum chat liberado automaticamente.
- Recursos exclusivos do projeto na conta Robson Lins; subdomínio novo `whatsapp.robsonlins.com`, sem registro ou app preexistente. Aplicação Access nova nas páginas humanas, MCP/OAuth/webhook com autenticação própria existente.
- Plugin privado GPT conectado ao MCP existente, OAuth/DCR. Servidor não recebe credenciais OpenAI. Login/consentimento do dono são a etapa humana inevitável; não alegar conexão do GPT antes de autenticar e testar ferramenta real.

## Execução

1. Backend/nonce/migração com TDD de segurança e recuperação (gpt-6.1-sol/high).
2. UI enxuta e acessível, mobile/desktop (gpt-6-sol/medium), sem copiar código do Elo.
3. Integração request/scheduled, recursos/config/deploy pelo agente principal. Testes reais locais com rede sintética, revisão adversarial final, CI/PR/release por marco 0.3.0.
4. Publicar página privada verificável e plugin privado; entrada de segredos e consentimento realizados pelo dono na interface, nunca no chat. Configuração real só comprovada após a submissão e readbacks do fornecedor.

Revisão adversarial anterior ao código identificou: hot rotation sem fence durável, lease não cancelando PUT remoto, leitura parcial de callbacks, fallback ENV indevido, restore e separação login/setup. As decisões acima incorporam as correções. Não há harness instalado por pedido explícito do dono.
