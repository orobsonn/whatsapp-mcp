import {env} from 'cloudflare:test';
import {beforeEach,it,expect,vi} from 'vitest';
import {ownerContextSummary} from '../assistant/owner-context-summary';
import {CanonicalCandidateExtractor} from '../assistant/canonical-extraction';
import {SourceController} from '../assistant/sources';
import {OwnerControl} from '../assistant/control';
import {InferenceBudget} from '../assistant/budget';
import type {OriginScope} from '../assistant/origin-guard';
import {SourceAccess} from '../assistant/access';
import {Routines,dailySummarySchema} from '../assistant/routines';
import {OriginGuard} from '../assistant/origin-guard';
import {receiveCapture} from '../assistant/ingress';
import {CaptureMaterializer} from '../assistant/materialize';
import {Conversations} from '../assistant/conversations';
const owner={kind:'owner'} as const;
let scope:OriginScope,now:number,sources:SourceController,anchor:string,support:string;
beforeEach(async()=>{
 scope={installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:'epoch',sourceGeneration:'capture'};now=Date.now();sources=new SourceController(env.DB,scope,owner,()=>now);
 await new OwnerControl(env.DB,scope,owner,()=>now).execute({kind:'project.put',operationId:'project',id:'private-project',expectedVersion:0,name:'Synthetic private project'});
 support=(await sources.create({originKey:'context',projectId:'private-project',text:'Private project context from the owner.',occurredAt:now})).id;
 anchor=(await sources.create({originKey:'anchor',audience:'public',text:'Independent original without a project.',occurredAt:now})).id;
 await new InferenceBudget(env.DB,{...scope,period:new Date(now).toISOString().slice(0,10)}).configure(100000);
});
async function publish(id=anchor,claims:unknown[]=[]){const adapter=vi.fn(async()=>({status:200,actualUnits:3,body:JSON.stringify({choices:[{message:{content:JSON.stringify({claims})}}]})}));expect(await new CanonicalCandidateExtractor(env.DB,scope,{clock:()=>now,adapter,enabled:()=>true,guard:()=>({sql:'1',values:[]})}).extract(owner,id,1)).toMatchObject({state:'published'});expect(adapter).toHaveBeenCalledTimes(1);return adapter;}
it('counts the global authorized Owner context and zero-claim backing without clearing the other pending source',async()=>{
 await publish();expect(await ownerContextSummary(env.DB,scope)).toMatchObject({sources:2,published:1,pending:1,missingCatalog:0,uncertain:0,observation:'current_generation_metadata'});
});
it('keeps CAS-only project edits backed but invalidates a changed descriptor and a withdrawn support',async()=>{
 await publish(anchor,[{kind:'suggestion',subject:{kind:'project',id:'private-project'},predicate:'candidate',quote:'Independent original without a project.'}]);
 const controls=new OwnerControl(env.DB,scope,owner,()=>now);await controls.execute({kind:'project.put',operationId:'same',id:'private-project',expectedVersion:1,name:'Synthetic private project'});
 expect(await ownerContextSummary(env.DB,scope)).toMatchObject({published:1,pending:1,missingCatalog:0});
 await controls.execute({kind:'project.put',operationId:'changed',id:'private-project',expectedVersion:2,name:'Different descriptor'});expect(await ownerContextSummary(env.DB,scope)).toMatchObject({published:0,pending:2,stale:1});
 const money=(await env.DB.prepare('SELECT * FROM assistant_budget_reservations WHERE installation_id=?').bind(scope.installationId).all()).results;
 await sources.withdraw(support,1);expect(await ownerContextSummary(env.DB,scope)).toMatchObject({sources:1,published:0,pending:1,missingCatalog:1});expect((await env.DB.prepare('SELECT * FROM assistant_budget_reservations WHERE installation_id=?').bind(scope.installationId).all()).results).toEqual(money);
});
it('refuses published metadata after losing support proof without changing the latch or money',async()=>{
 await publish();const before=(await env.DB.prepare('SELECT * FROM assistant_canonical_extractions WHERE installation_id=?').bind(scope.installationId).all()).results;
 await env.DB.prepare('DELETE FROM assistant_owner_canonical_supports WHERE installation_id=?').bind(scope.installationId).run();expect(await ownerContextSummary(env.DB,scope)).toMatchObject({published:0,pending:2,stale:1});
 expect((await env.DB.prepare('SELECT * FROM assistant_canonical_extractions WHERE installation_id=?').bind(scope.installationId).all()).results).toEqual(before);
});
it('requires exact financial settlement rather than a published flag or receipt alone',async()=>{
 await publish();const before=(await env.DB.prepare('SELECT * FROM assistant_budget_reservations WHERE installation_id=?').bind(scope.installationId).all()).results;
 await env.DB.prepare('UPDATE assistant_model_receipts SET actual_units=4 WHERE installation_id=?').bind(scope.installationId).run();expect(await ownerContextSummary(env.DB,scope)).toMatchObject({published:0,pending:2,stale:1});expect((await env.DB.prepare('SELECT * FROM assistant_budget_reservations WHERE installation_id=?').bind(scope.installationId).all()).results).toEqual(before);
});
it('preserves unknown attempts and financial ceilings across repeated metadata reads with no adapter retry',async()=>{
 const adapter=vi.fn(async()=>{throw Error('synthetic_provider_timeout');}),extractor=new CanonicalCandidateExtractor(env.DB,scope,{clock:()=>now,adapter,enabled:()=>true,guard:()=>({sql:'1',values:[]})});
 expect(await extractor.extract(owner,anchor,1)).toMatchObject({state:'uncertain'});const before=(await env.DB.prepare('SELECT * FROM assistant_budget_reservations WHERE installation_id=?').bind(scope.installationId).all()).results;
 for(let i=0;i<2;i++)expect(await ownerContextSummary(env.DB,scope)).toMatchObject({published:0,pending:2,uncertain:1});expect(adapter).toHaveBeenCalledTimes(1);expect((await env.DB.prepare('SELECT * FROM assistant_budget_reservations WHERE installation_id=?').bind(scope.installationId).all()).results).toEqual(before);
});
async function guestItem(){await env.DB.prepare(`INSERT INTO assistant_routine_items(installation_id,generation,source_epoch,source_generation,id,subject_json,binding_hash,binding_json,observation_key,actor_json,profile,source_id,source_revision,state,created_at,updated_at) VALUES(?,?,?,?, 'guest','{}',?,'{}','guest','{"kind":"interlocutor"}','interlocutor',?,1,'complete',?,?)`).bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,'a'.repeat(64),anchor,now,now).run();}
it('treats purged/corrupt private statuses as blocked and leaves guest phase, last gap and fingerprint intact',async()=>{
 await publish();await guestItem();const guest={kind:'interlocutor',provider:'whatsapp',address:'synthetic',conversationId:'chat',conversationKind:'private',action:'reply_text'} as const,access=new SourceAccess(env.DB,scope),q=access.inventory(guest,undefined,now),fp=async()=>env.DB.prepare('SELECT fingerprint FROM ('+q.sql+') WHERE id=?').bind(...q.values,anchor).first('fingerprint');const before=await fp(),item=await env.DB.prepare('SELECT * FROM assistant_routine_items WHERE installation_id=?').bind(scope.installationId).first();
 await env.DB.prepare(`INSERT INTO assistant_owner_canonical_status VALUES(?,?,?,?, 'guest',?,1,?)`).bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,anchor,'{"state":"blocked","gap":"canonical_context_purged"}').run();expect(await ownerContextSummary(env.DB,scope)).toMatchObject({published:0,pending:2,redacted:1,blocked:1});
 await env.DB.prepare('UPDATE assistant_owner_canonical_status SET body_json=? WHERE installation_id=?').bind('"invalid_status"',scope.installationId).run();expect(await ownerContextSummary(env.DB,scope)).toMatchObject({published:0,pending:2,blocked:1});
 expect(await fp()).toBe(before);expect(await env.DB.prepare('SELECT * FROM assistant_routine_items WHERE installation_id=?').bind(scope.installationId).first()).toEqual(item);
});
it('reports a bounded partial page and full denominator with SELECT-only calls within the Worker D1 quota',async()=>{
 const list=JSON.stringify(Array.from({length:63},(_,i)=>({id:'zz-extra-'+String(i).padStart(3,'0')})));
 await env.DB.batch([env.DB.prepare(`INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key) SELECT ?,?,json_extract(value,'$.id'),'owner_note',json_extract(value,'$.id') FROM json_each(?)`).bind(scope.installationId,scope.generation,list),env.DB.prepare(`INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) SELECT ?,?,json_extract(value,'$.id'),1,'Synthetic original',?,? FROM json_each(?)`).bind(scope.installationId,scope.generation,'a'.repeat(64),now,list)]);
 let calls=0,maxBinds=0;const counted={prepare(sql:string){expect(/^\s*(SELECT|WITH)\b/i.test(sql)).toBe(true);const statement=env.DB.prepare(sql);return new Proxy(statement,{get(t,key){if(key==='bind')return(...values:unknown[])=>{maxBinds=Math.max(maxBinds,values.length);const bound=t.bind(...values);return new Proxy(bound,{get(b,method){const value=Reflect.get(b,method,b);if(['all','first','run','raw'].includes(String(method)))return(...args:unknown[])=>{calls++;return value.apply(b,args);};return typeof value==='function'?value.bind(b):value;}});};const v=Reflect.get(t,key,t);return typeof v==='function'?v.bind(t):v;}});},batch:async(statements:D1PreparedStatement[])=>{calls++;return env.DB.batch(statements);}} as D1Database;
 expect(await ownerContextSummary(counted,scope)).toMatchObject({sources:65,published:0,pending:65,examined:64,coverage:'partial',remoteFreshness:'unchecked'});expect(calls).toBeLessThanOrEqual(1000);expect(maxBinds).toBeLessThanOrEqual(100);
});
it('writes a private daily DTO with metadata qualifiers and accepts earlier cached DTOs without touching guest workflow',async()=>{
 await publish();await guestItem();const routines=new Routines(env.DB,scope,()=>now),result=await routines.daily(true);expect(result.summary.canonicalExtraction).toMatchObject({sources:2,published:1,pending:1,missingCatalog:0,remoteFreshness:'unchecked',coverage:'complete'});expect(result.summary.freshness).toBe('metadata_unchecked');expect(await env.DB.prepare('SELECT state,last_gap,phase FROM assistant_routine_items WHERE installation_id=?').bind(scope.installationId).first()).toEqual({state:'complete',last_gap:null,phase:'created'});
 const old=structuredClone(result.summary);old.canonicalExtraction={sources:2,published:0,pending:2,missingCatalog:1,uncertain:0,observation:'current_generation_metadata'};expect(dailySummarySchema.parse(old)).toEqual(old);expect((await routines.daily(true)).id).toBe(result.id);
});
it('validates the exact16-support boundary without compacting guard authority or exceeding D1 bind limits',async()=>{
 const controls=new OwnerControl(env.DB,scope,owner,()=>now);for(let i=0;i<15;i++){await controls.execute({kind:'project.put',operationId:'p'+i,id:'p'+i,expectedVersion:0,name:'Synthetic project '+i});await sources.create({originKey:'context'+i,projectId:'p'+i,text:'Bounded owner context '+i,occurredAt:now});}await publish();
 let maxBinds=0;const wrap=(stmt:D1PreparedStatement):D1PreparedStatement=>new Proxy(stmt,{get(t,key){if(key==='bind')return(...v:unknown[])=>{maxBinds=Math.max(maxBinds,v.length);return wrap(t.bind(...v));};const v=Reflect.get(t,key,t);return typeof v==='function'?v.bind(t):v;}}),db={prepare:(q:string)=>wrap(env.DB.prepare(q)),batch:env.DB.batch.bind(env.DB)} as D1Database;
 expect(await ownerContextSummary(db,scope)).toMatchObject({sources:17,published:1,pending:16,missingCatalog:0,coverage:'complete'});expect(maxBinds).toBeLessThanOrEqual(100);
});
it('rechecks support authorization in the final read transaction after intervening awaits',async()=>{
 await publish();let armed=true;const queries=new WeakMap<object,string>(),wrap=(stmt:D1PreparedStatement,q:string):D1PreparedStatement=>{const proxy=new Proxy(stmt,{get(t,key){if(key==='bind')return(...v:unknown[])=>wrap(t.bind(...v),q);const v=Reflect.get(t,key,t);return typeof v==='function'?v.bind(t):v;}});queries.set(proxy,q);return proxy;},db={prepare:(q:string)=>wrap(env.DB.prepare(q),q),batch:async(statements:D1PreparedStatement[])=>{if(armed&&statements.some(s=>queries.get(s)?.startsWith('SELECT 1 WHERE '))){armed=false;now++;await sources.withdraw(support,1);}return env.DB.batch(statements);}} as D1Database;
 expect(await ownerContextSummary(db,scope,{clock:()=>now})).toMatchObject({published:0,pending:2,stale:1});expect(armed).toBe(false);
});
it('counts materialized WhatsApp backing using only local origin metadata and never refreshes the remote Reader',async()=>{
 const secret='synthetic-summary-reader-secret-fixed',reader={readSnapshot:vi.fn(async(input:{sourceId:string})=>({observation:'capture_snapshot',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:'message',sourceId:input.sourceId,chatId:'chat',sourceVersion:1,watermark:1,conversationKind:'private',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text:'Synthetic WhatsApp evidence.',authorId:'opaque-author',authorName:'Synthetic author',occurredAt:now,messageId:input.sourceId,messageVersion:1}}))};
 expect((await receiveCapture(new Request('https://fixture.invalid/internal/capture',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify({protocol:1,...scope,sequence:1,previousSequence:0,chatId:'chat',sourceId:'message',sourceKind:'message',operation:'upsert',recordedAt:now})}),{DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,BRIDGE_SECRET:secret})).status).toBe(200);
 await new CaptureMaterializer(env.DB,()=>scope,reader,secret,()=>now).drain(1);await new Conversations(env.DB,()=>scope).replay('chat');const wa=(await env.DB.prepare("SELECT id FROM assistant_sources WHERE installation_id=? AND origin='whatsapp'").bind(scope.installationId).first<string>('id'))!;
 const adapter=vi.fn(async()=>({status:200,actualUnits:3,body:JSON.stringify({choices:[{message:{content:'{"claims":[]}'}}]})})),origin=new OriginGuard(env.DB,()=>scope,reader,secret);expect(await new CanonicalCandidateExtractor(env.DB,scope,{clock:()=>now,adapter,origin,enabled:()=>true,guard:()=>({sql:'1',values:[]})}).extract(owner,wa,1)).toMatchObject({state:'published'});const remoteCalls=reader.readSnapshot.mock.calls.length;
 expect(await ownerContextSummary(env.DB,scope)).toMatchObject({sources:3,published:1,pending:2,remoteFreshness:'unchecked'});expect(reader.readSnapshot).toHaveBeenCalledTimes(remoteCalls);expect(adapter).toHaveBeenCalledTimes(1);
 const conversations=new Conversations(env.DB,()=>scope);await conversations.setPaused('chat',(await conversations.state('chat')).revision,true);expect(await ownerContextSummary(env.DB,scope)).toMatchObject({sources:2,published:0,pending:2});expect(reader.readSnapshot).toHaveBeenCalledTimes(remoteCalls);
});
