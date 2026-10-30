import {env} from 'cloudflare:test';
import {beforeEach,expect,it,vi,afterEach} from 'vitest';
import {CaptureMaterializer} from '../assistant/materialize';
import {OriginGuard,type OriginScope,type SnapshotReader} from '../assistant/origin-guard';
import {receiveCapture} from '../assistant/ingress';
import assistantWorker from '../assistant/index';
import {bridgeHash} from '../assistant/ingress';

let scope:OriginScope;
const secret='synthetic-historical-archive-secret-more-than32';
const ref={sourceKind:'message' as const,sourceId:'historical-message',chatId:'historical-chat'};
let reader:SnapshotReader,kind:'private'|'group',watermark:number,text:string;
const keys=()=>[scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration];
const sql=(q:string,...p:(string|number|null)[])=>env.DB.prepare(q).bind(...p);
const importer=(db=env.DB)=>new CaptureMaterializer(db,()=>scope,reader,secret);
const snapshot=(q:{sourceKind:string;sourceId:string;chatId:string})=>({observation:'capture_snapshot',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,...q,
 sourceVersion:watermark?2:1,watermark,conversationKind:kind,access:{captureEnabled:true,captureSince:0,discontinuous:false},
 content:q.sourceKind==='conversation'?{kind:kind==='private'?'individual':'group',name:'Synthetic historical conversation'}:{kind:'text',text,authorId:'person',authorName:'Synthetic person',fromMe:false,occurredAt:10,receivedAt:11,messageId:ref.sourceId,messageVersion:watermark?2:1}});
beforeEach(()=>{scope={installationId:crypto.randomUUID(),generation:'own-g',sourceEpoch:'source-e',sourceGeneration:'source-g'};kind='private';watermark=0;text='Historical eucalyptus agreement';
 reader={readSnapshot:vi.fn(async q=>snapshot(q))};});
afterEach(()=>vi.restoreAllMocks());
async function rows(table:string){return (await sql(`SELECT * FROM ${table} WHERE installation_id=? AND generation=?`,scope.installationId,scope.generation).all()).results;}
async function source(){return sql('SELECT id,status,revision,current_version FROM assistant_sources WHERE installation_id=? AND generation=?',scope.installationId,scope.generation).first<{id:string;status:string;revision:number;current_version:number|null}>();}
async function policy(excluded=0,mode='ignore'){
 await sql(`INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,excluded,group_mode) VALUES(?,?,?,?,?,?)`,scope.installationId,scope.generation,ref.chatId,kind,excluded,mode).run();
}
it('makes a pre-bridge original searchable with watermark zero and no retroactive inference or capture activity',async()=>{
 expect(await importer().importArchived(ref)).toMatchObject({state:'applied'});
 const saved=(await source())!;expect(saved).toMatchObject({status:'active',revision:1,current_version:1});
 expect((await sql(`SELECT original_text FROM assistant_archive_text WHERE assistant_archive_text MATCH 'eucalyptus' AND installation_id=? AND generation=?`,scope.installationId,scope.generation).all()).results).toEqual([{original_text:'Historical eucalyptus agreement'}]);
 expect((await rows('assistant_source_origins'))[0]).toMatchObject({watermark:0,source_id:ref.sourceId});
 for(const table of ['assistant_source_changes','assistant_capture_inbox','assistant_capture_streams','assistant_native_conversations','assistant_jobs','assistant_native_model_receipts'])expect(await rows(table)).toEqual([]);
 const guard=new OriginGuard(env.DB,()=>scope,reader,secret);expect(await guard.checkContext((await guard.fence(saved.id))!)).toEqual({state:'current'});
});
it('reuses canonical identities on replay and allows a later live correction to generate its normal change',async()=>{
 await importer().importArchived(ref);const before=await source();await importer().importArchived(ref);expect(await source()).toEqual(before);
 watermark=5;text='Corrected eucalyptus agreement';
 const response=await receiveCapture(new Request('https://internal.invalid/capture',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify({protocol:1,...scope,sequence:5,previousSequence:0,...ref,operation:'upsert',recordedAt:20})}),{DB:env.DB,BRIDGE_SECRET:secret,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation});
 expect(response.status).toBe(200);expect(await importer().process(5)).toMatchObject({state:'applied',canonicalId:before!.id});
 expect(await source()).toMatchObject({id:before!.id,revision:2,current_version:2});expect((await rows('assistant_source_changes')).map(r=>r.kind)).toEqual(['corrected']);
});
it('does not read message bodies in ignored groups or excluded conversations',async()=>{
 kind='group';expect(await importer().importArchived(ref)).toMatchObject({state:'excluded'});
 expect(vi.mocked(reader.readSnapshot).mock.calls.every(([q])=>q.sourceKind==='conversation')).toBe(true);expect(await source()).toBeNull();
 await policy(0,'observe');expect(await importer().importArchived(ref)).toMatchObject({state:'applied'});
 await sql('UPDATE assistant_conversation_policies SET excluded=1,revision=2 WHERE installation_id=?',scope.installationId).run();vi.mocked(reader.readSnapshot).mockClear();
 expect(await importer().importArchived(ref)).toMatchObject({state:'excluded'});expect(vi.mocked(reader.readSnapshot).mock.calls.every(([q])=>q.sourceKind==='conversation')).toBe(true);
});
it('rechecks policy in the commit batch if exclusion changes after the remote observation',async()=>{
 await policy();let flipped=false;
 const db={prepare:env.DB.prepare.bind(env.DB),async batch(statements:D1PreparedStatement[]){if(!flipped){flipped=true;await sql('UPDATE assistant_conversation_policies SET excluded=1,revision=2 WHERE installation_id=?',scope.installationId).run();}return env.DB.batch(statements);}} as D1Database;
 expect(await importer(db).importArchived(ref)).toMatchObject({state:'stale'});expect(await source()).toBeNull();
});
it('never revives a withdrawn canonical source on replay',async()=>{
 await importer().importArchived(ref);const saved=(await source())!;
 await sql("UPDATE assistant_sources SET status='withdrawn',revision=revision+1,current_version=NULL WHERE installation_id=? AND id=?",scope.installationId,saved.id).run();
 expect(await importer().importArchived(ref)).toMatchObject({state:'withdrawn'});expect(await source()).toMatchObject({status:'withdrawn',revision:2,current_version:null});
});
it('rejects metadata shape abuse before asking the source reader',async()=>{
 await expect(importer().importArchived({...ref,sourceKind:'conversation'} as any)).rejects.toThrow('archive_import_input');
 await expect(importer().importArchived({...ref,sql:'SELECT secret'} as any)).rejects.toThrow('archive_import_input');expect(reader.readSnapshot).not.toHaveBeenCalled();
});
it('refuses history while the namespace is held and when a retention barrier names the origin',async()=>{
 await sql("INSERT INTO assistant_retention_runtime_hold VALUES(?,'operation',?,1,1)",scope.installationId,scope.generation).run();
 expect(await importer().importArchived(ref)).toMatchObject({state:'excluded'});expect(reader.readSnapshot).not.toHaveBeenCalled();
 await sql('DELETE FROM assistant_retention_runtime_hold WHERE installation_id=?',scope.installationId).run();
 const canonicalId='wa_'+await bridgeHash([...keys(),ref.sourceKind,ref.sourceId]);
 const originKey=JSON.stringify([scope.sourceEpoch,scope.sourceGeneration,ref.sourceKind,ref.sourceId]);
 await sql(`INSERT INTO assistant_retention_barriers VALUES(?,?,?,?,?,0,0,'retirement',?,'token','retired','not_configured',1)`,scope.installationId,scope.generation,canonicalId,'whatsapp',originKey,'a'.repeat(64)).run();
 expect(await importer().importArchived(ref)).toMatchObject({state:'excluded'});expect(await source()).toBeNull();
});
it('keeps the migration endpoint private, strict and independent from model/send capabilities',async()=>{
 const own={DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,BRIDGE_SECRET:secret,CAPTURE_READER:reader,NATIVE_CONTEXT_ADMIN_SECRET:secret};
 const request=(body:unknown,authorized=true)=>new Request('https://own.invalid/internal/archive-import',{method:'POST',headers:authorized?{Authorization:'Bearer '+secret}:{},body:JSON.stringify(body)});
 expect((await assistantWorker.fetch(request(ref,false),own,{} as ExecutionContext)).status).toBe(403);expect(reader.readSnapshot).not.toHaveBeenCalled();
 expect((await assistantWorker.fetch(request({...ref,installationId:'other'}),own,{} as ExecutionContext)).status).toBe(400);
 const response=await assistantWorker.fetch(request(ref),own,{} as ExecutionContext);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({state:'applied'});
 for(const table of ['assistant_native_conversations','assistant_jobs','assistant_native_reply_actions'])expect(await rows(table)).toEqual([]);
});
it('keeps a concurrent live version instead of committing the historical observation over it',async()=>{
 let raced=false;
 const db={prepare:env.DB.prepare.bind(env.DB),async batch(statements:D1PreparedStatement[]){
  if(!raced){raced=true;watermark=5;text='Current live eucalyptus agreement';
   await receiveCapture(new Request('https://internal.invalid/capture',{method:'POST',headers:{Authorization:'Bearer '+secret},body:JSON.stringify({protocol:1,...scope,sequence:5,previousSequence:0,...ref,operation:'upsert',recordedAt:20})}),{DB:env.DB,BRIDGE_SECRET:secret,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation});
   expect(await importer().process(5)).toMatchObject({state:'applied'});
  }
  return env.DB.batch(statements);
 }} as D1Database;
 expect(await importer(db).importArchived(ref)).toEqual({state:'stale'});
 expect((await rows('assistant_source_versions')).map(r=>r.original_text)).toEqual(['Current live eucalyptus agreement']);
 expect((await rows('assistant_source_changes')).map(r=>r.kind)).toEqual(['created']);
});
it('preserves a lost commit acknowledgement and converges on the same source without duplicate versions',async()=>{
 const db={prepare:env.DB.prepare.bind(env.DB),async batch(statements:D1PreparedStatement[]){await env.DB.batch(statements);throw Error('synthetic lost acknowledgement');}} as unknown as D1Database;
 await expect(importer(db).importArchived(ref)).rejects.toThrow('materialization_commit_uncertain');
 const persisted=await source();expect(persisted).toMatchObject({revision:1,current_version:1});
 expect(await importer().importArchived(ref)).toMatchObject({state:'applied',canonicalId:persisted!.id});expect(await source()).toEqual(persisted);
 expect(await rows('assistant_source_versions')).toHaveLength(1);expect(await rows('assistant_source_changes')).toEqual([]);
});
it('does not cross a hold that appears after reading the source',async()=>{
 const db={prepare:env.DB.prepare.bind(env.DB),async batch(statements:D1PreparedStatement[]){await sql("INSERT INTO assistant_retention_runtime_hold VALUES(?,'race',?,1,1)",scope.installationId,scope.generation).run();return env.DB.batch(statements);}} as D1Database;
 expect(await importer(db).importArchived(ref)).toEqual({state:'stale'});expect(await source()).toBeNull();
});
it('leaves observations newer than the operator snapshot to live capture instead of suppressing their initial curation change',async()=>{
 watermark=7;
 expect(await importer().importArchived({...ref,throughSequence:6})).toEqual({state:'unavailable',reason:'historical_snapshot_changed'});
 expect(vi.mocked(reader.readSnapshot).mock.calls.every(([q])=>q.sourceKind==='conversation')).toBe(true);expect(await source()).toBeNull();
 reader={readSnapshot:vi.fn(async q=>{const observed=snapshot(q);return {...observed,watermark:q.sourceKind==='conversation'?6:7};})};
 expect(await importer().importArchived({...ref,throughSequence:6})).toEqual({state:'unavailable',reason:'historical_snapshot_changed'});expect(await source()).toBeNull();
});
