import {env} from 'cloudflare:test';
import {it,expect,vi} from 'vitest';
import {SourceController} from '../assistant/sources';
import {OriginGuard,type OriginFence,type SnapshotReader} from '../assistant/origin-guard';
import {observeSnapshot,type SnapshotProofPage,type CaptureIdentity} from '../src/capture-snapshot-contract';
import {NativeConversationRetention} from '../assistant/agent-runtime/conversation-retention';
import {SourceAccess} from '../assistant/access';
import {conversationAddress,type ConversationIdentity} from '../assistant/agent-runtime/conversation';

async function fixture(size=2){
 const scope={installationId:crypto.randomUUID(),generation:'own',sourceEpoch:'source-e',sourceGeneration:'source-g'},secret='synthetic-proof-secret';
 const snapshots=new Map<string,unknown>(),fences:OriginFence[]=[];
 const readSnapshot=vi.fn(async(q:{sourceId:string})=>snapshots.get(q.sourceId));
 const readSnapshotProofs=vi.fn(async(q:{refs:CaptureIdentity[]})=>{
  const items=[];for(const ref of q.refs){const {content,...proof}=await observeSnapshot(snapshots.get(ref.sourceId),{...scope,...ref});items.push({sourceKind:ref.sourceKind,sourceId:ref.sourceId,chatId:ref.chatId,...proof});}
  return {observation:'capture_snapshot_proofs',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,items} as SnapshotProofPage;
 });
 const port={readSnapshot,readSnapshotProofs} as unknown as SnapshotReader,guard=new OriginGuard(env.DB,()=>scope,port,secret);
 await env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,'private','available')").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,'source-chat').run();
 for(let i=0;i<size;i++){
  const source=await new SourceController(env.DB,scope,{kind:'owner'}).createReport({originKey:'proof-'+i,text:'Synthetic original '+i,occurredAt:1}),sourceId='source-'+i;
  snapshots.set(sourceId,{observation:'capture_snapshot',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:'message',sourceId,chatId:'source-chat',sourceVersion:1,watermark:1,conversationKind:'private',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text:'Synthetic original '+i,messageId:sourceId,messageVersion:1}});
  const observed=await guard.observe(scope,{sourceKind:'message',sourceId,chatId:'source-chat'});
  await env.DB.batch([
   env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp',conversation_id='source-chat' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId,scope.generation,source.id),
   env.DB.prepare("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,observation_hash,tombstoned) VALUES(?,?,?,?,'message',?,'source-chat',?,1,?,0)").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,sourceId,source.id,observed.hash),
  ]);
  fences.push((await guard.fence(source.id))!);
 }
 readSnapshot.mockClear();return {scope,secret,guard,port,fences,snapshots,readSnapshot,readSnapshotProofs};
}
it('checks a reordered hash-only page with one RPC and no singular fallback',async()=>{
 const f=await fixture(),original=f.readSnapshotProofs.getMockImplementation()!;f.readSnapshotProofs.mockImplementation(async q=>{const result=await original(q);if(result.state==='available')result.items.reverse();return result;});
 expect(await f.guard.checkContexts(f.fences)).toMatchObject({state:'current',proofPages:1});expect(f.readSnapshotProofs).toHaveBeenCalledOnce();expect(f.readSnapshot).not.toHaveBeenCalled();
});
it.each(['missing','duplicate','extra','identity','scope','timeout'] as const)('denies a %s proof page without multiplying calls or purging by assumption',async mode=>{
 const f=await fixture(),original=f.readSnapshotProofs.getMockImplementation()!;
 f.readSnapshotProofs.mockImplementation(async q=>{if(mode==='timeout')throw Error('reader_timeout');const result=await original(q);if(result.state!=='available')return result;
  if(mode==='missing')result.items.pop();if(mode==='duplicate')result.items[1]={...result.items[0]};if(mode==='extra')result.items.push({...result.items[0],sourceId:'extra'});
  if(mode==='identity')result.items[0].chatId='different-chat';if(mode==='scope')result.sourceGeneration='different';return result;});
 expect(await f.guard.checkContexts(f.fences)).toMatchObject({state:'unavailable'});expect(f.readSnapshotProofs).toHaveBeenCalledOnce();expect(f.readSnapshot).not.toHaveBeenCalled();
});
it('rechecks the first local fence after the last remote proof is read',async()=>{
 const f=await fixture(),original=f.readSnapshotProofs.getMockImplementation()!;
 f.readSnapshotProofs.mockImplementation(async q=>{const result=await original(q);await env.DB.prepare("UPDATE assistant_sources SET status='withdrawn',revision=revision+1 WHERE installation_id=? AND generation=? AND id=?").bind(f.scope.installationId,f.scope.generation,f.fences[0].canonicalId).run();return result;});
 expect(await f.guard.checkContexts(f.fences)).toMatchObject({state:'changed'});
});
it('rejects a changed remote digest and respects later chat activity alone',async()=>{
 const f=await fixture(),first=f.snapshots.get('source-0') as {watermark:number;content:{text:string}};first.watermark=2;
 expect(await f.guard.checkContexts(f.fences)).toMatchObject({state:'current'});first.content.text='Changed original';expect(await f.guard.checkContexts(f.fences)).toMatchObject({state:'changed'});
});
it('checks cancellation after the RPC and before any post-fence query',async()=>{
 const f=await fixture(),original=f.readSnapshotProofs.getMockImplementation()!,controller=new AbortController();
 f.readSnapshotProofs.mockImplementation(async q=>{const result=await original(q);controller.abort(Error('proof_cancelled'));return result;});
 await expect(f.guard.checkContexts(f.fences,controller.signal)).rejects.toThrow('proof_cancelled');expect(f.readSnapshot).not.toHaveBeenCalled();
});
it('accepts a valid proof delayed six seconds using the same single RPC',async()=>{
 const f=await fixture(),original=f.readSnapshotProofs.getMockImplementation()!;
 let begin!:()=>void;const started=new Promise<void>(resolve=>{begin=resolve;});
 f.readSnapshotProofs.mockImplementation(async q=>{begin();await new Promise(resolve=>setTimeout(resolve,6000));return original(q);});
 const pending=f.guard.checkContexts(f.fences);await started;
 expect(await pending).toMatchObject({state:'current',proofPages:1});expect(f.readSnapshotProofs).toHaveBeenCalledOnce();
});
it('denies a pending page after fifteen seconds and ignores its late success',async()=>{
 const f=await fixture(),original=f.readSnapshotProofs.getMockImplementation()!;
 let begin!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>{begin=resolve;});
 f.readSnapshotProofs.mockImplementation(async q=>{begin();await new Promise<void>(resolve=>{release=resolve;});return original(q);});
 const pending=f.guard.checkContexts(f.fences);await started;let settled=false;void pending.then(()=>{settled=true;});
 await new Promise(resolve=>setTimeout(resolve,6000));expect(settled).toBe(false);
 expect(await pending).toMatchObject({state:'unavailable',proofPages:1});
 release();await Promise.resolve();expect(f.readSnapshotProofs).toHaveBeenCalledOnce();expect(f.readSnapshot).not.toHaveBeenCalled();
});
it('cancels an in-flight proof immediately without waiting for its RPC deadline',async()=>{
 const f=await fixture(),controller=new AbortController();let begin!:()=>void;
 const started=new Promise<void>(resolve=>{begin=resolve;});f.readSnapshotProofs.mockImplementation(async()=>{begin();return new Promise<never>(()=>{});});
 const pending=f.guard.checkContexts(f.fences,controller.signal);await started;
 const outcome=pending.then(()=> 'unexpected',error=>error.message);controller.abort(Error('proof_cancelled'));
 expect(await Promise.race([outcome,new Promise(resolve=>setTimeout(()=>resolve('still_waiting'),100))])).toBe('proof_cancelled');
 expect(f.readSnapshotProofs).toHaveBeenCalledOnce();
});
it('uses the singular adapter only when proof-page capability is absent',async()=>{
 const f=await fixture(),legacy=new OriginGuard(env.DB,()=>f.scope,{readSnapshot:f.readSnapshot},f.secret);
 expect(await legacy.checkContexts(f.fences)).toMatchObject({state:'current',proofPages:0,singularChecks:2});expect(f.readSnapshot).toHaveBeenCalledTimes(2);
});
it.each(['media_unavailable','snapshot_changed','private provider details'] as const)('reports a blocked item with a closed reason (%s) and its page ordinal',async reason=>{
 const f=await fixture(),original=f.readSnapshotProofs.getMockImplementation()!,diagnostic=vi.fn();
 f.readSnapshotProofs.mockImplementation(async q=>{const result=await original(q);if(result.state==='available')result.items[0]={...result.items[0],state:'blocked',reason,hash:null};return result;});
 expect(await f.guard.checkContexts(f.fences,undefined,diagnostic)).toMatchObject({state:'unavailable'});
 expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({phase:'reader_rpc',reason:reason==='private provider details'?'exception':reason}),0);
 expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private provider details');expect(f.readSnapshot).not.toHaveBeenCalled();
});

async function retainedPageFixture(size:number){
 const f=await fixture(size),identity:ConversationIdentity={version:1,installationId:f.scope.installationId,generation:f.scope.generation,channel:'telegram',principalOrChatId:'owner',contextEpoch:'proof-pages'};
 const destroy=vi.fn(async()=>{}),retention=new NativeConversationRetention(env.DB,()=>f.scope,f.guard,{async abort(){},async quiesce(){},destroy});
 await retention.register(identity);const sessionId=await conversationAddress(identity,identity.channel,identity.principalOrChatId,identity.contextEpoch),access=new SourceAccess(env.DB,f.scope,Date.now,'knowledge');
 for(let i=0;i<f.fences.length;i++){
  const origin=f.fences[i],source=(await access.read({kind:'owner'},origin.canonicalId))!.fence;
  await env.DB.prepare('INSERT INTO assistant_native_context_exposures(id,installation_id,generation,conversation_id,source_id,source_fence_json,origin_fence_json,created_at) VALUES(?,?,?,?,?,?,?,1)')
   .bind(String(i).padStart(5,'0')+':'+sessionId,f.scope.installationId,f.scope.generation,sessionId,origin.canonicalId,JSON.stringify(source),JSON.stringify(origin)).run();
 }
 return {...f,identity,sessionId,retention,destroy};
}
it('checks every retained origin over multiple hash-only pages without singular RPCs',async()=>{
 const f=await retainedPageFixture(130);await f.retention.assertCurrent(f.identity);
 expect(f.readSnapshotProofs).toHaveBeenCalledTimes(3);expect(f.readSnapshot).not.toHaveBeenCalled();expect(f.destroy).not.toHaveBeenCalled();
 expect(f.readSnapshotProofs.mock.calls.map(([q])=>q.refs.length)).toEqual([64,64,2]);
});
it('checks the full relational context after the last remote page and purges a withdrawn first source',async()=>{
 const f=await retainedPageFixture(65),original=f.readSnapshotProofs.getMockImplementation()!;let calls=0;
 f.readSnapshotProofs.mockImplementation(async q=>{const result=await original(q);if(++calls===2)await new SourceController(env.DB,f.scope,{kind:'owner'}).withdraw(f.fences[0].canonicalId,1);return result;});
 await expect(f.retention.assertCurrent(f.identity)).rejects.toThrow('conversation_context_withdrawn');expect(calls).toBe(2);expect(f.destroy).toHaveBeenCalledOnce();
});
it('stops a cancelled page before another RPC and does not mistake cancellation for withdrawal',async()=>{
 const f=await retainedPageFixture(130),original=f.readSnapshotProofs.getMockImplementation()!,controller=new AbortController();let calls=0;
 f.readSnapshotProofs.mockImplementation(async q=>{const result=await original(q);if(++calls===2)controller.abort(Error('proof_cancelled'));return result;});
 await expect(f.retention.assertCurrent(f.identity,controller.signal)).rejects.toThrow('proof_cancelled');expect(calls).toBe(2);expect(f.destroy).not.toHaveBeenCalled();expect(f.readSnapshot).not.toHaveBeenCalled();
});
it('keeps the native context intact and blocks use when a proof page is incomplete',async()=>{
 const f=await retainedPageFixture(2),original=f.readSnapshotProofs.getMockImplementation()!;
 f.readSnapshotProofs.mockImplementation(async q=>{const result=await original(q);if(result.state==='available')result.items.pop();return result;});
 await expect(f.retention.assertCurrent(f.identity)).rejects.toThrow('conversation_context_unavailable');expect(f.destroy).not.toHaveBeenCalled();expect(f.readSnapshot).not.toHaveBeenCalled();
});
