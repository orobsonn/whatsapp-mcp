import {expect,it,vi} from "vitest";
import {CogneeEngine,type EngineStore} from "../assistant/engine";
function fixture(){
 const data=new Map<string,unknown>(),reads:string[]=[],writes=vi.fn(async()=>{throw Error("diagnostic_write");});
 const store:EngineStore={get:vi.fn(async()=>{throw Error("nontransactional_diagnostic_read");}),put:writes,
  transaction:vi.fn(async action=>{const snapshot=new Map(data);return action({get:async<T>(key:string)=>{reads.push(key);return structuredClone(snapshot.get(key)) as T|undefined;},put:writes});})};
 const effect=vi.fn(async()=>{throw Error("diagnostic_effect");}),port={running:false,start:effect,destroy:effect,intercept:effect,deny:effect,request:effect};
 const guard={check:vi.fn(async()=>false),issue:vi.fn(async()=>{throw Error("diagnostic_model_permit");}),revoke:effect};
 const scope={installationId:"synthetic-inspection",generation:"g1"},core=new CogneeEngine(scope,store,port,guard),epoch=crypto.randomUUID();
 const ticket={itemId:"a".repeat(64),inputHash:"c".repeat(64),indexEpoch:epoch,operationId:"b".repeat(64),admissionKind:"owner_once"};
 return {data,reads,writes,store,effect,guard,scope,core,ticket,epoch};
}
it("reads initial/index/access/receipt/active in one transaction without process, model or state effects",async()=>{
 const f=fixture();f.data.set("initial-ingest-v1",{state:"uncertain",ticket:f.ticket});f.data.set("index",{namespace:JSON.stringify(f.scope),epoch:f.epoch,revision:"empty",sources:[],lost:true});f.data.set("quarantine",true);f.data.set("active",null);
 const before=structuredClone([...f.data]),result=await f.core.observeInitial();
 expect(result).toMatchObject({state:"observed",activePresent:false,quarantine:true,index:{state:"present",sourceCount:0,lost:true},initial:{state:"present",admissionState:"uncertain",hasAccess:false,hasReceipt:false}});
 expect(JSON.stringify(result)).not.toContain(f.ticket.inputHash);expect(f.store.transaction).toHaveBeenCalledTimes(1);expect(f.store.get).not.toHaveBeenCalled();
 expect(f.data).toEqual(new Map(before));expect(f.writes).not.toHaveBeenCalled();expect(f.effect).not.toHaveBeenCalled();expect(f.guard.check).not.toHaveBeenCalled();expect(f.guard.issue).not.toHaveBeenCalled();
 f.data.set("access:"+f.ticket.operationId,null);expect((await f.core.observeInitial()).initial).toMatchObject({hasAccess:true});
});
it.each([null,false,0,{}, {state:"uncertain",ticket:{operationId:"invalid-private-value"}}])("keeps corrupt initial metadata distinct from absence and never follows an invalid operation key: %j",async marker=>{
 const f=fixture();f.data.set("initial-ingest-v1",marker);const before=structuredClone([...f.data]);
 expect((await f.core.observeInitial()).initial).toEqual({state:"invalid"});expect(f.reads.some(key=>key.startsWith("access:")||key.startsWith("receipt:"))).toBe(false);
 expect(f.data).toEqual(new Map(before));expect(f.writes).not.toHaveBeenCalled();expect(f.effect).not.toHaveBeenCalled();
});
it("reports absent metadata without manufacturing evidence of an unused initial ticket",async()=>{
 const f=fixture();expect(await f.core.observeInitial()).toMatchObject({initial:{state:"absent"},index:{state:"absent"}});expect(f.writes).not.toHaveBeenCalled();expect(f.effect).not.toHaveBeenCalled();
});
