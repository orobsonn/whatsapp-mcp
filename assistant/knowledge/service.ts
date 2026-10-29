import {knowledgeCommand,type KnowledgeCommand,type KnowledgeContext,type KnowledgePort,type NativeKnowledgeWrite,type KnowledgeClaim,type KnowledgeReceipt,type VerifiedKnowledgeClaim} from './contracts';
import {SourceAccess,type SourceFence,type SourceRead} from '../access';
import {SourceController,sourceTextHash,type SourceCommand} from '../sources';
import type {SourceRetirementGuard} from '../retention-authority';
import {bridgeHash} from '../ingress';
import type {OriginGuard,OriginFence} from '../origin-guard';
type Row={id:string;kind:string;client:KnowledgeContext['client'];request_hash:string;normalized_json:string|null;source_fences_json:string|null;state:string;response_json:string|null;created_at:number;request_json:string};
type Snapshot={sources:SourceFence[];origins:OriginFence[]};
type ControlPlan={sourceCommand:SourceCommand;previousRef?:{id:string;revision:number;version:number;hash:string};cleanupId?:string;sourceHash?:string};
type Visible={claim:VerifiedKnowledgeClaim;proof:Snapshot};
const owner={kind:'owner'} as const;
const scopeKey=(c:KnowledgeContext)=>JSON.stringify([c.scope.installationId,c.scope.generation,c.scope.sourceEpoch,c.scope.sourceGeneration,c.client]);
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
/** One knowledge service shared by MCP, bots and curator. Context is fixed by
 * the authenticated host; graph candidates never grant source access. */
export class KnowledgeService {
 constructor(private readonly db:D1Database,private readonly getContext:()=>KnowledgeContext,private readonly port:KnowledgePort,
  private readonly clock=Date.now,private readonly retirement?:SourceRetirementGuard,private readonly origin?:OriginGuard){}
 private context(){const c=copy(this.getContext());if(Object.values(c.scope).some(v=>typeof v!=='string'||!v)||!['owner_mcp','owner_telegram','conversation_agent','curator'].includes(c.client))throw Error('knowledge_context');return c;}
 private current(c:KnowledgeContext){if(scopeKey(this.getContext())!==scopeKey(c))throw Error('knowledge_scope_changed');}
 private keys(c:KnowledgeContext){return [c.scope.installationId,c.scope.generation];}
 private access(c:KnowledgeContext){return new SourceAccess(this.db,c.scope,this.clock,'knowledge');}
 private owner(c:KnowledgeContext){if(c.client!=='owner_mcp'&&c.client!=='owner_telegram')throw Error('knowledge_owner_required');}
 private async source(c:KnowledgeContext,ref:{id:string;revision:number;version:number;hash:string},quote?:string):Promise<SourceRead & {originFence?:OriginFence}>{
  this.current(c);const result=await this.access(c).read(owner,ref.id,ref.revision);this.current(c);
  if(!result||result.fence.source.version!==ref.version||result.fence.source.hash!==ref.hash||result.text===null)throw Error('knowledge_source_unavailable');
  if(quote!==undefined&&!result.text.includes(quote))throw Error('knowledge_quote_mismatch');
  let originFence:OriginFence|undefined;
  if(result.fence.source.origin==='whatsapp'){
   if(!this.origin)throw Error('knowledge_origin_unavailable');const fence=await this.origin.fence(ref.id);
   if(!fence||!await this.origin.check(fence))throw Error('knowledge_source_unavailable');this.current(c);originFence=fence;
  }
  return {...result,...(originFence?{originFence}:{})};
 }
 private async row(c:KnowledgeContext,id:string){return this.db.prepare('SELECT * FROM assistant_knowledge_operations WHERE installation_id=? AND generation=? AND id=?').bind(...this.keys(c),id).first<Row>();}
 private async admit(c:KnowledgeContext,command:Extract<KnowledgeCommand,{operationId:string}>):Promise<Row>{
  const hash=await bridgeHash(['knowledge-operation-v1',scopeKey(c),command]);this.current(c);
  await this.db.prepare(`INSERT INTO assistant_knowledge_operations(installation_id,generation,id,kind,client,request_hash,request_json,created_at,updated_at)
   VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).bind(...this.keys(c),command.operationId,command.kind,c.client,hash,JSON.stringify(command),this.clock(),this.clock()).run();
  const row=await this.row(c,command.operationId);this.current(c);if(!row||row.request_hash!==hash)throw Error('knowledge_operation_conflict');return row;
 }
 private async complete(c:KnowledgeContext,id:string,result:unknown){this.current(c);await this.db.prepare("UPDATE assistant_knowledge_operations SET state='complete',response_json=?,updated_at=? WHERE installation_id=? AND generation=? AND id=?").bind(JSON.stringify(result),this.clock(),...this.keys(c),id).run();return result;}
 private async claim(c:KnowledgeContext,id:string){this.current(c);return !!await this.db.prepare("UPDATE assistant_knowledge_operations SET state='attempting',updated_at=? WHERE installation_id=? AND generation=? AND id=? AND state='accepted' RETURNING id").bind(this.clock(),...this.keys(c),id).first();}
 private async uncertain(c:KnowledgeContext,id:string){await this.db.prepare("UPDATE assistant_knowledge_operations SET state='uncertain',error='outcome_uncertain',updated_at=? WHERE installation_id=? AND generation=? AND id=? AND state IN ('accepted','attempting','uncertain')").bind(this.clock(),...this.keys(c),id).run();return {operationId:id,state:'uncertain'} as const;}
 private snapshot(raw:string):Snapshot {const value=JSON.parse(raw);return Array.isArray(value)?{sources:value,origins:[]}:value;}
 /** Fresh Reader observations and one local D1 transaction form the publication
  * snapshot. Reader and D1 have no shared transaction; delivered copies cannot
  * be revoked and subsequent reads must obtain a new snapshot. */
 private async validSnapshot(c:KnowledgeContext,proof:Snapshot){
  for(const fence of proof.sources)if(fence.source.origin==='whatsapp'&&!proof.origins.some(o=>o.canonicalId===fence.source.id&&o.revision===fence.source.revision&&o.version===fence.source.version))return false;
  for(const fence of proof.origins){if(!this.origin||!await this.origin.check(fence))return false;this.current(c);}
  const access=this.access(c),now=this.clock(),guards=[...proof.sources.map(f=>access.guard(owner,f,now)),...proof.origins.map(f=>this.origin!.localGuard(f))];
  this.current(c);if(!guards.length)return true;
  const rows=await this.db.batch<{valid:number}>(guards.map(g=>this.db.prepare(`SELECT CASE WHEN (${g.sql}) THEN 1 ELSE 0 END AS valid`).bind(...g.values)));
  this.current(c);return rows.length===guards.length&&rows.every(r=>r.results[0]?.valid===1);
 }
 private async validFences(c:KnowledgeContext,raw:string|null){return !!raw&&this.validSnapshot(c,this.snapshot(raw));}
 private sources(c:KnowledgeContext){return new SourceController(this.db,c.scope,owner,this.clock,this.retirement);}
 private async control(c:KnowledgeContext,row:Row):Promise<unknown>{
  const command=JSON.parse(row.request_json) as Exclude<KnowledgeCommand,{kind:'remember'|'query'|'entities'|'status'}>;
  let plan:ControlPlan;
  if(row.normalized_json)plan=JSON.parse(row.normalized_json);
  else{
   const operationId='knowledge-source:'+await bridgeHash([c.scope,command.operationId]);this.current(c);
   if(command.kind==='context.report')plan={sourceCommand:{kind:'source.report',operationId,input:{originKey:'knowledge-report:'+command.operationId,text:command.text,occurredAt:command.occurredAt??row.created_at,...(command.title?{title:command.title}:{})}},sourceHash:await sourceTextHash(command.text)};
   else if(command.kind==='context.correct'){
    const previous=await this.access(c).read(owner,command.sourceId,command.expectedRevision);this.current(c);
    if(!previous||previous.fence.source.origin!=='owner_report'){const saved=await this.row(c,row.id);if(saved?.normalized_json)return this.control(c,saved);throw Error('knowledge_report_required');}
    const old=previous.fence.source;
    plan={sourceCommand:{kind:'source.correct_report',operationId,id:command.sourceId,expectedRevision:command.expectedRevision,text:command.text,occurredAt:command.occurredAt??row.created_at},
     previousRef:{id:old.id,revision:old.revision,version:old.version,hash:old.hash},cleanupId:await bridgeHash(['knowledge-correction',c.scope,command.operationId]),sourceHash:await sourceTextHash(command.text)};
   }else{
    const current=await new SourceAccess(this.db,c.scope,this.clock).read(owner,command.sourceRef.id,command.sourceRef.revision);this.current(c);
    if(!current||current.fence.source.hash!==command.sourceRef.hash||current.fence.source.version!==command.sourceRef.version){const saved=await this.row(c,row.id);if(saved?.normalized_json)return this.control(c,saved);throw Error('knowledge_source_unavailable');}
    plan={sourceCommand:{kind:'source.withdraw',operationId,id:command.sourceRef.id,expectedRevision:command.sourceRef.revision},previousRef:command.sourceRef,cleanupId:command.operationId};
   }
   this.current(c);
   // The full recovery plan is durable before either effect. An exact replay
   // recovers the Source ledger receipt even after its old revision is gone.
   await this.db.prepare("UPDATE assistant_knowledge_operations SET normalized_json=? WHERE installation_id=? AND generation=? AND id=? AND normalized_json IS NULL").bind(JSON.stringify(plan),...this.keys(c),row.id).run();
   plan=JSON.parse((await this.row(c,row.id))!.normalized_json!);
  }
  try{
   this.current(c);const ref=await this.sources(c).execute(plan.sourceCommand);this.current(c);
   if(command.kind==='context.report')return this.complete(c,row.id,{operationId:row.id,state:'recorded',origin:'owner_report',sourceRef:{id:ref.id,revision:ref.revision,version:ref.version,hash:plan.sourceHash}});
   let cleanup=await this.port.status(plan.cleanupId!);this.current(c);
   if(cleanup.state==='not_found'){cleanup=await this.port.withdraw(plan.cleanupId!,plan.previousRef!);this.current(c);}
   const result={operationId:row.id,state:command.kind==='context.correct'?'source_corrected':'source_withdrawn',...(command.kind==='context.correct'?{sourceRef:{id:ref.id,revision:ref.revision,version:ref.version,hash:plan.sourceHash}}:{}),cleanup};
   if(['ready','partial','conflict'].includes(cleanup.state))return this.complete(c,row.id,result);
   return result;
  }catch(error){if(error instanceof Error&&error.message==='knowledge_scope_changed')throw error;return this.uncertain(c,row.id);}
 }
 private async status(c:KnowledgeContext,id:string):Promise<KnowledgeReceipt|unknown>{
  const row=await this.row(c,id);this.current(c);if(!row)return {operationId:id,state:'not_found'};
  if(row.client!==c.client)throw Error('knowledge_operation_client');
  if(row.kind!=='remember'){this.owner(c);return row.response_json?JSON.parse(row.response_json):this.control(c,row);}
  if(!row.normalized_json)return {operationId:id,state:'accepted'};
  if(!await this.validFences(c,row.source_fences_json))return {operationId:id,state:'partial',error:'evidence_changed'};
  const result=await this.port.status(id);this.current(c);
  if(result.state==='not_found')return {operationId:id,state:row.state==='accepted'?'accepted':'uncertain'};
  if(!await this.validFences(c,row.source_fences_json))return {operationId:id,state:'partial',error:'evidence_changed'};
  return this.complete(c,id,result);
 }
 private async visible(c:KnowledgeContext,raw:KnowledgeClaim):Promise<Visible|null>{
  const claim=copy(raw);if(!Array.isArray(claim.supportGroups)||!claim.supportGroups.length)return null;
  const supportGroups:KnowledgeClaim['supportGroups']=[],proof:Snapshot={sources:[],origins:[]};
  for(const group of claim.supportGroups){if(!group.evidence.length)continue;const found:Snapshot={sources:[],origins:[]};let valid=true;
   for(const evidence of group.evidence){try{const source=await this.source(c,evidence.sourceRef,evidence.quote);found.sources.push(source.fence);if(source.originFence)found.origins.push(source.originFence);}catch(error){if(error instanceof Error&&error.message==='knowledge_scope_changed')throw error;valid=false;break;}}
   if(valid&&await this.validSnapshot(c,found)){supportGroups.push(group);proof.sources.push(...found.sources);proof.origins.push(...found.origins);}
  }
  if(!supportGroups.length)return null;
  const merged=new Map<string,KnowledgeClaim['evidence'][number]>();
  for(const evidence of supportGroups.flatMap(g=>g.evidence)){const prior=merged.get(evidence.id);merged.set(evidence.id,{...evidence,origins:[...new Set([...(prior?.origins??[]),...(evidence.origins??[])])]});}
  const evidence=[...merged.values()],origins=[...new Set(evidence.flatMap(e=>e.origins??[]))];
  return {claim:{...claim,supportGroups,evidence,origins,sourceFences:[...new Map(proof.sources.map(f=>[JSON.stringify(f),f])).values()]},proof};
 }
 private async entityVisible(c:KnowledgeContext,id:string):Promise<{proof:Snapshot;partial:boolean}|null>{let after:string|undefined,partial=false;const seen=new Set<string>();
  do{const page=await this.port.query({entityId:id,limit:20,...(after?{after}:{})});this.current(c);
   partial ||= page.coverage?.state==='partial';
   for(const claim of page.claims){const visible=await this.visible(c,claim);if(visible)return {proof:visible.proof,partial};}
   after=page.nextCursor;if(after&&seen.has(after))throw Error('knowledge_cursor_repeated');if(after)seen.add(after);
  }while(after);return null;
 }
 private async pageSnapshot(c:KnowledgeContext,proofs:Snapshot[]){
  if(!await this.validSnapshot(c,{sources:proofs.flatMap(p=>p.sources),origins:proofs.flatMap(p=>p.origins)}))throw Error('knowledge_evidence_changed');
 }
 async execute(raw:KnowledgeCommand):Promise<any>{
  if(new TextEncoder().encode(JSON.stringify(raw)).length>262144)throw Error('knowledge_request_size');
  const command=knowledgeCommand.parse(raw),c=this.context();
  if(command.kind==='query'){
   const {kind:_,...input}=command,page=await this.port.query(input);this.current(c);const claims:VerifiedKnowledgeClaim[]=[],proofs:Snapshot[]=[];let partial=page.coverage?.state==='partial';
   for(const claim of page.claims){const current=await this.visible(c,claim);if(current){claims.push(current.claim);proofs.push(current.proof);partial ||= current.claim.supportGroups.length!==claim.supportGroups.length;}}
   await this.pageSnapshot(c,proofs);
   return {claims,...(page.nextCursor?{nextCursor:page.nextCursor}:{}),coverage:{scope:'native_candidate_page',state:partial||claims.length!==page.claims.length?'partial':'complete',archive:'not_exhaustive'}};
  }
  if(command.kind==='entities'){
   const {kind:_,...input}=command,page=await this.port.find_entities(input);this.current(c);const entities=[],proofs:Snapshot[]=[];let partial=page.coverage?.state==='partial';
   for(const entity of page.entities){const visible=await this.entityVisible(c,entity.id);if(visible){entities.push(entity);proofs.push(visible.proof);partial ||= visible.partial;}}
   await this.pageSnapshot(c,proofs);
   return {entities,...(page.nextCursor?{nextCursor:page.nextCursor}:{}),coverage:{scope:'native_candidate_page',state:partial||entities.length!==page.entities.length?'partial':'complete',archive:'not_exhaustive'}};
  }
  if(command.kind==='status')return this.status(c,command.operationId);
  if(command.kind!=='remember')this.owner(c);
  const row=await this.admit(c,command);
  if(command.kind!=='remember')return row.response_json?JSON.parse(row.response_json):this.control(c,row);
  if(row.response_json||row.state!=='accepted')return this.status(c,command.operationId);
  let normalized:NativeKnowledgeWrite,proof:Snapshot;
  if(row.normalized_json){normalized=JSON.parse(row.normalized_json);proof=this.snapshot(row.source_fences_json!);if(!await this.validFences(c,row.source_fences_json))return {operationId:command.operationId,state:'partial',error:'evidence_changed'};}
  else{
   const aliases=new Map<string,string>(),entities:NativeKnowledgeWrite['entities']=[];proof={sources:[],origins:[]};
   for(const input of command.entities){if(aliases.has(input.key))throw Error('knowledge_entity_alias');
    let entity;if('ref'in input){entity=await this.port.get_entity(input.ref);this.current(c);if(!entity||!await this.entityVisible(c,input.ref))throw Error('knowledge_entity_unavailable');}
    else{entity={id:'entity-'+await bridgeHash(['knowledge-entity-v1',c.scope,command.operationId,input.key]),kind:input.kind,name:input.name};this.current(c);}
    aliases.set(input.key,entity.id);entities.push(entity);
   }
   const relations=[];
   for(const relation of command.relations){const subjectId=aliases.get(relation.subjectId),objectId=aliases.get(relation.objectId);if(!subjectId||!objectId)throw Error('knowledge_entity_alias');
    for(const evidence of relation.evidence){const source=await this.source(c,evidence.sourceRef,evidence.quote);proof.sources.push(source.fence);if(source.originFence)proof.origins.push(source.originFence);}
    relations.push({...relation,subjectId,objectId});
   }
   normalized={entities,relations,origin:'agent_derived'};
   await this.db.prepare("UPDATE assistant_knowledge_operations SET normalized_json=?,source_fences_json=? WHERE installation_id=? AND generation=? AND id=? AND normalized_json IS NULL AND state='accepted'").bind(JSON.stringify(normalized),JSON.stringify(proof),...this.keys(c),command.operationId).run();
   const stored=(await this.row(c,command.operationId))!;normalized=JSON.parse(stored.normalized_json!);proof=this.snapshot(stored.source_fences_json!);
  }
  if(!await this.validSnapshot(c,proof))return {operationId:command.operationId,state:'partial',error:'evidence_changed'};
  if(!await this.claim(c,command.operationId))return this.status(c,command.operationId);
  try{const result=await this.port.remember(command.operationId,normalized);this.current(c);
   if(!await this.validSnapshot(c,proof))return this.complete(c,command.operationId,{operationId:command.operationId,state:'partial',error:'evidence_changed'});
   return this.complete(c,command.operationId,result);
  }catch(error){if(error instanceof Error&&error.message==='knowledge_scope_changed')throw error;return this.uncertain(c,command.operationId);}
 }
}
