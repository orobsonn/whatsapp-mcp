import type {AccessGuard,SourceAccess,SourceFence} from '../access';
import {activeOrigin,type OriginFence,type OriginGuard,type OriginScope} from '../origin-guard';
import {retentionExecutionGuard} from '../retention-execution';

export type ReadExposure={sources:SourceFence[];origins:OriginFence[]};
export type ContextOriginReader=Pick<OriginGuard,'fence'|'checkContext'|'localContextGuard'>;
/** Host-only live scope and native epoch authority. No permissive default. */
export type ReadPublicationBoundary={getScope:()=>OriginScope;authorityGuard:()=>AccessGuard};
const owner={kind:'owner'} as const;
const equalScope=(a:OriginScope,b:OriginScope)=>a.installationId===b.installationId&&a.generation===b.generation&&a.sourceEpoch===b.sourceEpoch&&a.sourceGeneration===b.sourceGeneration;
/** Call only AFTER every remote check, exposure write and asynchronous task
 * check. D1.batch checks the whole selected cohort in one relational snapshot.
 * Its return must be the final await before publishing any selected body.
 * Remote observations and this local snapshot are not a cross-worker commit. */
export async function assertReadExposureCurrent(db:D1Database,scope:OriginScope,access:SourceAccess,origin:ContextOriginReader,
 proof:ReadExposure,boundary:ReadPublicationBoundary,denied:string,additional:AccessGuard[]=[]){
 const assertScope=()=>{if(!equalScope(scope,activeOrigin(boundary.getScope)))throw Error(denied);};
 assertScope();
 const control=[retentionExecutionGuard(scope),boundary.authorityGuard()];
 const groups:AccessGuard[][]=[control,...proof.sources.map(fence=>{
  const origins=proof.origins.filter(item=>item.canonicalId===fence.source.id);
  if(fence.source.origin==='whatsapp'&&origins.length!==1||origins.some(item=>item.revision!==fence.source.revision||item.version!==fence.source.version))throw Error(denied);
  return [access.guard(owner,fence,Date.now()),...origins.map(item=>origin.localContextGuard(item))];
 }),...additional.map(guard=>[guard])];
 if(proof.origins.some(item=>!proof.sources.some(fence=>fence.source.id===item.canonicalId&&fence.source.origin==='whatsapp')))throw Error(denied);
 const statements=groups.map(guards=>db.prepare(`SELECT 1 AS current WHERE ${guards.map(guard=>`(${guard.sql})`).join(' AND ')}`).bind(...guards.flatMap(guard=>guard.values)));
 const results=await db.batch(statements);
 // Synchronous only after the final database snapshot, including live affinity.
 assertScope();
 if(results.length!==statements.length||results.some(result=>result.results.length!==1))throw Error(denied);
}
