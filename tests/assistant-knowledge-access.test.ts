import { env } from 'cloudflare:test';
import { beforeEach, expect, it } from 'vitest';
import { SourceAccess } from '../assistant/access';
import { SourceController } from '../assistant/sources';
import { sourceFence } from '../assistant/source-proof-contract';
import type { OriginScope } from '../assistant/origin-guard';
let scope: OriginScope, knowledge: SourceAccess, archive: SourceAccess, sources: SourceController;
const owner = { kind: 'owner' } as const;
const sql = (query: string, ...values: (string|number|null)[]) => env.DB.prepare(query).bind(scope.installationId, scope.generation, ...values);
beforeEach(() => {
 scope={installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:'epoch',sourceGeneration:'source-g1'};
 knowledge=new SourceAccess(env.DB,scope,()=>100,'knowledge');
 archive=new SourceAccess(env.DB,scope,()=>100);
 sources=new SourceController(env.DB,scope,owner,()=>100);
});
async function original(chat: string, kind: 'private'|'group') {
 const note=await sources.create({originKey:chat,text:'Synthetic original about Cedar',conversationId:chat,occurredAt:1});
 await sql("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=? AND id=?",note.id).run();
 await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?, ?,?,1,?,'available')",scope.sourceEpoch,scope.sourceGeneration,chat,kind).run();
 await sql("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,tombstoned) VALUES(?,?,?,?,'message',?,?,?,1,0)",scope.sourceEpoch,scope.sourceGeneration,chat+'-message',chat,note.id).run();
 return note;
}
it('knowledge admits private conversations by default and groups only after explicit inclusion',async()=>{
 const direct=await original('direct','private'),group=await original('group','group');
 expect((await knowledge.read(owner,direct.id))?.text).toContain('Cedar');
 expect(await knowledge.read(owner,group.id)).toBeNull();
 await sql("INSERT INTO assistant_conversation_policies VALUES(?,?,'group','group',0,'observe',1)").run();
 expect((await knowledge.read(owner,group.id))?.text).toContain('Cedar');
});
it('exclusion denies original, inventory and stale knowledge fence while preserving the captured original',async()=>{
 const direct=await original('direct','private');const read=(await knowledge.read(owner,direct.id))!;
 await sql("INSERT INTO assistant_conversation_policies VALUES(?,?,'direct','private',1,'ignore',1)").run();
 expect(await knowledge.read(owner,direct.id)).toBeNull();
 expect(await knowledge.revalidate(owner,read.fence)).toBe(false);
 const inventory=knowledge.inventory(owner,undefined,100,{includePaused:true});
 expect((await env.DB.prepare(inventory.sql).bind(...inventory.values).all()).results).toEqual([]);
 expect((await archive.read(owner,direct.id))?.text).toContain('Cedar');
});
it('knowledge denies absent, withdrawn or foreign-generation conversation metadata',async()=>{
 const direct=await original('direct','private');
 await sql("UPDATE assistant_origin_conversations SET source_generation='other' WHERE installation_id=? AND generation=?").run();
 expect(await knowledge.read(owner,direct.id)).toBeNull();
 await sql("UPDATE assistant_origin_conversations SET source_generation=?,access_state='withdrawn' WHERE installation_id=? AND generation=?",scope.sourceGeneration).run();
 expect(await knowledge.read(owner,direct.id)).toBeNull();
});
it('independent owner context remains usable when an unrelated conversation is excluded',async()=>{
 await original('excluded','private');await sql("INSERT INTO assistant_conversation_policies VALUES(?,?,'excluded','private',1,'ignore',1)").run();
 const independent=await sources.create({originKey:'independent-owner-context',text:'Independent synthetic context about Cedar',occurredAt:1});
 expect((await knowledge.read(owner,independent.id))?.text).toContain('Independent');
});
it('excluding and reincluding a conversation does not revive an old knowledge fence',async()=>{
 const direct=await original('direct','private');const old=(await knowledge.read(owner,direct.id))!;
 await sql("INSERT INTO assistant_conversation_policies VALUES(?,?,'direct','private',1,'ignore',1)").run();
 await sql("UPDATE assistant_conversation_policies SET excluded=0,revision=2 WHERE installation_id=? AND generation=?").run();
 expect(await knowledge.read(owner,direct.id)).not.toBeNull();
 expect(await knowledge.revalidate(owner,old.fence)).toBe(false);
 const guard=knowledge.guard(owner,old.fence,100);
 expect((await env.DB.prepare('SELECT ('+guard.sql+') allowed').bind(...guard.values).first<{allowed:number}>())?.allowed).toBe(0);
});
it('restored sharing authority stays visible internally and cannot be used as an archive or legacy authority fence',async()=>{
 const source=await sources.create({originKey:'restored-note',text:'Restored synthetic owner context',audience:'restricted',occurredAt:1});
 const before=(await knowledge.read(owner,source.id))!;
 await sql("INSERT INTO assistant_retention_quarantines(installation_id,generation,kind,record_key,source_id,version,active,reason,snapshot_seal) VALUES(?,?,'source_authorization',?,?,1,1,'snapshot_reproof_required','synthetic-seal')",source.id,source.id).run();
 const restored=(await knowledge.read(owner,source.id))!;
 expect(restored.text).toContain('Restored');
 expect(restored.fence.knowledge?.sharingQuarantined).toBe(true);
 expect(await knowledge.revalidate(owner,before.fence)).toBe(false);
 expect(await archive.revalidate(owner,restored.fence)).toBe(false);
 expect((await archive.read(owner,source.id))?.text).toContain('Restored');
});

it('a knowledge fence remains valid after the actual typed contract reorders its fields',async()=>{
 const direct=await original('direct','private');const read=(await knowledge.read(owner,direct.id))!;
 const parsed=sourceFence.parse(read.fence);
 expect(await knowledge.revalidate(owner,parsed)).toBe(true);
 expect(await knowledge.revalidate(owner,{...parsed,source:{...parsed.source,hash:'f'.repeat(64)}})).toBe(false);
});
