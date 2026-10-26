import {z} from 'zod';
import type {Env} from './env';
import {safeEqual,assertActive,currentFence,assertFence} from './core';
import {resolveRuntimeEnv,runtimeConnectionGuard} from './connection';
import {ZapiClient} from './zapi';
import {sendEnvelopeSchema,actionDigest,canonicalEnvelope} from './send-envelope';
import {resolveSendEnvelope,sendEnvelopeGuard} from './send-envelope-validation';
import {recipientInput} from './recipients';
const input=z.object({secret:z.string().max(256),sourceEpoch:z.string().min(1).max(256),sourceGeneration:z.string().min(1).max(256),envelope:sendEnvelopeSchema}).strict();
/** Metadata only; capture opt-out does not imply a no-contact policy. No sender. */
export async function readRecipientEnvelope(raw:Env,value:unknown,provider?:Pick<ZapiClient,'status'>){
 const q=input.parse(value),secret=raw.ASSISTANT_READER_SECRET;if(!secret||secret.length<32||!await safeEqual(secret,q.secret))throw Error('reader_denied');
 const env=await resolveRuntimeEnv(raw);assertActive(env);const fence=currentFence(env);if(q.sourceEpoch!==fence.epoch||q.sourceGeneration!==fence.generation)throw Error('reader_denied');
 const connection=await runtimeConnectionGuard(env),snapshot={phone:env.CONNECTED_PHONE,instance:env.ZAPI_INSTANCE_ID,token:env.ZAPI_TOKEN,client:env.ZAPI_CLIENT_TOKEN};
 const stable=()=>{assertActive(env);assertFence(env,fence);if(raw.ASSISTANT_READER_SECRET!==secret||env.CONNECTED_PHONE!==snapshot.phone||env.ZAPI_INSTANCE_ID!==snapshot.instance||env.ZAPI_TOKEN!==snapshot.token||env.ZAPI_CLIENT_TOKEN!==snapshot.client)throw Error('reader_changed');};
 const status=provider??new ZapiClient(env),before=await status.status();stable();if(!before.connected||!snapshot.phone||before.phone!==snapshot.phone)throw Error('reader_changed');
 const selected=await resolveSendEnvelope(env,q.envelope);stable();if(selected.chat.kind!=='individual'||!recipientInput.shape.phone.safeParse('+'+selected.chat.external_id).success)throw Error('recipient_kind');
 const after=await status.status();stable();if(!after.connected||after.phone!==before.phone)throw Error('reader_changed');
 const current=await resolveRuntimeEnv(raw);assertActive(current);assertFence(current,fence);if(current.CONNECTED_PHONE!==snapshot.phone||current.ZAPI_INSTANCE_ID!==snapshot.instance||current.ZAPI_TOKEN!==snapshot.token||current.ZAPI_CLIENT_TOKEN!==snapshot.client)throw Error('reader_changed');
 if(!await env.DB.prepare('SELECT 1 WHERE '+connection.sql).bind(...connection.values).first())throw Error('reader_changed');stable();
 const final=await resolveSendEnvelope(current,selected.envelope);if(canonicalEnvelope(final.envelope)!==canonicalEnvelope(selected.envelope)||JSON.stringify(final.chat)!==JSON.stringify(selected.chat)||JSON.stringify(final.media)!==JSON.stringify(selected.media))throw Error('reader_changed');
 const local=sendEnvelopeGuard(selected);
 const envelopeHash=await actionDigest(selected.envelope),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify([fence,selected.chat.id,selected.chat.external_id,selected.chat.kind,snapshot.phone,snapshot.instance,connection,selected.media,envelopeHash])));
 if(!await current.DB.prepare(`SELECT 1 WHERE (${connection.sql}) AND (${local.sql})`).bind(...connection.values,...local.values).first())throw Error('reader_changed');stable();
 return {observation:'recipient_envelope' as const,state:'available' as const,sourceEpoch:fence.epoch,sourceGeneration:fence.generation,recipient:{chatId:selected.chat.id,kind:'individual' as const,validated_format:true as const,registeredOnWhatsApp:'unknown' as const,fingerprint:Array.from(new Uint8Array(signature),x=>x.toString(16).padStart(2,'0')).join('')},envelope:selected.envelope,envelopeHash};
}
