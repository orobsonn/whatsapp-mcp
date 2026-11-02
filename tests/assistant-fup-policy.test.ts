import { env } from 'cloudflare:test';
import { beforeEach, it, expect, vi, afterEach } from 'vitest';
import { OwnerControl, ownerCommandSchema,captureWorkFence,workGuard,workIntentGuard } from '../assistant/control';
import { SourceController } from '../assistant/sources';
import { dueFollowUpGuard,FollowUps } from '../assistant/followups';
let scope: {installationId:string;generation:string;sourceEpoch:string;sourceGeneration:string}, control:OwnerControl, source:{id:string;revision:number};
const sql=(query:string,...args:(string|number|null)[])=>env.DB.prepare(query).bind(scope.installationId,scope.generation,...args);
const command=(extra:Record<string,unknown>={})=>({kind:'fup.put',operationId:'private-reminder',id:'private-reminder',expectedVersion:0,conversationId:'group',policyRevision:0,source,
 purpose:'Synthetic private owner reminder; no group message',dueAt:2000,timezone:'UTC',precision:'exact',state:'scheduled',...extra});
beforeEach(async()=>{
 scope={installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:'capture-e',sourceGeneration:'capture-g'};
 control=new OwnerControl(env.DB,scope,{kind:'owner'},()=>1000);
 source=await new SourceController(env.DB,scope,{kind:'owner'}).create({originKey:'owner-note',text:'Synthetic explicit owner request',occurredAt:100,audience:'owner'});
 source={id:source.id,revision:1};
 await sql("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,'group',1,'group','available')",scope.sourceEpoch,scope.sourceGeneration).run();
});
afterEach(()=>vi.restoreAllMocks());
const policy=async(mode='observe',excluded=0)=>sql("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded,group_mode,revision) VALUES(?,?,'group','group',?,?,1)",excluded,mode).run();
async function live(){const g=dueFollowUpGuard(scope,{id:'private-reminder',version:1},source,2000);return !!await env.DB.prepare('SELECT 1 WHERE '+g.sql).bind(...g.values).first();}
it('records an owner-private reminder with atomic absence and no policy, mandate, job or sending authority',async()=>{
 const first=await control.execute(command());expect(await control.execute(command())).toEqual(first);
 expect(await sql('SELECT COUNT(*) n FROM assistant_follow_ups WHERE installation_id=? AND generation=?').first('n')).toBe(1);
 for(const table of ['assistant_conversation_policies','assistant_mandates','assistant_jobs','assistant_native_task_bindings'])expect(await sql(`SELECT COUNT(*) n FROM ${table} WHERE installation_id=? AND generation=?`).first('n')).toBe(0);
 const body=JSON.parse((await sql('SELECT body_json FROM assistant_fup_provenance WHERE installation_id=? AND generation=?').first<string>('body_json'))!);
 expect(body.ownerReminder).toEqual({policyRevision:0});expect(body.outgoing).toBeUndefined();expect(await live()).toBe(true);
});
it.each(['observe','respond','ignore'])('revision 0 cannot bypass an existing %s policy',async mode=>{
 await policy(mode);await expect(control.execute(command())).rejects.toThrow('control_policy_revision');
 expect(await sql('SELECT COUNT(*) n FROM assistant_follow_ups WHERE installation_id=? AND generation=?').first('n')).toBe(0);
});
it('requires the exact positive revision and preserves exclusions and explicit ignore',async()=>{
 await policy();await expect(control.execute(command({policyRevision:2}))).rejects.toThrow('control_policy_revision');
 await expect(control.execute(command({policyRevision:1}))).resolves.toMatchObject({version:1});
 for(const [index,extra]of [{excluded:1,group_mode:'observe'},{excluded:0,group_mode:'ignore'}].entries()){
  await env.DB.prepare('UPDATE assistant_conversation_policies SET excluded=?,group_mode=? WHERE installation_id=? AND generation=?').bind(extra.excluded,extra.group_mode,scope.installationId,scope.generation).run();
  await expect(control.execute(command({id:'denied-'+index,operationId:'denied-'+index,policyRevision:1}))).rejects.toThrow('control_policy_restricted');
 }
});
it('rejects a policy created between the read and the ledger transaction without recording a receipt',async()=>{
 const batch=env.DB.batch.bind(env.DB);const race=vi.spyOn(env.DB,'batch').mockImplementationOnce(async statements=>{race.mockRestore();await policy();return batch(statements);});
 await expect(control.execute(command())).rejects.toThrow('control_policy_revision');
 expect(await sql('SELECT COUNT(*) n FROM assistant_follow_ups WHERE installation_id=? AND generation=?').first('n')).toBe(0);
 expect(await sql('SELECT COUNT(*) n FROM assistant_owner_commands WHERE installation_id=? AND generation=?').first('n')).toBe(0);
});
it.each(['observe','respond'])('a %s policy created after registration invalidates the absence fence, never falls through to legacy permissions',async mode=>{
 await control.execute(command());expect(await live()).toBe(true);await policy(mode);expect(await live()).toBe(false);
});
it.each(['unknown','withdrawn','paused','quarantine'])('preserves the existing %s target restriction',async restriction=>{
 if(restriction==='unknown')await sql('DELETE FROM assistant_origin_conversations WHERE installation_id=? AND generation=?').run();
 if(restriction==='withdrawn')await sql("UPDATE assistant_origin_conversations SET access_state='withdrawn' WHERE installation_id=? AND generation=?").run();
 if(restriction==='paused')await sql("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,paused,policy_revision,mode) VALUES(?,?,?,?,'group',1,0,'ignore')",scope.sourceEpoch,scope.sourceGeneration).run();
 if(restriction==='quarantine')await sql("INSERT INTO assistant_retention_quarantines(installation_id,generation,kind,record_key,conversation_id,version,active,reason,snapshot_seal) VALUES(?,?,'policy','group','group',1,1,'synthetic',?)",'a'.repeat(64)).run();
 await expect(control.execute(command())).rejects.toThrow(restriction==='quarantine'?'control_policy_restricted':'control_conversation_unavailable');
});
it.each(['paused','withdrawn','source'])('a later %s restriction invalidates a registered private reminder',async restriction=>{
 await control.execute(command());
 if(restriction==='paused')await sql("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,paused,policy_revision,mode) VALUES(?,?,?,?,'group',1,0,'ignore')",scope.sourceEpoch,scope.sourceGeneration).run();
 if(restriction==='withdrawn')await sql("UPDATE assistant_origin_conversations SET access_state='withdrawn' WHERE installation_id=? AND generation=?").run();
 if(restriction==='source')await new SourceController(env.DB,scope,{kind:'owner'}).execute({kind:'source.withdraw',operationId:'withdraw',id:source.id,expectedRevision:1});
 expect(await live()).toBe(false);
});
it('does not use a group-associated note or candidate to grant access through the private exception',async()=>{
 const linked=await new SourceController(env.DB,scope,{kind:'owner'}).create({originKey:'linked',text:'Untrusted group context',occurredAt:100,conversationId:'group',audience:'owner'});
 await expect(control.execute(command({source:{id:linked.id,revision:1}}))).rejects.toThrow('control_source_private_required');
 await expect(control.execute(command({candidate:{batchKey:'untrusted',claimIndex:0}}))).rejects.toThrow('control_source_private_required');
});
it('keeps source input limited to id and revision, deriving version and hash only on the server',async()=>{
 expect(ownerCommandSchema.safeParse(command()).success).toBe(true);
 for(const extra of [{version:1},{hash:'a'.repeat(64)}]){
  expect(ownerCommandSchema.safeParse(command({source:{...source,...extra}})).success).toBe(false);
  await expect(control.execute(command({source:{...source,...extra}}))).rejects.toThrow('control_source_reference');
 }
});
it('respects pause even with a matching positive revision',async()=>{
 await policy();await sql("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,paused,policy_revision,mode) VALUES(?,?,?,?,'group',1,1,'observe')",scope.sourceEpoch,scope.sourceGeneration).run();
 await expect(control.execute(command({policyRevision:1}))).rejects.toThrow('control_conversation_unavailable');
});
it('does not turn retention hold or an obsolete namespace into absent-policy permission',async()=>{
 const other=new OwnerControl(env.DB,{...scope,sourceGeneration:'obsolete'},{kind:'owner'},()=>1000);
 await expect(other.execute(command())).rejects.toThrow('control_conversation_unavailable');
 await env.DB.prepare('INSERT INTO assistant_retention_runtime_hold VALUES(?,?,?,1,?)').bind(scope.installationId,'hold','next',1000).run();
 await expect(control.execute(command())).rejects.toThrow('control_conversation_unavailable');
});
it('rechecks the absence fence when a legacy job is claimed or publishes after computation',async()=>{
 await control.execute(command());const admitted=await new FollowUps(env.DB,scope,{clock:()=>2000}).admitDue();
 const jobId=admitted.items[0].jobId!;expect(jobId).toBeTruthy();
 const fence=(await captureWorkFence(env.DB,scope,{id:jobId,kind:'follow_up'},2000))!;expect(fence).not.toBeNull();
 const allowed=workGuard(fence,2000,scope);expect(await env.DB.prepare('SELECT 1 WHERE '+allowed.sql).bind(...allowed.values).first()).not.toBeNull();
 const unknownScope=workGuard(fence,2000);expect(await env.DB.prepare('SELECT 1 WHERE '+unknownScope.sql).bind(...unknownScope.values).first()).toBeNull();
 const foreign=workIntentGuard(fence,2000,{...scope,sourceGeneration:'foreign'});expect(await env.DB.prepare('SELECT 1 WHERE '+foreign.sql).bind(...foreign.values).first()).toBeNull();
 const intent=workIntentGuard(fence,2000,scope);expect(await env.DB.prepare('SELECT 1 WHERE '+intent.sql).bind(...intent.values).first()).not.toBeNull();
 await policy('respond');expect(await captureWorkFence(env.DB,scope,{id:jobId,kind:'follow_up'},2000)).toBeNull();
 for(const guard of [workGuard(fence,2000,scope),workIntentGuard(fence,2000,scope)])expect(await env.DB.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.values).first()).toBeNull();
});
it('reports a withdrawn source as source failure and never creates a replacement',async()=>{
 await new SourceController(env.DB,scope,{kind:'owner'}).execute({kind:'source.withdraw',operationId:'withdraw-before-create',id:source.id,expectedRevision:1});
 await expect(control.execute(command())).rejects.toThrow('control_source_unavailable');
 expect(await sql('SELECT COUNT(*) n FROM assistant_follow_ups WHERE installation_id=? AND generation=?').first('n')).toBe(0);
});
