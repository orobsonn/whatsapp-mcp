import {getAgentInstance,init,type DispatchReceipt} from '@flue/runtime';
import type {AssistantEnv} from '../env';
import {ConversationRuntimeAgent} from './entry';
import type {NativeContextDestroyPort} from './conversation-retention';

export const openNativeConversation=(sessionId:string)=>init(ConversationRuntimeAgent,{id:sessionId});
/** No SDK internal storage deletion. A failed erase RPC is reconciled through
 * the public instance lookup because SDK destroy may abort its own request. */
export function nativeContextDestroyPort(env:AssistantEnv):NativeContextDestroyPort {
 const db=env.DB,namespace=env.FLUE_CONVERSATION_RUNTIME_AGENT,secret=env.NATIVE_CONTEXT_ADMIN_SECRET;
 if(!db||!namespace||!secret||secret.length<32)throw Error('native_destroy_unconfigured');
 const current=()=>{if(db!==env.DB||namespace!==env.FLUE_CONVERSATION_RUNTIME_AGENT||secret!==env.NATIVE_CONTEXT_ADMIN_SECRET)throw Error('native_destroy_changed');};
 async function settled(id:string){current();const n=await db!.prepare(`SELECT COUNT(*) n FROM assistant_native_model_receipts WHERE installation_id=? AND generation=? AND session_id=? AND state='attempting'`)
  .bind(env.INSTALLATION_ID!,env.OPERATIONAL_GENERATION!,id).first<number>('n');if(n)throw Error('native_model_still_attempting');}
 const present=(id:string)=>getAgentInstance(ConversationRuntimeAgent,id);
 return {
  async abort(id){current();if(await present(id))await openNativeConversation(id).abort();},
  async quiesce(id){
   current();const rows=await db!.prepare(`SELECT receipt_json FROM assistant_native_conversation_events WHERE conversation_id=?`).bind(id).all<{receipt_json:string|null}>();
   // Unknown native admission ACK remains pending; never infer no work from it.
   if(rows.results.some(row=>!row.receipt_json))throw Error('native_quiescence_unknown_ack');
   if(await present(id))for(const row of rows.results){
    try{await openNativeConversation(id).read(JSON.parse(row.receipt_json!) as DispatchReceipt,{signal:AbortSignal.timeout(5000)});}
    catch(error){const e=error as {name?:string;outcome?:string};if(e.name!=='AgentRunError'||!['failed','aborted'].includes(e.outcome??''))throw error;}
   }
   await settled(id);
  },
  async destroy(id){
   current();if(await present(id))try{await namespace!.get(namespace!.idFromName(id)).eraseNativeContext(secret!,id);}
   catch(error){if(await present(id))throw error;}
   if(await present(id))throw Error('native_destroy_not_confirmed');await settled(id);
  },
 };
}
