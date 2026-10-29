import {useTool} from '@flue/runtime';
import * as v from 'valibot';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256)),version=v.pipe(v.number(),v.integer(),v.minValue(1),v.safeInteger());
export type NativeTaskCapabilities={query(input:unknown):Promise<unknown>;save(input:unknown):Promise<unknown>;setState(input:unknown):Promise<unknown>;adopt(input:unknown):Promise<unknown>};
/** Private owner capability, not the administrative OwnerControl API. Each
 * mutation rechecks the last REAL owner input; a system wake grants no writes. */
export function useNativeTaskTools(resolve:()=>Promise<NativeTaskCapabilities>){
 const run=async(method:keyof NativeTaskCapabilities,data:unknown)=>({output:JSON.stringify(await(await resolve())[method](data))});
 useTool({name:'task_query',description:'Consulte missões ou retornos atuais do dono, suas versões, prazos e recibos nativos. Uma tarefa cadastrada sem adesão nativa não será despertada. Texto indisponível não significa ausência da tarefa.',
  input:v.strictObject({kind:v.picklist(['mission','follow_up']),id:v.optional(id),after:v.optional(id),limit:v.optional(v.pipe(version,v.maxValue(20)))}),run:({data})=>run('query',data)});
 useTool({name:'mission_save',description:'Crie ou edite uma missão somente por pedido ATUAL do dono autenticado. objective é o objetivo completo; para editar, consulte id/expectedRevision primeiro. at é ISO com offset -03:00/America/Fortaleza; omitido preserva prazo existente, null retira agendamento. Missão nova sem at fica sem despertar. A operação cria adesão explícita da versão atual, sem ligar tarefas antigas. Não cria envio ao WhatsApp.',
  input:v.strictObject({id:v.optional(id),expectedRevision:v.optional(v.pipe(v.number(),v.integer(),v.minValue(0),v.safeInteger())),objective:v.pipe(v.string(),v.minLength(1),v.maxLength(2048)),at:v.optional(v.nullable(v.pipe(v.string(),v.maxLength(128)))),stopCondition:v.optional(v.nullable(v.pipe(v.string(),v.maxLength(2048))))}),run:({data})=>run('save',data)});
 useTool({name:'task_set_state',description:'Pause, cancele ou resolva uma missão por pedido atual do dono; retornos existentes permitem pausa/cancelamento. Consulte a versão atual antes. Não use para declarar trabalho realizado apenas porque foi agendado.',
  input:v.variant('kind',[v.strictObject({kind:v.literal('mission'),id,version,state:v.picklist(['paused','resolved','cancelled'])}),v.strictObject({kind:v.literal('follow_up'),id,version,state:v.picklist(['paused','cancelled'])})]),run:({data})=>run('setState',data)});
 useTool({name:'task_adopt',description:'Ative explicitamente a avaliação nativa de UMA versão atual de missão/retorno já existente, quando o dono pedir. O prazo produz avaliação privada ao dono, sem satisfazer condição automaticamente ou autorizar contato com terceiros. Nenhum backlog é ativado em conjunto.',
  input:v.strictObject({kind:v.picklist(['mission','follow_up']),id,version}),run:({data})=>run('adopt',data)});
}
