import {env} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import {SourceController} from '../assistant/sources';
import {SourceAccess} from '../assistant/access';
import {OwnerControl} from '../assistant/control';
import {Relations} from '../assistant/relations';
import {Retrieval} from '../assistant/retrieval';
const owner={kind:'owner'} as const,guest={kind:'interlocutor',provider:'whatsapp',address:'synthetic-guest',conversationId:'chat',conversationKind:'private',action:'reply_text'} as const;
let scope:{installationId:string;generation:string},sourceId:string,relations:Relations,now:number;
const privateKey=(i:number)=>'canonical-owner-v2:'+i.toString(16).padStart(64,'0');
beforeEach(async()=>{
 scope={installationId:crypto.randomUUID(),generation:'g1'};now=Date.now();const control=new OwnerControl(env.DB,scope,owner,()=>now);for(const id of ['public-project','private-project'])await control.execute({kind:'project.put',operationId:id,id,expectedVersion:0,name:id});
 sourceId=(await new SourceController(env.DB,scope,owner,()=>now).create({originKey:'original',audience:'public',text:'Public original quote.',occurredAt:now})).id;relations=new Relations(env.DB,scope);await batch('legacy','public-project');
});
async function batch(key:string,project='private-project'){
 const source=(await new SourceAccess(env.DB,scope).read(owner,sourceId))!;await relations.publish({key,sourceId,revision:1,version:1,hash:source.fence.source.hash,claims:[{kind:'suggestion',subject:{kind:'project',id:project},predicate:'candidate',quote:source.text!}]});
}
async function fingerprint(){const q=new SourceAccess(env.DB,scope).inventory(guest,undefined,now);return env.DB.prepare('SELECT fingerprint FROM ('+q.sql+') WHERE id=?').bind(...q.values,sourceId).first<string>('fingerprint');}
it('hides missing-proof Owner batches before read LIMIT/overflow and does not leak their existence in guest inventory or scores',async()=>{
 const before=await fingerprint();for(let i=0;i<17;i++)await batch(privateKey(i));
 expect(await relations.read(guest,sourceId)).toHaveLength(1);expect(await relations.read(owner,sourceId)).toHaveLength(1);expect(await fingerprint()).toBe(before);
 const source=(await new SourceAccess(env.DB,scope).read(guest,sourceId))!;expect(await new Retrieval(env.DB,scope).scoreOriginal(source,{query:'absent',entities:[{kind:'project',id:'private-project'}]})).toMatchObject({score:0,linked:false,gaps:[]});
});
// @ts-expect-error Vite SQL asset.
import contextMigration from '../assistant/migrations/0027_owner_canonical_context.sql?raw';
it('applies migration27 repeatedly and permanently refuses to rename an Owner key into legacy source visibility',async()=>{
 for(let i=0;i<2;i++)await env.DB.batch(contextMigration.replace(/^--.*$/gm,'').trim().split(/;\s*(?=CREATE|$)/).filter((q:string)=>q.trim()).map((q:string)=>env.DB.prepare(q)));
 const key=privateKey(1);await batch(key);await expect(env.DB.prepare('UPDATE assistant_relation_batches SET operation_key=? WHERE installation_id=? AND generation=? AND operation_key=?').bind('promoted',scope.installationId,scope.generation,key).run()).rejects.toThrow('owner_relation_marker_immutable');expect(await relations.read(guest,sourceId)).toHaveLength(1);
});
it('pins support sidecars to the exact namespace/slot and preserves the single attempt after proof deletion',async()=>{
 const key=privateKey(2),pin='a'.repeat(64),source=(await new SourceAccess(env.DB,scope).read(owner,sourceId))!;
 await env.DB.prepare(`INSERT INTO assistant_canonical_extractions(installation_id,generation,source_id,source_revision,source_version,source_hash,slot_key,pin_hash,config_hash,actor_json,fence_json,catalog_json,payload_json,period,state,created_at) VALUES(?,?,?,1,1,?,?,?,?,'{"kind":"owner"}',?,'[]','{}','fixture','prepared',?)`).bind(scope.installationId,scope.generation,sourceId,source.fence.source.hash,key,pin,'b'.repeat(64),JSON.stringify(source.fence),now).run();
 const support=(p:string)=>env.DB.prepare('INSERT INTO assistant_owner_canonical_supports VALUES(?,?,?,1,?,?,?,?)').bind(scope.installationId,scope.generation,sourceId,key,p,'c'.repeat(64),'{}').run();await expect(support('d'.repeat(64))).rejects.toThrow();await support(pin);
 await expect(env.DB.prepare('UPDATE assistant_owner_canonical_supports SET proof_json=? WHERE installation_id=? AND generation=?').bind('{"changed":true}',scope.installationId,scope.generation).run()).rejects.toThrow('owner_context_proof_immutable');await env.DB.prepare('DELETE FROM assistant_owner_canonical_supports WHERE installation_id=? AND generation=?').bind(scope.installationId,scope.generation).run();expect(await env.DB.prepare('SELECT slot_key FROM assistant_canonical_extractions WHERE installation_id=? AND generation=? AND source_id=?').bind(scope.installationId,scope.generation,sourceId).first('slot_key')).toBe(key);
 await expect(env.DB.prepare('UPDATE assistant_canonical_extractions SET slot_key=? WHERE installation_id=? AND generation=? AND source_id=?').bind('canonical-new-key',scope.installationId,scope.generation,sourceId).run()).rejects.toThrow('owner_context_slot_immutable');
});
