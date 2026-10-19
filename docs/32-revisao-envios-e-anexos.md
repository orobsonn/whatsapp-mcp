# Revisão de envios e anexos — 19/10/2026

## Ocorrência investigada

O chat do Codex indicado pelo dono registrou falha de contrato nas leituras de grupos. Na tentativa seguinte, o upload foi recusado com HTTP403; o cliente declarou o anexo pendente e preparou somente `kind=text`. Portanto, não existiu tentativa de envio da imagem nessa ocorrência. Não repetir a mensagem real para testar.

## Correções

- O SDK MCP descartava os campos de uma união Zod na raiz do catálogo de `preparar_envio`. Objeto plano torna os parâmetros visíveis; `prepareAction` mantém a validação discriminada estrita e rejeita mistura texto/mídia inválida.
- Diagnóstico fechado de tipos/campos, sem valores do provedor, confirmou `isGroup=false` em uma linha do endpoint de grupos. Esse registro agora é omitido antes de ler nome/telefone. O tamanho bruto da página continua determinando a paginação; exclusões são contadas. Completo significa páginas disponíveis percorridas, não todas as identidades da conta.
- Recusas HTTP400/401/403/404/405/413/415/422/429 preservam código sanitizado e estado rejeitado. HTTP408, rede, timeout, 5xx e desconhecido permanecem incertos. A mesma ação não repete automaticamente em nenhum desses casos.
- Instruções do plugin explicam consulta a uploads recentes e imagem com legenda, sem pedir códigos ao dono nem substituir silenciosamente por texto.

## Verificações

- 192 testes passaram, TypeScript e build passaram; auditoria de dependências de produção sem vulnerabilidades.
- Regressões reproduzidas antes das correções: catálogo sem campos, rejeição explícita classificada como incerta e linha não-grupo bloqueando a página inteira.
- Jornada HTTP/MCP autenticada sintética: upload PNG → R2 → consulta de uploads → proposta de imagem com legenda → corpo `send-image` com bytes e legenda → segunda execução sem novo efeito. Combinações incompatíveis são recusadas antes de criar ação.
- Revisão adversarial independente: envios/mídia/transporte e autenticação/setup/grupos/políticas. Nenhum bloqueador remanescente no diff final.
- Upload real no navegador autenticado concluiu com arquivo PNG sintético. A recusa403 antiga não se reproduziu; não atribuir a ela uma causa que não foi observada.
- Busca autenticada em produção voltou a localizar o grupo solicitado após percorrer as páginas disponíveis, omitindo dez registros explicitamente não-grupo. Nenhuma captura foi habilitada.
- Cliente GPT real, com Zap selecionado: localizou sozinho o grupo, consultou uploads e preparou a imagem sintética pelo nome com legenda, sem ID/hash fornecido no pedido. Registro no MCP conferido como `proposed`, `kind=image` e sem tentativa externa; proposta de teste cancelada após a conferência. Plugin App atualizado1.0.1 preservou identidade, OAuth e permissões.
- Worker v0.4.2 ativo, health e bloqueio de arquivo privado sem autenticação conferidos. Não foi enviado teste para grupo real.

Aceitação da Z-API não prova entrega/leitura. A jornada de envio com imagem acima usa provedor sintético; não é homologação de entrega real no aparelho.
