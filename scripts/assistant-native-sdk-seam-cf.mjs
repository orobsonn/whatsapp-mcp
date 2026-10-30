/** Invoke only the disposable authenticated probe, never Own or OpenAI. */
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
export async function proveNativeSdkSeam(call){
 const proofs=[];
 for(const mode of ['error','normal']){
  const run=crypto.randomUUID(),invoke=(action,extra={})=>call({action:'sdk-seam-'+action,run,...extra});
  const setup=await invoke('setup',{mode}),due=await invoke('dispatch',{kind:'due'});
  assert.equal(due.state,'admitted');assert.deepEqual(await invoke('dispatch',{kind:'due'}),due);
  const deadline=Date.now()+20000;let inspect;
  do{inspect=await invoke('inspect');if(inspect.calls.some(c=>c.input_kind==='due'&&c.transports===1))break;if(Date.now()>deadline)throw Error('sdk_seam_transport_not_started');await new Promise(resolve=>setTimeout(resolve,100));}while(true);
  const owner=await invoke('dispatch',{kind:'owner'});assert.equal(owner.sessionId,due.sessionId);assert.deepEqual(await invoke('dispatch',{kind:'owner'}),owner);
  const queued=await invoke('inspect');assert.deepEqual(queued.consumed.map(c=>c.input_kind),['due']);
  await invoke('release');const first=await invoke('read',{taskRef:due.taskRef}),next=await invoke('read',{taskRef:owner.taskRef});
  assert.equal(first.outcome,mode==='error'?'failed':'succeeded');assert.equal(next.outcome,'succeeded');assert.equal(next.result.reply.text,mode==='error'?'CONTROLLED_SDK_SEAM_OWNER':'CONTROLLED_SDK_SEAM_DUE\n\nCONTROLLED_SDK_SEAM_OWNER');
  if(mode==='normal'){assert.equal(first.result.reply.text,next.result.reply.text);assert.deepEqual(first.result.reply.metadata.conversationCohort.taskRefs,[due.taskRef,owner.taskRef]);}
  inspect=await invoke('inspect');assert.deepEqual(inspect.consumed.map(c=>c.input_kind),['due','owner']);
  assert.equal(inspect.consumed[0].leader,due.receipt.submissionId);assert.equal(inspect.consumed[1].leader,mode==='error'?owner.receipt.submissionId:due.receipt.submissionId);
  assert.deepEqual(inspect.calls.filter(c=>c.transports>0).map(c=>[c.input_kind,c.transports]),[['due',1],['owner',1]]);assert.equal(inspect.modelReceipts.length,2);
  // Flue may resolve a transient-error continuation; cancelled authority must
  // reject it before reservation/transport. It is not a paid-model retry.
  const rejected=inspect.calls.filter(c=>c.transports===0);
  for(const call of rejected){assert.equal(mode,'error');assert.equal(call.input_kind,'due');assert.equal(call.leader,due.receipt.submissionId);assert.ok(!inspect.modelReceipts.some(receipt=>receipt.turn_id===call.turn_id));}
  assert.equal(inspect.paidModelCalls,0);assert.equal(inspect.externalModelCalls,0);
  assert.deepEqual(await invoke('dispatch',{kind:'due'}),due);assert.deepEqual(await invoke('dispatch',{kind:'owner'}),owner);
  const replay=await invoke('inspect');assert.deepEqual(replay.calls,inspect.calls);assert.deepEqual(replay.modelReceipts,inspect.modelReceipts);
  proofs.push({run,mode,guardRejectedResolutions:rejected.length,sessionId:setup.sessionId,due,owner,first,next,inspect,replayStable:true,ledger:'simulated-not-invoice'});
 }
 return {state:'verified-native-sdk-protocol',paidModelCalls:0,proofs};
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const url=process.env.SDK_SEAM_PROBE_URL,token=process.env.PROBE_BEARER;
 if(!url||!token)throw Error('SDK_SEAM_PROBE_URL and PROBE_BEARER are required locally');
 const call=async body=>{const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('sdk_seam_probe_http_'+response.status);return response.json();};
 console.log(JSON.stringify(await proveNativeSdkSeam(call),null,2));
}
