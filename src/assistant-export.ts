import type {Env} from './env';
import {requireOwner,publicOrigin} from './auth';
import {AppError,assertActive,currentFence} from './core';
import {resolveRuntimeEnv} from './connection';
import {ownerAffinitySchema,ownerQuerySchema} from '../assistant/mcp';

/** The assistant receives a private link, never the export's source bodies. */
export function assistantExportLink(env:Env,input:unknown){
 const query=ownerQuerySchema.parse(input);if(query.kind!=='assistant.export')throw new AppError('invalid_input',400);
 const url=new URL('/assistant/export',publicOrigin(env));url.searchParams.set('limit',String(query.limit));if(query.cursor)url.searchParams.set('cursor',query.cursor);
 return {state:'private_download',browserUrl:url.toString(),coverage:'single_page',instruction:'Abra o link privado para baixar esta página do arquivo. O download exige seu login.'};
}
/** Same owner Access boundary as media downloads; no public export token or R2 copy. */
export async function assistantExportDownload(request:Request,raw:Env):Promise<Response>{
 const env=await resolveRuntimeEnv(raw);assertActive(env);const identity=await requireOwner(request,env);
 if(request.method!=='GET')throw new AppError('method_not_allowed',405);
 const url=new URL(request.url);
 if([...url.searchParams.keys()].some(k=>!['cursor','limit'].includes(k))||['cursor','limit'].some(k=>url.searchParams.getAll(k).length>1))throw new AppError('invalid_input',400);
 const query=ownerQuerySchema.parse({kind:'assistant.export',...(url.searchParams.has('cursor')?{cursor:url.searchParams.get('cursor')}:{ }),...(url.searchParams.has('limit')?{limit:Number(url.searchParams.get('limit'))}:{})});
 const fence=currentFence(env),affinity=ownerAffinitySchema.parse({installationId:env.ASSISTANT_INSTALLATION_ID,generation:env.ASSISTANT_GENERATION,sourceEpoch:fence.epoch,sourceGeneration:fence.generation});
 if(!env.ASSISTANT_OWNER)throw new AppError('assistant_unconfigured',503);
 const page=await env.ASSISTANT_OWNER.query(affinity,query);
 const current=await resolveRuntimeEnv(raw);assertActive(current);const now=currentFence(current),owner=await requireOwner(request,current);
 if(now.epoch!==fence.epoch||now.generation!==fence.generation||owner.sub!==identity.sub||current.ASSISTANT_INSTALLATION_ID!==affinity.installationId||current.ASSISTANT_GENERATION!==affinity.generation||current.ASSISTANT_OWNER!==env.ASSISTANT_OWNER)throw new AppError('assistant_export_changed',409);
 return new Response(JSON.stringify(page,null,2),{headers:{'content-type':'application/json; charset=utf-8','content-disposition':'attachment; filename="assistant-export-page.json"','cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; sandbox; frame-ancestors 'none'",'cross-origin-resource-policy':'same-origin'}});
}
