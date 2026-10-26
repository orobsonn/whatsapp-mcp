import {z} from 'zod';
import type {Env} from './env';
import {AppError,assertActive,assertFence,currentFence} from './core';
import {ZapiClient} from './zapi';
import {runtimeConnectionGuard} from './connection';
import {getChatExternal,type ChatRow} from './store';
import type {CaptureMode} from './capture-policy';
export const recipientInput=z.object({
 phone:z.string().regex(/^\+[1-9][0-9]{7,14}$/).describe('Telefone internacional explícito: + e8–15dígitos, primeiro1–9. Sem espaços, inferência de DDI ou nono dígito.'),
 alias:z.string().max(128).refine(s=>!/[\x00-\x1f\x7f]/.test(s)).transform(s=>s.trim()).refine(s=>s.length>0).optional(),
}).strict();
type ResolvedRow=ChatRow&{capture_mode:CaptureMode};
export type RecipientResolution={chatId:string;kind:'individual';name:string;created:boolean;captureEnabled:boolean;captureMode:CaptureMode;captureSince:number|null;capturePolicy:'current_default_inherited'|'existing_preserved';validated_format:true;registeredOnWhatsApp:'unknown';messageAttempted:false;contactSavedOnDevice:false;historicalImport:false};
/** Explicit owner address only. This creates/reuses a local reference; it does
 * not contact the destination, change capture controls or verify registration. */
export async function resolveRecipient(env:Env,raw:unknown,provider:Pick<ZapiClient,'status'>=new ZapiClient(env)):Promise<RecipientResolution>{
 assertActive(env);const input=recipientInput.parse(raw),fence=Object.freeze(currentFence(env)),address=input.phone.slice(1);
 const binding={phone:env.CONNECTED_PHONE,instance:env.ZAPI_INSTANCE_ID,token:env.ZAPI_TOKEN,clientToken:env.ZAPI_CLIENT_TOKEN};
 const stable=()=>{assertActive(env);assertFence(env,fence);if(binding.phone!==env.CONNECTED_PHONE||binding.instance!==env.ZAPI_INSTANCE_ID||binding.token!==env.ZAPI_TOKEN||binding.clientToken!==env.ZAPI_CLIENT_TOKEN)throw new AppError('connection_changed',409);};
 const connection=await runtimeConnectionGuard(env);stable();
 const before=await provider.status();stable();if(!before.connected||!binding.phone||before.phone!==binding.phone)throw new AppError('device_changed',409);
 const existing=await getChatExternal(env,address,fence);stable();if(existing&&existing.kind!=='individual')throw new AppError('recipient_kind_conflict',409);
 const after=await provider.status();stable();if(!after.connected||after.phone!==before.phone)throw new AppError('device_changed',409);
 const now=Date.now();
 // Existing records are never updated, including aliases and opt-out/deletion.
 // New records receive the SAME creation trigger/default as directory discovery.
 const result=await env.DB.batch([
  env.DB.prepare(`INSERT INTO chats(id,epoch,generation,external_id,kind,name,created_at,updated_at)
   SELECT ?,?,?,?,'individual',?,?,? WHERE (${connection.sql})
    AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='capture_chat_insert')
   ON CONFLICT(epoch,generation,external_id) DO NOTHING RETURNING id`).bind(crypto.randomUUID(),fence.epoch,fence.generation,address,input.alias??'Sem nome',now,now,...connection.values),
  env.DB.prepare(`SELECT c.*,s.mode capture_mode FROM chats c JOIN capture_settings s ON s.chat_id=c.id
   WHERE c.epoch=? AND c.generation=? AND c.external_id=? AND c.kind='individual' AND (${connection.sql})`).bind(fence.epoch,fence.generation,address,...connection.values),
 ]);stable();
 const current=await env.DB.prepare(`SELECT 1 WHERE ${connection.sql}`).bind(...connection.values).first();stable();if(!current)throw new AppError('connection_changed',409);
 const row=result[1].results[0] as ResolvedRow|undefined;if(!row)throw new AppError('recipient_unavailable',409);
 const created=result[0].results.length===1;
 return {chatId:row.id,kind:'individual',name:row.name,created,captureEnabled:row.capture_enabled===1,captureMode:row.capture_mode,captureSince:row.capture_since,capturePolicy:created?'current_default_inherited':'existing_preserved',validated_format:true,registeredOnWhatsApp:'unknown',messageAttempted:false,contactSavedOnDevice:false,historicalImport:false};
}
