import {env,createExecutionContext} from 'cloudflare:test';
import {afterEach,expect,it,vi} from 'vitest';
import {mcpFetch} from '../src/mcp';
import type {Env} from '../src/env';
import {OwnerAssistant} from '../assistant/mcp';
import type {AssistantEnv} from '../assistant/env';
const owner={sub:'synthetic-knowledge-owner',epoch:'synthetic-e1'};
function request(method:string,params:unknown={}){return new Request('https://synthetic.invalid/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});}
function setup(){
 const scope={installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:owner.epoch,sourceGeneration:'sg1'};
 const own:AssistantEnv={DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,
  BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,
  KNOWLEDGE_SERVICE_URL:'https://synthetic.invalid/knowledge',KNOWLEDGE_SERVICE_TOKEN:'synthetic-knowledge-token'.repeat(3),KNOWLEDGE_SPACE_GENERATION:'knowledge-v1'};
 const rpc=new OwnerAssistant(createExecutionContext(),own);
 const settings:Env={...env,PUBLIC_ORIGIN:'https://synthetic.invalid',OWNER_SUB:owner.sub,INSTALLATION_EPOCH:owner.epoch,
  CONNECTION_GENERATION:scope.sourceGeneration,MAINTENANCE:'false',ASSISTANT_INSTALLATION_ID:scope.installationId,
  ASSISTANT_GENERATION:scope.generation,ASSISTANT_OWNER:rpc,ASSISTANT_KNOWLEDGE_ENABLED:'true'};
 return {scope,own,rpc,settings};
}
afterEach(()=>vi.restoreAllMocks());
it('advertises memory only when enabled and authenticated through the existing assistant MCP',async()=>{
 const {settings}=setup();
 const names=async(s:Env)=>{const r=await mcpFetch(request('tools/list'),s,owner);return (await r.json() as any).result.tools.map((t:any)=>t.name);};
 expect(await names({...settings,ASSISTANT_KNOWLEDGE_ENABLED:'false'})).not.toContain('assistente_memoria');
 expect(await names(settings)).toContain('assistente_memoria');
 await expect(mcpFetch(request('tools/list'),settings,{...owner,sub:'other'})).rejects.toThrow();
});
it('records owner context through MCP and reads its original without granting model-chosen namespace',async()=>{
 const {settings,rpc,scope}=setup(),transport=vi.spyOn(globalThis,'fetch');
 const command={kind:'context.report',operationId:'report',text:'Synthetic Nora leads Cedar.'};
 async function call(args:unknown){const r=await mcpFetch(request('tools/call',{name:'assistente_memoria',arguments:args}),settings,owner);return (await r.json() as any).result;}
 const result=await call({command});expect(result.isError).not.toBe(true);
 const receipt=JSON.parse(result.content[0].text);expect(receipt).toMatchObject({state:'recorded',origin:'owner_report'});
 const original=await rpc.query(scope,{kind:'source',id:receipt.sourceRef.id}) as any;
 expect(original).toMatchObject({state:'available',source:{text:command.text,fence:{source:{origin:'owner_report'}}}});
 for(const extra of [{namespace:'foreign'},{role:'owner'},{url:'https://foreign.invalid'},{sql:'SELECT *'}]){
  expect((await call({command,...extra})).isError).toBe(true);
  expect((await call({command:{...command,...extra}})).isError).toBe(true);
 }
 expect(transport).not.toHaveBeenCalled();
});
it('uses the host-configured shared space and refuses foreign affinity before transport',async()=>{
 const {rpc,scope,own}=setup();
 const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
  const body=JSON.parse(init?.body as string);expect(body.namespace).toEqual({installationId:scope.installationId,generation:'knowledge-v1'});
  expect(body.method).toBe('query');expect(body.input).toEqual({limit:20});
  return Response.json({ok:true,namespace:body.namespace,result:{claims:[],coverage:{scope:'native_candidate_page',state:'complete',candidates:0,returned:0}}});
 });
 expect(await rpc.knowledge(scope,{kind:'query'})).toMatchObject({claims:[],coverage:{archive:'not_exhaustive'}});
 expect(transport).toHaveBeenCalledTimes(1);
 await expect(rpc.knowledge({...scope,generation:'foreign'},{kind:'query'})).rejects.toThrow('owner_binding_affinity');
 expect(transport).toHaveBeenCalledTimes(1);
 expect(JSON.stringify(await rpc.knowledge(scope,{kind:'query'}))).not.toContain(own.KNOWLEDGE_SERVICE_TOKEN);
});
it('honors restore hold before accepting new context or calling the native service',async()=>{
 const {rpc,scope}=setup(),transport=vi.spyOn(globalThis,'fetch');
 await env.DB.prepare('INSERT INTO assistant_retention_runtime_hold(installation_id,operation_id,target_generation,active,created_at) VALUES(?,?,?,1,1)').bind(scope.installationId,'synthetic_restore','restored-g2').run();
 await expect(rpc.knowledge(scope,{kind:'context.report',operationId:'held',text:'Do not record'})).rejects.toThrow('restore_runtime_paused');
 expect(await env.DB.prepare('SELECT id FROM assistant_knowledge_operations WHERE installation_id=?').bind(scope.installationId).first()).toBeNull();
 expect(transport).not.toHaveBeenCalled();
});
