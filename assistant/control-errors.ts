/** Public diagnostics are a closed vocabulary. Never forward remote messages,
 * SQL, source text, IDs, credentials, stacks or exception causes to the client. */
const diagnostics={
 control_source_unavailable:{field:'source',message:'A fonte não está atual e acessível para este pedido. Consulte seu estado e revisão; não restaure, copie ou substitua uma fonte retirada para contornar a recusa sem novo pedido do dono.'},
 control_policy_revision:{field:'policyRevision',message:'A revisão informada não corresponde à política atual. Use 0 somente quando não houver política própria; caso exista, consulte sua revisão exata. Não crie política para contornar a recusa.'},
 control_policy_restricted:{field:'policyRevision',message:'A política ou sua retenção restringe esta conversa. Exclusão e ignore explícito não podem ser contornados por um FUP; nenhuma política foi alterada.'},
 control_conversation_unavailable:{field:'conversationId',message:'A conversa está sem observação válida na conexão atual, indisponível ou pausada. Nenhum FUP foi criado; não habilite captura ou acompanhamento para contornar a recusa.'},
 control_source_reference:{field:'source',message:'Use somente source={id, revision}. version e hash são derivados pelo servidor; não devem ser enviados.'},
 control_source_private_required:{field:'source',message:'Sem política própria, use uma nota privada atual do dono, sem conversationId nem candidate. Isso não concede acesso ao grupo. Fonte retirada não deve ser restaurada ou copiada para contornar uma recusa.'},
 control_scheduler_unavailable:{field:'configuration',message:'O agendador privado precisa estar ativo, sem pausa e com a sessão Telegram do dono disponível. O acompanhamento não foi agendado; confira a configuração antes de repetir a mesma operação.'},
 control_input:{field:'command',message:'Parâmetros incompatíveis. Confira os campos da operação, a precisão da data e o fuso informado.'},
 control_precondition:{field:'references',message:'Uma versão ou permissão exigida não está vigente. Confira a conversa, a política, a fonte, o projeto e expectedVersion. Consulte o mesmo operationId antes de repetir; não crie outro ID para contornar a falha.'},
 control_operation_conflict:{field:'operationId',message:'Este operationId já pertence a outro conteúdo. Recupere a operação original antes de tentar outra alteração.'},
 owner_required:{field:'authorization',message:'Esta operação exige o dono autenticado.'},
 control_origin_unconfigured:{field:'configuration',message:'A origem da instalação não está configurada para esta operação.'},
} as const;
export function ownerControlDiagnostic(error:unknown){
 const code=error instanceof Error?error.message:undefined;
 if(!code||!Object.hasOwn(diagnostics,code))return null;
 return {error:code,...diagnostics[code as keyof typeof diagnostics]};
}
