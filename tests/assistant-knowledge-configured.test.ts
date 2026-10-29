import {env} from 'cloudflare:test';
import {afterEach,expect,it,vi} from 'vitest';
import {configuredKnowledge} from '../assistant/knowledge/configured';
import {OriginGuard,type SnapshotReader} from '../assistant/origin-guard';
import {SourceAccess} from '../assistant/access';
import {SourceController} from '../assistant/sources';
import type {AssistantEnv} from '../assistant/env';
import type {KnowledgeCommand,KnowledgeClaim} from '../assistant/knowledge/contracts';

afterEach(()=>vi.restoreAllMocks());
it('configured knowledge reads opted-in observe groups while keeping default/excluded groups private',async()=>{
 const scope={installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:'e1',sourceGeneration:'sg1'},owner={kind:'owner'} as const;
 const text='Nora leads Cedar.',chatId='synthetic-observe-group';
 const source=await new SourceController(env.DB,scope,owner).create({originKey:chatId,conversationId:chatId,text,occurredAt:1});
 const snapshot={observation:'capture_snapshot',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:'message',sourceId:'message',chatId,sourceVersion:1,watermark:1,conversationKind:'group',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text,messageId:'message',messageVersion:1}};
 const reader:SnapshotReader={readSnapshot:vi.fn(async()=>snapshot)};
 const observation=await new OriginGuard(env.DB,()=>scope,reader,'synthetic').observe(scope,{sourceKind:'message',sourceId:'message',chatId});
 await env.DB.batch([
  env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId,scope.generation,source.id),
  env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,'group','available')").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,chatId),
  env.DB.prepare("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,observation_hash,tombstoned) VALUES(?,?,?,?,'message','message',?,?,1,?,0)").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,chatId,source.id,observation.hash),
 ]);
 const archive=new SourceAccess(env.DB,scope),knowledge=new SourceAccess(env.DB,scope,Date.now,'knowledge');
 const sourceRef={...source,hash:(await archive.read(owner,source.id))!.fence.source.hash};
 const settings:AssistantEnv={DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,BRIDGE_SECRET:'synthetic',CAPTURE_READER:reader,KNOWLEDGE_SERVICE_URL:'https://synthetic.invalid/knowledge',KNOWLEDGE_SERVICE_TOKEN:'synthetic-knowledge-token'.repeat(3),KNOWLEDGE_SPACE_GENERATION:'knowledge-v1'};
 const remember=(operationId:string):KnowledgeCommand=>({kind:'remember',operationId,entities:[{key:'nora',kind:'person',name:'Nora'},{key:'cedar',kind:'project',name:'Cedar'}],relations:[{subjectId:'nora',predicate:'leads',objectId:'cedar',classification:'reported',evidence:[{sourceRef,quote:text}]}]});
 const claim:KnowledgeClaim={id:'claim',subject:{id:'nora',kind:'person',name:'Nora'},predicate:'leads',object:{id:'cedar',kind:'project',name:'Cedar'},classification:'reported',evidence:[{id:'evidence',sourceRef,quote:text,origins:['agent_derived']}],supportGroups:[{id:'group',evidence:[{id:'evidence',sourceRef,quote:text,origins:['agent_derived']}]}]};
 const transport=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
  const body=JSON.parse(init?.body as string);
  const result=body.method==='remember'?{operationId:body.input.operationId,state:'ready'}:{claims:[claim],coverage:{scope:'native_candidate_page',state:'complete',candidates:1,returned:1}};
  return Response.json({ok:true,namespace:body.namespace,result});
 });
 const service=configuredKnowledge(settings,scope,'owner_mcp');
 expect(await knowledge.read(owner,source.id)).toBeNull();
 await expect(service.execute(remember('default-denied'))).rejects.toThrow('knowledge_source_unavailable');
 expect(transport).not.toHaveBeenCalled();
 expect((await archive.read(owner,source.id))?.text).toBe(text);
 await env.DB.prepare("INSERT INTO assistant_conversation_policies VALUES(?,?,?,'group',0,'observe',1)").bind(scope.installationId,scope.generation,chatId).run();
 expect(await new OriginGuard(env.DB,()=>scope,reader,'synthetic').fence(source.id)).not.toBeNull();
 expect((await knowledge.read(owner,source.id))?.text).toBe(text);
 expect(await service.execute(remember('observe-allowed'))).toMatchObject({state:'ready'});
 expect(await service.execute({kind:'query'})).toMatchObject({claims:[{id:'claim'}]});
 expect(transport).toHaveBeenCalledTimes(2);
 await env.DB.prepare('UPDATE assistant_conversation_policies SET excluded=1,revision=2 WHERE installation_id=? AND generation=? AND conversation_id=?').bind(scope.installationId,scope.generation,chatId).run();
 expect(await knowledge.read(owner,source.id)).toBeNull();
 await expect(service.execute(remember('excluded-denied'))).rejects.toThrow('knowledge_source_unavailable');
 expect(transport).toHaveBeenCalledTimes(2);
 expect(await service.execute({kind:'query'})).toMatchObject({claims:[],coverage:{state:'partial'}});
 expect((await archive.read(owner,source.id))?.text).toBe(text);
});
