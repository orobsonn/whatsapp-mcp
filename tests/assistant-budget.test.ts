import {env} from 'cloudflare:test';
import {beforeEach,it,expect} from 'vitest';
import {InferenceBudget} from '../assistant/budget';
import {invokeBudgeted,prepareInference} from '../assistant/models';
import {JobQueue} from '../assistant/queue';
import {JobController} from '../assistant/jobs';
import {SourceController} from '../assistant/sources';
import {receiveCapture} from '../assistant/ingress';
// @ts-expect-error Vite raw SQL import.
import sources from '../assistant/migrations/0001_sources.sql?raw';
// @ts-expect-error Vite raw SQL import.
import policies from '../assistant/migrations/0002_identity_policy.sql?raw';
// @ts-expect-error Vite raw SQL import.
import work from '../assistant/migrations/0003_work.sql?raw';
// @ts-expect-error Vite raw SQL import.
import inbox from '../assistant/migrations/0004_capture_inbox.sql?raw';
// @ts-expect-error Vite raw SQL import.
import jobs from '../assistant/migrations/0005_job_ledger.sql?raw';
// @ts-expect-error Vite raw SQL import.
import controls from '../assistant/migrations/0007_source_controls.sql?raw';
// @ts-expect-error Vite raw SQL import, without app config changes.
import schema from '../assistant/migrations/0008_inference_budget.sql?raw';
let budget:InferenceBudget;
let installationId:string;
const hash='a'.repeat(64), request={model:'synthetic-small',input:'fixture',maxOutputTokens:10,priceVersion:'synthetic-v1'};
beforeEach(async()=>{
 const statements=schema.replace(/^--.*$/gm,'').trim().split(/;\s*(?=CREATE|$)/).filter((s:string)=>s.trim());
 if(statements.length)await env.DB.batch(statements.map((s:string)=>env.DB.prepare(s)));
 installationId=crypto.randomUUID();budget=new InferenceBudget(env.DB,{installationId,generation:'g',period:'pilot'});
});
it('blocks inference at the queue boundary while capture and its pending item survive',async()=>{
 for(const sql of [sources,policies,work,inbox,jobs,controls]){
  await env.DB.batch(sql.replace(/^--.*$/gm,'').trim().split(/;\s*(?=CREATE|$)/).filter((s:string)=>s.trim()).map((s:string)=>env.DB.prepare(s)));
 }
 const scope={installationId,generation:'g'},owner=new SourceController(env.DB,scope,{kind:'owner'});
 const source=await owner.create({originKey:'budget-input',text:'Synthetic request',occurredAt:1});
 const queue=new JobQueue(env.DB,scope),job=await queue.enqueue({kind:'reasoning',dedupeKey:'budget-test',sourceId:source.id,sourceRevision:1,request:JSON.stringify(request)},100);
 await budget.configure(0);let calls=0;
 const controller=new JobController(queue,{
  prepare:(key,requestHash)=>prepareInference(budget,key,requestHash,5),
  execute:async()=>{calls++;return 'must not happen';},lookup:async()=>({state:'not_found'}),
 },()=>100);
 expect(await controller.process((await queue.claim(100))!)).toBe('blocked');
 expect(calls).toBe(0);expect((await queue.ledger(job.id))?.state).toBe('prepared');
 expect(await queue.get(job.id)).toMatchObject({state:'failed',last_error:'budget_blocked'});
 const secret='synthetic-bridge-budget-test-secret';
 const response=await receiveCapture(new Request('https://assistant.invalid/internal/capture',{method:'POST',headers:{Authorization:`Bearer ${secret}`},body:JSON.stringify({protocol:1,...scope,sourceEpoch:'capture',sourceGeneration:'capture-g',sequence:1,previousSequence:0,chatId:'c',sourceId:'m',sourceKind:'message',operation:'upsert',recordedAt:100})}),{
  DB:env.DB,BRIDGE_SECRET:secret,INSTALLATION_ID:installationId,OPERATIONAL_GENERATION:'g',BRIDGE_SOURCE_EPOCH:'capture',BRIDGE_SOURCE_GENERATION:'capture-g',
 });
 expect(response.status).toBe(200);
 expect(await env.DB.prepare('SELECT application_state FROM assistant_capture_inbox WHERE installation_id=?').bind(installationId).first()).toEqual({application_state:'pending'});
});
it('admits only six concurrent reservations under 30 with ceiling 5',async()=>{
 await budget.configure(30);
 const results=await Promise.allSettled(Array.from({length:10},(_,n)=>budget.reserve('op'+n,hash,5)));
 expect(results.filter(x=>x.status==='fulfilled')).toHaveLength(6);
 expect(await budget.status()).toEqual({cap:30,committed:30,blocked:false});
});
it('same key is idempotent but changed effective request or ceiling conflicts',async()=>{
 await budget.configure(10);
 expect(await budget.reserve('same',hash,5)).toMatchObject({created:true});
 expect(await budget.reserve('same',hash,5)).toMatchObject({created:false});
 await expect(budget.reserve('same','b'.repeat(64),5)).rejects.toThrow('reservation_conflict');
 await expect(budget.reserve('same',hash,6)).rejects.toThrow('reservation_conflict');
 expect((await budget.status()).committed).toBe(5);
});
it('timeout retains full reservation and lookup never frees it by itself',async()=>{
 await budget.configure(5);await budget.reserve('timeout',hash,5);await budget.uncertain('timeout');
 expect(await budget.reserve('timeout',hash,5)).toMatchObject({created:false,state:'uncertain'});
 await expect(budget.reserve('another',hash,1)).rejects.toThrow('budget_exhausted');
});
it('settles actual once and rejects contradictory settlement',async()=>{
 await budget.configure(10);await budget.reserve('done',hash,8);await budget.settle('done',hash,3);await budget.settle('done',hash,3);
 expect((await budget.status()).committed).toBe(3);
 await expect(budget.settle('done',hash,1)).rejects.toThrow('settlement_conflict');
});
it('records overage honestly and blocks later paid work',async()=>{
 await budget.configure(10);await budget.reserve('over',hash,5);await budget.settle('over',hash,12);
 expect(await budget.status()).toEqual({cap:10,committed:12,blocked:true});
 await expect(budget.reserve('new',hash,1)).rejects.toThrow('budget_blocked');
});
it('scope and safe integer validation prevent accidental reset or negative charges',async()=>{
 await expect(budget.reserve('missing',hash,1)).rejects.toThrow('budget_unconfigured');
 await budget.configure(10);
 for(const n of [-1,0,1.5,Number.MAX_SAFE_INTEGER+1])await expect(budget.reserve('invalid',hash,n)).rejects.toThrow('invalid_budget_units');
 const other=new InferenceBudget(env.DB,{installationId:'other',generation:'g',period:'pilot'});
 await expect(other.reserve('missing',hash,1)).rejects.toThrow('budget_unconfigured');
});
it('wrapper reserves before inference and duplicate reservation never invokes twice',async()=>{
 await budget.configure(10);let executions=0;
 const adapter=async()=>{executions++;expect((await budget.status()).committed).toBe(5);return {output:'synthetic',cost:2};};
 expect(await invokeBudgeted(budget,'model',request,5,adapter)).toEqual({state:'complete',output:'synthetic'});
 expect(await invokeBudgeted(budget,'model',request,5,adapter)).toEqual({state:'already_reserved'});
 expect(executions).toBe(1);expect((await budget.status()).committed).toBe(2);
});
it('provider failure and changed model cannot cause paid retry under the same key',async()=>{
 await budget.configure(10);let executions=0;
 const adapter=async()=>{executions++;throw new Error('synthetic timeout');};
 expect(await invokeBudgeted(budget,'lost',request,5,adapter)).toEqual({state:'uncertain'});
 expect(await invokeBudgeted(budget,'lost',request,5,adapter)).toEqual({state:'already_reserved'});
 await expect(invokeBudgeted(budget,'lost',{...request,model:'different'},5,adapter)).rejects.toThrow('reservation_conflict');
 expect(executions).toBe(1);expect((await budget.status()).committed).toBe(5);
});
it('rollover cannot reserve the same operation twice or escape a blocked namespace',async()=>{
 await budget.configure(10);await budget.reserve('rollover',hash,5);
 const tomorrow=new InferenceBudget(env.DB,{installationId,generation:'g',period:'tomorrow'});
 expect(await tomorrow.reserve('rollover',hash,5)).toEqual({created:false,state:'reserved'});
 await tomorrow.configure(10);await tomorrow.settle('rollover',hash,12);
 expect(await budget.status()).toEqual({cap:10,committed:12,blocked:true});
 await expect(tomorrow.reserve('new',hash,1)).rejects.toThrow('budget_blocked');
});
it('concurrent settlements cannot overwrite the winning actual charge',async()=>{
 await budget.configure(10);await budget.reserve('race',hash,5);
 const results=await Promise.allSettled([budget.settle('race',hash,2),budget.settle('race',hash,3)]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect([2,3]).toContain((await budget.status()).committed);
});
// Lose the response after the real D1 write; the write itself is never mocked.
function lostAcknowledgement(kind:'reserve'|'settle'):D1Database{
 let lost=false;
 const wrap=(statement:D1PreparedStatement):D1PreparedStatement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...values:unknown[])=>wrap(target.bind(...values));
  if(key==='all')return async()=>{const result=await target.all();if(!lost&&kind==='reserve'){lost=true;throw new Error('lost_ack');}return result;};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 return new Proxy(env.DB,{get(target,key){
  if(key==='prepare')return(sql:string)=>wrap(target.prepare(sql));
  if(key==='batch')return async(statements:D1PreparedStatement[])=>{const result=await target.batch(statements);if(!lost&&kind==='settle'){lost=true;throw new Error('lost_ack');}return result;};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
it('lost reservation acknowledgement never permits a paid retry',async()=>{
 await budget.configure(10);let calls=0;
 const uncertain=new InferenceBudget(lostAcknowledgement('reserve'),{installationId,generation:'g',period:'pilot'});
 const adapter=async()=>{calls++;return{output:'synthetic',cost:1};};
 await expect(invokeBudgeted(uncertain,'reserve-lost',request,5,adapter)).rejects.toThrow('lost_ack');
 expect(await invokeBudgeted(budget,'reserve-lost',request,5,adapter)).toEqual({state:'already_reserved'});
 expect(calls).toBe(0);expect((await budget.status()).committed).toBe(5);
});
it('lost settlement acknowledgement reconciles the same stored actual cost',async()=>{
 await budget.configure(10);await budget.reserve('settle-lost',hash,5);
 const uncertain=new InferenceBudget(lostAcknowledgement('settle'),{installationId,generation:'g',period:'pilot'});
 await expect(uncertain.settle('settle-lost',hash,2)).rejects.toThrow('lost_ack');
 await budget.settle('settle-lost',hash,2);expect((await budget.status()).committed).toBe(2);
 await expect(budget.settle('settle-lost',hash,3)).rejects.toThrow('settlement_conflict');
});
it('blocked budget invokes no adapter and price changes cannot reuse a reservation',async()=>{
 await budget.configure(10);let calls=0;
 const adapter=async()=>{calls++;return{output:'synthetic',cost:2};};
 await invokeBudgeted(budget,'priced',request,5,adapter);
 await expect(invokeBudgeted(budget,'priced',{...request,priceVersion:'synthetic-v2'},5,adapter)).rejects.toThrow('reservation_conflict');
 await budget.reserve('overage',hash,5);await budget.settle('overage',hash,6);
 await expect(invokeBudgeted(budget,'blocked',request,1,adapter)).rejects.toThrow('budget_blocked');
 expect(calls).toBe(1);
});
