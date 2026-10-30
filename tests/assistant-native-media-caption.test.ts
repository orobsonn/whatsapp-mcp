import {env} from 'cloudflare:test';
import {expect,it,vi,afterEach} from 'vitest';
import {CaptureMaterializer} from '../assistant/materialize';
import {OriginGuard} from '../assistant/origin-guard';
import {SourceAccess} from '../assistant/access';
import {InferenceBudget} from '../assistant/budget';
import {nativeMediaCapability} from '../assistant/agent-runtime/native-media';
afterEach(()=>vi.restoreAllMocks());
it.each([true,false])('reads caption and file through the same paid image receipt, and revokes the alias when the file is withdrawn (caption=%s)',async hasCaption=>{
 const scope={installationId:crypto.randomUUID(),generation:'g',sourceEpoch:'e',sourceGeneration:'cg'},bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
 const blobHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
 const attachment={id:'file',version:1,hash:blobHash,size:bytes.length,mime:'image/png'},base={observation:'capture_snapshot',state:'available',sourceEpoch:'e',sourceGeneration:'cg',chatId:'chat',sourceVersion:1,watermark:2,conversationKind:'private',access:{captureEnabled:true,captureSince:0,discontinuous:false}};
 const snapshots:any={message:{...base,sourceKind:'message',sourceId:'message',content:{kind:'image',messageId:'message',messageVersion:1,...(hasCaption?{text:'What does this warning mean?'}:{}),media:attachment}},media:{...base,sourceKind:'media',sourceId:'file',content:{kind:'image',messageId:'message',messageVersion:1,media:attachment}}};
 const reader={readSnapshot:async(q:any)=>snapshots[q.sourceKind]};
 await env.DB.prepare('INSERT INTO assistant_capture_streams VALUES(?,?,?,?,2,0)').bind(...Object.values(scope)).run();
 for(const [sequence,kind,id] of [[1,'message','message'],[2,'media','file']] as const)await env.DB.prepare(`INSERT INTO assistant_capture_inbox(installation_id,generation,source_epoch,source_generation,sequence,previous_sequence,chat_id,source_kind,source_id,operation,recorded_at,metadata_hash,received_at) VALUES(?,?,?,?,?,?,'chat',?,?,'upsert',100,?,100)`)
  .bind(...Object.values(scope),sequence,sequence-1,kind,id,'a'.repeat(64)).run();
 const materializer=new CaptureMaterializer(env.DB,()=>scope,reader,'secret');const caption=await materializer.process(1),file=await materializer.process(2);
 const access=new SourceAccess(env.DB,scope,Date.now,'knowledge'),ref=async(id:string)=>{const r=(await access.read({kind:'owner'},id))!;return {id,revision:r.fence.source.revision,version:r.fence.source.version,hash:r.fence.source.hash};};
 const captionRef=await ref(caption.canonicalId!),fileRef=await ref(file.canonicalId!);
 await new InferenceBudget(env.DB,{...scope,period:new Date().toISOString().slice(0,10)}).configure(600000);
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({observations:'There is an update warning.',pages:[{page:1,state:'readable',text:'Update failed.'}]})}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}));
 const expose=vi.fn(),capability=nativeMediaCapability({env:{DB:env.DB,MEDIA_CONTEXT_ENABLED:'true',NATIVE_MODEL_PROVIDER:'deepseek',DEEPSEEK_API_KEY:'synthetic-key',BRIDGE_SECRET:'secret',CAPTURE_MEDIA_READER:{readBoundedMedia:async()=>({observation:'capture_media',state:'available',sourceEpoch:'e',sourceGeneration:'cg',chatId:'chat',mediaId:'file',messageVersion:1,mediaVersion:1,blobHash,mime:'image/png',size:bytes.length,watermark:2,bytes})}},
  task:{identity:{},knowledge:{scope}} as any,runtime:{assertTaskCurrent:async()=>{}} as any,retention:{expose} as any,origin:new OriginGuard(env.DB,()=>scope,reader,'secret'),getScope:()=>scope,authorityGuard:()=>({sql:'1',values:[]}),modelGuard:()=>({sql:'1',values:[]})});
 expect(await capability.read(captionRef)).toMatchObject({state:'available',parentSourceRef:fileRef,requestSourceRef:captionRef,caption:hasCaption?{state:'available',sourceRef:captionRef,text:'What does this warning mean?'}:{state:'absent'}});
 expect(await capability.read(fileRef)).toMatchObject({state:'available',parentSourceRef:fileRef,caption:hasCaption?{state:'available',sourceRef:captionRef,text:'What does this warning mean?'}:{state:'absent'}});
 expect(fetch).toHaveBeenCalledTimes(1);expect(expose.mock.calls.every(([_,value])=>value.sources.length===2&&value.origins.length===2)).toBe(true);
 snapshots.media={...snapshots.media,state:'withdrawn'};
 await expect(capability.read(captionRef)).rejects.toThrow('native_media_source_changed');expect(fetch).toHaveBeenCalledTimes(1);
});
