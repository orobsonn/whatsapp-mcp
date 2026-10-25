import {beforeEach,expect,it,vi} from "vitest";
import {env} from "cloudflare:test";
import {ingestEvent} from "../src/capture";
import {upsertDirectoryPage,setCapture} from "../src/directory";
import {processMediaJobs,readMedia} from "../src/media";
import {cleanup,diagnostics} from "../src/operations";
import type {Env} from "../src/env";
const fence={epoch:"derived-e",generation:"derived-g"};
const e:Env={...env,OWNER_SUB:"owner",INSTALLATION_EPOCH:fence.epoch,CONNECTION_GENERATION:fence.generation,MAINTENANCE:"false"};
let chatId:string,mediaId:string;
beforeEach(async()=>{
 await env.DB.exec("DELETE FROM media_derivatives; DELETE FROM media_jobs; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM participants; DELETE FROM chats;");
 const page=await upsertDirectoryPage(e,fence,{items:[{externalId:"derived-chat",kind:"individual",name:"Synthetic"}],complete:true});
 chatId=page.items[0].id;await setCapture(e,chatId,true,fence);
 const r=await ingestEvent(e,fence,{chatExternalId:"derived-chat",externalId:"derived-msg",fromMe:false,kind:"audio",timestamp:1,media:{url:"https://example.test/audio",mime:"audio/ogg"}});
 mediaId=(await env.DB.prepare("SELECT id FROM media WHERE message_id=?").bind(r.messageId!).first<{id:string}>())!.id;
 await env.DB.exec("DELETE FROM assistant_capture_changes;");
});
async function derivative(){
 await env.DB.prepare("INSERT INTO media_derivatives(id,media_id,media_version,epoch,generation,kind,text,state,created_at) VALUES('derived-transcript',?,1,?,?,'transcription','synthetic transcript','ready',1)").bind(mediaId,fence.epoch,fence.generation).run();
}
const feed=async()=> (await env.DB.prepare("SELECT source_kind,source_id,operation FROM assistant_capture_changes ORDER BY sequence").all()).results;
it("captures late transcript and its withdrawal without copying transcript into outbox",async()=>{
 await derivative();await env.DB.prepare("UPDATE media_derivatives SET text=NULL,state='deleted' WHERE id='derived-transcript'").run();
 expect(await feed()).toEqual([{source_kind:"derivative",source_id:"derived-transcript",operation:"upsert"},{source_kind:"derivative",source_id:"derived-transcript",operation:"withdraw"}]);
 expect(JSON.stringify(await feed())).not.toContain("synthetic transcript");
});
it("records capture revocation independently from message timestamp",async()=>{
 await setCapture(e,chatId,false,fence);
 expect(await feed()).toContainEqual({source_kind:"conversation",source_id:chatId,operation:"access"});
});
it("records media readiness once and physical derivative removal",async()=>{
 await env.DB.prepare("UPDATE media SET state='ready',sha256=? WHERE id=?").bind("a".repeat(64),mediaId).run();
 await env.DB.prepare("UPDATE media SET state='ready' WHERE id=?").bind(mediaId).run();
 await derivative();await env.DB.prepare("DELETE FROM media_derivatives WHERE id='derived-transcript'").run();
 const rows=await feed();
 expect(rows.filter(x=>x.source_kind==='media')).toEqual([{source_kind:"media",source_id:mediaId,operation:"upsert"}]);
 expect(rows.at(-1)).toEqual({source_kind:"derivative",source_id:"derived-transcript",operation:"withdraw"});
});
it("rolls back derivative and notification together on failure",async()=>{
 await expect(env.DB.batch([
 env.DB.prepare("INSERT INTO media_derivatives(id,media_id,media_version,epoch,generation,kind,text,state,created_at) VALUES('rollback-transcript',?,1,?,?,'transcription','synthetic','ready',1)").bind(mediaId,fence.epoch,fence.generation),
 env.DB.prepare("INSERT INTO message_versions(message_id,version,kind,created_at) VALUES('missing',1,'text',1)")])).rejects.toThrow();
 expect(await feed()).toEqual([]);
 expect(await env.DB.prepare("SELECT id FROM media_derivatives WHERE id='rollback-transcript'").first()).toBeNull();
});

it("captures media inserted ready after an existing message",async()=>{
 const m=await env.DB.prepare("SELECT message_id FROM media WHERE id=?").bind(mediaId).first<{message_id:string}>();
 await env.DB.prepare("DELETE FROM media_jobs WHERE media_id=?").bind(mediaId).run();
 await env.DB.prepare("DELETE FROM media WHERE id=?").bind(mediaId).run();
 await env.DB.exec("DELETE FROM assistant_capture_changes;");
 await env.DB.prepare("INSERT INTO media(id,chat_id,message_id,epoch,generation,kind,state,created_at) VALUES('late-ready',?,?,?,?,'audio','ready',1)").bind(chatId,m!.message_id,fence.epoch,fence.generation).run();
 expect(await feed()).toEqual([{source_kind:"media",source_id:"late-ready",operation:"upsert"}]);
});
it("does not republish derivatives after deletion and replay",async()=>{
 await derivative();
 await ingestEvent(e,fence,{chatExternalId:"derived-chat",externalId:"derived-msg",fromMe:false,kind:"audio",timestamp:2,deleted:true});
 await env.DB.exec("DELETE FROM assistant_capture_changes;");
 await ingestEvent(e,fence,{chatExternalId:"derived-chat",externalId:"derived-msg",fromMe:false,kind:"audio",timestamp:1,media:{url:"https://example.test/audio",mime:"audio/ogg"}});
 expect((await feed()).every(x=>x.operation==='withdraw')).toBe(true);
 expect(await env.DB.prepare("SELECT state,text FROM media_derivatives WHERE id='derived-transcript'").first()).toEqual({state:"deleted",text:null});
});
it("exposes pending object cleanup and keeps withdrawal after R2 failure",async()=>{
 await env.DB.prepare("UPDATE media SET object_key='synthetic/purge',state='deleted',deleted_at=1 WHERE id=?").bind(mediaId).run();
 const fail=vi.spyOn(env.MEDIA,'delete').mockRejectedValueOnce(new Error('synthetic R2 unavailable'));
 try {await expect(cleanup(e)).rejects.toThrow('synthetic R2 unavailable');} finally {fail.mockRestore();}
 expect((await diagnostics(e)).counts.pendingObjectPurges).toBe(1);
 expect(await env.DB.prepare("SELECT state,object_key FROM media WHERE id=?").bind(mediaId).first()).toEqual({state:"deleted",object_key:"synthetic/purge"});
 expect((await feed()).at(-1)?.operation).toBe('withdraw');
 await cleanup(e);
 expect((await diagnostics(e)).counts.pendingObjectPurges).toBe(0);
 expect((await feed()).at(-1)?.operation).toBe('withdraw');
});

it.each([false,true])("preserves bytes after lost commit acknowledgement, reconciliation unavailable=%s",async(reconcileUnavailable)=>{
 const bytes=Uint8Array.from(atob('T2dnUwACAAAAAAAAAAADHYPEAAAAANg89KYBE09wdXNIZWFkAQE4AUAfAAAAAABPZ2dTAAAAAAAAAAAAAAMdg8QBAAAA1InspQE+T3B1c1RhZ3MNAAAATGF2ZjYyLjEyLjEwMQEAAAAdAAAAZW5jb2Rlcj1MYXZjNjIuMjguMTAxIGxpYm9wdXNPZ2dTAAQYAwAAAAAAAAMdg8QCAAAAe+E0QAEDmP/+'),x=>x.charCodeAt(0));
 await env.DB.prepare("UPDATE media SET source_url='https://media.example/audio' WHERE id=?").bind(mediaId).run();
 const prepare=env.DB.prepare.bind(env.DB);
 const read=vi.spyOn(env.DB,'prepare').mockImplementation(sql=>{
   if(reconcileUnavailable && sql.startsWith('SELECT id FROM media WHERE object_key=')) throw new Error('synthetic D1 unavailable');
   return prepare(sql);
 });
 const batch=env.DB.batch.bind(env.DB);
 const lost=vi.spyOn(env.DB,'batch').mockImplementationOnce(batch).mockImplementationOnce(async statements=>{
   await batch(statements);throw new Error('synthetic acknowledgement lost');
 });
 try {await processMediaJobs({...e,MEDIA_HOSTS:'media.example'},async()=>new Response(bytes,{headers:{'content-type':'audio/ogg'}}));} finally {lost.mockRestore();read.mockRestore();}
 expect((await readMedia(e,mediaId)).bytes).toEqual(bytes);
 expect(await env.DB.prepare("SELECT status FROM media_jobs WHERE media_id=?").bind(mediaId).first()).toEqual({status:'ready'});
});
