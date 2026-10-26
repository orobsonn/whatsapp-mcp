import {env} from 'cloudflare:test';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {AssistantScheduler} from '../assistant/scheduler';
import {Routines} from '../assistant/routines';
import {SourceController} from '../assistant/sources';
import {SourceAccess} from '../assistant/access';
import {OriginGuard} from '../assistant/origin-guard';
import {CogneeContainer,CanonicalEngineGuard} from '../assistant/container';
import {CogneeEngine,type EngineSearch} from '../assistant/engine';
import {InferenceBudget} from '../assistant/budget';
import {receiveCapture,bridgeHash} from '../assistant/ingress';
import {hostConfiguredSearch} from '../assistant/configured-search';
import {EpisodeController,type EpisodeDriver} from '../assistant/agent/controller';
import {boundEpisode} from '../assistant/agent/contracts';
import {DEFAULT_BROKER_CONFIG} from '../assistant/model-transport';
import type {CheckpointManifest,IndexProof,SourceStamp} from '../assistant/checkpoints';
import type {AssistantEnv} from '../assistant/env';
import type {OriginScope,ReaderQuery} from '../assistant/origin-guard';
import type {ModelAdapter} from '../assistant/model-broker';
import type {EngineIngest} from '../assistant/engine';
// @ts-expect-error Vite migration fixtures.
const migrations=import.meta.glob('../assistant/migrations/*.sql',{query:'?raw',import:'default',eager:true}) as Record<string,string>;
let scope:OriginScope,settings:AssistantEnv,now:number,modelCalls:number,dispatches:number;
let data:Map<string,unknown>,physical:Map<string,SourceStamp>,running:boolean,tail:Promise<unknown>;
let engine:CogneeContainer,port:ReturnType<typeof physicalPort>,model:ModelAdapter,driver:EpisodeDriver;
const keys=()=>[scope.installationId,scope.generation],sql=(query:string,...args:(string|number|null)[])=>env.DB.prepare(query).bind(...args);
const clone=<T>(value:T):T=>structuredClone(value);
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical((value as Record<string,unknown>)[k])])):value;
function memoryStorage(){
  const tx=(map:Map<string,unknown>)=>({get:async<T>(key:string)=>clone(map.get(key) as T|undefined),put:async(key:string,value:unknown)=>{map.set(key,clone(value));},list:async<T>({prefix,limit}:{prefix:string;limit:number})=>new Map([...map].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,clone(v as T)]))});
  return {...tx(data),transaction:<T>(action:(store:ReturnType<typeof tx>)=>Promise<T>)=>{const result=tail.then(async()=>{const copy=new Map(data);const result=await action(tx(copy));data.clear();for(const [k,v]of copy)data.set(k,v);return result;});tail=result.then(()=>{},()=>{});return result;}};
}
function physicalPort(){let saved:Map<string,SourceStamp>|undefined,last:CheckpointManifest|undefined;
  const proof=async(manifest:CheckpointManifest,closed=false):Promise<IndexProof>=>{
    expect(manifest.sources.length).toBeGreaterThan(0);expect(physical.size).toBe(manifest.sources.length);
    for(const source of manifest.sources)expect(physical.get(source.id)).toEqual(source);
    const {imageRef:_,...identity}=manifest.identity;
    return {...identity,indexEpoch:manifest.indexEpoch,indexRevision:manifest.indexRevision,manifestHash:await bridgeHash(canonical(manifest)),closed,poisoned:false,pendingOperations:0,sources:manifest.sources.map(x=>({id:x.id,version:x.version,hash:x.hash,originalHash:x.hash,chunks:1}))};
  };
  return {get running(){return running;},start:vi.fn(async(check?:()=>Promise<void>)=>{await check?.();running=true;await check?.();}),
    deny:vi.fn(async(check?:()=>Promise<void>)=>{await check?.();}),intercept:vi.fn(async()=>{}),destroy:vi.fn(async(check?:()=>Promise<void>)=>{await check?.();running=false;physical.clear();await check?.();}),
    snapshot:vi.fn(async()=>{saved=new Map(physical);return{id:'synthetic-first-nonempty-snapshot',size:4096};}),restore:vi.fn(async(_snapshot:unknown,check?:()=>Promise<void>)=>{await check?.();physical=new Map(saved);running=true;await check?.();}),
    quiesce:vi.fn(async(manifest:CheckpointManifest)=>{last=manifest;return proof(manifest,true);}),inspect:vi.fn(async()=>proof(last!)),verify:vi.fn(async(manifest:CheckpointManifest)=>proof(manifest)),
    request:vi.fn(async(path:string,body:unknown)=>{
      if(path==='/health')return{ready:true,poisoned:false,namespace:{installationId:scope.installationId,generation:scope.generation}};
      if(path==='/ingest'){const wire=body as {source:{id:string;version:number;hash:string;text:string};operationId:string};expect(wire.source.text.trim()).not.toBe('');
        const row=await sql('SELECT revision FROM assistant_sources WHERE installation_id=? AND generation=? AND id=?',...keys(),wire.source.id).first<{revision:number}>();expect(row).toBeTruthy();
        physical.set(wire.source.id,{id:wire.source.id,revision:row!.revision,version:wire.source.version,hash:wire.source.hash});
        return{ok:true,result:{id:wire.source.id,version:wire.source.version,hash:wire.source.hash,state:'completed',chunks:1,relations:1,nodes:1,edges:1}};
      }
      if(path==='/search'){const wire=body as EngineSearch;return{ok:true,result:{candidates:wire.allowedSources.map(x=>({...x,via:['chunks'],relationCount:0})),missing:[]}};}
      throw Error('unexpected_physical_request');
    })};
}
beforeEach(async()=>{
  for(const [_,query]of Object.entries(migrations).sort(([a],[b])=>a.localeCompare(b))){const parts=query.replace(/^--.*$/gm,'').trim().split(/;\s*(?=CREATE|ALTER|INSERT|$)/).filter(p=>p.trim());if(parts.length)await env.DB.batch(parts.map(p=>env.DB.prepare(p)));}
  scope={installationId:crypto.randomUUID(),generation:'g1',sourceEpoch:'synthetic-first-e',sourceGeneration:'synthetic-first-g'};now=Date.parse('2026-10-26T12:00:00Z');modelCalls=0;dispatches=0;data=new Map();physical=new Map();running=false;tail=Promise.resolve();
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
  const capturedAt=now,secret='synthetic-first-index-capture-secret',reader={async readSnapshot(input:ReaderQuery){if(input.secret!==secret)throw Error('denied');return{observation:'capture_snapshot',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:'message',sourceId:'first',chatId:'chat',sourceVersion:1,watermark:1,conversationKind:'private',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text:'Synthetic first captured request.',authorId:'a'.repeat(64),authorName:'Synthetic author',fromMe:false,occurredAt:capturedAt,messageId:'first',messageVersion:1}};}};
  settings={DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,BRIDGE_SOURCE_EPOCH:scope.sourceEpoch,BRIDGE_SOURCE_GENERATION:scope.sourceGeneration,BRIDGE_SECRET:secret,CAPTURE_READER:reader,OPENAI_API_KEY:'synthetic-only-key',FLUE_EPISODES_ENABLED:'shadow',ROUTINES_ENABLED:'shadow'};
  await new InferenceBudget(env.DB,{...scope,period:'2026-10-26'}).configure(1000000);
  const storage=memoryStorage();port=physicalPort();const core=new CogneeEngine(scope,storage,port,new CanonicalEngineGuard(settings),()=>now);
  engine=Object.assign(Object.create(CogneeContainer.prototype),{ctx:{storage,container:{images:{cognee:'synthetic-first-pinned-image'}}},env:settings,engine:core,port});
  settings.COGNEE={idFromName:()=>({}),get:()=>engine} as unknown as NonNullable<AssistantEnv['COGNEE']>;
  model=async request=>{modelCalls++;const prompt=JSON.parse(JSON.parse(request.body).messages.at(-1).content),source=prompt.sources[0];return{status:200,actualUnits:3,body:JSON.stringify({choices:[{message:{content:JSON.stringify({decision:'proposed',text:'Synthetic shadow only',citations:[{id:source.id,revision:source.revision,version:source.version,hash:source.hash,quote:source.text}]})}}]})};};
  driver=(profile,runtimeId)=>({dispatch:async()=>{dispatches++;return{submissionId:'submission-first',uid:'uid-first',acceptedAt:new Date(now).toISOString()};},read:async receipt=>{const {search}=hostConfiguredSearch(settings,'automation',()=>now),host=new EpisodeController(env.DB,{...scope,period:'2026-10-26'},search,model,DEFAULT_BROKER_CONFIG,{purpose:'automation',clock:()=>now});const row=await sql('SELECT id FROM assistant_episodes WHERE installation_id=? AND generation=? AND runtime_id=?',...keys(),runtimeId).first<{id:string}>();const episode=boundEpisode((await host.episodes.get(row!.id))!);return{...receipt,text:await host.model(episode.id,{profile,runtimeId,submissionId:receipt.submissionId},{messages:[{role:'user',content:host.message(episode)}]}),data:{}};}});
});
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
async function capture(){const response=await receiveCapture(new Request('https://synthetic.invalid/internal/capture',{method:'POST',headers:{Authorization:'Bearer '+settings.BRIDGE_SECRET},body:JSON.stringify({protocol:1,...scope,sequence:1,previousSequence:0,chatId:'chat',sourceId:'first',sourceKind:'message',operation:'upsert',recordedAt:now})}),settings);expect(response.status).toBe(200);}
const scheduler=()=>new AssistantScheduler(settings,{clock:()=>now,driver,model});
async function admission(){settings.ROUTINES_PAUSED='true';await capture();await scheduler().tick();settings.ROUTINES_PAUSED='false';now+=60001;vi.setSystemTime(now);
  const item=await sql('SELECT id,source_id,actor_json FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first<{id:string;source_id:string;actor_json:string}>(),actor=JSON.parse(item!.actor_json);
  const source=(await new SourceAccess(env.DB,scope).read(actor,item!.source_id))!,origin=(await new OriginGuard(env.DB,()=>scope,settings.CAPTURE_READER!,settings.BRIDGE_SECRET!).fence(source.id))!;
  const ref={id:source.id,revision:source.fence.source.revision,version:source.fence.source.version,hash:source.fence.source.hash};await sql('UPDATE assistant_routine_items SET index_sources_json=? WHERE installation_id=? AND generation=? AND id=?',JSON.stringify([ref]),...keys(),item!.id).run();
  const routines=new Routines(env.DB,scope,()=>now),cycle=(await routines.begin(false))!;await routines.phase(cycle,'work',item!.id);
  const input:EngineIngest={actor,source,origin},a={itemId:item!.id,owner:cycle.owner};
  return{input,a,ref,async reserve(){const result=await engine.reserveInitialIngest(input,a);expect(result.state).toBe('reserved');if(result.state!=='reserved')throw Error('not_reserved');return result.ticket;},async claim(epoch:string){await sql("INSERT INTO assistant_routine_ingestions VALUES(?,?,?,?,?,?,?,?,'attempting')",...keys(),scope.sourceEpoch,scope.sourceGeneration,item!.id,ref.id,JSON.stringify(ref),epoch).run();}};
}
it('bootstraps one authorized original from genuinely absent Core index, checkpoints it, then reaches a shadow decision without reingesting',async()=>{
  await capture();
  expect(data.has('index')).toBe(false);expect(data.has('checkpoint')).toBe(false);expect(running).toBe(false);
  await scheduler().tick();
  expect(await sql('SELECT last_gap FROM assistant_routine_items WHERE installation_id=? AND generation=?',...keys()).first('last_gap')).not.toBe('index_uninitialized');
  expect(port.start).toHaveBeenCalledTimes(1);expect(port.request.mock.calls.filter(([path])=>path==='/ingest')).toHaveLength(1);
  const index=data.get('index') as {epoch:string;sources:SourceStamp[];indexState:string};expect(index.sources).toHaveLength(1);expect(index.indexState).toBe('checkpoint_confirmed');
  expect(await sql('SELECT index_epoch,state FROM assistant_routine_ingestions WHERE installation_id=? AND generation=?',...keys()).first()).toMatchObject({index_epoch:index.epoch,state:'complete'});expect(dispatches).toBe(0);
  now+=60001;vi.setSystemTime(now);await scheduler().tick();expect(dispatches).toBe(1);expect(modelCalls).toBe(1);expect(port.request.mock.calls.filter(([path])=>path==='/ingest')).toHaveLength(1);
  expect(await sql('SELECT COUNT(*) n FROM assistant_shadow_decisions WHERE installation_id=? AND generation=?',...keys()).first('n')).toBe(1);
});
it('never treats blank storage plus a running process or persisted history as a pristine installation',async()=>{
  const x=await admission();running=true;expect(await engine.reserveInitialIngest(x.input,x.a)).toMatchObject({state:'blocked',reason:'initial_index_not_pristine'});running=false;
  for(const [key,value]of [['active',{}],['checkpoint',{phase:'confirmed'}],['rebuild',{phase:'ready'}],['maintenance',true],['quarantine',true],['access:old',{}],['receipt:old',{}],['search-ticket:old',{}],['search-operation:old',{}]] as const){data.set(key,value);expect(await engine.reserveInitialIngest(x.input,x.a)).toMatchObject({state:'blocked',reason:'initial_index_not_pristine'});data.delete(key);}
  expect(data.has('index')).toBe(false);expect(data.has('initial-ingest-v1')).toBe(false);expect(port.start).not.toHaveBeenCalled();expect(modelCalls).toBe(0);
});
it('preserves every corrupt initial marker without reserving or creating an epoch',async()=>{
  const x=await admission();for(const marker of [null,false,0,{}, {state:'reserved',ticket:{indexEpoch:'invalid'}}]){data.set('initial-ingest-v1',marker);const before=clone([...data]);const result=await engine.reserveInitialIngest(x.input,x.a);expect(result.state).not.toBe('reserved');expect([...data]).toEqual(before);expect(port.start).not.toHaveBeenCalled();}
});
it('blocks normal ingest on a corrupt initial marker and requires strict absence of structural metadata',async()=>{
  const x=await admission();for(const marker of [null,false,0,{}]){data.set('initial-ingest-v1',marker);const before=clone([...data]);expect(await engine.ingest(x.input)).toMatchObject({state:'blocked'});expect([...data]).toEqual(before);expect(port.start).not.toHaveBeenCalled();}
  data.delete('initial-ingest-v1');for(const [key,value]of [['index',false],['checkpoint',null],['rebuild',false],['active',null],['maintenance',false],['quarantine',false]] as const){data.set(key,value);const before=clone([...data]);expect((await engine.reserveInitialIngest(x.input,x.a)).state).not.toBe('reserved');expect([...data]).toEqual(before);data.delete(key);}
});
it('reserves one immutable real epoch without starting, blocks normal ingest B, and commits A exactly once',async()=>{
  const x=await admission(),ticket=await x.reserve();expect(await x.reserve()).toEqual(ticket);expect(data.has('index')).toBe(false);expect(port.start).not.toHaveBeenCalled();
  running=true;expect(await engine.reserveInitialIngest(x.input,x.a)).toMatchObject({state:'blocked',reason:'initial_index_not_pristine'});running=false;
  const owner=new SourceController(env.DB,scope,{kind:'owner'},()=>now),b=await owner.create({originKey:'different',text:'Synthetic unrelated B',occurredAt:now}),source=(await new SourceAccess(env.DB,scope).read({kind:'owner'},b.id))!;
  expect(await engine.ingest({actor:{kind:'owner'},source})).toMatchObject({state:'blocked',reason:'initial_ingest_reserved'});expect(data.has('index')).toBe(false);expect(port.start).not.toHaveBeenCalled();
  await x.claim(ticket.indexEpoch);expect(await engine.commitInitialIngest(x.input,ticket,x.a)).toMatchObject({state:'complete',operationId:ticket.operationId});
  expect(await engine.commitInitialIngest(x.input,ticket,x.a)).toMatchObject({state:'complete',operationId:ticket.operationId});expect(port.start).toHaveBeenCalledTimes(1);expect(port.request.mock.calls.filter(([p])=>p==='/ingest')).toHaveLength(1);
  expect((data.get('index') as {epoch:string}).epoch).toBe(ticket.indexEpoch);expect(await engine.initialIngestReceipt(x.input,x.a.itemId,'wrong-epoch')).toMatchObject({state:'uncertain'});
});
it('concurrent reservations and commits share a single durable epoch and physical attempt',async()=>{
  const x=await admission(),reservations=await Promise.all([engine.reserveInitialIngest(x.input,x.a),engine.reserveInitialIngest(x.input,x.a)]),tickets=reservations.flatMap(r=>r.state==='reserved'?[r.ticket]:[]);expect(tickets.length).toBeGreaterThan(0);expect(new Set(tickets.map(t=>t.indexEpoch)).size).toBe(1);expect(port.start).not.toHaveBeenCalled();
  const ticket=tickets[0];await x.claim(ticket.indexEpoch);const outcomes=await Promise.all([engine.commitInitialIngest(x.input,ticket,x.a),engine.commitInitialIngest(x.input,ticket,x.a)]) as {state:string}[];expect(outcomes.some(r=>r.state==='complete')).toBe(true);expect(port.start).toHaveBeenCalledTimes(1);expect(port.request.mock.calls.filter(([p])=>p==='/ingest')).toHaveLength(1);expect((data.get('index') as {epoch:string}).epoch).toBe(ticket.indexEpoch);
});
it('rejects a changed pin, expired cycle and restore hold before any initial process/model effect',async()=>{
  const x=await admission(),ticket=await x.reserve();await x.claim(ticket.indexEpoch);
  expect(await engine.commitInitialIngest({...x.input,actor:{kind:'owner'}},ticket,x.a)).toMatchObject({state:'blocked',reason:'initial_input_changed'});
  expect(await engine.commitInitialIngest(x.input,{...ticket,operationId:'f'.repeat(64)},x.a)).toMatchObject({state:'blocked',reason:'initial_ticket_changed'});
  now+=840001;vi.setSystemTime(now);expect(await engine.commitInitialIngest(x.input,ticket,x.a)).toMatchObject({state:'blocked',reason:'initial_ingest_denied'});
  await sql("INSERT INTO assistant_retention_runtime_hold VALUES(?,'restore','next',1,?)",scope.installationId,now).run();await expect(engine.commitInitialIngest(x.input,ticket,x.a)).rejects.toThrow('restore_runtime_paused');expect(port.start).not.toHaveBeenCalled();expect(data.has('index')).toBe(false);expect(modelCalls).toBe(0);
});
it('retains the first epoch/op after an uncertain ingest and never redispatches or replaces it',async()=>{
  const x=await admission(),ticket=await x.reserve();await x.claim(ticket.indexEpoch);const request=port.request.getMockImplementation()!;port.request.mockImplementation(async(path,body)=>{if(path==='/ingest')throw Error('controlled_lost_result');return request(path,body);});
  expect(await engine.commitInitialIngest(x.input,ticket,x.a)).toMatchObject({state:'uncertain'});expect((data.get('initial-ingest-v1') as {state:string}).state).toBe('uncertain');
  expect(await engine.reserveInitialIngest(x.input,x.a)).toMatchObject({state:'uncertain'});expect(await engine.commitInitialIngest(x.input,ticket,x.a)).toMatchObject({state:'uncertain'});expect(await engine.initialIngestReceipt(x.input,x.a.itemId,ticket.indexEpoch)).toMatchObject({state:'uncertain'});expect(port.start).toHaveBeenCalledTimes(1);expect(port.request.mock.calls.filter(([p])=>p==='/ingest')).toHaveLength(1);expect((data.get('index') as {epoch:string}).epoch).toBe(ticket.indexEpoch);
});
it('recovers a lost RPC ACK through the original epoch receipt, then checkpoints and resumes without another ingest',async()=>{
  const commit=engine.commitInitialIngest.bind(engine);vi.spyOn(engine,'commitInitialIngest').mockImplementationOnce(async(...args)=>{await commit(...args);throw Error('RPC_ACK_lost_after_complete');});await capture();await scheduler().tick();const before=await sql('SELECT index_epoch,state FROM assistant_routine_ingestions WHERE installation_id=? AND generation=?',...keys()).first<{index_epoch:string;state:string}>();expect(before?.state).toBe('attempting');
  now+=60001;vi.setSystemTime(now);await scheduler().tick();now+=60001;vi.setSystemTime(now);await scheduler().tick();
  expect(await sql('SELECT index_epoch,state FROM assistant_routine_ingestions WHERE installation_id=? AND generation=?',...keys()).first()).toEqual({index_epoch:before!.index_epoch,state:'complete'});expect(port.request.mock.calls.filter(([p])=>p==='/ingest')).toHaveLength(1);expect(port.start).toHaveBeenCalledTimes(1);expect(dispatches).toBe(1);expect(modelCalls).toBe(1);
});
