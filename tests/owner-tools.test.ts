import {beforeEach,describe,it,expect} from 'vitest';
import {env} from 'cloudflare:test';
import type {Env} from '../src/env';
import {ownerToolCatalog,ownerToolExecute} from '../src/owner-tools';
import {ownerToolProvenance} from '../src/owner-tool-provenance';
import {readCaptureSnapshot} from '../src/assistant-source-reader';
import {observeSnapshot} from '../src/capture-snapshot-contract';
import {OWNER_TOOL_NAMES} from '../src/owner-tool-contract';
import {prepareAction,executeAction} from '../src/actions';
import {upsertDirectoryPage} from '../src/directory';
const scope={installationId:'own',generation:'own-g1',sourceEpoch:'e1',sourceGeneration:'g1'},secret='s'.repeat(48);
let authorized=true,checks=0;
const e:Env={...env,OWNER_SUB:'owner',INSTALLATION_EPOCH:'e1',CONNECTION_GENERATION:'g1',CONNECTED_PHONE:'device',MAINTENANCE:'false',PUBLIC_ORIGIN:'http://localhost:8787',RUNTIME_CONFIG:'static',DEVELOPMENT:'true',ASSISTANT_INSTALLATION_ID:'own',ASSISTANT_GENERATION:'own-g1',ASSISTANT_KNOWLEDGE_ENABLED:'true',ASSISTANT_APPROVED_SEND_SECRET:secret,ASSISTANT_READER_SECRET:'reader-secret-for-owner-tool-tests-0001',
 ASSISTANT_OWNER:{ownerToolAuthorization:async()=>{checks++;return authorized?{authorized:true,expiresAt:Date.now()+5000}:{authorized:false};}} as unknown as Env['ASSISTANT_OWNER']};
const context={secret,scope,sessionId:'telegram-session',taskRef:'owner-request'};
beforeEach(async()=>{authorized=true;checks=0;await env.DB.prepare('DELETE FROM owner_tool_receipts').run();});
describe('owner Telegram Source tools',()=>{
 it('shares the MCP schema including direct media and group tools, and denies revoked/wrong affinity',async()=>{
  const catalog=await ownerToolCatalog(e,{...context,name:'preparar_envio'});expect(catalog.tools).toHaveLength(1);expect(catalog.tools[0].inputSchema).toBeDefined();
  const media=await ownerToolCatalog(e,{...context,name:'obter_midia'});expect(media.tools[0].readOnly).toBe(true);
  expect(OWNER_TOOL_NAMES).toContain('executar_acao_grupo');expect(checks).toBe(4);
  for(const name of OWNER_TOOL_NAMES){const found=await ownerToolCatalog(e,{...context,name});expect(found.tools[0]?.name).toBe(name);expect(new TextEncoder().encode(JSON.stringify(found)).length).toBeLessThan(262144);}
  authorized=false;await expect(ownerToolCatalog(e,context)).rejects.toThrow('owner_tool_denied');
  authorized=true;await expect(ownerToolCatalog(e,{...context,scope:{...scope,sourceEpoch:'old'}})).rejects.toThrow('owner_tool_denied');
 });
 it('reuses one prepared action under canonical argument order and does not reclaim an uncertain RPC',async()=>{
  const {items}=await upsertDirectoryPage(e,{epoch:'e1',generation:'g1'},{items:[{externalId:'5585999111122',kind:'individual',name:'Teste controlado'}],complete:true});
  const chatId=items[0].id,q={...context,tool:'preparar_envio',input:{kind:'text',chatId,text:'Mensagem sintética sem envio'}};
  const first=await ownerToolExecute(e,q) as {result:{content:{text:string}[]}};const id=JSON.parse(first.result.content[0].text).id;
  const replay=await ownerToolExecute(e,{...q,input:{text:q.input.text,chatId,kind:'text'}}) as typeof first;
  expect(JSON.parse(replay.result.content[0].text).id).toBe(id);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM owner_tool_receipts').first<number>('n')).toBe(1);
  const status=await ownerToolExecute(e,{...context,tool:'consultar_envio',input:{id}});
  expect(JSON.stringify(status)).not.toContain(q.input.text);
  expect(JSON.stringify(status)).not.toContain('envelope');
  const stored=await env.DB.prepare('SELECT result_json FROM owner_tool_receipts').first<string>('result_json');expect(stored).not.toContain(q.input.text);
  await env.DB.prepare("UPDATE owner_tool_receipts SET state='attempting',result_json=NULL").run();
  expect(await ownerToolExecute(e,q)).toMatchObject({result:{state:'uncertain'}});
 });
 it('rejects unknown tools and invalid schemas before reserving effects',async()=>{
  await expect(ownerToolExecute(e,{...context,tool:'fetch_any_url',input:{url:'https://example.com'}})).rejects.toThrow();
  await expect(ownerToolExecute(e,{...context,tool:'preparar_envio',input:{kind:'text'}})).rejects.toThrow();
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM owner_tool_receipts').first<number>('n')).toBe(0);
 });
 it('final owner-command guard grants no approval and cannot steal an approved-send review proposal',async()=>{
  const {items}=await upsertDirectoryPage(e,{epoch:'e1',generation:'g1'},{items:[{externalId:'5585999111133',kind:'individual',name:'Teste sem envio'}],complete:true});
  const action=await prepareAction(e,{kind:'text',chatId:items[0].id,text:'Só preparação'});
  let providerCalls=0;const provider={status:async()=>{providerCalls++;return {connected:true,phone:'device'};},send:async()=>{throw Error('must never send');}};
  const finalGuard={beforeClaim:async()=>{if(!authorized)throw Error('owner_tool_denied');return {sql:'1',values:[]};}};
  await expect(executeAction(e,action.id,provider,undefined,undefined,finalGuard)).rejects.toThrow('action_not_approved');
  const revokeProvider={...provider,status:async()=>{providerCalls++;authorized=false;return {connected:true,phone:'device'};}};
  await expect(executeAction(e,action.id,revokeProvider,{confirmed:true,hash:action.hash},undefined,finalGuard)).rejects.toThrow('owner_tool_denied');
  expect(await env.DB.prepare('SELECT attempted_at FROM actions WHERE id=?').bind(action.id).first('attempted_at')).toBeNull();
  authorized=true;providerCalls=0;
  await env.DB.prepare(`INSERT INTO approved_sends(installation_id,generation,source_epoch,source_generation,operation_id,action_id,hash,target_json,created_at) VALUES('own','own-g1','e1','g1','review',?,?, '{}',?)`).bind(action.id,action.hash,Date.now()).run();
  await expect(executeAction(e,action.id,provider,{confirmed:true,hash:action.hash},undefined,finalGuard)).rejects.toThrow('approved_send_actuator_required');
  expect(providerCalls).toBe(0);
 });

 it('binds returned messages and audio transcripts to exact current Source observations',async()=>{
  await env.DB.batch([
   env.DB.prepare(`INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at) VALUES('provenance-chat','e1','g1','provenance-address','individual','Teste',1,10,10)`),
   env.DB.prepare(`INSERT INTO messages(id,chat_id,epoch,generation,external_id,from_me,kind,text,timestamp,received_at) VALUES('provenance-message','provenance-chat','e1','g1','provenance-message',0,'audio','Legenda sintética',10,10)`),
   env.DB.prepare(`INSERT INTO media(id,chat_id,message_id,epoch,generation,kind,mime,size,sha256,object_key,state,created_at) VALUES('provenance-media','provenance-chat','provenance-message','e1','g1','audio','audio/ogg',100,?,'synthetic/private-object','ready',10)`).bind('a'.repeat(64)),
   env.DB.prepare(`INSERT INTO media_derivatives(id,media_id,media_version,epoch,generation,kind,text,state,created_at) VALUES('provenance-derivative','provenance-media',1,'e1','g1','transcript','Transcrição sintética','ready',10)`),
  ]);
  const response=await ownerToolExecute(e,{...context,tool:'consultar_mensagens',input:{chatId:'provenance-chat'}}) as {result:unknown;provenance:{origins:{sourceKind:string;sourceId:string;observationHash:string}[]}};
  expect(response.provenance.origins.map(r=>r.sourceKind)).toEqual(['message','derivative']);
  expect(response.provenance.origins.every(r=>/^[a-f0-9]{64}$/.test(r.observationHash))).toBe(true);
  // Independent reader/canonical boundary must agree, including transcripts
  // whose mediaVersion and media fields arrive in a different property order.
  for(const origin of response.provenance.origins){
   const identity={sourceEpoch:'e1',sourceGeneration:'g1',sourceKind:origin.sourceKind as 'message'|'derivative',sourceId:origin.sourceId,chatId:'provenance-chat'};
   const snapshot=await readCaptureSnapshot(e,{...identity,secret:e.ASSISTANT_READER_SECRET});
   const canonical=await observeSnapshot(snapshot,identity);
   expect(origin.observationHash).toBe(canonical.hash);
  }
  await env.DB.prepare("UPDATE messages SET text='Legenda alterada',version=2 WHERE id='provenance-message'").run();
  await expect(ownerToolProvenance(e,scope,'consultar_mensagens',response.result)).rejects.toThrow('owner_tool_provenance_unavailable');
 });

});
