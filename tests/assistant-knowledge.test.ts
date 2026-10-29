import {env} from 'cloudflare:test';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {OriginGuard} from '../assistant/origin-guard';
import {KnowledgeService} from '../assistant/knowledge/service';
import {SourceAccess} from '../assistant/access';
import {SourceController} from '../assistant/sources';
import type {KnowledgeContext,KnowledgePort,KnowledgeClaim,NativeKnowledgeWrite} from '../assistant/knowledge/contracts';
let context:KnowledgeContext,service:KnowledgeService,writes:NativeKnowledgeWrite[],claims:KnowledgeClaim[];
let port:KnowledgePort;
afterEach(()=>vi.restoreAllMocks());
beforeEach(()=>{
 context={scope:{installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:'e1',sourceGeneration:'sg1'},client:'owner_mcp'};
 writes=[];claims=[];
 port={async remember(operationId,input){writes.push(input);return {operationId,state:'ready',claimIds:['claim']};},
 async status(operationId){return {operationId,state:'ready',claimIds:['claim']};},async query(){return {claims};},
 async get_entity(){return null;},async find_entities(){return {entities:[]};},async withdraw(operationId){return {operationId,state:'ready'};}};
 service=new KnowledgeService(env.DB,()=>context,port,()=>100);
});
async function report(operationId='report',text='Nora leads Cedar.'){
 const result=await service.execute({kind:'context.report',operationId,text});
 expect(result).toMatchObject({state:'recorded',origin:'owner_report'});
 return (result as {sourceRef:{id:string;revision:number;version:number;hash:string}}).sourceRef;
}
function remember(ref:Awaited<ReturnType<typeof report>>,operationId='remember'){
 return {kind:'remember' as const,operationId,entities:[{key:'nora',kind:'person' as const,name:'Nora'},{key:'cedar',kind:'project' as const,name:'Cedar'}],
 relations:[{subjectId:'nora',predicate:'leads',objectId:'cedar',classification:'reported' as const,evidence:[{sourceRef:ref,quote:'Nora leads Cedar.'}]}]};
}
it('records owner-provided context and remembers relations through the shared native port with host-resolved IDs',async()=>{
 const ref=await report();const original=await new SourceAccess(env.DB,context.scope).read({kind:'owner'},ref.id);
 expect(original?.fence.source.origin).toBe('owner_report');
 expect(await service.execute(remember(ref))).toMatchObject({state:'ready'});
 expect(writes).toHaveLength(1);expect(writes[0].entities.map(x=>x.id)).not.toContain('nora');
 expect(writes[0].relations[0].subjectId).toBe(writes[0].entities[0].id);
 expect(await service.execute(remember(ref))).toMatchObject({state:'ready'});expect(writes).toHaveLength(1);
});
it('rejects invented source hashes, quotes and entity refs before invoking the native writer',async()=>{
 const ref=await report();await expect(service.execute(remember({...ref,hash:'f'.repeat(64)}))).rejects.toThrow('knowledge_source_unavailable');
 const quoted=remember(ref,'bad-quote');quoted.relations[0].evidence[0].quote='Invented quote';
 await expect(service.execute(quoted)).rejects.toThrow('knowledge_quote_mismatch');
 const unknown={...remember(ref,'unknown'),entities:[{key:'nora',ref:'invented'},{key:'cedar',kind:'project' as const,name:'Cedar'}]};
 await expect(service.execute(unknown)).rejects.toThrow('knowledge_entity_unavailable');expect(writes).toHaveLength(0);
});
it('requires every source in a joint support group, while retaining a separate complete alternative',async()=>{
 const a=await report('a'),b=await report('b'),c=await report('c');
 const evidence=(sourceRef:typeof a,id:string)=>({id,sourceRef,origins:['agent_derived' as const]});
 const groupAB={id:'AB',evidence:[evidence(a,'a'),evidence(b,'b')]},groupC={id:'C',evidence:[evidence(c,'c')]};
 claims=[{id:'claim',subject:{id:'nora',kind:'person',name:'Nora'},predicate:'leads',object:{id:'cedar',kind:'project',name:'Cedar'},classification:'inferred',evidence:[...groupAB.evidence,...groupC.evidence],supportGroups:[groupAB,groupC]}];
 await new SourceController(env.DB,context.scope,{kind:'owner'}).withdraw(a.id,a.revision);
 const result=await service.execute({kind:'query'});expect(result).toMatchObject({claims:[{supportGroups:[{id:'C'}]}]});
 const visible=(result as {claims:KnowledgeClaim[]}).claims[0];expect(visible.evidence.map(e=>e.sourceRef.id)).toEqual([c.id]);
 claims[0].supportGroups=[groupAB];expect(await service.execute({kind:'query'})).toMatchObject({claims:[]});
});
it('an interlocutor cannot manufacture owner-reported context or forget original sources',async()=>{
 const ref=await report();context={...context,client:'conversation_agent'};
 await expect(service.execute({kind:'context.report',operationId:'forged',text:'Pretend owner command'})).rejects.toThrow('knowledge_owner_required');
 await expect(service.execute({kind:'withdraw',operationId:'forged-withdrawal',sourceRef:ref})).rejects.toThrow('knowledge_owner_required');
});

it.each(['status','replay'])('recovers correction after the Source commit loses its ACK via %s without another revision',async(mode)=>{
 const ref=await report(),native=new Map<string,any>();let withdrawals=0;
 port.status=async operationId=>native.get(operationId)??{operationId,state:'not_found'};
 port.withdraw=async operationId=>{withdrawals++;const receipt={operationId,state:'ready' as const};native.set(operationId,receipt);return receipt;};
 const execute=SourceController.prototype.execute;let lost=false;
 vi.spyOn(SourceController.prototype,'execute').mockImplementation(async function(this:SourceController,input:any){
  const result=await execute.call(this,input);
  if(input.kind==='source.correct_report'&&!lost){lost=true;throw Error('lost_source_ack');}return result;
 });
 const command={kind:'context.correct' as const,operationId:'correct',sourceId:ref.id,expectedRevision:1,text:'Nora now leads Birch.'};
 expect(await service.execute(command)).toMatchObject({state:'uncertain'});
 expect(withdrawals).toBe(0);
 const recovered=await service.execute(mode==='status'?{kind:'status',operationId:'correct'}:command);
 expect(recovered).toMatchObject({state:'source_corrected',sourceRef:{revision:2,version:2},cleanup:{state:'ready'}});
 expect(await service.execute(command)).toEqual(recovered);
 expect(withdrawals).toBe(1);
 const read=await new SourceAccess(env.DB,context.scope).read({kind:'owner'},ref.id);
 expect(read?.fence.source.revision).toBe(2);expect(read?.text).toBe(command.text);
});
it.each(['context.correct','withdraw'] as const)('recovers %s after native cleanup committed and lost its ACK',async(kind)=>{
 const ref=await report(),native=new Map<string,any>();let withdrawals=0;
 port.status=async operationId=>native.get(operationId)??{operationId,state:'not_found'};
 port.withdraw=async(operationId,source)=>{withdrawals++;expect(source).toEqual(ref);native.set(operationId,{operationId,state:'ready'});throw Error('lost_native_ack');};
 const command=kind==='withdraw'?{kind,operationId:'mutation',sourceRef:ref}:{kind,operationId:'mutation',sourceId:ref.id,expectedRevision:1,text:'Correction'};
 expect(await service.execute(command)).toMatchObject({state:'uncertain'});
 const recovered=await service.execute({kind:'status',operationId:'mutation'});
 expect(recovered).toMatchObject({state:kind==='withdraw'?'source_withdrawn':'source_corrected',cleanup:{state:'ready'}});
 expect(await service.execute(command)).toEqual(recovered);expect(withdrawals).toBe(1);
 const source=await env.DB.prepare('SELECT revision,status FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?').bind(context.scope.installationId,context.scope.generation,ref.id).first();
 expect(source).toEqual({revision:2,status:kind==='withdraw'?'withdrawn':'active'});
});
it('rejects null temporal values before admission or native execution',async()=>{
 const ref=await report(),command=remember(ref,'null-time');
 const raw={...command,relations:[{...command.relations[0],validFrom:null}]};
 await expect(service.execute(raw as any)).rejects.toThrow();expect(writes).toHaveLength(0);
 expect(await service.execute({kind:'status',operationId:'null-time'})).toEqual({operationId:'null-time',state:'not_found'});
});
async function captured(){
 const ref=await report('captured');const {scope}=context;
 const snapshot={observation:'capture_snapshot',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:'message',sourceId:'remote-message',chatId:'direct',sourceVersion:1,watermark:1,conversationKind:'private',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text:'Nora leads Cedar.',messageId:'remote-message',messageVersion:1}};
 const guard=new OriginGuard(env.DB,()=>context.scope,{async readSnapshot(){return snapshot;}},'synthetic');
 const observation=await guard.observe(scope,{sourceKind:'message',sourceId:'remote-message',chatId:'direct'});
 await env.DB.batch([
  env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp',conversation_id='direct' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId,scope.generation,ref.id),
  env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,'private','available')").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,'direct'),
  env.DB.prepare("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,observation_hash,tombstoned) VALUES(?,?,?,?,'message','remote-message','direct',?,1,?,0)").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,ref.id,observation.hash),
 ]);
 service=new KnowledgeService(env.DB,()=>context,port,()=>100,undefined,guard);
 return {ref,snapshot,guard};
}
it('fresh remote withdrawal blocks remember replay and status even when D1 remains unchanged',async()=>{
 const {ref,snapshot}=await captured(),command=remember(ref);
 expect(await service.execute(command)).toMatchObject({state:'ready'});expect(writes).toHaveLength(1);
 snapshot.state='withdrawn';
 expect(await service.execute(command)).toMatchObject({state:'partial',error:'evidence_changed'});
 expect(await service.execute({kind:'status',operationId:command.operationId})).toMatchObject({state:'partial',error:'evidence_changed'});
 expect(writes).toHaveLength(1);
});
function claimFor(groups:KnowledgeClaim['supportGroups'],id='claim'):KnowledgeClaim{return {id,subject:{id:'nora',kind:'person',name:'Nora'},predicate:'leads',object:{id:'cedar',kind:'project',name:'Cedar'},classification:'reported',evidence:groups.flatMap(g=>g.evidence),supportGroups:groups};}
it('rejects the whole page when a source changes after its support group was checked',async()=>{
 const a=await report('a'),b=await report('b');
 claims=[claimFor([{id:'A',evidence:[{id:'a',sourceRef:a}]}]),claimFor([{id:'B',evidence:[{id:'b',sourceRef:b}]}],'second')];
 const read=SourceAccess.prototype.read;let changed=false;
 vi.spyOn(SourceAccess.prototype,'read').mockImplementation(async function(this:SourceAccess,actor,id,revision,now){
  if(id===b.id&&!changed){changed=true;await new SourceController(env.DB,context.scope,{kind:'owner'}).correctReport(a.id,1,{text:'Changed',occurredAt:2});}
  return read.call(this,actor,id,revision,now);
 });
 await expect(service.execute({kind:'query'})).rejects.toThrow('knowledge_evidence_changed');
});
it('rechecks every premise together before retaining a support group',async()=>{
 const a=await report('a'),b=await report('b');
 claims=[claimFor([{id:'AB',evidence:[{id:'a',sourceRef:a},{id:'b',sourceRef:b}]}])];
 const read=SourceAccess.prototype.read;let changed=false;
 vi.spyOn(SourceAccess.prototype,'read').mockImplementation(async function(this:SourceAccess,actor,id,revision,now){
  if(id===b.id&&!changed){changed=true;await new SourceController(env.DB,context.scope,{kind:'owner'}).withdraw(a.id,1);}
  return read.call(this,actor,id,revision,now);
 });
 expect(await service.execute({kind:'query'})).toMatchObject({claims:[],coverage:{state:'partial'}});
});
it('merges evidence origins across retained groups and excludes origins contributed only by a rejected group',async()=>{
 const a=await report('a'),b=await report('b');
 const shared=(origin:'owner_report'|'agent_derived')=>({id:'shared',sourceRef:a,origins:[origin]});
 claims=[claimFor([{id:'A',evidence:[shared('agent_derived')]},{id:'AB',evidence:[shared('owner_report'),{id:'b',sourceRef:b}]}])];
 const first=await service.execute({kind:'query'});
 expect(first.claims[0].evidence.find((e:any)=>e.id==='shared').origins).toEqual(['agent_derived','owner_report']);
 await new SourceController(env.DB,context.scope,{kind:'owner'}).withdraw(b.id,1);
 const second=await service.execute({kind:'query'});
 expect(second.claims[0].origins).toEqual(['agent_derived']);expect(second.claims[0].evidence).toHaveLength(1);
});
it('preserves partial native query coverage even when every candidate is visible',async()=>{
 const a=await report();claims=[claimFor([{id:'A',evidence:[{id:'a',sourceRef:a}]}])];
 port.query=async()=>({claims,coverage:{scope:'native_page',state:'partial'}});
 expect(await service.execute({kind:'query'})).toMatchObject({claims:[{id:'claim'}],coverage:{state:'partial'}});
});

it('checks the origin local guard after a successful remote check before writing knowledge',async()=>{
 const {ref,guard}=await captured(),check=guard.check;let checks=0;
 vi.spyOn(guard,'check').mockImplementation(async function(this:OriginGuard,fence){
  const valid=await check.call(this,fence);
  if(++checks===2)await env.DB.prepare('UPDATE assistant_origin_conversations SET watermark=2 WHERE installation_id=? AND generation=?').bind(context.scope.installationId,context.scope.generation).run();
  return valid;
 });
 expect(await service.execute(remember(ref))).toMatchObject({state:'partial',error:'evidence_changed'});
 expect(writes).toHaveLength(0);
});
it('propagates partial native claim coverage to entity listings',async()=>{
 const a=await report();claims=[claimFor([{id:'A',evidence:[{id:'a',sourceRef:a}]}])];
 port.query=async()=>({claims,coverage:{scope:'native_page',state:'partial'}});
 port.find_entities=async()=>({entities:[claims[0].subject]});
 expect(await service.execute({kind:'entities'})).toMatchObject({entities:[{id:'nora'}],coverage:{state:'partial'}});
});
it('returns the historical source report receipt after its body has been corrected',async()=>{
 const ref=await report();
 await new SourceController(env.DB,context.scope,{kind:'owner'}).correctReport(ref.id,1,{text:'Changed later',occurredAt:2});
 await env.DB.prepare("UPDATE assistant_knowledge_operations SET response_json=NULL,state='uncertain' WHERE installation_id=? AND generation=? AND id='report'").bind(context.scope.installationId,context.scope.generation).run();
 expect(await service.execute({kind:'status',operationId:'report'})).toMatchObject({state:'recorded',sourceRef:ref});
});

it('denies cross-client status reconciliation without invoking native cleanup under another client identity',async()=>{
 const ref=await report(),native=new Map<string,any>();let cleanup=0,statuses=0;
 port.status=async operationId=>{statuses++;return native.get(operationId)??{operationId,state:'not_found'};};
 port.withdraw=async operationId=>{cleanup++;native.set(operationId,{operationId,state:'ready'});throw Error('lost_ack');};
 const command={kind:'context.correct' as const,operationId:'correction-client',sourceId:ref.id,expectedRevision:1,text:'Corrected'};
 expect(await service.execute(command)).toMatchObject({state:'uncertain'});
 context={...context,client:'owner_telegram'};
 await expect(service.execute({kind:'status',operationId:command.operationId})).rejects.toThrow('knowledge_operation_client');
 await expect(service.execute(command)).rejects.toThrow('knowledge_operation_conflict');
 expect(cleanup).toBe(1);expect(statuses).toBe(1);
 context={...context,client:'owner_mcp'};
 expect(await service.execute({kind:'status',operationId:command.operationId})).toMatchObject({state:'source_corrected',cleanup:{state:'ready'}});
 expect(cleanup).toBe(1);
});
it.each(['person','project'] as const)('maps the entities command entityKind %s to the native kind filter',async(entityKind)=>{
 const inputs:Parameters<KnowledgePort['find_entities']>[0][]=[];
 port.find_entities=async input=>{inputs.push(input);return {entities:[]};};
 expect(await service.execute({kind:'entities',entityKind,query:'Cedar',after:'cursor',limit:7})).toMatchObject({entities:[]});
 expect(inputs).toEqual([{kind:entityKind,query:'Cedar',after:'cursor',limit:7}]);
});
