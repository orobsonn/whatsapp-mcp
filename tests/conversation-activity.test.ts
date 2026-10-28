import {env,createExecutionContext} from 'cloudflare:test';
import app from '../src/index';
import {beforeEach,expect,it} from 'vitest';
import type {Env} from '../src/env';
import {upsertDirectoryPage} from '../src/directory';
import {ingestEvent} from '../src/capture';
import {readConversationActivity,registerProviderRelationship} from '../src/conversation-activity';
const e:Env={...env,OWNER_SUB:'owner',INSTALLATION_EPOCH:'e1',CONNECTION_GENERATION:'g1',CONNECTED_PHONE:'device',ZAPI_INSTANCE_ID:'instance',MAINTENANCE:'false',RUNTIME_CONFIG:'static',DEVELOPMENT:'true',PUBLIC_ORIGIN:'http://localhost:8787',ASSISTANT_READER_SECRET:'r'.repeat(48)};
const fence={epoch:'e1',generation:'g1'};let phone:string,lid:string;
beforeEach(async()=>{
 await env.DB.exec('DELETE FROM conversation_relationships; DELETE FROM owner_message_originals; DELETE FROM approved_sends; DELETE FROM actions; DELETE FROM assistant_capture_changes; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM participants; DELETE FROM directory_syncs; DELETE FROM chats;');
 const {items}=await upsertDirectoryPage(e,fence,{items:[{externalId:'5585999999999',kind:'individual',name:'Pessoa'},{externalId:'777777777777777@lid',kind:'individual',name:'Pessoa'}],complete:true});phone=items[0]!.id;lid=items[1]!.id;
});
const read=(chatId=phone)=>readConversationActivity(e,{secret:e.ASSISTANT_READER_SECRET,sourceEpoch:'e1',sourceGeneration:'g1',chatId});
const link=()=>registerProviderRelationship(e,{sourceEpoch:'e1',sourceGeneration:'g1',instanceId:'instance',phoneChatId:phone,lidChatId:lid,phone:'5585999999999',lid:'777777777777777@lid',proofHash:'a'.repeat(64),observedAt:Date.now()});
const message=(fromMe:boolean,id:string,address='777777777777777@lid',revision=1)=>ingestEvent(e,fence,{chatExternalId:address,chatKind:'individual',externalId:id,kind:'text',text:'Conteúdo de teste',fromMe,timestamp:100,revision});
it('sees already-answered LID only after provider relationship, without moving history',async()=>{
 const incoming=await message(false,'incoming','5585999999999');const trigger=await env.DB.prepare('SELECT MIN(sequence) n FROM assistant_capture_changes WHERE source_id=?').bind(incoming.messageId).first<number>('n');
 await message(true,'reply');expect(await read()).toMatchObject({state:'available',lastOwnerOriginalSequence:0,members:[{chatId:phone}]});
 await link();const activity=await read();expect(activity.state).toBe('available');if(activity.state!=='available')throw Error('blocked');expect(activity.lastOwnerOriginalSequence).toBeGreaterThan(trigger!);expect(activity.members.map(m=>m.chatId).sort()).toEqual([phone,lid].sort());
 expect(await env.DB.prepare("SELECT COUNT(*) n FROM messages WHERE chat_id=?").bind(lid).first<number>('n')).toBe(1);
});
it('uses original upsert sequence, not edits, and preserves a deleted owner reply tombstone',async()=>{
 await message(true,'old');await link();const original=await read();if(original.state!=='available')throw Error('blocked');
 await message(true,'old','777777777777777@lid',2);const edited=await read();expect(edited).toMatchObject({lastOwnerOriginalSequence:original.lastOwnerOriginalSequence});
 await env.DB.prepare('DELETE FROM message_versions WHERE message_id IN(SELECT id FROM messages WHERE chat_id=?)').bind(lid).run();await env.DB.prepare('DELETE FROM messages WHERE chat_id=?').bind(lid).run();expect(await read()).toMatchObject({lastOwnerOriginalSequence:original.lastOwnerOriginalSequence});
});
it('exposes disabled capture and rejects provider conflict without linking by name',async()=>{
 await link();await env.DB.prepare('UPDATE chats SET capture_enabled=0 WHERE id=?').bind(lid).run();const a=await read();if(a.state!=='available')throw Error('blocked');expect(a.members.find(m=>m.chatId===lid)?.captureEnabled).toBe(false);
 await expect(registerProviderRelationship(e,{sourceEpoch:'e1',sourceGeneration:'g1',instanceId:'wrong',phoneChatId:phone,lidChatId:lid,phone:'5585999999999',lid:'777777777777777@lid',proofHash:'b'.repeat(64),observedAt:Date.now()})).rejects.toThrow();
});
it('blocks a contradictory authenticated pair instead of following a transitive/name link',async()=>{
 await link();const {items}=await upsertDirectoryPage(e,fence,{items:[{externalId:'888888888888888@lid',kind:'individual',name:'Pessoa'}],complete:true});
 await expect(registerProviderRelationship(e,{sourceEpoch:'e1',sourceGeneration:'g1',instanceId:'instance',phoneChatId:phone,lidChatId:items[0]!.id,phone:'5585999999999',lid:'888888888888888@lid',proofHash:'b'.repeat(64),observedAt:Date.now()})).rejects.toThrow('relationship_conflict');
 expect(await read()).toMatchObject({state:'blocked',reason:'relationship_ambiguous'});
});

const callback=(overrides:Record<string,unknown>={})=>({type:'ReceivedCallback',instanceId:'instance',connectedPhone:'device',phone:'5585999999999',chatLid:'777777777777777@lid',isGroup:false,fromMe:false,messageId:'callback-original',momment:Date.now(),text:{message:'Mensagem sintética'},...overrides});
async function deliver(body:unknown,secret='synthetic-webhook-secret-at-least-24'){
 const local={...e,WEBHOOK_SECRET:'synthetic-webhook-secret-at-least-24'};
 return app.fetch(new Request(`http://localhost:8787/webhook/g1/${secret}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),local,createExecutionContext());
}
it('a later authenticated contradictory chatLid vetoes the pair and pending send without relocating history',async()=>{
 const old=await message(true,'historical-owner');await link();const action=crypto.randomUUID();
 await env.DB.prepare("INSERT INTO actions(id,epoch,generation,chat_id,envelope_json,hash,status,expires_at,created_at) VALUES(?,'e1','g1',?,'{}',?,'proposed',?,?)").bind(action,phone,'a'.repeat(64),Date.now()+60000,Date.now()).run();
 await env.DB.prepare("INSERT INTO approved_sends(installation_id,generation,source_epoch,source_generation,operation_id,action_id,hash,target_json,created_at) VALUES('own','og','e1','g1','pending',?,?,'{}',?)").bind(action,'a'.repeat(64),Date.now()).run();
 expect((await deliver(callback({chatLid:'888888888888888@lid'}))).status).toBe(200);
 expect(await read()).toMatchObject({state:'blocked',reason:'relationship_ambiguous'});
 expect(await env.DB.prepare('SELECT state,revision FROM conversation_relationships').first()).toMatchObject({state:'blocked',revision:2});
 expect(await env.DB.prepare('SELECT status,attempted_at FROM actions WHERE id=?').bind(action).first()).toMatchObject({status:'cancelled',attempted_at:null});
 expect(await env.DB.prepare('SELECT chat_id FROM messages WHERE id=?').bind(old.messageId).first<string>('chat_id')).toBe(lid);
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM chats').first<number>('n')).toBe(2);
});
it('matching/null/group or unauthenticated identity fields do not block an existing pair',async()=>{
 await link();
 expect((await deliver(callback(),'wrong-webhook-secret-at-least-24')).status).toBe(404);
 expect((await deliver(callback({instanceId:'wrong',chatLid:'888888888888888@lid'}))).status).toBe(403);
 expect((await deliver(callback({connectedPhone:'wrong',chatLid:'888888888888888@lid'}))).status).toBe(403);
 for(const body of [callback(),callback({chatLid:null,senderLid:'888888888888888@lid'}),callback({isGroup:true,chatLid:'888888888888888@lid'}),callback({chatLid:'invalid'})])await deliver(body);
 expect(await env.DB.prepare('SELECT state,revision FROM conversation_relationships').first()).toMatchObject({state:'active',revision:1});
});
