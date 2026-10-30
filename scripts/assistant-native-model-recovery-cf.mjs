/** Authenticated disposable CF fixture: real Flue and production adapter,
 * controlled provider only. No OpenAI credential, invoice or owner data. */
import assert from 'node:assert/strict';
export async function proveNativeModelRecovery(call){
 const proofs=[];
 for(const mode of ['uncertain','overflow','headroom']){
  const run=crypto.randomUUID(),invoke=(action,extra={})=>call({action:'sdk-seam-'+action,run,...extra});
  const setup=await invoke('setup',{mode});await invoke('release');
  const first=await invoke('dispatch',{kind:'due'}),reply=await invoke('read',{taskRef:first.taskRef});
  assert.equal(reply.outcome,mode==='uncertain'?'failed':'succeeded');
  let second;
  if(mode==='overflow'){
   const next=await invoke('dispatch',{kind:'owner'});second=await invoke('read',{taskRef:next.taskRef});assert.equal(second.outcome,'succeeded');
  }
  const inspect=await invoke('inspect');assert.equal(inspect.paidModelCalls,0);assert.equal(inspect.externalModelCalls,0);
  if(mode==='uncertain'){
   assert.equal(inspect.calls.reduce((n,c)=>n+c.transports,0),1,'uncertain POST must not cause new native paid turns');
   assert.equal(inspect.modelReceipts.length,1);assert.equal(inspect.modelReceipts[0].state,'uncertain');
   assert.equal((await invoke('read',{taskRef:first.taskRef})).outcome,'failed');
  }else{
   assert.ok(inspect.payloads.some(p=>p.compaction===1),'SDK must perform native compaction');
   assert.ok(inspect.modelReceipts.some(r=>r.state==='complete'));
   if(mode==='overflow')assert.equal(inspect.modelReceipts.filter(r=>r.state==='uncertain').length,1,'rejected original reservation must remain preserved');
   else{
    const beforeTransport=inspect.calls.filter(c=>c.transports===0);assert.ok(beforeTransport.length>=1,'headroom exhaustion must be caught before transport');
    for(const c of beforeTransport)assert.ok(!inspect.modelReceipts.some(r=>r.turn_id===c.turn_id),'preflight must not create a paid receipt');
    assert.ok(inspect.modelReceipts.every(r=>r.state==='complete'));
   }
  }
  assert.deepEqual(await invoke('dispatch',{kind:'due'}),first);const replay=await invoke('inspect');
  assert.deepEqual(replay.calls,inspect.calls);assert.deepEqual(replay.modelReceipts,inspect.modelReceipts);
  proofs.push({mode,run,setup,first,reply,second,inspect,replayStable:true});
 }
 return {state:'verified-native-model-recovery',paidModelCalls:0,proofs};
}
