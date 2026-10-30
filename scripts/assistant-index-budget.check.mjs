import {test,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {resolve,join} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {build} from "esbuild";
const root=resolve(import.meta.dirname,".."),scratch=await mkdtemp(join(tmpdir(),"assistant-index-budget-"));after(()=>rm(scratch,{recursive:true,force:true}));
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error("network_forbidden_in_index_budget_fixture");};after(()=>{globalThis.fetch=originalFetch;});
const entry=join(scratch,"entry.ts"),output=join(scratch,"entry.mjs");
await writeFile(entry,`export {CogneeContainer} from ${JSON.stringify(join(root,"assistant/container.ts"))};export {bridgeHash} from ${JSON.stringify(join(root,"assistant/ingress.ts"))};`,{mode:0o600});
await build({entryPoints:[entry],outfile:output,platform:"node",format:"esm",bundle:true,logLevel:"silent",plugins:[{name:"base-class-only",setup(build){build.onResolve({filter:/^cloudflare:workers$/},()=>({path:"workers",namespace:"fixture"}));build.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:"export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}} export class WorkerEntrypoint extends DurableObject{}",loader:"js"}));}}]});
const {CogneeContainer,bridgeHash}=await import(pathToFileURL(output).href);
const scope={installationId:"synthetic-index-budget",generation:"g1"},stamps=Array.from({length:128},(_,i)=>({id:"source-"+i,revision:1,version:1,hash:"a".repeat(64)}));
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
async function fixture(origin,warm,mutation){
 const count={d1:0,statements:0,rpc:0,verify:0,maxBinds:0,maxBatch:0,model:0},state={held:false,revoked:null,withdrawn:null},seen=new Set(),access={captureEnabled:true,captureSince:1,discontinuous:false},hashes=new Map();
 const content=id=>({kind:"text",text:"PRIVATE-DO-NOT-RETURN",messageId:id,messageVersion:1});
 for(const stamp of stamps)hashes.set(stamp.id,await bridgeHash([1,access,content(stamp.id)]));
 const cost=()=>{if(++count.d1>1000)throw Error("D1_API_QUOTA_1000");if(count.d1+count.rpc>10000)throw Error("WORKER_SUBREQUEST_QUOTA_10000");};
 const execute=(sql,values)=>{
  count.statements++;count.maxBinds=Math.max(count.maxBinds,values.length);assert.ok(values.length<=100,"per-query parameter limit");
  if(sql.includes("FROM sqlite_master"))return {name:"assistant_retention_generation_seals"};
  if(sql.startsWith("SELECT generation FROM assistant_retention_active_generation"))return null;
  if(sql.startsWith("SELECT g.seal"))return null;
  if(sql.includes("AS active")&&sql.includes("AS quiescing"))return {active:null,seal:null,state:null,released:0,held:state.held?1:0,quiescing:0};
  if(sql.startsWith("SELECT 1 FROM assistant_retention_runtime_hold"))return state.held?{held:1}:null;
  if(sql.startsWith("SELECT 1 FROM assistant_retention_installation_gate"))return null;
  if(sql.startsWith("SELECT s.id")){const id=values[2];seen.add(id);if(state.withdrawn===id||state.revoked===id)return null;return {id,revision:1,version:1,content_hash:"a".repeat(64),audience:"owner",origin,conversation_id:origin==="whatsapp"?"chat":null,project_id:null,original_text:"PRIVATE-DO-NOT-RETURN",author_id:null,author_label:null,occurred_at:1};}
  if(sql.startsWith("SELECT 1 WHERE"))return state.revoked!==null&&values.includes(state.revoked)?null:{allowed:1};
  if(sql.startsWith("SELECT o.canonical_id,o.source_kind")){const id=values[4];return {canonical_id:id,source_kind:"message",source_id:id,chat_id:"chat",watermark:10,observation_hash:hashes.get(id),revision:1,current_version:1,kind:"private",chat_watermark:10,access_state:"available",policy_kind:null,policy_revision:0,policy_mode:"attend"};}
  throw Error("unexpected_SQL");
 };
 const env={INSTALLATION_ID:scope.installationId,OPERATIONAL_GENERATION:scope.generation,OPENAI_API_KEY:"synthetic-never-used",BRIDGE_SECRET:"synthetic",BRIDGE_SOURCE_EPOCH:"epoch",BRIDGE_SOURCE_GENERATION:"capture"};
 env.DB={prepare(sql){let values=[];return {bind(...args){values=args;return this;},_execute(){return execute(sql,values);},async first(){cost();return this._execute();}};},async batch(statements){cost();count.maxBatch=Math.max(count.maxBatch,statements.length);assert.ok(statements.length<=6,"bounded host batch");return statements.map(s=>{const row=s._execute();return {success:true,results:row?[row]:[]};});}};
 env.CAPTURE_READER={async readSnapshot(ref){count.rpc++;assert.ok(count.d1+count.rpc<=10000);if(mutation==="hold_remote")state.held=true;if(mutation==="acl_remote")state.revoked=ref.sourceId;return {observation:"capture_snapshot",state:mutation==="origin_withdraw"&&ref.sourceId==="source-127"?"withdrawn":"available",sourceEpoch:"epoch",sourceGeneration:"capture",sourceKind:"message",sourceId:ref.sourceId,chatId:"chat",sourceVersion:1,watermark:10,conversationKind:"private",access,content:content(ref.sourceId)};}};
 const metadata={index:{namespace:JSON.stringify(scope),epoch:"index-e",revision:"b".repeat(64),sources:structuredClone(stamps),lost:false},active:null,maintenance:false,quarantine:false,checkpoint:{phase:"confirmed"}};
 const ctx={storage:{transaction:fn=>fn({get:async key=>structuredClone(metadata[key])})},container:{images:{cognee:"synthetic-digest"}}},container=new CogneeContainer(ctx,env);
 container.host=()=>({maintain:async fn=>(await fn(null)).value,checkpointEffect:fn=>fn()});
 container.port={running:warm,async verify(manifest){count.verify++;if(mutation==="hold_verify")state.held=true;const {imageRef,...identity}=manifest.identity;return {...identity,indexEpoch:manifest.indexEpoch,indexRevision:manifest.indexRevision,manifestHash:await bridgeHash(canonical(manifest)),closed:false,poisoned:false,pendingOperations:0,sources:manifest.sources.map(({id,version,hash})=>({id,version,hash,originalHash:hash,chunks:1}))};}};
 if(mutation==="withdrawn_global")state.withdrawn="source-127";
 return {count,state,seen,async run(){const result=await container.indexPreflight({indexEpoch:metadata.index.epoch,indexRevision:metadata.index.revision});assert.equal(JSON.stringify(result).includes("PRIVATE-DO-NOT-RETURN"),false);return result;}};
}
for(const origin of ["owner_note","whatsapp"])for(const warm of [false,true])test(`full 128-source ${origin} ${warm?"warm two-pass":"cold"} preflight stays within real API and bind quotas`,async()=>{
 const f=await fixture(origin,warm),result=await f.run();assert.equal(result.state,warm?"verified":"current_metadata",JSON.stringify(f.count));assert.equal(result.sourceCount,128);assert.equal(f.seen.size,128);assert.ok(f.count.d1<=1000);assert.ok(f.count.d1+f.count.rpc<=10000);assert.ok(f.count.maxBinds<=100);assert.ok(f.count.maxBatch<=6);assert.equal(f.count.verify,warm?1:0);assert.equal(f.count.rpc,origin==="whatsapp"?(warm?256:128):0);assert.equal(f.count.model,0);console.log(JSON.stringify({observation:"synthetic_full_preflight_api_count",origin,warm,...f.count}));
});
for(const mutation of ["hold_remote","hold_verify","acl_remote","origin_withdraw"])test(`full preflight refuses ${mutation} after awaits without cached execution or authorization`,async()=>{const f=await fixture("whatsapp",true,mutation),result=await f.run();assert.equal(result.state,"unavailable");assert.ok(f.count.d1<=1000);assert.equal(f.count.model,0);});
test("withdrawn source outside an active guest pack still invalidates the global 128 inventory",async()=>{const f=await fixture("owner_note",false,"withdrawn_global");assert.deepEqual(await f.run(),{state:"maintenance_required",reason:"canonical_sources_changed"});assert.ok(f.seen.has("source-127"));assert.equal(f.count.verify,0);});
