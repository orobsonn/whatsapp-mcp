import{env}from'cloudflare:test';
import{it,expect,vi}from'vitest';
import{receiveCapture}from'../assistant/ingress';
import type{AssistantEnv}from'../assistant/env';
import application from'../assistant/index';
const native=vi.hoisted(()=>({receive:vi.fn()}));
vi.mock('../assistant/agent-runtime/native-host',()=>({NativeApplicationHost:class{receiveCapture(sequence:number){return native.receive(sequence);}}}));
const secret='synthetic-capture-callback-secret-at-least32';
function fixture(){const installationId=crypto.randomUUID(),event={protocol:1,installationId,generation:'g1',sourceEpoch:'e1',sourceGeneration:'s1',sequence:1,previousSequence:0,chatId:'synthetic-chat',sourceId:'synthetic-message',sourceKind:'message',operation:'upsert',recordedAt:1};
 const configuration:AssistantEnv={DB:env.DB,INSTALLATION_ID:installationId,OPERATIONAL_GENERATION:'g1',BRIDGE_SOURCE_EPOCH:'e1',BRIDGE_SOURCE_GENERATION:'s1',BRIDGE_SECRET:secret,NATIVE_CONVERSATIONS_MODE:'approval'};
 const request=(token=secret)=>new Request('https://own.invalid/internal/capture',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(event)});return{event,configuration,request};}
it('authenticates and commits the exact transport receipt before native intake receives its sequence',async()=>{
 const f=fixture(),intake=vi.fn(async(sequence:number)=>{expect(sequence).toBe(1);expect(await env.DB.prepare('SELECT source_id FROM assistant_capture_inbox WHERE installation_id=? AND sequence=?').bind(f.event.installationId,sequence).first('source_id')).toBe(f.event.sourceId);});
 expect((await receiveCapture(f.request('wrong'),f.configuration,intake)).status).toBe(403);expect(intake).not.toHaveBeenCalled();
 expect(await(await receiveCapture(f.request(),f.configuration,intake)).json()).toMatchObject({state:'received',sequence:1});expect(intake).toHaveBeenCalledOnce();
});
it('keeps the durable receipt available for reconciliation if native admission fails',async()=>{
 const f=fixture(),intake=vi.fn(async()=>{throw Error('synthetic_downstream_unavailable');});
 expect((await receiveCapture(f.request(),f.configuration,intake)).status).toBe(200);expect(intake).toHaveBeenCalledOnce();
 expect(await env.DB.prepare('SELECT application_state FROM assistant_capture_inbox WHERE installation_id=?').bind(f.event.installationId).first('application_state')).toBe('pending');
});
it.each([{NATIVE_CONVERSATIONS_MODE:'off' as const},{ROUTINES_PAUSED:'true'}])('does not wake native intake when the host is disabled: %j',async mode=>{
 const f=fixture(),intake=vi.fn(async()=>{});expect((await receiveCapture(f.request(),{...f.configuration,...mode},intake)).status).toBe(200);expect(intake).not.toHaveBeenCalled();
});
it('acknowledges committed capture while native admission is still running, using the Worker lifetime',async()=>{
 const f=fixture(),continuations:Promise<unknown>[]=[];let finish!:()=>void;
 const held=new Promise<void>(resolve=>{finish=resolve;});native.receive.mockImplementation(async()=>{await held;});
 const context={waitUntil:(promise:Promise<unknown>)=>{continuations.push(promise);}} as unknown as ExecutionContext;
 expect((await application.fetch(f.request('wrong'),f.configuration,context)).status).toBe(403);expect(continuations).toHaveLength(0);expect(native.receive).not.toHaveBeenCalled();
 const pending=application.fetch(f.request(),f.configuration,context);
 try{
  // Source aborts its bridge at 2s. A held downstream operation must not own
  // that ACK; this bounded check completes without releasing native intake.
  const response=await Promise.race([pending,new Promise<null>(resolve=>setTimeout(()=>resolve(null),1000))]);
  expect(response?.status).toBe(200);expect(continuations).toHaveLength(1);
  expect(await env.DB.prepare('SELECT source_id FROM assistant_capture_inbox WHERE installation_id=?').bind(f.event.installationId).first('source_id')).toBe(f.event.sourceId);
 }finally{finish();await pending;await Promise.allSettled(continuations);}
});
