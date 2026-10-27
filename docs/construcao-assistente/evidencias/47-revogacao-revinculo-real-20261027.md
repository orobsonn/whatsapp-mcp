# Telegram próprio — revogação e revínculo reais

## Fronteira observada

Em27/10/2026, após a v0.46.0, o MCP autenticado confirmou vínculo `active/revision1/affinityCurrent=true`, quatro tópicosready e nenhuma notificação. O Chrome solicitado pelo dono estava autenticado e aberto no próprio bot. A revisão adversarial aceitou o ensaio, distinguindo revogação causal de repetir desafios já expirados.

`telegram_link.revoke`, com CAS1 e operationId fixo, retornou `revoked/revision2`. Nova consulta confirmou esse estado; a consulta de revisão Telegram, somente leitura, foi recusada pelo gateway com `operation_failed/INVALID_ARGUMENT`. O erro público não expõe sua causa interna e não é apresentado como prova de um código de erro mais específico.

Um novo begin com CAS2 emitiu A. O mesmo Chrome enviou A; o MCP observou `claimed`, então emitiu B, enviado no mesmo chat. Nova consulta confirmou `active/revision3/affinityCurrent=true`. Leitura agregada na D1 própria verificou dois pareamentos consumidos nas revisões esperadas0/2, uma única combinação dono/chat, novo corte de ativação posterior ao anterior e nenhum inbox antigo pendente. A consulta não exportou identidade, conteúdo ou desafios. Não houve reset de dedupe, contadores ou recibos.

## Tópicos e limite atual

O novo vínculo invalida os fences anteriores. `topics.ensure` criou quatro tópicos próprios da revisão3, todosready com primeiro preflight e IDs persistidos. Os quatro tópicos da revisão1 permanecem no histórico, sem reuso de IDs ou exclusão por SQL; são dois conjuntos visíveis. Esta é uma limitação de UX observada, não repetição de tentativa incerta. Nenhuma notificação foi preparada/publicada, nem callback ou avaliação humana fabricado. Callbacks reais continuam na #48.

## Matriz de aceite #47

| Critério | Evidência e limite |
| --- | --- |
| 14.211 — segredo errado recusa | Nove checks públicos do Worker próprio incluíram webhook sem segredo/segredo errado403; bundle instalado passou16 casos de ingresso isolados em workerd. Registro anterior identifica os hashes e a única correção posterior, no transporte Telegram. |
| 14.212 — outro user/chat não controla | Contraprovas integradas de autenticação/isolamento no workerd/D1, além do vínculo real por A/B. Não se usou conta alheia real para tentar acesso. |
| 14.213 — update repetido não repete comando | Dedupe persistente, conflitos e corridas cobertos pelos testes de autenticação; novo ensaio não zerou seu estado. Não se afirma replay de transporte real do Telegram nesta rodada. |
| 14.214 — token fora D1/Git | Token lido do arquivo privado0600 e instalado somente como Worker secret; configuração/readback anteriores e diff desta entrega não contêm segredo. |
| 14.215 — revogação MCP | Revogação autenticada real1→2, recusa durante revogado e recuperação A/B para3, mesmo dono/chat, novo corte e nenhuma pendência antiga. |

A matriz combina testes integrados atuais e observações reais identificadas; não atribui provas de laboratório a outro bot ou afirma que todos os negativos foram enviados ao provedor real. A CI do commit de release deve passar antes da tag/publicação e do fechamento da issue.

## Estado preservado

Nenhuma mudança de runtime/configuração nesta entrega, além das operações de vínculo/tópicos previstas. Fonte funcional do Worker continua `13d19981aabd42c23997c6d4d0fc847c530cc9a9`, versão `f4085d95-b133-4eb5-a6fa-7bc7a5c94f75`, com hashes relidos na evidência da0.46. A v0.46.0 foi publicada em `d4950b835bbd3f91515afe2763626b31c2f18bfa`, CI40496031005 aprovada com1350 testes gerais/65 nativos.

Rotinas sombra/pausadas; WhatsApp automático e escrita Calendar desabilitados. Nenhuma inferência paga nova da assistente. Histórico financeiro e tentativas incertas preservados; fatura de infraestrutura não conciliada. Google tem projeto/cliente próprios e credencial privada, mas o consentimento final de leitura está pendente e o Worker ainda não recebeu refresh token. #48/#51 e homologação integral do piloto continuam pendentes. O avatar solicitado foi gerado em arquivo local fora do Git; não foi aplicado como identidade do bot.
