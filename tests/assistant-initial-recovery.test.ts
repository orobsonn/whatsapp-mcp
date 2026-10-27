import {expect,it,vi} from "vitest";
import {CogneeEngine,type EngineIngest,type EngineStore,type EngineGuard,type ContainerPort,type InitialIngestAdmission} from "../assistant/engine";
import {sourceTextHash} from "../assistant/sources";
import {bridgeHash} from "../assistant/ingress";
type Proof={previousId:string;previousPlanHash:string;previousJobHash:string;indexEpoch:string;operationId:string;witnessHash:string};
async function fixture(){
 const scope={installationId:"synthetic-initial-recovery",generation:"g1"},data=new Map<string,unknown>();let tail=Promise.resolve(),ackLost=false,rollback=false;
 const view=(map:Map<string,unknown>)=>({get:async<T>(key:string)=>structuredClone(map.get(key)) as T|undefined,
  put:async(key:string,value:unknown)=>{map.set(key,structuredClone(value));},delete:async(key:string)=>{map.delete(key);},
  list:async<T>({prefix,limit}:{prefix:string;limit:number})=>new Map([...map].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,structuredClone(v) as T]))});
 const store:EngineStore={...view(data),transaction:async action=>{const run=tail.then(async()=>{const copy=new Map(structuredClone([...data])),result=await action(view(copy));if(rollback){rollback=false;throw Error("synthetic_rollback");}data.clear();for(const[k,v]of copy)data.set(k,v);if(ackLost){ackLost=false;throw Error("synthetic_ACK_lost");}return result;});tail=run.then(()=>{},()=>{});return run;}};
 const text="Synthetic technical Owner original.",hash=await sourceTextHash(text),source={id:"owner-note",text,authorId:null,authorLabel:null,occurredAt:100,
  fence:{...scope,actor:"owner",source:{id:"owner-note",revision:1,version:1,hash,audience:"owner" as const,origin:"owner_note",conversationId:null,projectId:"own-project"},policy:null,identity:null,mandate:null}};
 const previousId="a".repeat(64),itemId="b".repeat(64),token=crypto.randomUUID(),epoch=crypto.randomUUID();
 const input:EngineIngest={actor:{kind:"owner"},source,ownerOnce:{id:itemId,token}},wire={source:{id:source.id,version:1,hash,text,occurredAt:100,projectId:"own-project"}};
 const operationId=await bridgeHash([scope,epoch,"/ingest",wire,null]),ticket={itemId:previousId,inputHash:"c".repeat(64),indexEpoch:epoch,operationId,admissionKind:"owner_once" as const};
 data.set("initial-ingest-v1",{state:"uncertain",ticket});data.set("index",{namespace:JSON.stringify(scope),revision:"empty",epoch,sources:[],indexState:"needs_checkpoint",lost:true});data.set("quarantine",true);data.set("active",null);
 const effect=vi.fn(async()=>{throw Error("recovery_must_not_execute");}),port:ContainerPort&{running:boolean}={running:false,start:effect,destroy:effect,deny:effect,intercept:effect,request:effect};
 const guard:EngineGuard&{checkInitialRecovery:ReturnType<typeof vi.fn>}={check:vi.fn(async()=>true),checkInitialAdmission:vi.fn(async()=>true),checkInitialRecovery:vi.fn(async()=>true),issue:vi.fn(async()=>{throw Error("recovery_model_permit");}),revoke:effect};
 const engine=new CogneeEngine(scope,store,port,guard),admission:InitialIngestAdmission={itemId,owner:token,kind:"owner_once"};
 return {scope,data,store,source,input,ticket,epoch,previousId,itemId,port,effect,guard,engine,admission,
  loseAck:()=>{ackLost=true;},rollback:()=>{rollback=true;},async proof():Promise<Proof>{const witness=await engine.prepareInitialRecovery(previousId);expect(witness.state).toBe("available");if(witness.state!=="available")throw Error("witness_missing");return{previousId,previousPlanHash:"d".repeat(64),previousJobHash:"e".repeat(64),indexEpoch:epoch,operationId,witnessHash:witness.witnessHash};}};
}
it("reserves a separately authorized ticket on the same wire/epoch and archives all old state atomically without dispatch",async()=>{
 const f=await fixture(),before=structuredClone([...f.data]),proof=await f.proof();
 const result=await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof);
 expect(result).toMatchObject({state:"reserved",created:true,ticket:{itemId:f.itemId,indexEpoch:f.epoch,operationId:f.ticket.operationId}});
 if(result.state!=="reserved")throw Error("reservation_missing");
 expect(result.ticket?.inputHash).not.toBe(f.ticket.inputHash);expect(f.data.get("initial-ingest-v1")).toEqual({state:"reserved",ticket:result.ticket});
 expect(f.data.has("index")).toBe(false);expect(f.data.has("quarantine")).toBe(false);expect(f.data.has("active")).toBe(false);
 const archive=[...f.data].find(([key])=>key.startsWith("initial-recovery-v1:"))?.[1] as {previous:{initial:unknown;index:unknown;quarantine:unknown;active:unknown}};
 expect(archive.previous).toMatchObject({initial:new Map(before).get("initial-ingest-v1"),index:new Map(before).get("index"),quarantine:true,active:null});
 expect(JSON.stringify(archive)).not.toContain(f.input.source.text!);expect(JSON.stringify(archive)).not.toContain(f.admission.owner);expect(f.effect).not.toHaveBeenCalled();expect(f.guard.issue).not.toHaveBeenCalled();
 expect(await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof)).toMatchObject({state:"reserved",created:false,ticket:result.ticket});
});
it.each(["checkpoint","rebuild","maintenance"])("treats even a false %s marker as incompatible history",async key=>{
 const f=await fixture();f.data.set(key,false);const before=structuredClone([...f.data]);
 expect((await f.engine.prepareInitialRecovery(f.previousId)).state).toBe("blocked");expect([...f.data]).toEqual(before);
});
it.each(["initial","namespace","epoch","revision","sources","lost","quarantine","active","kind","state","consumed"])("rejects changed or malformed bootstrap metadata: %s",async change=>{
 const f=await fixture(),index=f.data.get("index") as Record<string,unknown>;
 if(change==="initial")f.data.set("initial-ingest-v1",null);
 if(change==="namespace")f.data.set("index",{...index,namespace:"wrong"});
 if(change==="epoch")f.data.set("index",{...index,epoch:crypto.randomUUID()});
 if(change==="revision")f.data.set("index",{...index,revision:"d".repeat(64)});
 if(change==="sources")f.data.set("index",{...index,sources:[{id:"other"}]});
 if(change==="lost")f.data.set("index",{...index,lost:false});
 if(change==="quarantine")f.data.set("quarantine",1);
 if(change==="active")f.data.set("active",false);
 if(change==="kind")f.data.set("initial-ingest-v1",{state:"uncertain",ticket:{...f.ticket,admissionKind:undefined}});
 if(change==="state")f.data.set("initial-ingest-v1",{state:"attempting",ticket:f.ticket});
 if(change==="consumed")f.data.set("initial-recovery-v1:unrelated",null);
 const before=structuredClone([...f.data]);expect((await f.engine.prepareInitialRecovery(f.previousId)).state).toBe("blocked");expect([...f.data]).toEqual(before);expect(f.effect).not.toHaveBeenCalled();
});
it("rechecks process, authority and storage support and never starts on a refusal",async()=>{
 const f=await fixture(),proof=await f.proof(),before=structuredClone([...f.data]);
 f.port.running=true;expect((await f.engine.prepareInitialRecovery(f.previousId)).state).toBe("blocked");expect((await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof)).state).not.toBe("reserved");f.port.running=false;
 expect((await f.engine.reserveRecoveredInitialIngest({...f.input,actor:{kind:"public"} as never},f.admission,proof)).state).toBe("blocked");
 expect((await f.engine.reserveRecoveredInitialIngest({...f.input,ownerOnce:{id:f.itemId,token:crypto.randomUUID()}},f.admission,proof)).state).toBe("blocked");
 f.guard.checkInitialRecovery.mockResolvedValue(false);expect((await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof)).state).not.toBe("reserved");
 expect([...f.data]).toEqual(before);expect(f.effect).not.toHaveBeenCalled();
 const noList=new CogneeEngine(f.scope,{get:f.store.get,put:f.store.put,transaction:async fn=>fn({get:f.store.get,put:f.store.put})},f.port,f.guard);
 expect((await noList.prepareInitialRecovery(f.previousId)).state).toBe("blocked");
});
it("rolls back all metadata together, then allows only one competing new Root",async()=>{
 const f=await fixture(),proof=await f.proof(),before=structuredClone([...f.data]);f.rollback();
 expect((await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof)).state).toBe("uncertain");expect([...f.data]).toEqual(before);
 const otherId="f".repeat(64),second=new CogneeEngine(f.scope,f.store,f.port,f.guard);
 const results=await Promise.all([f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof),second.reserveRecoveredInitialIngest({...f.input,ownerOnce:{id:otherId,token:f.admission.owner}},{...f.admission,itemId:otherId},proof)]);
 expect(results.filter(x=>x.state==="reserved")).toHaveLength(1);expect([...f.data.keys()].filter(x=>x.startsWith("initial-recovery-v1:"))).toHaveLength(1);expect(f.effect).not.toHaveBeenCalled();
});
it("recovers an ACK-lost commit without recreating it or rechecking the fresh-creation financial gate",async()=>{
 const f=await fixture(),proof=await f.proof();f.loseAck();
 expect((await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof)).state).toBe("uncertain");const committed=structuredClone([...f.data]);
 f.guard.checkInitialRecovery.mockResolvedValue(false);
 expect(await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof)).toMatchObject({state:"reserved",created:false});
 expect([...f.data]).toEqual(committed);expect(f.guard.checkInitialRecovery).toHaveBeenCalledTimes(1);expect(f.effect).not.toHaveBeenCalled();
 const changed={...proof,previousJobHash:"f".repeat(64)};expect((await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,changed)).state).not.toBe("reserved");
});
it("recognizes committed recovery after actual new work and does not clear a later quarantine",async()=>{
 const f=await fixture(),proof=await f.proof(),reserved=await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof);if(reserved.state!=="reserved")throw Error("missing");
 f.data.set("initial-ingest-v1",{state:"uncertain",ticket:reserved.ticket});f.data.set("index",{epoch:f.epoch,revision:"f".repeat(64)});f.data.set("quarantine",true);f.data.set("access:actual-new-dispatch",{});
 f.guard.checkInitialRecovery.mockResolvedValue(false);const before=structuredClone([...f.data]);
 expect(await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof)).toMatchObject({state:"already_admitted",created:false});
 expect([...f.data]).toEqual(before);expect(f.guard.checkInitialRecovery).toHaveBeenCalledTimes(1);expect(f.effect).not.toHaveBeenCalled();
});
it.each(["access:","receipt:","search-ticket:","search-operation:","search-operation-history-v1"])("does not call a reserved replay pristine when global history appeared: %s",async prefix=>{
 const f=await fixture(),proof=await f.proof();expect((await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof)).state).toBe("reserved");
 f.data.set(prefix+"unexpected",null);const before=structuredClone([...f.data]);
 expect((await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof)).state).not.toBe("reserved");expect([...f.data]).toEqual(before);expect(f.effect).not.toHaveBeenCalled();
});
it("releases in-memory quarantine only after confirmed commit, including recovery of a lost ACK after a real failed boot",async()=>{
 const f=await fixture();f.data.clear();f.port.deny=vi.fn(async()=>{});f.port.destroy=vi.fn(async()=>{f.port.running=false;});
 f.port.start=vi.fn(async()=>{throw Error("synthetic_boot_failure");});
 const oldAdmission={...f.admission,itemId:f.previousId,owner:crypto.randomUUID()},oldInput={...f.input,ownerOnce:{id:f.previousId,token:oldAdmission.owner}};
 const original=await f.engine.reserveInitialIngest(oldInput,oldAdmission);if(original.state!=="reserved")throw Error("original_missing");
 expect(await f.engine.commitInitialIngest(oldInput,original.ticket,oldAdmission)).toMatchObject({state:"uncertain"});expect(f.data.get("quarantine")).toBe(true);
 const witness=await f.engine.prepareInitialRecovery(f.previousId);if(witness.state!=="available")throw Error("witness_missing");
 const proof={previousId:f.previousId,previousPlanHash:"d".repeat(64),previousJobHash:"e".repeat(64),indexEpoch:witness.indexEpoch,operationId:witness.operationId,witnessHash:witness.witnessHash};
 f.loseAck();expect((await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof)).state).toBe("uncertain");
 const replay=await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,proof);if(replay.state!=="reserved")throw Error("replay_missing");
 f.port.start=vi.fn(async()=>{f.port.running=true;});f.port.intercept=vi.fn(async()=>{});vi.spyOn(f.guard,"issue").mockResolvedValue("permit");f.guard.revoke=vi.fn(async()=>{});
 f.port.request=vi.fn(async(path:string)=>path==="/health"?{namespace:f.scope,ready:true}:{ok:true,result:{id:f.source.id,version:1,hash:f.source.fence.source.hash,state:"completed",chunks:1,relations:0,nodes:0,edges:0}}) as typeof f.port.request;
 expect(await f.engine.commitInitialIngest(f.input,replay.ticket,f.admission)).toMatchObject({state:"complete"});
 expect(f.port.start).toHaveBeenCalledTimes(1);expect(f.port.request).toHaveBeenCalledTimes(2);
 expect(await f.engine.commitInitialIngest(oldInput,original.ticket,oldAdmission)).toMatchObject({state:"blocked",reason:"initial_ticket_changed"});
 expect([...f.data.keys()].filter(x=>x.startsWith("initial-recovery-v1:"))).toHaveLength(1);
});
it.each(["access:","receipt:","search-ticket:","search-operation:","search-operation-history-v1"])("refuses global incompatible history, including null, without clearing it: %s",async prefix=>{
 const f=await fixture();f.data.set(prefix+"unrelated",null);const before=structuredClone([...f.data]);
 expect((await f.engine.prepareInitialRecovery(f.previousId)).state).not.toBe("available");expect([...f.data]).toEqual(before);expect(f.effect).not.toHaveBeenCalled();
});
it("rejects a witness changed after preparation and a different source wire without mutating original state",async()=>{
 const f=await fixture(),proof=await f.proof(),before=structuredClone([...f.data]);
 expect((await f.engine.reserveRecoveredInitialIngest(f.input,f.admission,{...proof,witnessHash:"f".repeat(64)})).state).not.toBe("reserved");
 const changed={...f.input,source:{...f.input.source,occurredAt:101}};
 expect((await f.engine.reserveRecoveredInitialIngest(changed,f.admission,proof)).state).not.toBe("reserved");expect([...f.data]).toEqual(before);expect(f.effect).not.toHaveBeenCalled();
});
