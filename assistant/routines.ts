import { z } from "zod";
import type { OriginScope } from "./origin-guard";
import { originScopeSql,scopeKeys } from "./origin-guard";
import { DecisionJournal } from "./decisions";
import { bridgeHash } from "./ingress";
const count=z.number().int().nonnegative().safe();
export const dailySummarySchema=z.object({kind:z.literal("daily_shadow_summary"),reportingScope:z.literal("current_generation_cumulative"),snapshotAt:count,period:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 journal:z.record(z.string(),count),freshness:z.literal("metadata_unchecked"),gaps:count,pausedConversations:count,paused:z.boolean(),blockedFollowUps:count,
 budget:z.object({state:z.enum(["available","blocked","exhausted","unconfigured"]),periodCap:count.nullable(),committedMicroUsd:count,uncertainMicroUsd:count}).strict(),
 pipelineGaps:z.array(z.string()).max(16)}).strict();
export type DailySummary=z.infer<typeof dailySummarySchema>;
export type RoutineCycle={window:number;owner:string;until:number};
export class Routines {
 constructor(private db:D1Database,readonly scope:OriginScope,private clock=Date.now){}
 private sql(query:string,...values:(string|number|null)[]){return this.db.prepare(query).bind(...values);}
 async begin(paused:boolean):Promise<RoutineCycle|null>{
  const now=this.clock(),window=Math.floor(now/60000),owner=crypto.randomUUID(),until=now+840000,keys=scopeKeys(this.scope);
  await this.sql(`INSERT INTO assistant_routine_state(installation_id,generation,source_epoch,source_generation) VALUES(?,?,?,?) ON CONFLICT DO NOTHING`,...keys).run();
  const recovered=await this.sql(`SELECT state,lease_until,active_item_id FROM assistant_routine_state WHERE ${originScopeSql}`,...keys).first<{state:string;lease_until:number;active_item_id:string|null}>();
  if(recovered?.state==="uncertain"&&recovered.active_item_id||recovered?.state==="running"&&recovered.lease_until<=now&&recovered.active_item_id){
   await this.sql(`UPDATE assistant_routine_state SET state='uncertain',last_gap='previous_cycle_uncertain' WHERE ${originScopeSql} AND state='running' AND lease_until<=?`,...keys,now).run();return null;
  }
  const gate=`EXISTS(SELECT 1 FROM assistant_routine_state WHERE ${originScopeSql} AND owner_token=?)`,values=[...keys,owner];
  const result=await this.db.batch([
   this.sql(`UPDATE assistant_routine_state SET owner_token=?,lease_until=?,state='running',paused=?,last_run_at=?,last_gap=NULL WHERE ${originScopeSql}
    AND (state='idle' OR ((state='uncertain' OR (state='running' AND lease_until<=?)) AND active_item_id IS NULL)) AND NOT EXISTS(SELECT 1 FROM assistant_routine_cycles WHERE ${originScopeSql} AND window_key=?) RETURNING owner_token`,owner,until,paused?1:0,now,...keys,now,...keys,window),
   this.sql(`INSERT INTO assistant_routine_cycles SELECT ?,?,?,?,?,?,?,'running','capture',NULL,?,NULL,NULL WHERE ${gate} ON CONFLICT DO NOTHING`,...keys,window,owner,until,now,...values),
  ]);
  return result[0].results.length?{window,owner,until}:null;
 }
 async reconcileBegin(paused:boolean):Promise<RoutineCycle|null>{
  const now=this.clock(),window=Math.floor(now/60000),owner=crypto.randomUUID(),until=now+840000,keys=scopeKeys(this.scope);
  const result=await this.db.batch([
   this.sql(`UPDATE assistant_routine_state SET owner_token=?,lease_until=?,state='running',paused=?,last_run_at=? WHERE ${originScopeSql} AND state='uncertain' AND active_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM assistant_routine_cycles WHERE ${originScopeSql} AND window_key=?) RETURNING active_item_id`,owner,until,paused?1:0,now,...keys,...keys,window),
   this.sql(`INSERT INTO assistant_routine_cycles SELECT ?,?,?,?,?,?,?,'running','reconcile',active_item_id,?,NULL,NULL FROM assistant_routine_state WHERE ${originScopeSql} AND owner_token=? ON CONFLICT DO NOTHING`,...keys,window,owner,until,now,...keys,owner),
  ]);
  return result[0].results.length?{window,owner,until}:null;
 }
 async current(cycle:RoutineCycle){return !!await this.sql(`SELECT 1 FROM assistant_routine_state WHERE ${originScopeSql} AND owner_token=? AND state='running' AND lease_until>?`,...scopeKeys(this.scope),cycle.owner,this.clock()).first();}
 async phase(cycle:RoutineCycle,phase:string,item:string|null=null){
  const keys=scopeKeys(this.scope),result=await this.sql(`UPDATE assistant_routine_state SET active_item_id=? WHERE ${originScopeSql} AND owner_token=? AND state='running' AND lease_until>? RETURNING owner_token`,item,...keys,cycle.owner,this.clock()).all();
  if(!result.results.length)throw new Error("routine_stale");
  await this.sql(`UPDATE assistant_routine_cycles SET phase=?,active_item_id=? WHERE ${originScopeSql} AND window_key=? AND owner_token=?`,phase,item,...keys,cycle.window,cycle.owner).run();
 }
 async finish(cycle:RoutineCycle,gap:string|null=null,uncertain=false){
  const keys=scopeKeys(this.scope);
  await this.db.batch([
   this.sql(`UPDATE assistant_routine_state SET state=?,last_gap=?,active_item_id=CASE WHEN ?=1 THEN active_item_id ELSE NULL END WHERE ${originScopeSql} AND owner_token=?`,uncertain?"uncertain":"idle",gap,uncertain?1:0,...keys,cycle.owner),
   this.sql(`UPDATE assistant_routine_cycles SET state=?,last_gap=?,finished_at=? WHERE ${originScopeSql} AND window_key=? AND owner_token=?`,uncertain?"uncertain":"completed",gap,this.clock(),...keys,cycle.window,cycle.owner),
  ]);
 }
 async daily(paused:boolean){
  const period=new Date(this.clock()).toISOString().slice(0,10),keys=scopeKeys(this.scope),prior=await this.sql(`SELECT id,payload_hash,payload_json FROM assistant_routine_reviews WHERE ${originScopeSql} AND period=?`,...keys,period).first<{id:string;payload_hash:string;payload_json:string}>();if(prior)return {id:prior.id,summary:dailySummarySchema.parse(JSON.parse(prior.payload_json))};
  const counts=await new DecisionJournal(this.db,this.scope,{kind:"owner"}).metadataCounts();
  const gaps=await this.sql(`SELECT COUNT(*) n FROM assistant_conversation_replay WHERE ${originScopeSql} AND state='gap'`,...keys).first<number>("n");
  const pausedChats=await this.sql(`SELECT COUNT(*) n FROM assistant_conversations WHERE ${originScopeSql} AND paused=1`,...keys).first<number>("n");
  const itemGaps=await this.sql(`SELECT COUNT(*) n FROM assistant_routine_items WHERE ${originScopeSql} AND state IN ('waiting_context','blocked','uncertain')`,...keys).first<number>("n");
  const fups=await this.sql(`SELECT COUNT(*) n FROM assistant_follow_ups f WHERE f.installation_id=? AND f.generation=? AND f.version=(SELECT MAX(v.version) FROM assistant_follow_ups v WHERE v.installation_id=f.installation_id AND v.generation=f.generation AND v.id=f.id) AND (f.state IN ('paused','awaiting_condition') OR (f.state='scheduled' AND EXISTS(SELECT 1 FROM assistant_routine_fup_results r WHERE r.installation_id=f.installation_id AND r.generation=f.generation AND r.follow_up_id=f.id AND r.follow_up_version=f.version AND r.state<>'admitted')))`,this.scope.installationId,this.scope.generation).first<number>("n");
  const account=await this.sql(`SELECT cap_units,EXISTS(SELECT 1 FROM assistant_budget_accounts b WHERE b.installation_id=a.installation_id AND b.generation=a.generation AND b.blocked=1) blocked FROM assistant_budget_accounts a WHERE installation_id=? AND generation=? AND period=?`,this.scope.installationId,this.scope.generation,period).first<{cap_units:number;blocked:number}>();
  const budget=await this.sql(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual_units ELSE ceiling_units END),0) committed,COALESCE(SUM(CASE WHEN state='uncertain' THEN ceiling_units ELSE 0 END),0) uncertain FROM assistant_budget_reservations WHERE installation_id=? AND generation=?`,this.scope.installationId,this.scope.generation).first<{committed:number;uncertain:number}>();
  const periodSpend=await this.sql(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual_units ELSE ceiling_units END),0) n FROM assistant_budget_reservations WHERE installation_id=? AND generation=? AND period=?`,this.scope.installationId,this.scope.generation,period).first<number>("n");
  const summary=dailySummarySchema.parse({kind:"daily_shadow_summary",reportingScope:"current_generation_cumulative",snapshotAt:this.clock(),period,journal:counts,freshness:"metadata_unchecked",gaps:(gaps??0)+(itemGaps??0),pausedConversations:pausedChats??0,paused,blockedFollowUps:fups??0,budget:{state:!account?"unconfigured":account.blocked?"blocked":(periodSpend??0)>=account.cap_units?"exhausted":"available",periodCap:account?.cap_units??null,committedMicroUsd:budget?.committed??0,uncertainMicroUsd:budget?.uncertain??0},pipelineGaps:["canonical_relations_unpublished"]});
  const id=await bridgeHash(["daily-review-v1",...keys,period]),hash=await bridgeHash(summary);
  await this.sql(`INSERT INTO assistant_routine_reviews VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,...keys,period,id,hash,JSON.stringify(summary),this.clock()).run();
  const stored=await this.sql(`SELECT payload_json FROM assistant_routine_reviews WHERE ${originScopeSql} AND period=?`,...keys,period).first<string>("payload_json");return {id,summary:dailySummarySchema.parse(JSON.parse(stored!))};
 }
}
