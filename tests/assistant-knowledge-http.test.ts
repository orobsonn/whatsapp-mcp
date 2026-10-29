import {expect,it} from 'vitest';
import {HttpKnowledgePort} from '../assistant/knowledge/http-port';
import type {NativeKnowledgeWrite} from '../assistant/knowledge/contracts';
const namespace={installationId:'synthetic-installation',generation:'knowledge-v1'},token='synthetic-token-'.repeat(4);
const input:NativeKnowledgeWrite={entities:[],relations:[],origin:'agent_derived'};
function options(transport:typeof fetch,generation='runtime-1'){
 return {endpoint:'https://synthetic.example/knowledge',token,namespace,operationalGeneration:generation,client:'owner_mcp' as const,fetch:transport};
}
it('keeps shared namespace stable while separating operation receipts across runtime generations',async()=>{
 const calls:{namespace:typeof namespace;method:string;input:{operationId:string}}[]=[];
 const transport=(async(url,init)=>{expect(url).toBe('https://synthetic.example/knowledge');expect(init?.redirect).toBe('error');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer '+token);
  const body=JSON.parse(init?.body as string);calls.push(body);
  return Response.json({ok:true,namespace,result:{operationId:body.input.operationId,state:'ready'}});
 }) as typeof fetch;
 const first=new HttpKnowledgePort(options(transport)),second=new HttpKnowledgePort(options(transport,'runtime-2'));
 expect(await first.remember('same',input)).toMatchObject({operationId:'same',state:'ready'});
 await first.status('same');await second.status('same');
 expect(calls[0].input.operationId).toBe(calls[1].input.operationId);
 expect(calls[2].input.operationId).not.toBe(calls[0].input.operationId);
 expect(calls.every(x=>JSON.stringify(x.namespace)===JSON.stringify(namespace))).toBe(true);
 expect(JSON.stringify(calls)).not.toContain(token);
});
it('never retries an uncertain mutation or includes upstream secrets in errors',async()=>{
 let count=0;const port=new HttpKnowledgePort(options((async()=>{count++;throw Error(token);}) as typeof fetch));
 await expect(port.remember('uncertain',input)).rejects.toThrow(/^knowledge_transport_unavailable$/);expect(count).toBe(1);
});
it('accepts native remember receipts and their status with origin and support group IDs',async()=>{
 const nativeReceipt={state:'ready',origin:'agent_derived',claimIds:['claim-native-1'],
  evidenceIds:['evidence-native-1'],supportGroupIds:['support-native-1']};
 const port=new HttpKnowledgePort(options((async(_url,init)=>{
  const body=JSON.parse(init?.body as string);
  return Response.json({ok:true,namespace,result:{operationId:body.input.operationId,...nativeReceipt}});
 }) as typeof fetch));
 expect(await port.remember('native-write',input)).toEqual({operationId:'native-write',...nativeReceipt});
 expect(await port.status('native-write')).toEqual({operationId:'native-write',...nativeReceipt});
});
it('accepts native withdrawal receipts and their status with the source key',async()=>{
 const nativeReceipt={state:'ready',sourceKey:'f930b92c-73c0-5b6a-8e98-a9dd01bb62d1:1b4cfef2-d24a-55a9-916c-59ca8422dc67',
  claimIds:['claim-native-1'],evidenceIds:[]};
 const port=new HttpKnowledgePort(options((async(_url,init)=>{
  const body=JSON.parse(init?.body as string);
  return Response.json({ok:true,namespace,result:{operationId:body.input.operationId,...nativeReceipt}});
 }) as typeof fetch));
 const ref={id:'message:synthetic',revision:1,version:1,hash:'a'.repeat(64)};
 expect(await port.withdraw('native-withdraw',ref)).toEqual({operationId:'native-withdraw',...nativeReceipt});
 expect(await port.status('native-withdraw')).toEqual({operationId:'native-withdraw',...nativeReceipt});
});
it('keeps native receipt extensions typed and rejects unknown fields',async()=>{
 let extension:Record<string,unknown>={origin:'provider_granted'};
 const port=new HttpKnowledgePort(options((async(_url,init)=>{
  const body=JSON.parse(init?.body as string);
  return Response.json({ok:true,namespace,result:{operationId:body.input.operationId,state:'ready',...extension}});
 }) as typeof fetch));
 for(const invalid of [{origin:'provider_granted'},{sourceKey:123},{nativeAdmin:true}]){
  extension=invalid;
  await expect(port.status('known')).rejects.toThrow('knowledge_transport_unavailable');
 }
});
it('rejects namespace confusion and receipt substitution',async()=>{
 let mode='namespace';const port=new HttpKnowledgePort(options((async(_url,init)=>{
  const body=JSON.parse(init?.body as string);
  return Response.json({ok:true,namespace:mode==='namespace'?{...namespace,generation:'foreign'}:namespace,
   result:{operationId:mode==='receipt'?'foreign-receipt':body.input.operationId,state:'ready'}});
 }) as typeof fetch));
 await expect(port.status('known')).rejects.toThrow('knowledge_transport_unavailable');mode='receipt';
 await expect(port.status('known')).rejects.toThrow('knowledge_receipt_mismatch');
});
it('preserves explicit partial candidate coverage and refuses untyped claims',async()=>{
 let invalid=false;const port=new HttpKnowledgePort(options((async()=>Response.json({ok:true,namespace,result:{claims:invalid?[{id:'invented'}]:[],
  coverage:{scope:'native_candidate_page',state:'partial',candidates:3,returned:0},nextCursor:'cursor'}})) as typeof fetch));
 expect(await port.query({limit:20})).toMatchObject({coverage:{state:'partial'},nextCursor:'cursor'});invalid=true;
 await expect(port.query({limit:20})).rejects.toThrow('knowledge_transport_unavailable');
});
it('accepts only a configured HTTPS endpoint and bounds payload before transport',async()=>{
 const transport=(async()=>{throw Error('must not call');}) as typeof fetch;
 for(const endpoint of ['http://local/knowledge','https://user:secret@example.test/knowledge','https://example.test/knowledge?token=secret','https://example.test/admin']){
  expect(()=>new HttpKnowledgePort({...options(transport),endpoint})).toThrow('knowledge_endpoint_configuration');
 }
 const port=new HttpKnowledgePort(options(transport));
 await expect(port.remember('large',{...input,entities:[{id:'a',kind:'person',name:'x'.repeat(262144)}]})).rejects.toThrow('knowledge_request_size');
});
