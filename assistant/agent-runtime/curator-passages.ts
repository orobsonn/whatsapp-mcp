import type {AccessGuard} from '../access';
import type {OriginScope} from '../origin-guard';
export type CuratorPassage={installation_id:string;generation:string;run_id:string;revision:number;conversation_id:string;after_sequence:number;through_sequence:number;resume_request_hash:string|null;state:'prepared'|'yielded'|'finished';created_at:number};
/** Host tickets, not model cursors. A yielded page becomes dispatchable only
 * after its exact native SDK receipt has settled successfully. */
export class CuratorPassages{
 constructor(private db:D1Database,private scope:OriginScope,private authority:()=>Promise<AccessGuard>|AccessGuard){}
 private keys(){return [this.scope.installationId,this.scope.generation];}
 async latest(runId:string){return this.db.prepare('SELECT * FROM assistant_curator_passages WHERE installation_id=? AND generation=? AND run_id=? ORDER BY revision DESC LIMIT 1').bind(...this.keys(),runId).first<CuratorPassage>();}
 async ticket(runId:string,revision:number){return this.db.prepare('SELECT * FROM assistant_curator_passages WHERE installation_id=? AND generation=? AND run_id=? AND revision=?').bind(...this.keys(),runId,revision).first<CuratorPassage>();}
 async reserve(runId:string,revision:number,sessionId:string,range:{after:number;through:number},predecessor:number|null,resumeHash:string|null){
  const guard=await this.authority();
  await this.db.prepare(`INSERT INTO assistant_curator_passages(installation_id,generation,run_id,revision,conversation_id,after_sequence,through_sequence,resume_request_hash,created_at)
   SELECT ?,?,?,?,?,?,?,?,? WHERE (${guard.sql}) AND EXISTS(SELECT 1 FROM assistant_curator_runs WHERE installation_id=? AND generation=? AND id=? AND source_epoch=? AND source_generation=? AND native_session_id=?)
   AND (SELECT MAX(revision) FROM assistant_curator_passages WHERE installation_id=? AND generation=? AND run_id=?) IS ? ON CONFLICT DO NOTHING`)
   .bind(...this.keys(),runId,revision,sessionId,range.after,range.through,resumeHash,Date.now(),...guard.values,...this.keys(),runId,this.scope.sourceEpoch,this.scope.sourceGeneration,sessionId,...this.keys(),runId,predecessor).run();
  const ticket=await this.ticket(runId,revision);if(!ticket||ticket.conversation_id!==sessionId||ticket.resume_request_hash!==resumeHash)throw Error('curator_passage_conflict');return ticket;
 }
 toolGuard(ticket:CuratorPassage):AccessGuard{return {sql:`EXISTS(SELECT 1 FROM assistant_curator_passages WHERE installation_id=? AND generation=? AND run_id=? AND revision=? AND conversation_id=? AND state='prepared') AND NOT EXISTS(SELECT 1 FROM assistant_curator_passages WHERE installation_id=? AND generation=? AND run_id=? AND revision>?)`,values:[...this.keys(),ticket.run_id,ticket.revision,ticket.conversation_id,...this.keys(),ticket.run_id,ticket.revision]};}
 async yield(ticket:CuratorPassage){
  const guard=await this.authority(),live=this.toolGuard(ticket);
  const row=await this.db.prepare(`UPDATE assistant_curator_passages SET state='yielded' WHERE installation_id=? AND generation=? AND run_id=? AND revision=? AND (${guard.sql}) AND (${live.sql})
   AND NOT EXISTS(SELECT 1 FROM assistant_curator_items WHERE installation_id=? AND generation=? AND run_id=? AND sequence>? AND sequence<=? AND state IN('pending','presented')) RETURNING revision`)
   .bind(...this.keys(),ticket.run_id,ticket.revision,...guard.values,...live.values,...this.keys(),ticket.run_id,ticket.after_sequence,ticket.through_sequence).first();
  if(!row)throw Error('curator_passage_pending');
 }
 async finish(ticket:CuratorPassage){const guard=await this.authority();await this.db.prepare(`UPDATE assistant_curator_passages SET state='finished' WHERE installation_id=? AND generation=? AND run_id=? AND revision=? AND state='prepared' AND (${guard.sql}) AND EXISTS(SELECT 1 FROM assistant_curator_runs WHERE installation_id=? AND generation=? AND id=? AND finished_at IS NOT NULL)`).bind(...this.keys(),ticket.run_id,ticket.revision,...guard.values,...this.keys(),ticket.run_id).run();}
}
