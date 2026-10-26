import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { RetrievalRuns, type CoverageProof, type SearchFence } from "../assistant/retrieval-runs";
import { CogneeEngine, type EngineSearch, type EngineStore, type EngineSearchOutcome } from "../assistant/engine";
import { SourceAccess, type TrustedActor } from "../assistant/access";
import { SourceController, sourceTextHash } from "../assistant/sources";
import { CogneeModelBroker, type ModelAdapter } from "../assistant/model-broker";
import { InferenceBudget } from "../assistant/budget";
import { OriginGuard, type OriginFence } from "../assistant/origin-guard";
import { CanonicalEngineGuard, handleBrokerRequest } from "../assistant/container";
// @ts-expect-error Raw SQL.
import sources from "../assistant/migrations/0001_sources.sql?raw";
// @ts-expect-error Raw SQL.
import policies from "../assistant/migrations/0002_identity_policy.sql?raw";
// @ts-expect-error Raw SQL.
import inbox from "../assistant/migrations/0004_capture_inbox.sql?raw";
// @ts-expect-error Raw SQL.
import origins from "../assistant/migrations/0006_source_origins.sql?raw";
// @ts-expect-error Raw SQL.
import controls from "../assistant/migrations/0007_source_controls.sql?raw";
// @ts-expect-error Raw SQL.
import budgets from "../assistant/migrations/0008_inference_budget.sql?raw";
// @ts-expect-error Raw SQL.
import relations from "../assistant/migrations/0009_relations.sql?raw";
// @ts-expect-error Raw SQL.
import receipts from "../assistant/migrations/0010_model_receipts.sql?raw";
// @ts-expect-error Raw SQL.
import conversations from "../assistant/migrations/0011_conversations.sql?raw";
// @ts-expect-error Raw SQL.
import runs from "../assistant/migrations/0014_retrieval_runs.sql?raw";
// @ts-expect-error Raw SQL.
import semantic from "../assistant/migrations/0015_semantic_retrieval.sql?raw";
const owner={kind:"owner"} as const;
const guest:TrustedActor={kind:"interlocutor",provider:"whatsapp",address:"unknown",conversationId:"chat",conversationKind:"private",action:"reply_text"};
let scope:{installationId:string;generation:string},search:RetrievalRuns,engine:CogneeEngine,controller:SourceController,data:Map<string,unknown>,store:EngineStore;
let selected:string,epoch:string,searchCalls:number,callback:(proof:CoverageProof)=>Promise<void>,mutate:()=>Promise<void>,response:((wire:EngineSearch)=>unknown)|undefined;
let lastInput:EngineSearch|undefined,restartEngine:()=>void;
const clock=()=>1000;
const config={extractionConfig:"synthetic-semantic-v1",priceVersion:"synthetic-v1",chatModel:"gpt-6-luna",embeddingModel:"text-embedding-3-small",maxOutputTokens:20,chatCeiling:5,embeddingCeiling:2};
const keys=()=>[scope.installationId,scope.generation];
beforeEach(async()=>{
  for(const migration of [sources,policies,inbox,origins,controls,budgets,relations,receipts,conversations,runs,semantic]) await env.DB.batch(migration.replace(/^--.*$/gm,"").trim().split(/;\s*(?=CREATE|$)/).filter((part:string)=>part.trim()).map((part:string)=>env.DB.prepare(part)));
  scope={installationId:crypto.randomUUID(),generation:"g1"};controller=new SourceController(env.DB,scope,owner,clock);data=new Map();epoch="";searchCalls=0;callback=async()=>{};mutate=async()=>{};response=undefined;lastInput=undefined;
  let tail=Promise.resolve();
  const storage:NonNullable<EngineStore["transaction"]>=async operation=>{
    const previous=tail;let release!:()=>void;tail=new Promise(resolve=>{release=resolve;});await previous;
    const snapshot=new Map(structuredClone([...data]));
    try{const result=await operation({get:async<T>(key:string)=>structuredClone(snapshot.get(key)) as T|undefined,put:async(key,value)=>{snapshot.set(key,structuredClone(value));},list:async<T>({prefix,limit}:{prefix:string;limit:number})=>new Map(structuredClone([...snapshot].filter(([key])=>key.startsWith(prefix)).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit))) as Map<string,T>});data.clear();for(const [key,value] of snapshot)data.set(key,value);return result;}finally{release();}
  };
  store={get:<T>(key:string)=>storage(tx=>tx.get<T>(key)),put:(key,value)=>storage(tx=>tx.put(key,value)),transaction:storage};
  data.set("index",{namespace:JSON.stringify(scope),epoch:"epoch-a",revision:"a".repeat(64),sources:[],lost:false,indexState:"needs_checkpoint"});
  const access=new SourceAccess(env.DB,scope,clock);
  const guard={check:async(actor:TrustedActor,permits:EngineSearch["permits"])=>{for(const permit of permits)if(!await access.revalidate(actor,permit.source))return false;return true;},checkCoverage:(proof:CoverageProof)=>search.checkProof(proof),issue:async(fence:EngineSearch["permits"][0]["source"])=>new CogneeModelBroker(env.DB,{...scope,period:"1970-01-01"},config,async()=>{throw 0;},clock).issuePermit(fence.source.id,fence.source.revision,5000),revoke:async()=>{}};
  const port={running:true,start:async()=>{throw new Error("unexpected wake");},intercept:async(value:string)=>{epoch=value;},deny:async()=>{},destroy:async()=>{},request:async(path:string,body:unknown)=>{
    if(path!=="/search")throw new Error("unexpected path");searchCalls++;
    const wire=body as EngineSearch;lastInput=wire;
    await mutate(); const grant=await engine.authorize(epoch);if(!grant?.coverage)throw new Error("coverage denied");await callback(grant.coverage);
    const ref=wire.allowedSources.find(ref=>ref.id===selected)!;
    return {ok:true,result:response?response(wire):{candidates:[{...ref,via:["chunks"],relationCount:0}],missing:[]}};
  }};
  restartEngine=()=>{engine=new CogneeEngine(scope,store,port,guard,clock);};restartEngine();
  search=new RetrievalRuns(env.DB,scope,{clock,semantic:{mode:"required",engine}});
});
async function create(text:string,audience:"public"|"owner"="public",projectId?:string){return controller.create({originKey:crypto.randomUUID(),text,audience,occurredAt:100,...(projectId?{projectId}:{})});}
async function inventory(actor:TrustedActor=owner,query="Quem responde pela cobrança?",key=crypto.randomUUID()){
  let progress=await search.start(actor,key,{query});
  for(let i=0;progress.state==="pending"&&i<80;i++)progress=await search.step(actor,{runId:progress.runId,stepId:`step-${i}`,expectedCheckpoint:progress.checkpoint});
  return progress.runId;
}
it("rereads the literal score-zero synonym source and binds deterministic semantic provenance",async()=>{
  selected=(await create("Breno cuida das faturas do projeto Íris.")).id;
  const id=await inventory();
  expect(await env.DB.prepare("SELECT score FROM assistant_retrieval_items WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first("score")).toBe(0);
  expect((await search.result(owner,id)).state).toBe("pending");expect(searchCalls).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_budget_reservations WHERE installation_id=? AND generation=?").bind(...keys()).first("n")).toBe(0);
  await search.advanceSemantic(owner,id);
  const result=await search.result(owner,id);
  expect(result.state).toBe("ready");expect(result.sources[0].text).toBe("Breno cuida das faturas do projeto Íris.");expect(result.coverage).toEqual({inventoryComplete:true,engine:"complete",gaps:[]});expect(result.fence!.ranking).toMatchObject({engine:"complete",binding:{configuration:{version:"rrf-60-v1",mode:"required"},receipt:{indexRevision:"a".repeat(64)}}});
  expect(await search.check(owner,result.fence!)).toBe(true);
  expect((await search.result(owner,id)).fence!.allowedPackHash).toBe(result.fence!.allowedPackHash);
});
it("sends every allowed score-zero reference and excludes semantically adjacent private sources",async()=>{
  selected=(await create("Breno cuida das faturas do projeto Íris.")).id;
  const privateId=(await create("Responsável pela cobrança secreta", "owner")).id;
  await create("Algodão e chá.");const id=await inventory(guest);
  await search.advanceSemantic(guest,id);
  const result=await search.result(guest,id);
  expect(result.sources.map(source=>source.id)).toEqual([selected]);expect(lastInput!.allowedSources).toHaveLength(2);expect(JSON.stringify(lastInput)).not.toContain(privateId);
  const stored=await env.DB.prepare("SELECT proof_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first<string>("proof_json");
  expect(await search.checkProof({...JSON.parse(stored!),actor:JSON.stringify(owner)})).toBe(false);
});
it.each(["insert","grant","correct"])("invalidates coverage before callback after %s without paid adapter",async change=>{
  selected=(await create("Breno cuida das faturas.")).id;
  const hidden=(await create("Uma fonte privada.","owner")).id;
  const actor=change==="grant"?guest:owner,id=await inventory(actor);
  await search.result(actor,id);
  mutate=async()=>{
    if(change==="insert")await create("Nova fonte atrás do inventário.");
    if(change==="grant")await env.DB.prepare("UPDATE assistant_sources SET audience='public' WHERE installation_id=? AND generation=? AND id=?").bind(...keys(),hidden).run();
    if(change==="correct")await controller.correct(selected,1,{text:"Correção: Breno saiu.",occurredAt:100});
  };
  const called=vi.fn();callback=async()=>{called();};
  await search.advanceSemantic(actor,id);
  expect(called).not.toHaveBeenCalled();expect((await search.result(actor,id)).state).not.toBe("ready");
});
it("keeps >64 global lexical coverage with explicit semantic capacity gap and zero engine work",async()=>{
  for(let i=0;i<65;i++)await create(i===64?"Prazo quinta":"Algodão.");
  search=new RetrievalRuns(env.DB,scope,{clock,semantic:{mode:"lexical_fallback",engine}});
  const id=await inventory(owner,"Prazo quinta");const result=await search.result(owner,id);
  expect(result.state).toBe("ready");expect(result.sources[0].text).toBe("Prazo quinta");expect(result.coverage).toEqual({inventoryComplete:true,engine:"not_run_capacity",gaps:["semantic_unsearched"]});expect(searchCalls).toBe(0);
  const required=new RetrievalRuns(env.DB,scope,{clock,semantic:{mode:"required",engine}});
  await expect(required.result(owner,id)).rejects.toThrow("retrieval_run_configuration");
});
it("does not reinfer after lost submit ACK or restart",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.result(owner,id);
  const submit=engine.submit.bind(engine);vi.spyOn(engine,"submit").mockImplementationOnce(async ticket=>{await submit(ticket);throw new Error("ACK lost");});
  await expect(search.advanceSemantic(owner,id)).rejects.toThrow("ACK lost");
  search=new RetrievalRuns(env.DB,scope,{clock,semantic:{mode:"required",engine}});
  await search.advanceSemantic(owner,id);expect((await search.result(owner,id)).state).toBe("ready");expect(searchCalls).toBe(1);
});
it("blocks changed index at persisted receipt/cache and prevents consuming old SearchFence",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.advanceSemantic(owner,id);const result=await search.result(owner,id);expect(result.state).toBe("ready");
  data.set("index",{...(data.get("index") as object),revision:"b".repeat(64)});
  expect((await search.result(owner,id)).state).not.toBe("ready");expect(await search.check(owner,result.fence!)).toBe(false);expect(searchCalls).toBe(1);
});
it.each(["missing","duplicate","extra"])("leaves %s semantic response incomplete without claiming searched coverage",async kind=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();
  response=wire=>{const ref=wire.allowedSources[0],candidate={...ref,via:["chunks"],relationCount:0};return kind==="missing"?{candidates:[],missing:[ref]}:kind==="duplicate"?{candidates:[candidate,candidate],missing:[]}:{candidates:[{...candidate,private_id:"auxiliary"}],missing:[]};};
  await search.advanceSemantic(owner,id);const result=await search.result(owner,id);expect(result.state).not.toBe("ready");expect(result.coverage.engine).not.toBe("complete");
});
it("revalidates CoverageProof in actual broker admission transaction including cache",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.result(owner,id);
  await new InferenceBudget(env.DB,{...scope,period:"1970-01-01"}).configure(30);
  const adapter=vi.fn<ModelAdapter>(async()=>({status:200,body:JSON.stringify({data:[{index:0,embedding:Array(1536).fill(0)}]}),actualUnits:1}));
  callback=async proof=>{
    let inject=true;
    const database={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{
      if(inject){inject=false;const text="Inserted during admission";const hash=await sourceTextHash(text);return env.DB.batch([
        env.DB.prepare("INSERT INTO assistant_sources(installation_id,generation,id,origin,origin_key,audience) VALUES(?,?,'behind','owner_note','behind','public')").bind(...keys()),
        env.DB.prepare("INSERT INTO assistant_source_versions(installation_id,generation,source_id,version,original_text,content_hash,occurred_at) VALUES(?,?,'behind',1,?,?,100)").bind(...keys(),text,hash),...statements]);}
      return env.DB.batch(statements);
    }} as D1Database;
    const grant=await engine.authorize(epoch);expect(grant).not.toBeNull();
    const broker=new CogneeModelBroker(database,{...scope,period:"1970-01-01"},config,adapter,clock,{prepare:async()=>({guard:await search.proofGuard(proof),statements:[]}),uncertain:async()=>{}});
    expect((await broker.invoke(grant!.token,"/v1/embeddings",{model:config.embeddingModel,input:"consulta sintética"})).state).toBe("uncertain");
  };
  await search.advanceSemantic(owner,id);expect(adapter).not.toHaveBeenCalled();expect((await search.result(owner,id)).state).not.toBe("ready");
});
it("binds ranking provenance in the local atomic SearchFence guard",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.advanceSemantic(owner,id);const result=await search.result(owner,id);
  const forged={...result.fence!,ranking:{...result.fence!.ranking!,engine:"forged",binding:null}};
  const guard=search.guard(owner,forged as unknown as SearchFence);
  expect(await env.DB.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first()).toBeNull();
});
it("keeps canonical entity constraints on score-zero semantic candidates",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;
  let progress=await search.start(owner,"entity-constrained",{query:"Quem responde pela cobrança?",entities:[{kind:"project",id:"other-project"}]});
  progress=await search.step(owner,{runId:progress.runId,stepId:"first",expectedCheckpoint:0});await search.advanceSemantic(owner,progress.runId);
  expect((await search.result(owner,progress.runId)).sources).toEqual([]);
});
it("does not reuse owner_read proof/ticket for automation",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;
  search=new RetrievalRuns(env.DB,scope,{clock,purpose:"owner_read",semantic:{mode:"required",engine}});
  const id=await inventory();await search.result(owner,id);
  const row=await env.DB.prepare("SELECT proof_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first<{proof_json:string}>();
  const automation=new RetrievalRuns(env.DB,scope,{clock,semantic:{mode:"required",engine}});
  expect(await automation.checkProof(JSON.parse(row!.proof_json))).toBe(false);
  await expect(automation.result(owner,id)).rejects.toThrow("retrieval_run_denied");
});
it("blocks insertion during a cached broker admission without another adapter call",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.result(owner,id);
  await new InferenceBudget(env.DB,{...scope,period:"1970-01-01"}).configure(30);
  const adapter=vi.fn<ModelAdapter>(async()=>({status:200,body:JSON.stringify({data:[{index:0,embedding:Array(1536).fill(0)}]}),actualUnits:1}));
  callback=async proof=>{
    let calls=0,armed=false;
    const database={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{
      if(armed){armed=false;return env.DB.batch([env.DB.prepare("UPDATE assistant_sources SET audience='owner' WHERE installation_id=? AND generation=? AND id=?").bind(...keys(),selected),...statements]);}
      return env.DB.batch(statements);
    }} as D1Database;
    const grant=await engine.authorize(epoch);
    const broker=new CogneeModelBroker(database,{...scope,period:"1970-01-01"},config,adapter,clock,{prepare:async()=>{const guard=await search.proofGuard(proof);if(++calls===2)armed=true;return {guard,statements:[]};},uncertain:async()=>{}});
    const payload={model:config.embeddingModel,input:"consulta cache"};
    expect((await broker.invoke(grant!.token,"/v1/embeddings",payload)).state).toBe("complete");
    expect((await broker.invoke(grant!.token,"/v1/embeddings",payload)).state).toBe("uncertain");
  };
  const guestRun=await inventory(guest,"Quem responde pela cobrança?","cache-guest");
  // Guest proof loses the source when audience changes during cache admission.
  await search.advanceSemantic(guest,guestRun);expect(adapter).toHaveBeenCalledTimes(1);expect((await search.result(guest,guestRun)).state).not.toBe("ready");
});
it("withholds model response when coverage changes during the adapter while preserving charged truth",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.result(owner,id);
  await new InferenceBudget(env.DB,{...scope,period:"1970-01-01"}).configure(30);
  const adapter=vi.fn<ModelAdapter>(async()=>{await create("New observation while paid call was running.");return {status:200,body:JSON.stringify({data:[{index:0,embedding:Array(1536).fill(0)}]}),actualUnits:1};});
  callback=async()=>{
    const result=await handleBrokerRequest(new Request("http://broker.internal/v1/embeddings",{method:"POST",body:JSON.stringify({model:config.embeddingModel,input:"consulta em voo"})}),epoch,engine,(period,proof)=>new CogneeModelBroker(env.DB,{...scope,period},config,adapter,clock,{prepare:async()=>({guard:await search.proofGuard(proof!),statements:[]}),uncertain:async()=>{}}));
    expect(result.status).toBe(403);expect(await result.text()).not.toContain("embedding");
  };
  await search.advanceSemantic(owner,id);expect(adapter).toHaveBeenCalledTimes(1);
  expect((await new InferenceBudget(env.DB,{...scope,period:"1970-01-01"}).status()).committed).toBe(1);
  expect((await search.result(owner,id)).state).not.toBe("ready");
});
it("uses rank positions rather than incompatible lane scores, with ID tie break",async()=>{
  const lexical=(await create("cobrança cobrança responde responde")).id;
  selected=(await create("Breno cuida das faturas.")).id;
  const id=await inventory();await search.advanceSemantic(owner,id);
  expect((await search.result(owner,id)).sources.map(source=>source.id)).toEqual([lexical,selected].sort());
});
it("recovers the original prepared ticket after lost prepare ACK without budget or wake",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();
  const prepare=engine.prepare.bind(engine);let original:unknown;
  vi.spyOn(engine,"prepare").mockImplementationOnce(async(alias,input)=>{original=await prepare(alias,input);throw new Error("prepare ACK lost");});
  await expect(search.result(owner,id)).rejects.toThrow("prepare ACK lost");
  restartEngine();search=new RetrievalRuns(env.DB,scope,{clock,semantic:{mode:"required",engine}});
  expect((await search.result(owner,id)).state).toBe("pending");expect(searchCalls).toBe(0);
  const stored=await env.DB.prepare("SELECT ticket_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first<string>("ticket_json");
  expect(JSON.parse(stored!)).toEqual((original as {ticket:unknown}).ticket);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_budget_reservations WHERE installation_id=? AND generation=?").bind(...keys()).first("n")).toBe(0);
});
it("does not retry a claim that survived process death before a search response existed",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.result(owner,id);
  const transaction=store.transaction!;let crash=true;
  store.transaction=async operation=>{const result=await transaction(operation);if(crash&&[...data].some(([key,value])=>key.startsWith("search-ticket:")&&(value as {state:string}).state==="attempting")){crash=false;throw new Error("process died after CAS");}return result;};
  await expect(search.advanceSemantic(owner,id)).rejects.toThrow("process died after CAS");
  restartEngine();search=new RetrievalRuns(env.DB,scope,{clock,semantic:{mode:"required",engine}});
  await search.advanceSemantic(owner,id);await search.advanceSemantic(owner,id);
  expect(searchCalls).toBe(0);expect((await search.result(owner,id)).coverage.gaps).toContain("semantic_unsearched");
  expect([...data].filter(([key])=>key.startsWith("search-ticket:")).map(([,value])=>(value as {state:string}).state)).toEqual(["attempting"]);
});
it("does not expose rejected engine auxiliaries or arbitrary reasons in lexical fallback",async()=>{
  selected=(await create("Quem responde pela cobrança? Breno.")).id;
  search=new RetrievalRuns(env.DB,scope,{clock,semantic:{mode:"lexical_fallback",engine}});
  const id=await inventory();await search.result(owner,id);
  vi.spyOn(engine,"submit").mockResolvedValueOnce({state:"complete",operationId:"a".repeat(64),indexRevision:"a".repeat(64),indexState:"needs_checkpoint",result:{candidates:[],missing:[],extra:"PRIVATE_AUXILIARY_SENTINEL"}} as unknown as EngineSearchOutcome);
  vi.spyOn(engine,"lookupTicket").mockResolvedValue({state:"uncertain",reason:"PRIVATE_REASON_SENTINEL"});
  await search.advanceSemantic(owner,id);const result=await search.result(owner,id);
  expect(result.state).toBe("ready");expect(result.coverage.gaps).toContain("semantic_unsearched");expect(JSON.stringify(result)).not.toMatch(/PRIVATE_AUXILIARY_SENTINEL|PRIVATE_REASON_SENTINEL/);
  expect(await env.DB.prepare("SELECT outcome_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first("outcome_json")).not.toContain("PRIVATE_AUXILIARY_SENTINEL");
});
it("empty inventory is no_matches without prepare, submit, wake or model calls",async()=>{
  const prepare=vi.spyOn(engine,"prepare"),submit=vi.spyOn(engine,"submit");
  const id=await inventory();await search.advanceSemantic(owner,id);const result=await search.result(owner,id);
  expect(result.state).toBe("waiting_context");expect(result.coverage).toEqual({inventoryComplete:true,engine:"complete",gaps:["no_matches"]});expect(result.sources).toEqual([]);expect(prepare).not.toHaveBeenCalled();expect(submit).not.toHaveBeenCalled();expect(searchCalls).toBe(0);
});
it("reconstructs a nominal WhatsApp CoverageProof without database bindings and denies remote withdrawal",async()=>{
  const text="Breno cuida das faturas.",created=await create(text),nominal={...scope,sourceEpoch:"capture-epoch",sourceGeneration:"capture-generation"};selected=created.id;
  let withdrawn=false;
  const reader={async readSnapshot(){return {observation:"capture_snapshot",state:withdrawn?"withdrawn":"available",sourceEpoch:nominal.sourceEpoch,sourceGeneration:nominal.sourceGeneration,sourceKind:"message",sourceId:"wa-message",chatId:"wa-chat",sourceVersion:1,watermark:1,conversationKind:"private",access:{captureEnabled:!withdrawn,captureSince:0,discontinuous:false},content:{kind:"text",messageId:"wa-message",messageVersion:1,text,occurredAt:100}};}};
  const origin=new OriginGuard(env.DB,()=>nominal,reader,"synthetic-reader-secret");
  const observation=await origin.observe(nominal,{sourceKind:"message",sourceId:"wa-message",chatId:"wa-chat"});
  await env.DB.batch([
    env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp',conversation_id='wa-chat' WHERE installation_id=? AND generation=? AND id=?").bind(...keys(),selected),
    env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,'wa-chat',1,'private','available')").bind(...keys(),nominal.sourceEpoch,nominal.sourceGeneration),
    env.DB.prepare("INSERT INTO assistant_source_origins VALUES(?,?,?,?,'message','wa-message','wa-chat',?,1,?,0)").bind(...keys(),nominal.sourceEpoch,nominal.sourceGeneration,selected,observation.hash!),
    env.DB.prepare("INSERT INTO assistant_conversations(installation_id,generation,source_epoch,source_generation,chat_id,policy_revision,mode) VALUES(?,?,?,?,'wa-chat',0,'attend')").bind(...keys(),nominal.sourceEpoch,nominal.sourceGeneration),
  ]);
  search=new RetrievalRuns(env.DB,nominal,{clock,origin,semantic:{mode:"required",engine}});
  const id=await inventory();expect((await search.result(owner,id)).state).toBe("pending");
  const record=await env.DB.prepare("SELECT proof_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first<{proof_json:string}>();
  const proof=JSON.parse(record!.proof_json) as CoverageProof;
  const host=new CanonicalEngineGuard({DB:env.DB,INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,OPENAI_API_KEY:"synthetic-unused",BRIDGE_SOURCE_EPOCH:nominal.sourceEpoch,BRIDGE_SOURCE_GENERATION:nominal.sourceGeneration,BRIDGE_SECRET:"synthetic-reader-secret",CAPTURE_READER:reader});
  expect(await host.checkCoverage(proof)).toBe(true);
  const source=await new SourceAccess(env.DB,scope,clock).read(owner,selected);
  expect(await host.check(owner,[{source:source!.fence,origin:(await origin.fence(selected))!}])).toBe(true);
  const original=(await origin.fence(selected))!,reordered=Object.fromEntries(Object.entries(original).reverse()) as OriginFence;
  expect(await origin.check(reordered)).toBe(true);
  expect(await origin.check({...reordered,watermark:2})).toBe(false);
  expect(await origin.check({...reordered,extra:"untrusted"} as OriginFence)).toBe(false);
  withdrawn=true;expect(await host.checkCoverage(proof)).toBe(false);
});
it("cannot reuse a current proof with another query, allowed reference subset or actor",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;await create("Outra fonte pública.");const id=await inventory();await search.result(owner,id);
  const input=([...data].find(([key])=>key.startsWith("search-ticket:"))![1] as {input:EngineSearch}).input;
  expect(await engine.prepare("changed-query",{...input,query:"Different content"})).toMatchObject({state:"blocked"});
  expect(await engine.prepare("subset",{...input,allowedSources:input.allowedSources.slice(0,1),permits:input.permits.slice(0,1)})).toMatchObject({state:"blocked"});
  expect(await engine.prepare("actor",{...input,actor:guest})).toMatchObject({state:"blocked"});
});
it("admits all 64 current score-zero sources with distinct conversation guards on real D1",async()=>{
  search=new RetrievalRuns(env.DB,scope,{clock,purpose:"owner_read",semantic:{mode:"required",engine}});
  for(let i=0;i<64;i++)selected=(await controller.create({originKey:`bounded-${i}`,text:`Algodão ${i}.`,conversationId:`conversation-${i}`,audience:"public",occurredAt:100})).id;
  const id=await inventory();await search.advanceSemantic(owner,id);const result=await search.result(owner,id);
  expect(result.state).toBe("ready");expect(lastInput!.allowedSources).toHaveLength(64);expect(await search.check(owner,result.fence!)).toBe(true);
},30000);
it("times out a 64-origin presearch after five seconds with at most eight in flight and the same unsubmitted ticket",async()=>{
  const nominal={...scope,sourceEpoch:"synthetic-epoch",sourceGeneration:"synthetic-origin"};let slow=false,calls=0,active=0,maximum=0;const release:(()=>void)[]=[];
  const origin={fence:async(id:string)=>({...nominal,canonicalId:id,sourceKind:"message",sourceId:id,chatId:"synthetic-chat",revision:1,version:1,watermark:1,hash:"a".repeat(64),conversationKind:"private",policyRevision:0,policyMode:"attend"} as OriginFence),check:async()=>{if(!slow)return true;calls++;active++;maximum=Math.max(maximum,active);await new Promise<void>(resolve=>release.push(resolve));active--;return true;}};
  for(let i=0;i<64;i++)await create(`Algodão ${i}.`);
  await env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=?").bind(...keys()).run();
  search=new RetrievalRuns(env.DB,scope,{clock,origin,semantic:{mode:"required",engine}});
  const id=await inventory();await search.result(owner,id);
  const before=await env.DB.prepare("SELECT ticket_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first("ticket_json");
  expect(before).toEqual(expect.any(String));
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"]});slow=true;
  try {
    const submit=vi.spyOn(engine,"submit"),pending=search.advanceSemantic(owner,id);
    for(let tick=0;calls<8&&tick<100;tick++)await new Promise<void>(resolve=>setImmediate(resolve));
    expect(calls).toBe(8);await vi.advanceTimersByTimeAsync(5000);await pending;
    expect(maximum).toBe(8);expect(calls).toBe(8);expect(searchCalls).toBe(0);expect(submit).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT ticket_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first("ticket_json")).toBe(before);
    release.splice(0).forEach(resolve=>resolve());await Promise.resolve();await Promise.resolve();expect(calls).toBe(8);
  } finally{vi.useRealTimers();}
});
it("reuses an exact index receipt under a new current proof without depending on the old proof",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const first=await inventory();await search.advanceSemantic(owner,first);expect((await search.result(owner,first)).state).toBe("ready");
  const source=(await new SourceAccess(env.DB,scope,clock).read(owner,selected))!;
  await env.DB.prepare("INSERT INTO assistant_relation_batches(installation_id,generation,operation_key,request_hash,source_id,source_revision,source_version,source_hash,claims_json) VALUES(?,?,'new-observation',?,?,1,1,?,'[]')").bind(...keys(),"b".repeat(64),selected,source.fence.source.hash).run();
  expect((await search.result(owner,first)).state).not.toBe("ready");
  const next=await inventory(owner,"Quem responde pela cobrança?","fresh-proof");await search.advanceSemantic(owner,next);
  expect((await search.result(owner,next)).state).toBe("ready");expect(searchCalls).toBe(1);
});

it("recovers metadata prepare after maintenance with the same alias and current proof",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();
  const prepare=vi.spyOn(engine,"prepare");data.set("maintenance",true);
  expect((await search.result(owner,id)).state).toBe("pending");expect(prepare).toHaveBeenCalledTimes(1);
  expect([...data.keys()].filter(key=>key.startsWith("search-ticket:"))).toHaveLength(0);
  data.set("maintenance",false);
  expect((await search.result(owner,id)).state).toBe("pending");expect(prepare).toHaveBeenCalledTimes(2);
  expect(prepare.mock.calls[1]).toEqual(prepare.mock.calls[0]);expect(searchCalls).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) n FROM assistant_budget_reservations WHERE installation_id=? AND generation=?").bind(...keys()).first("n")).toBe(0);
  await search.advanceSemantic(owner,id);expect((await search.result(owner,id)).state).toBe("ready");expect(searchCalls).toBe(1);
});
it("reconciles a lost prepare ACK to the exact original ticket without model work",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();
  const original=engine.prepare.bind(engine);let ticket:unknown;
  vi.spyOn(engine,"prepare").mockImplementationOnce(async(alias,input)=>{const prepared=await original(alias,input);ticket=prepared.state==="prepared"?prepared.ticket:null;throw new Error("prepare ACK lost");});
  await expect(search.result(owner,id)).rejects.toThrow("prepare ACK lost");
  expect((await search.result(owner,id)).state).toBe("pending");
  expect(JSON.parse((await env.DB.prepare("SELECT ticket_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first<string>("ticket_json"))!)).toEqual(ticket);
  expect(searchCalls).toBe(0);
});
it("recovers a blocked submit only when lookup proves the same ticket strictly not_submitted",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.result(owner,id);
  vi.spyOn(engine,"submit").mockResolvedValueOnce({state:"blocked",reason:"busy"});
  await search.advanceSemantic(owner,id);expect(searchCalls).toBe(0);
  await search.advanceSemantic(owner,id);expect((await search.result(owner,id)).state).toBe("ready");expect(searchCalls).toBe(1);
});

it.each(["attempting","wrong_operation","generic_blocked"])("does not reopen a blocked ticket on %s lookup",async kind=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.result(owner,id);
  await env.DB.prepare("UPDATE assistant_retrieval_semantic SET outcome_json=? WHERE installation_id=? AND generation=? AND run_id=?").bind(JSON.stringify({state:"blocked",reason:"semantic_blocked"}),...keys(),id).run();
  if(kind==="attempting"){
    for(const [key,row]of data)if(key.startsWith("search-ticket:"))data.set(key,{...(row as object),state:"attempting"});
  }else vi.spyOn(engine,"lookupTicket").mockResolvedValue(kind==="wrong_operation"?{state:"uncertain",reason:"not_submitted",operationId:"0".repeat(64)}:{state:"blocked",reason:"source_denied"});
  const submit=vi.spyOn(engine,"submit");await search.advanceSemantic(owner,id);
  expect(submit).not.toHaveBeenCalled();expect(searchCalls).toBe(0);expect((await search.result(owner,id)).state).not.toBe("ready");
});

it("reconciles the exact complete receipt after a concurrent busy refusal without repeating submit",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.result(owner,id);
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  mutate=async()=>{enter();await hold;};
  const submit=vi.spyOn(engine,"submit"),first=search.advanceSemantic(owner,id);await entered;
  await search.advanceSemantic(owner,id);
  expect(await env.DB.prepare("SELECT outcome_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first("outcome_json")).toBe(JSON.stringify({state:"blocked",reason:"semantic_blocked"}));
  release();await first;
  expect((await search.result(owner,id)).state).toBe("ready");
  await search.advanceSemantic(owner,id);expect((await search.result(owner,id)).state).toBe("ready");
  expect(searchCalls).toBe(1);expect(submit).toHaveBeenCalledTimes(2);
});

it("reconciles a persisted busy refusal from the exact existing receipt without calling submit again",async()=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.result(owner,id);
  const ticket=JSON.parse((await env.DB.prepare("SELECT ticket_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first<string>("ticket_json"))!);
  expect(await engine.submit(ticket)).toMatchObject({state:"complete"});
  await env.DB.prepare("UPDATE assistant_retrieval_semantic SET outcome_json=? WHERE installation_id=? AND generation=? AND run_id=?").bind(JSON.stringify({state:"blocked",reason:"semantic_blocked"}),...keys(),id).run();
  const submit=vi.spyOn(engine,"submit");
  search=new RetrievalRuns(env.DB,scope,{clock,semantic:{mode:"required",engine}});
  expect((await search.result(owner,id)).state).toBe("ready");await search.advanceSemantic(owner,id);
  expect(submit).not.toHaveBeenCalled();expect(searchCalls).toBe(1);
});
it.each(["operation","revision"])("refuses a completed receipt with wrong %s after a busy refusal",async kind=>{
  selected=(await create("Breno cuida das faturas.")).id;const id=await inventory();await search.result(owner,id);
  const ticket=JSON.parse((await env.DB.prepare("SELECT ticket_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first<string>("ticket_json"))!);
  const source=(await new SourceAccess(env.DB,scope,clock).read(owner,selected))!;
  await env.DB.prepare("UPDATE assistant_retrieval_semantic SET outcome_json=? WHERE installation_id=? AND generation=? AND run_id=?").bind(JSON.stringify({state:"blocked",reason:"semantic_blocked"}),...keys(),id).run();
  vi.spyOn(engine,"lookupTicket").mockResolvedValue({state:"complete",operationId:kind==="operation"?"0".repeat(64):ticket.operationId,indexRevision:kind==="revision"?"b".repeat(64):ticket.indexRevision,indexState:"needs_checkpoint",result:{candidates:[{id:selected,version:source.fence.source.version,hash:source.fence.source.hash,via:["chunks"],relationCount:0}],missing:[]}});
  const submit=vi.spyOn(engine,"submit");await search.advanceSemantic(owner,id);
  expect((await search.result(owner,id)).state).not.toBe("ready");expect(submit).not.toHaveBeenCalled();expect(searchCalls).toBe(0);
  expect(await env.DB.prepare("SELECT outcome_json FROM assistant_retrieval_semantic WHERE installation_id=? AND generation=? AND run_id=?").bind(...keys(),id).first("outcome_json")).toBe(JSON.stringify({state:"blocked",reason:"semantic_blocked"}));
});
