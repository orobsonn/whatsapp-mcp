import type {AssistantEnv} from './env';
import {safeEqual} from '../src/core';
import {CaptureMaterializer} from './materialize';
import {activeOrigin,type OriginScope} from './origin-guard';
import {assertRestoredGeneration} from './retention-runtime';
import {configuredRetirementGuard} from './retention-authority';
import type {AccessGuard} from './access';

/** Operator-only one-off archive repair. No model tool, send capability,
 * inference or new event is reachable from this route. Namespace is host-owned. */
export async function importArchivedReference(request:Request,env:AssistantEnv):Promise<Response>{
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
 const result=(body:object,status=200)=>Response.json(body,{status,headers});
 const secret=env.NATIVE_CONTEXT_ADMIN_SECRET;
 if(request.method!=='POST'||typeof secret!=='string'||secret.length<32||!await safeEqual(request.headers.get('Authorization')??'','Bearer '+secret))return result({error:'archive_import_denied'},403);
 if(Number(request.headers.get('Content-Length')??0)>2048)return result({error:'archive_import_input'},400);
 let input:unknown;
 try{const text=await request.text();if(new TextEncoder().encode(text).length>2048)return result({error:'archive_import_input'},400);input=JSON.parse(text);}catch{return result({error:'archive_import_input'},400);}
 try{
  if(!env.DB||!env.CAPTURE_READER||!env.BRIDGE_SECRET)throw Error('archive_import_unconfigured');
  const frozen=[env.DB,env.CAPTURE_READER,env.BRIDGE_SECRET,secret,env.RETENTION_GENERATION_SEAL,env.RETENTION_GENERATION_SEAL_REQUIRED,env.INSTALLATION_ID,env.OPERATIONAL_GENERATION,env.BRIDGE_SOURCE_EPOCH,env.BRIDGE_SOURCE_GENERATION];
  const current=():OriginScope=>{
   const now=[env.DB,env.CAPTURE_READER,env.BRIDGE_SECRET,env.NATIVE_CONTEXT_ADMIN_SECRET,env.RETENTION_GENERATION_SEAL,env.RETENTION_GENERATION_SEAL_REQUIRED,env.INSTALLATION_ID,env.OPERATIONAL_GENERATION,env.BRIDGE_SOURCE_EPOCH,env.BRIDGE_SOURCE_GENERATION];
   if(now.some((value,i)=>value!==frozen[i]))throw Error('archive_import_changed');
   return {installationId:env.INSTALLATION_ID!,generation:env.OPERATIONAL_GENERATION!,sourceEpoch:env.BRIDGE_SOURCE_EPOCH!,sourceGeneration:env.BRIDGE_SOURCE_GENERATION!};
  };
  const scope=activeOrigin(current);await assertRestoredGeneration(env);
  const retirement=configuredRetirementGuard(env);
  const guard=():AccessGuard=>{current();return {sql:`(
    (NOT EXISTS(SELECT 1 FROM assistant_retention_generation_seals WHERE installation_id=? AND generation=?) AND ?=0)
    OR EXISTS(SELECT 1 FROM assistant_retention_generation_seals s WHERE s.installation_id=? AND s.generation=? AND s.state='inactive_complete' AND s.seal=?
      AND EXISTS(SELECT 1 FROM assistant_retention_restore_sessions r WHERE r.installation_id=s.installation_id AND r.generation=s.generation AND r.ticket_hash=s.ticket_hash AND r.snapshot_seal=s.snapshot_seal AND r.state='inactive_complete' AND r.released=1)))`,
    values:[scope.installationId,scope.generation,env.RETENTION_GENERATION_SEAL_REQUIRED==='true'||!!env.RETENTION_GENERATION_SEAL?1:0,scope.installationId,scope.generation,env.RETENTION_GENERATION_SEAL??null]};};
  const materializer=new CaptureMaterializer(env.DB,current,env.CAPTURE_READER,env.BRIDGE_SECRET,Date.now,5000,{guard,beforeRead:async(id,key)=>{await retirement?.allow('whatsapp',key,id);await assertRestoredGeneration(env);}});
  return result(await materializer.importArchived(input));
 }catch(error){
  if(error instanceof Error&&error.message==='archive_import_input')return result({error:'archive_import_input'},400);
  // A commit acknowledgement may be missing. The operator must reconcile the
  // same canonical reference, preserving this outcome instead of claiming loss.
  return result({error:error instanceof Error&&error.message==='materialization_commit_uncertain'?'archive_import_commit_uncertain':'archive_import_unavailable'},503);
 }
}
