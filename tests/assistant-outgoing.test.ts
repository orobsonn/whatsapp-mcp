import {env,applyD1Migrations,createExecutionContext} from 'cloudflare:test';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {Env} from '../src/env';
import {resolveRecipient} from '../src/recipients';
import {readRecipientEnvelope} from '../src/assistant-recipient-reader';
import {SourceController} from '../assistant/sources';
import {OwnerAssistant} from '../assistant/mcp';
import {FollowUps} from '../assistant/followups';
import {SourceAccess} from '../assistant/access';
import {JobQueue} from '../assistant/queue';
import {EpisodeController,type EpisodeDriver,type EpisodeSearch} from '../assistant/agent/controller';
import {RetrievalRuns} from '../assistant/retrieval-runs';
import {InferenceBudget} from '../assistant/budget';
import {DEFAULT_BROKER_CONFIG} from '../assistant/model-transport';
import {DecisionJournal} from '../assistant/decisions';
import {OwnerControl} from '../assistant/control';
import {outgoingPort} from '../assistant/outgoing';
import {uploadMedia} from '../src/media';
import {setCapture} from '../src/directory';
import {readCaptureSnapshot} from '../src/assistant-source-reader';
import {receiveCapture} from '../assistant/ingress';
import {CaptureMaterializer} from '../assistant/materialize';
import {Conversations} from '../assistant/conversations';
const archive=(env as unknown as {RECIPIENT_DB:D1Database}).RECIPIENT_DB,secret='synthetic-outgoing-nominal-reader-secret',phone='12025550100';
let e:Env,scope:{installationId:string;generation:string;sourceEpoch:string;sourceGeneration:string},settings:any,rpc:OwnerAssistant,source:{id:string;revision:number},target:string,now:number;
const status=vi.fn(async()=>({connected:true,phone}));
beforeEach(async()=>{
 await applyD1Migrations(archive,env.TEST_MIGRATIONS);await archive.exec('DELETE FROM actions;DELETE FROM media_jobs;DELETE FROM media_derivatives;DELETE FROM media;DELETE FROM message_versions;DELETE FROM messages;DELETE FROM participants;DELETE FROM directory_syncs;DELETE FROM chats;DELETE FROM policies;DELETE FROM connection_state;');status.mockReset();status.mockImplementation(async()=>({connected:true,phone}));now=Date.now();scope={installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:'explicit-e',sourceGeneration:'explicit-g'};
 e={...env,DB:archive,OWNER_SUB:'fixture-owner',INSTALLATION_EPOCH:scope.sourceEpoch,CONNECTION_GENERATION:scope.sourceGeneration,CONNECTED_PHONE:phone,MAINTENANCE:'false',PUBLIC_ORIGIN:'https://fixture.invalid',RUNTIME_CONFIG:'static',DEVELOPMENT:'true',ASSISTANT_READER_SECRET:secret,ZAPI_INSTANCE_ID:'fixture-instance',ZAPI_TOKEN:'fixture-token',ZAPI_CLIENT_TOKEN:'fixture-client'};
 const resolved=await resolveRecipient(e,{phone:'+12025550123'}, {status});expect(resolved.created).toBe(true);target=resolved.chatId;
 settings={DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,BRIDGE_SECRET:secret,FLUE_EPISODES_ENABLED:'shadow',CAPTURE_READER:{readSnapshot:async()=>{throw Error('no_capture_history');},readRecipientEnvelope:(input:unknown)=>readRecipientEnvelope(e,input,{status})}};
 rpc=new OwnerAssistant(createExecutionContext(),settings);source=await new SourceController(env.DB,scope,{kind:'owner'},()=>now).create({originKey:'explicit-owner',text:'The owner explicitly requests this exact shadow proposal.',occurredAt:now});
 await rpc.control(scope,{kind:'policy.put',operationId:'policy',id:target,expectedRevision:0,conversationKind:'private'});
});
afterEach(()=>vi.restoreAllMocks());
const command=()=>({kind:'fup.put',operationId:'initiative',id:'initiative',expectedVersion:0,conversationId:target,policyRevision:1,source:{id:source.id,revision:1},purpose:'Evaluate the exact owner-requested shadow proposal.',dueAt:now-1,timezone:'UTC',precision:'exact',state:'scheduled',outgoing:{envelope:{kind:'text',chatId:target,text:'Hello, this is the exact authorized text.'},authorization:{kind:'owner_exact'}}});
async function prepared(during:()=>Promise<void>=async()=>{},input:unknown=command()){
 await rpc.control(scope,input);const row=await env.DB.prepare('SELECT body_json FROM assistant_fup_provenance WHERE installation_id=?').bind(scope.installationId).first<string>('body_json');expect(JSON.parse(row!).outgoing.observation.recipient.chatId).toBe(target);
 const due=new FollowUps(env.DB,scope,{clock:()=>now}),admitted=(await due.admitDue()).items[0];expect(admitted.state).toBe('admitted');const queue=new JobQueue(env.DB,scope),lease=(await queue.claim(now,90000))!,ledger=(await queue.ledger(lease.id))!,request=JSON.parse(ledger.request_json);expect(request.outgoing).toEqual(JSON.parse(row!).outgoing);
 const search=new RetrievalRuns(env.DB,scope,{clock:()=>now});let progress=await search.start({kind:'owner'},'initiative-search',{query:request.input});for(let n=0;progress.state==='pending'&&n<10;n++)progress=await search.step({kind:'owner'},{runId:progress.runId,stepId:'step-'+n,expectedCheckpoint:progress.checkpoint});
 await new InferenceBudget(env.DB,{...scope,period:'fixture'}).configure(100000);const model=vi.fn(async()=>{const read=(await new SourceAccess(env.DB,scope).read({kind:'owner'},source.id))!;const result={status:200,actualUnits:3,body:JSON.stringify({choices:[{message:{content:JSON.stringify({decision:'proposed',text:command().outgoing.envelope.text,citations:[{id:source.id,revision:1,version:1,hash:read.fence.source.hash,quote:read.text}]})}}]})};await during();return result;});
 const host=new EpisodeController(env.DB,{...scope,period:'fixture'},search,model,DEFAULT_BROKER_CONFIG,{clock:()=>now,outgoing:outgoingPort(settings)}),episode=await host.prepare(lease,'owner',progress.runId);expect(episode.binding.work.kind).toBe('follow_up');expect(episode.binding.outgoing).toEqual(request.outgoing);
 const receipt={submissionId:'fixture-submission',uid:'fixture-uid',acceptedAt:new Date(now).toISOString()};await host.episodes.dispatch(episode.id);await host.episodes.accept(episode.id,{profile:'owner',runtimeId:episode.runtime_id,bindingHash:episode.binding_hash,envelopeHash:episode.dispatch_hash,receipt});
 return {host,episode,receipt,queue,due,admitted,ledger,request,model,search};
}
it('pins a resolved new recipient with no history to a FUP and one guarded shadow episode, preserving its envelope on replay',async()=>{
 const {host,episode,receipt,queue,due,admitted,ledger,request,model}=await prepared();
 const text=await host.model(episode.id,{profile:'owner',runtimeId:episode.runtime_id,submissionId:receipt.submissionId},{messages:[{role:'user',content:host.message(episode)}]});const result=await host.publish(episode.id,{...receipt,text,data:{}});expect(result).toMatchObject({state:'shadow_completed',proposal:{mode:'shadow',externalAttempted:false,outgoing:request.outgoing}});
 await rpc.control(scope,command());expect((await due.admitDue()).items[0].jobId).toBe(admitted.jobId);expect(model).toHaveBeenCalledTimes(1);expect((await queue.ledger(leaseId(episode)))!.request_json).toBe(ledger.request_json);
 for(const table of ['messages','actions'])expect(await archive.prepare('SELECT COUNT(*) n FROM '+table).first('n')).toBe(0);expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_origin_conversations WHERE installation_id=?').bind(scope.installationId).first('n')).toBe(0);
});
const leaseId=(episode:Awaited<ReturnType<EpisodeController['prepare']>>)=>episode.job_id;
async function captureOffProjection(){
 await setCapture(e,target,false,{epoch:e.INSTALLATION_EPOCH,generation:e.CONNECTION_GENERATION});settings.CAPTURE_READER.readSnapshot=(input:unknown)=>readCaptureSnapshot(e,input);
 const response=await receiveCapture(new Request('https://fixture.invalid/internal/capture',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify({protocol:1,...scope,sequence:1,previousSequence:0,chatId:target,sourceId:target,sourceKind:'conversation',operation:'access',recordedAt:now})}),settings);expect(response.status).toBe(200);await new CaptureMaterializer(env.DB,()=>scope,settings.CAPTURE_READER,secret).process(1);
 await env.DB.prepare('DELETE FROM assistant_policy_versions WHERE installation_id=? AND generation=?').bind(scope.installationId,scope.generation).run();await env.DB.prepare('DELETE FROM assistant_conversation_policies WHERE installation_id=? AND generation=?').bind(scope.installationId,scope.generation).run();await new Conversations(env.DB,()=>scope).ensure(target);
}
it('capture OFF projected to Own does not become no-contact or create a policy/frame',async()=>{
 await captureOffProjection();const before=(await env.DB.prepare('SELECT * FROM assistant_conversations WHERE installation_id=?').bind(scope.installationId).all()).results;expect(await env.DB.prepare('SELECT access_state FROM assistant_origin_conversations WHERE installation_id=?').bind(scope.installationId).first('access_state')).toBe('withdrawn');
 const p=await prepared(async()=>{},{...command(),policyRevision:0}),text=await invoke(p),result=await p.host.publish(p.episode.id,{...p.receipt,text,data:{}});expect(result).toMatchObject({state:'shadow_completed',proposal:{externalAttempted:false,outgoing:{policy:{kind:'absent',revision:0}}}});expect(p.episode.binding.work.kind==='follow_up'&&p.episode.binding.work.target.fence).toBeNull();
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_conversation_policies WHERE installation_id=?').bind(scope.installationId).first('n')).toBe(0);expect((await env.DB.prepare('SELECT * FROM assistant_conversations WHERE installation_id=?').bind(scope.installationId).all()).results).toEqual(before);expect(await archive.prepare('SELECT capture_enabled FROM chats WHERE id=?').bind(target).first('capture_enabled')).toBe(0);for(const table of ['messages','actions'])expect(await archive.prepare('SELECT COUNT(*) n FROM '+table).first('n')).toBe(0);
});
it('does not bypass an unavailable source attendance anchor even when its target has an outgoing proof',async()=>{
 await captureOffProjection();source=await new SourceController(env.DB,scope,{kind:'owner'},()=>now).create({originKey:'attached',text:'The owner explicitly requests this exact shadow proposal.',occurredAt:now,conversationId:target});await rpc.control(scope,{...command(),policyRevision:0});expect((await new FollowUps(env.DB,scope,{clock:()=>now}).admitDue()).items[0]).toMatchObject({state:'unavailable',reason:'admission_uncertain'});expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_episode_calls WHERE installation_id=?').bind(scope.installationId).first('n')).toBe(0);
});
it.each(['policy_arrives','policy_revision','policy_excluded','frame_pause'] as const)('revalidates %s during the model without repinning, preserving its paid receipt',async change=>{
 const absent=change==='policy_arrives'||change==='frame_pause';if(absent)await captureOffProjection();const p=await prepared(async()=>{if(change==='policy_arrives')await env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind) VALUES(?,?,?,'private')").bind(scope.installationId,scope.generation,target).run();else if(change==='frame_pause')await new Conversations(env.DB,()=>scope).setPaused(target,1,true);else await rpc.control(scope,{kind:'policy.put',operationId:'changed-policy',id:target,expectedRevision:1,conversationKind:'private',excluded:change==='policy_excluded'});},{...command(),policyRevision:absent?0:1});
 await expect(invoke(p)).rejects.toThrow();expect(p.model).toHaveBeenCalledTimes(1);expect((await new InferenceBudget(env.DB,{...scope,period:'fixture'}).status()).committed).toBe(3);expect((await p.queue.ledger(p.episode.job_id))!.request_json).toBe(p.ledger.request_json);
});
it('a policy appearing during the metadata await cannot be silently treated as the original absence pin',async()=>{
 await captureOffProjection();let changed=false;status.mockImplementation(async()=>{if(!changed){changed=true;await env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind) VALUES(?,?,?,'group')").bind(scope.installationId,scope.generation,target).run();}return {connected:true,phone};});await expect(rpc.control(scope,{...command(),policyRevision:0})).rejects.toThrow('control_precondition');expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_follow_ups WHERE installation_id=?').bind(scope.installationId).first('n')).toBe(0);
});
it('policy zero never bypasses an existing policy, an explicit pause or a legacy FUP contract',async()=>{
 await expect(rpc.control(scope,{...command(),policyRevision:0})).rejects.toThrow('control_precondition');const {outgoing,...legacy}=command();await expect(rpc.control(scope,{...legacy,policyRevision:0})).rejects.toThrow('control_input');await captureOffProjection();await new Conversations(env.DB,()=>scope).setPaused(target,1,true);await expect(rpc.control(scope,{...command(),policyRevision:0})).rejects.toThrow('control_precondition');
});
it('denies unproven target, envelope mismatch and missing explicit authorization without making a FUP',async()=>{
 for(const extra of [{outgoing:{...command().outgoing,envelope:{...command().outgoing.envelope,chatId:'invented'}}},{outgoing:{...command().outgoing,authorization:undefined}}])await expect(rpc.control(scope,{...command(),...extra})).rejects.toThrow();
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_follow_ups WHERE installation_id=?').bind(scope.installationId).first('n')).toBe(0);
});
it.each(['group','lid'] as const)('does not treat an existing %s address as an explicit international individual recipient',async kind=>{
 await archive.prepare(kind==='group'?"UPDATE chats SET kind='group' WHERE id=?":"UPDATE chats SET external_id='opaque@lid' WHERE id=?").bind(target).run();await expect(rpc.control(scope,command())).rejects.toThrow('recipient_kind');expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_follow_ups WHERE installation_id=?').bind(scope.installationId).first('n')).toBe(0);
});
it('bounds the complete UTF-8 outgoing provenance instead of truncating its envelope into a query',async()=>{
 await expect(rpc.control(scope,{...command(),outgoing:{...command().outgoing,envelope:{...command().outgoing.envelope,text:'é'.repeat(4096)}}})).rejects.toThrow('control_input');expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_follow_ups WHERE installation_id=?').bind(scope.installationId).first('n')).toBe(0);
});
const invoke=(p:Awaited<ReturnType<typeof prepared>>)=>p.host.model(p.episode.id,{profile:'owner',runtimeId:p.episode.runtime_id,submissionId:p.receipt.submissionId},{messages:[{role:'user',content:p.host.message(p.episode)}]});
it.each(['device','generation','source','pin','legacy_pin'] as const)('revokes %s after preparation without repinning or calling a model',async change=>{
 const p=await prepared(),before=p.episode.binding_hash;if(change==='device')status.mockResolvedValue({connected:true,phone:'12025550999'});if(change==='generation')e.CONNECTION_GENERATION='other';if(change==='source')await new SourceController(env.DB,scope,{kind:'owner'}).withdraw(source.id,1);if(change==='pin')await env.DB.prepare("UPDATE assistant_fup_provenance SET body_json=json_set(body_json,'$.outgoing.envelope.text','Changed') WHERE installation_id=?").bind(scope.installationId).run();
 if(change==='legacy_pin')await env.DB.prepare("UPDATE assistant_fup_provenance SET body_json=json_remove(body_json,'$.outgoing.policy') WHERE installation_id=?").bind(scope.installationId).run();
 await expect(invoke(p)).rejects.toThrow();expect(p.model).not.toHaveBeenCalled();expect((await p.host.episodes.get(p.episode.id))!.binding_hash).toBe(before);expect((await p.queue.ledger(p.episode.job_id))!.request_json).toBe(p.ledger.request_json);expect(await archive.prepare('SELECT COUNT(*) n FROM actions').first('n')).toBe(0);
});
it('local cancellation during the remote proof await prevents model admission',async()=>{
 const p=await prepared();let revoked=false;status.mockImplementation(async()=>{if(!revoked){revoked=true;await rpc.control(scope,{kind:'fup.cancel',operationId:'cancel',id:'initiative',expectedVersion:1});}return {connected:true,phone};});await expect(invoke(p)).rejects.toThrow();expect(revoked).toBe(true);expect(p.model).not.toHaveBeenCalled();
});
it('settles a known response after source revocation during the model, suppresses it and never retries',async()=>{
 const p=await prepared(async()=>{await new SourceController(env.DB,scope,{kind:'owner'}).withdraw(source.id,1);});await expect(invoke(p)).rejects.toThrow();await expect(invoke(p)).rejects.toThrow();expect(p.model).toHaveBeenCalledTimes(1);expect((await new InferenceBudget(env.DB,{...scope,period:'fixture'}).status()).committed).toBe(3);expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_shadow_decisions WHERE installation_id=? AND proposal_json IS NOT NULL').bind(scope.installationId).first('n')).toBe(0);
});
it('a provider timeout keeps the original episode/key uncertain with one model attempt',async()=>{
 const p=await prepared();p.model.mockRejectedValue(Error('synthetic timeout unknown'));await expect(invoke(p)).rejects.toThrow();await expect(invoke(p)).rejects.toThrow();expect(p.model).toHaveBeenCalledTimes(1);expect((await p.queue.ledger(p.episode.job_id))!.request_json).toBe(p.ledger.request_json);expect((await p.host.episodes.get(p.episode.id))!.binding_hash).toBe(p.episode.binding_hash);
});
it('reads a published proposal only with the original current recipient/source/intent proof',async()=>{
 const p=await prepared(),text=await invoke(p),published=await p.host.publish(p.episode.id,{...p.receipt,text,data:{}});expect(published.state).toBe('shadow_completed');const journal=new DecisionJournal(env.DB,scope,{kind:'owner'},{clock:()=>now,search:p.search,outgoing:outgoingPort(settings)});expect(await journal.get(published.decisionId!)).toMatchObject({freshness:'current',proposal:{externalAttempted:false}});
 let revoked=false;status.mockImplementation(async()=>{if(!revoked){revoked=true;await rpc.control(scope,{kind:'fup.pause',operationId:'pause',id:'initiative',expectedVersion:1});}return {connected:true,phone};});const stale=await journal.get(published.decisionId!);expect('freshness'in stale?stale.freshness:'unavailable').not.toBe('current');expect(stale).not.toHaveProperty('proposal');expect(p.model).toHaveBeenCalledTimes(1);
});
it('a target change during HMAC cannot release a cached proposal using the previous recipient proof',async()=>{
 const p=await prepared(),text=await invoke(p),published=await p.host.publish(p.episode.id,{...p.receipt,text,data:{}});expect(published.state).toBe('shadow_completed');const sign=crypto.subtle.sign.bind(crypto.subtle);let changed=false;
 vi.spyOn(crypto.subtle,'sign').mockImplementation(async(...args)=>{const result=await sign(...args);if(!changed){changed=true;await archive.prepare("UPDATE chats SET external_id='12025550998' WHERE id=?").bind(target).run();}return result;});
 const journal=new DecisionJournal(env.DB,scope,{kind:'owner'},{clock:()=>now,search:p.search,outgoing:outgoingPort(settings)}),detail=await journal.get(published.decisionId!);expect(changed).toBe(true);expect(detail).not.toHaveProperty('proposal');expect(p.model).toHaveBeenCalledTimes(1);
});
it('lost command ACK recovers the same FUP/proof and a changed envelope conflicts',async()=>{
 const batch=env.DB.batch.bind(env.DB);let lost=false;const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{const result=await batch(statements);if(!lost){lost=true;throw Error('ACK lost');}return result;}} as D1Database;
 const uncertain=new OwnerAssistant(createExecutionContext(),{...settings,DB:db});await expect(uncertain.control(scope,command())).rejects.toThrow();const before=await env.DB.prepare('SELECT body_json FROM assistant_fup_provenance WHERE installation_id=?').bind(scope.installationId).first('body_json');expect(await rpc.control(scope,command())).toMatchObject({id:'initiative',version:1});expect(await env.DB.prepare('SELECT body_json FROM assistant_fup_provenance WHERE installation_id=?').bind(scope.installationId).first('body_json')).toBe(before);
 await expect(rpc.control(scope,{...command(),outgoing:{...command().outgoing,envelope:{...command().outgoing.envelope,text:'Changed'}}})).rejects.toThrow('control_operation_conflict');
});
it('requires current future_contact mandate coverage, preserving spend when it is revoked during the model',async()=>{
 await rpc.control(scope,{kind:'mandate.put',operationId:'mandate',id:'mandate',expectedVersion:0,conversationId:target,policyRevision:1,purpose:'Only this shadow proposal',status:'active',expiresAt:now+60000,actions:['future_contact'],sources:[{id:source.id,revision:source.revision}]});const input={...command(),mandate:{id:'mandate',version:1},outgoing:{...command().outgoing,authorization:{kind:'mandate',id:'mandate',version:1}}};
 now=Date.now();
 const p=await prepared(async()=>{await rpc.control(scope,{kind:'mandate.revoke',operationId:'revoke',id:'mandate',expectedVersion:1});},input);await expect(invoke(p)).rejects.toThrow();expect(p.model).toHaveBeenCalledTimes(1);expect((await new InferenceBudget(env.DB,{...scope,period:'fixture'}).status()).committed).toBe(3);
});
it.each(['model','publish','read'] as const)('expiry during the final search guard blocks %s using a fresh authority clock',async phase=>{
 const expires=now+60000;await rpc.control(scope,{kind:'mandate.put',operationId:'mandate',id:'mandate',expectedVersion:0,conversationId:target,policyRevision:1,purpose:'Only this shadow proposal',status:'active',expiresAt:expires,actions:['future_contact'],sources:[{id:source.id,revision:1}]});now=Date.now();const input={...command(),mandate:{id:'mandate',version:1},outgoing:{...command().outgoing,authorization:{kind:'mandate',id:'mandate',version:1}}},p=await prepared(async()=>{},input);
 const text=phase==='model'?undefined:await invoke(p),published=phase==='read'?await p.host.publish(p.episode.id,{...p.receipt,text:text!,data:{}}):undefined;let crossed=false;const guard=p.search.guard.bind(p.search),asynchronous:EpisodeSearch=p.search;vi.spyOn(asynchronous,'guard').mockImplementation(async(...args)=>{const result=await guard(...args);crossed=true;now=expires+1;return result;});
 if(phase==='model')await expect(invoke(p)).rejects.toThrow();else if(phase==='publish')expect(await p.host.publish(p.episode.id,{...p.receipt,text:text!,data:{}})).toEqual({state:'blocked'});else{expect(published?.state).toBe('shadow_completed');const detail=await new DecisionJournal(env.DB,scope,{kind:'owner'},{clock:()=>now,search:p.search,outgoing:outgoingPort(settings)}).get(published!.decisionId!);expect(detail).not.toHaveProperty('proposal');}
 expect(crossed).toBe(true);expect(p.model).toHaveBeenCalledTimes(phase==='model'?0:1);expect((await new InferenceBudget(env.DB,{...scope,period:'fixture'}).status()).committed).toBe(phase==='model'?0:3);expect((await p.queue.ledger(p.episode.job_id))!.request_json).toBe(p.ledger.request_json);
});
it.each(['text','envelope'] as const)('rejects a model attempt to replace the authorized %s',async change=>{
 const p=await prepared(),read=(await new SourceAccess(env.DB,scope).read({kind:'owner'},source.id))!;p.model.mockResolvedValue({status:200,actualUnits:3,body:JSON.stringify({choices:[{message:{content:JSON.stringify({decision:'proposed',text:change==='text'?'Changed by the model':command().outgoing.envelope.text,citations:[{id:source.id,revision:1,version:1,hash:read.fence.source.hash,quote:read.text}],...(change==='envelope'?{outgoing:{envelope:{chatId:'invented',kind:'text',text:'Forbidden'}}}:{})})}}]})});
 await expect(invoke(p)).rejects.toThrow();expect(p.model).toHaveBeenCalledTimes(1);expect((await p.queue.ledger(p.episode.job_id))!.request_json).toBe(p.ledger.request_json);expect(await archive.prepare('SELECT COUNT(*) n FROM actions').first('n')).toBe(0);
});
it('an expired mandate after the last proof await cannot admit a FUP using an earlier clock sample',async()=>{
 await rpc.control(scope,{kind:'mandate.put',operationId:'mandate',id:'mandate',expectedVersion:0,conversationId:target,policyRevision:1,purpose:'Only this shadow proposal',status:'active',expiresAt:now+60000,actions:['future_contact'],sources:[{id:source.id,revision:1}]});let reads=0;const original=now;status.mockImplementation(async()=>{if(++reads>=3)now=original+120000;return {connected:true,phone};});
 const control=new OwnerControl(env.DB,scope,{kind:'owner'},()=>now,outgoingPort(settings));await expect(control.execute({...command(),mandate:{id:'mandate',version:1},outgoing:{...command().outgoing,authorization:{kind:'mandate',id:'mandate',version:1}}})).rejects.toThrow('control_precondition');expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_follow_ups WHERE installation_id=?').bind(scope.installationId).first('n')).toBe(0);
});
it('the new nominal reader authenticates before resolving the target or querying provider state',async()=>{
 const n=status.mock.calls.length;await expect(readRecipientEnvelope(e,{secret:'wrong',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,envelope:command().outgoing.envelope},{status})).rejects.toThrow('reader_denied');expect(status.mock.calls.length).toBe(n);
 const actor={kind:'interlocutor' as const,provider:'wa',address:'external',conversationId:target,conversationKind:'private' as const,action:'reply_text' as const};await expect(new OwnerControl(env.DB,scope,actor,()=>now,outgoingPort(settings)).execute(command())).rejects.toThrow('owner_required');
});
it('checks the current production database connection version after provider awaits instead of trusting a decrypted Env',async()=>{
 const generation='a'.repeat(32);e.CONNECTION_GENERATION=generation;e.RUNTIME_CONFIG='database';e.DEVELOPMENT='false';e.ENCRYPTION_KEY=btoa('k'.repeat(32));await archive.prepare('UPDATE chats SET generation=? WHERE id=?').bind(generation,target).run();
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('k'.repeat(32)),{name:'AES-GCM'},false,['encrypt']),iv=crypto.getRandomValues(new Uint8Array(12)),payload={instanceId:e.ZAPI_INSTANCE_ID,instanceToken:e.ZAPI_TOKEN,clientToken:e.ZAPI_CLIENT_TOKEN,phone,generation,webhookSecret:'b'.repeat(64)},cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(JSON.stringify(['whatsapp-mcp/connection/v1',e.PUBLIC_ORIGIN,e.INSTALLATION_EPOCH]))},key,new TextEncoder().encode(JSON.stringify(payload)));
 await archive.prepare("INSERT INTO connection_state VALUES(1,?,?,'active','fixture-attempt',0,0,'complete',NULL,1,1,1)").bind(e.INSTALLATION_EPOCH,'v1.'+btoa(String.fromCharCode(...iv))+'.'+btoa(String.fromCharCode(...new Uint8Array(cipher)))).run();let n=0;const provider={status:async()=>{if(++n===2)await archive.prepare('UPDATE connection_state SET version=2 WHERE id=1').run();return {connected:true,phone};}};
 await expect(readRecipientEnvelope(e,{secret,sourceEpoch:e.INSTALLATION_EPOCH,sourceGeneration:generation,envelope:command().outgoing.envelope},provider)).rejects.toThrow('reader_changed');expect(n).toBe(2);expect(await archive.prepare('SELECT COUNT(*) n FROM actions').first('n')).toBe(0);
});
it.each(['image','pdf','audio'] as const)('reuses the existing %s envelope validation and permits capture opt-out without making a send action',async kind=>{
 await setCapture(e,target,false,{epoch:e.INSTALLATION_EPOCH,generation:e.CONNECTION_GENERATION});const bytes=kind==='pdf'?new TextEncoder().encode('%PDF-1.4\nSynthetic\n%%EOF'):kind==='image'?new Uint8Array([255,216,255,0,0,0,0,0,0,0,255,217]):new Uint8Array([255,251,144,0,1,2,3,4]),mime=kind==='pdf'?'application/pdf':kind==='image'?'image/jpeg':'audio/mpeg',filename='synthetic.'+(kind==='pdf'?'pdf':kind==='image'?'jpg':'mp3');const media=await uploadMedia(e,target,{bytes,mime,filename,durationSeconds:1});
 const input={...command(),outgoing:{authorization:{kind:'owner_exact'},envelope:{kind,chatId:target,mediaId:media.id,mediaHash:media.sha256}}};await rpc.control(scope,input);const stored=JSON.parse((await env.DB.prepare('SELECT body_json FROM assistant_fup_provenance WHERE installation_id=?').bind(scope.installationId).first<string>('body_json'))!).outgoing;expect(stored.envelope.kind).toBe(kind);if(kind==='pdf')expect(stored.envelope.fileName).toBe(filename);expect(await outgoingPort(settings).check(stored)).toBe(true);
 await archive.prepare('UPDATE media SET version=version+1 WHERE id=?').bind(media.id).run();expect(await outgoingPort(settings).check(stored)).toBe(false);expect(await archive.prepare('SELECT COUNT(*) n FROM actions').first('n')).toBe(0);expect(await archive.prepare('SELECT capture_enabled FROM chats WHERE id=?').bind(target).first('capture_enabled')).toBe(0);
});
