import {OwnerControl} from '../../assistant/control';
import {SourceController} from '../../assistant/sources';
import {ownerControlDiagnostic} from '../../assistant/control-errors';
import {fupInstant} from '../../assistant/followups';

/** Operator-only proof for an existing isolated Cloudflare test Worker/D1.
 * No provider, Telegram, capture or execution capability is supplied. */
export async function runFupControlProbe(db:D1Database,run:string){
 if(!/^[a-f0-9-]{36}$/.test(run))throw Error('synthetic_run_invalid');
 const scope={installationId:'synthetic-fup-proof',generation:run,sourceEpoch:'synthetic',sourceGeneration:'synthetic'};
 const control=new OwnerControl(db,scope,{kind:'owner'}),sources=new SourceController(db,scope,{kind:'owner'});
 const source=await sources.execute({kind:'source.create',operationId:'note',input:{originKey:'note',text:'Synthetic owner instruction: record a private review, never send.',occurredAt:1}});
 const results=[];
 for(const [id,dueAt,kind]of [['tutor','2026-11-03T10:00:00-03:00','private'],['curso','2026-11-05T10:00:00-03:00','group']] as const){
  await control.execute({kind:'project.put',operationId:'project-'+id,id:'project-'+id,expectedVersion:0,name:'Synthetic '+id});
  const command={kind:'fup.put',operationId:'fup-'+id,id:'fup-'+id,expectedVersion:0,conversationId:'chat-'+id,policyRevision:0,source:{id:source.id,revision:1},project:{id:'project-'+id,revision:1},purpose:'Synthetic private review; never send.',dueAt,timezone:'America/Fortaleza',precision:'exact',state:'awaiting_approval'};
  let diagnostic;try{await control.execute(command);}catch(error){diagnostic=ownerControlDiagnostic(error);}
  if(diagnostic?.error!=='control_policy_required')throw Error('synthetic_expected_policy_rejection');
  const prior=await db.prepare('SELECT COUNT(*) n FROM assistant_follow_ups WHERE installation_id=? AND generation=? AND id=?').bind(scope.installationId,run,command.id).first('n');
  if(prior!==0)throw Error('synthetic_unexpected_write');
  await control.execute({kind:'policy.put',operationId:'policy-'+id,id:command.conversationId,expectedRevision:0,conversationKind:kind,groupMode:kind==='group'?'observe':'ignore'});
  const valid={...command,policyRevision:1},receipt=await control.execute(valid),replayed=await control.execute(valid);
  if(JSON.stringify(receipt)!==JSON.stringify(replayed))throw Error('synthetic_replay_mismatch');
  const rows=await db.prepare('SELECT state,due_at,timezone FROM assistant_follow_ups WHERE installation_id=? AND generation=? AND id=?').bind(scope.installationId,run,command.id).all<{state:string;due_at:number;timezone:string}>();
  if(rows.results.length!==1||rows.results[0].state!=='awaiting_approval'||rows.results[0].due_at!==fupInstant(dueAt,command.timezone))throw Error('synthetic_persistence_mismatch');
  results.push({case:id,diagnostic,receipt,rows:rows.results.length,state:rows.results[0].state,dueAtUTC:new Date(rows.results[0].due_at).toISOString(),replaySameReceipt:true});
  await control.execute({kind:'fup.pause',operationId:'pause-'+id,id:command.id,expectedVersion:1});
 }
 const jobs=await db.prepare('SELECT COUNT(*) n FROM assistant_jobs WHERE installation_id=? AND generation=?').bind(scope.installationId,run).first('n');
 if(jobs!==0)throw Error('synthetic_unexpected_work');
 return {state:'passed',run,results,jobs:0,paidModelCalls:0,externalAttempted:false,productionDataChanged:false,finalState:'paused'};
}
