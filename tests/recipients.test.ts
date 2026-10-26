import {env} from 'cloudflare:test';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {Env} from '../src/env';
import {resolveRecipient} from '../src/recipients';
import {upsertDirectoryPage,setCapture} from '../src/directory';
import {prepareAction} from '../src/actions';
import {uploadMedia} from '../src/media';
import {resolveRuntimeEnv} from '../src/connection';
import {mcpFetch} from '../src/mcp';
let e:Env;
const address='12025550123',input={phone:'+'+address,alias:'Explicit synthetic recipient'},ownerPhone='12025550100';
const provider=()=>({status:vi.fn(async()=>({connected:true,phone:ownerPhone}))});
const query=(sql:string,...values:unknown[])=>env.DB.prepare(sql).bind(...values);
beforeEach(async()=>{
 await env.DB.exec('DELETE FROM actions;DELETE FROM media_jobs;DELETE FROM media_derivatives;DELETE FROM media;DELETE FROM message_versions;DELETE FROM messages;DELETE FROM participants;DELETE FROM directory_syncs;DELETE FROM chats;DELETE FROM policies;DELETE FROM connection_state;');
 e={...env,OWNER_SUB:'recipient-owner',INSTALLATION_EPOCH:'recipient-epoch',CONNECTION_GENERATION:'recipient-generation',CONNECTED_PHONE:ownerPhone,MAINTENANCE:'false',PUBLIC_ORIGIN:'https://recipient.invalid',RUNTIME_CONFIG:'static',DEVELOPMENT:'true',ZAPI_INSTANCE_ID:'synthetic-instance',ZAPI_TOKEN:'synthetic-token',ZAPI_INSTANCE_TOKEN:'synthetic-token',ZAPI_CLIENT_TOKEN:'synthetic-client'};
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function snapshot(id:string){return {chat:await query('SELECT * FROM chats WHERE id=?',id).first(),capture:await query('SELECT * FROM capture_settings WHERE chat_id=?',id).first(),gaps:(await query('SELECT * FROM capture_gaps WHERE chat_id=? ORDER BY revision',id).all()).results,messages:(await query('SELECT * FROM messages WHERE chat_id=?',id).all()).results};}
it('creates one individual reference for an explicit international number with no history or device contact save',async()=>{
 const p=provider(),r=await resolveRecipient(e,input,p);expect(r).toMatchObject({chatId:expect.any(String),kind:'individual',name:input.alias,created:true,validated_format:true,registeredOnWhatsApp:'unknown',messageAttempted:false,contactSavedOnDevice:false,historicalImport:false,capturePolicy:'current_default_inherited'});expect(r.captureEnabled).toBe(true);expect(r.captureMode).toBe('default');expect(r.captureSince).toBeTypeOf('number');expect(p.status).toHaveBeenCalledTimes(2);
 expect(await query('SELECT external_id FROM chats WHERE id=?',r.chatId).first('external_id')).toBe(address);expect(await query('SELECT COUNT(*) n FROM messages').first('n')).toBe(0);expect(await query('SELECT COUNT(*) n FROM actions').first('n')).toBe(0);expect(JSON.stringify(r)).not.toContain(address);
});
it('reuses a directory contact with no messages and preserves its proven name and complete capture state',async()=>{
 const chat=(await upsertDirectoryPage(e,{epoch:e.INSTALLATION_EPOCH,generation:e.CONNECTION_GENERATION},{items:[{externalId:address,kind:'individual',name:'Directory name'}],complete:true})).items[0]!;await setCapture(e,chat.id,false,{epoch:e.INSTALLATION_EPOCH,generation:e.CONNECTION_GENERATION});const before=await snapshot(chat.id),r=await resolveRecipient(e,input,provider());expect(r).toMatchObject({chatId:chat.id,name:'Directory name',created:false,captureEnabled:false,captureMode:'disabled',capturePolicy:'existing_preserved'});expect(await snapshot(chat.id)).toEqual(before);expect((await prepareAction(e,{chatId:r.chatId,kind:'text',text:'Synthetic unsent proposal'})).status).toBe('proposed');
});
it.each(['enabled','disabled','legacy_hold'] as const)('never rewrites existing %s capture, since, name or historical tombstones',async mode=>{
 const chat=(await upsertDirectoryPage(e,{epoch:e.INSTALLATION_EPOCH,generation:e.CONNECTION_GENERATION},{items:[{externalId:address,kind:'individual',name:'Known'}],complete:true})).items[0]!;await query('UPDATE capture_settings SET mode=?,revision=7 WHERE chat_id=?',mode,chat.id).run();await query('UPDATE chats SET capture_since=NULL WHERE id=?',chat.id).run();await query("INSERT INTO messages(id,chat_id,epoch,generation,external_id,from_me,kind,text,timestamp,received_at,deleted_at) VALUES('deleted',?,?,?,'m',0,'text',NULL,1,1,2)",chat.id,e.INSTALLATION_EPOCH,e.CONNECTION_GENERATION).run();const before=await snapshot(chat.id);expect((await resolveRecipient(e,input,provider())).chatId).toBe(chat.id);expect(await snapshot(chat.id)).toEqual(before);
});
it('inherits a disabled global default on new creation without changing the global policy',async()=>{
 await query('INSERT INTO policies VALUES(?,?,?,?)','capture_default_enabled:'+e.CONNECTION_GENERATION,'false',e.INSTALLATION_EPOCH,100).run();const before=await query('SELECT * FROM policies').all();const r=await resolveRecipient(e,input,provider());expect(r).toMatchObject({captureEnabled:false,captureMode:'default',captureSince:null});expect(await query('SELECT * FROM policies').all()).toEqual(before);
});
it('concurrency and retry after lost ACK return the same address reference without overwriting its initial alias',async()=>{
 const [a,b]=await Promise.all([resolveRecipient(e,input,provider()),resolveRecipient(e,{...input,alias:'Other alias'},provider())]);expect(a.chatId).toBe(b.chatId);expect(await query('SELECT COUNT(*) n FROM chats').first('n')).toBe(1);const before=await snapshot(a.chatId);expect((await resolveRecipient({...e},input,provider())).chatId).toBe(a.chatId);expect(await snapshot(a.chatId)).toEqual(before);
});
it('recovers a committed reference after a genuinely lost transaction ACK without recreating capture or changing the alias',async()=>{
 const batch=env.DB.batch.bind(env.DB);let lost=false;const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{const result=await batch(statements);if(!lost){lost=true;throw Error('synthetic lost ACK');}return result;}} as D1Database;await expect(resolveRecipient({...e,DB:db},input,provider())).rejects.toThrow('synthetic lost ACK');const id=await query('SELECT id FROM chats WHERE external_id=?',address).first<string>('id');expect(id).toBeTruthy();const before=await snapshot(id!);expect(await resolveRecipient(e,{...input,alias:'Retry must not rename'},provider())).toMatchObject({chatId:id,created:false,name:input.alias});expect(await snapshot(id!)).toEqual(before);expect(await query('SELECT COUNT(*) n FROM chats').first('n')).toBe(1);
});
it('refuses a partially migrated existing record without silently repairing capture policy',async()=>{
 const chat=(await upsertDirectoryPage(e,{epoch:e.INSTALLATION_EPOCH,generation:e.CONNECTION_GENERATION},{items:[{externalId:address,kind:'individual',name:'Known'}],complete:true})).items[0]!;await query('DELETE FROM capture_settings WHERE chat_id=?',chat.id).run();const before=await snapshot(chat.id);await expect(resolveRecipient(e,input,provider())).rejects.toThrow('recipient_unavailable');expect(await snapshot(chat.id)).toEqual(before);
});
it.each(['12025550123','+02025550123','+1202555','+1234567890123456','+1 2025550123','12025550123@lid','+12025550123@g.us','+12025550123@c.us','Alice','+12025550123/../send-text'])('rejects nonexplicit or unsupported address %s before a provider call',async phone=>{
 const p=provider();await expect(resolveRecipient(e,{phone},p)).rejects.toThrow();expect(p.status).not.toHaveBeenCalled();expect(await query('SELECT COUNT(*) n FROM chats').first('n')).toBe(0);
});
it('rejects unknown administrative fields and invalid aliases before any provider operation',async()=>{
 const p=provider();for(const change of [{kind:'group'},{generation:'other'},{captureEnabled:true},{url:'https://other.invalid'},{alias:'\nunsafe'},{alias:''}])await expect(resolveRecipient(e,{...input,...change},p)).rejects.toThrow();expect(p.status).not.toHaveBeenCalled();
});
it('does not convert a colliding group or reuse another generation',async()=>{
 await upsertDirectoryPage(e,{epoch:e.INSTALLATION_EPOCH,generation:e.CONNECTION_GENERATION},{items:[{externalId:address,kind:'group',name:'Group collision'}],complete:true});await expect(resolveRecipient(e,input,provider())).rejects.toThrow();expect(await query('SELECT kind FROM chats WHERE external_id=?',address).first('kind')).toBe('group');
 await query('DELETE FROM chats').run();await query("INSERT INTO chats(id,epoch,generation,external_id,kind,name,created_at,updated_at) VALUES('old',?,'old',?,'individual','Old',1,1)",e.INSTALLATION_EPOCH,address).run();expect((await resolveRecipient(e,input,provider())).chatId).not.toBe('old');
});
it.each(['phone','generation','maintenance'] as const)('refuses %s change during provider await before creating a reference',async change=>{
 let calls=0;const p={status:vi.fn(async()=>{if(++calls===2){if(change==='generation')e.CONNECTION_GENERATION='other';if(change==='maintenance')e.MAINTENANCE='true';}return {connected:true,phone:change==='phone'&&calls===2?'12025550999':ownerPhone};})};await expect(resolveRecipient(e,input,p)).rejects.toThrow();expect(await query('SELECT COUNT(*) n FROM chats').first('n')).toBe(0);
});
it.each(['image','pdf','audio'] as const)('a new recipient can prepare existing %s media flow without execution or fabricated messages',async kind=>{
 const r=await resolveRecipient(e,input,provider()),bytes=kind==='pdf'?new TextEncoder().encode('%PDF-1.4\nSynthetic\n%%EOF'):kind==='image'?new Uint8Array([255,216,255,0,0,0,0,0,0,0,255,217]):new Uint8Array([255,251,144,0,1,2,3,4]),mime=kind==='pdf'?'application/pdf':kind==='image'?'image/jpeg':'audio/mpeg',filename=kind==='pdf'?'synthetic.pdf':kind==='image'?'synthetic.jpg':'synthetic.mp3';const media=await uploadMedia(e,r.chatId,{bytes,mime,filename,durationSeconds:1});expect((await prepareAction(e,{chatId:r.chatId,kind,mediaId:media.id,mediaHash:media.sha256})).status).toBe('proposed');expect(await query('SELECT COUNT(*) n FROM messages').first('n')).toBe(0);
});
async function production(){
 e.RUNTIME_CONFIG='database';e.DEVELOPMENT='false';e.ENCRYPTION_KEY=btoa('k'.repeat(32));const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('k'.repeat(32)),{name:'AES-GCM'},false,['encrypt']),iv=crypto.getRandomValues(new Uint8Array(12)),payload={instanceId:e.ZAPI_INSTANCE_ID,instanceToken:e.ZAPI_TOKEN,clientToken:e.ZAPI_CLIENT_TOKEN,phone:ownerPhone,generation:'a'.repeat(32),webhookSecret:'b'.repeat(64)},cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode(JSON.stringify(['whatsapp-mcp/connection/v1',e.PUBLIC_ORIGIN,e.INSTALLATION_EPOCH]))},key,new TextEncoder().encode(JSON.stringify(payload)));await query("INSERT INTO connection_state VALUES(1,?,?,'active','synthetic-attempt',0,0,'complete',NULL,1,1,1)",e.INSTALLATION_EPOCH,'v1.'+btoa(String.fromCharCode(...iv))+'.'+btoa(String.fromCharCode(...new Uint8Array(cipher)))).run();e=await resolveRuntimeEnv(e);
}
it('the production connection pin rejects a database change inside the mutation, even if the request Env stayed old',async()=>{
 await production();const batch=env.DB.batch.bind(env.DB);let injected=false;const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{if(!injected){injected=true;await query('UPDATE connection_state SET version=version+1 WHERE id=1').run();}return batch(statements);}} as D1Database;await expect(resolveRecipient({...e,DB:db},input,provider())).rejects.toThrow();expect(injected).toBe(true);expect(await query('SELECT COUNT(*) n FROM chats').first('n')).toBe(0);
});
it('checks the production database pin again after the mutation await instead of returning a stale connection reference',async()=>{
 await production();const batch=env.DB.batch.bind(env.DB);let injected=false;const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{const result=await batch(statements);injected=true;await query('UPDATE connection_state SET version=version+1 WHERE id=1').run();return result;}} as D1Database;await expect(resolveRecipient({...e,DB:db},input,provider())).rejects.toThrow('connection_changed');expect(injected).toBe(true);expect(await query('SELECT COUNT(*) n FROM chats').first('n')).toBe(1);
});
it('does not trust a stale decrypted Env after connection ciphertext/phone changes in the database',async()=>{
 await production();await query("UPDATE connection_state SET cipher='corrupt',version=version+1 WHERE id=1").run();const p=provider();await expect(resolveRecipient(e,input,p)).rejects.toThrow();expect(p.status).not.toHaveBeenCalled();expect(await query('SELECT COUNT(*) n FROM chats').first('n')).toBe(0);
});
const request=(method:string,params:unknown={},origin?:string)=>new Request(e.PUBLIC_ORIGIN+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25',...(origin?{Origin:origin}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
it('MCP authenticates the new creation tool, marks it writable, validates strict input and uses only status/device GETs',async()=>{
 const fetcher=vi.fn<typeof fetch>(async(input,init)=>{expect(init?.method??'GET').toBe('GET');const path=new URL(String(input)).pathname;expect(path.endsWith('/status')||path.endsWith('/device')).toBe(true);return Response.json(path.endsWith('/status')?{connected:true}:{phone:ownerPhone});});vi.stubGlobal('fetch',fetcher);const props={sub:e.OWNER_SUB,epoch:e.INSTALLATION_EPOCH};await expect(mcpFetch(request('tools/list'),e,{})).rejects.toThrow();expect((await mcpFetch(request('tools/list',{},'https://other.invalid'),e,props)).status).toBe(403);
 const list=await (await mcpFetch(request('tools/list'),e,props)).json() as any,tool=list.result.tools.find((t:any)=>t.name==='resolver_destinatario');expect(tool).toBeTruthy();expect(tool.annotations.readOnlyHint).toBe(false);expect(tool.annotations.idempotentHint).toBe(true);
 const call=async(args:unknown)=>(await (await mcpFetch(request('tools/call',{name:'resolver_destinatario',arguments:args}),e,props)).json()) as any;expect((await call({...input,send:true})).result.isError).toBe(true);expect(fetcher).not.toHaveBeenCalled();const reply=await call(input);expect(reply.result.isError).not.toBe(true);expect(JSON.parse(reply.result.content[0].text)).toMatchObject({chatId:expect.any(String),messageAttempted:false});expect(fetcher).toHaveBeenCalledTimes(4);expect(await query('SELECT COUNT(*) n FROM messages').first('n')).toBe(0);
});
