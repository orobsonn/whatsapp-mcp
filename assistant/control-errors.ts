/** Public diagnostics are a closed vocabulary. Never forward remote messages,
 * SQL, source text, IDs, credentials, stacks or exception causes to the client. */
const diagnostics={
 control_scheduler_unavailable:{field:'configuration',message:'O agendador privado precisa estar ativo, sem pausa e com a sessão Telegram do dono disponível. O acompanhamento não foi agendado; confira a configuração antes de repetir a mesma operação.'},
 control_policy_required:{field:'policyRevision',message:'Este fup.put precisa da revisão positiva de uma política de atendimento vigente. Revisão 0 só é aceita no fluxo outgoing com suas autorizações próprias. Consulte a conversa e a política; não habilite captura ou grupos automaticamente.'},
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
