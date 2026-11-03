import {z} from 'zod';
import {SourceAccess} from '../access';
import {sourceRef} from '../source-proof-contract';
import {bridgeHash} from '../ingress';
import type {AssistantEnv} from '../env';
import type {NativeApplicationHost} from './native-host';

/** Server output fields with known administrative schemas, not text scraping.
 * Source's scope checks and original query still run before this admission. */
export async function administrativeToolReferences(host:NativeApplicationHost,env:AssistantEnv,tool:string,input:unknown,result:unknown){
 if(tool!=='assistente_consultar')return [];
 const query=(input as {query?:{kind?:unknown;id?:unknown}})?.query;if(!query||typeof query.kind!=='string')return [];
 const scope=host.currentScope(),access=new SourceAccess(env.DB!,scope,Date.now,'knowledge'),refs:z.infer<typeof sourceRef>[]=[];
 const values=((result as {content?:{type?:string;text?:string}[]})?.content??[]).filter(row=>row.type==='text'&&typeof row.text==='string').map(row=>{try{return JSON.parse(row.text!);}catch{return null;}}).filter(Boolean);
 async function source(id:unknown,revision:unknown){
  if(typeof id!=='string'||!Number.isSafeInteger(revision)||Number(revision)<1)throw Error('owner_tool_admin_source_missing');
  const read=await access.read({kind:'owner'},id,Number(revision));if(!read)throw Error('owner_tool_source_not_current');
  refs.push({id:read.id,revision:read.fence.source.revision,version:read.fence.source.version,hash:read.fence.source.hash});
 }
 if(['projects','missions','policies','mandates','follow_ups','follow_up'].includes(query.kind)){
  for(const value of values)for(const row of Array.isArray(value.items)?value.items:[value]){
   if(row&&typeof row==='object'&&(typeof row.objective==='string'||typeof row.purpose==='string'||typeof row.name==='string'||typeof row.title==='string')){
    if(row.source_id!==undefined||row.source_revision!==undefined)await source(row.source_id,row.source_revision);
    // Projects/policy names without source columns are owner-maintained metadata,
    // not captured source bodies. No invented source grant is fabricated here.
   }
  }
 }
 if(query.kind==='decision'&&typeof query.id==='string'&&values.some(value=>value.proposal)){
  const key=query.id.startsWith('decision:')?query.id.slice('decision:'.length):query.id;
  const row=await env.DB!.prepare(`SELECT dependencies_json,proposal_hash FROM assistant_shadow_decisions WHERE installation_id=? AND generation=? AND id=?`).bind(scope.installationId,scope.generation,key).first<{dependencies_json:string;proposal_hash:string}>();
  if(!row)throw Error('owner_tool_admin_source_missing');
  for(const value of values)if(value.proposal&&await bridgeHash(value.proposal)!==row.proposal_hash)throw Error('owner_tool_source_not_current');
  refs.push(...z.array(sourceRef).max(10).parse(JSON.parse(row.dependencies_json)));
 }
 return refs;
}
