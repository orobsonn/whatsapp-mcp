/** Disposable CF -> authenticated VPS -> native Cognee proof. Synthetic only.
 * No model calls, personal sources, Telegram or WhatsApp credentials. */
import {KnowledgeService} from '../../assistant/knowledge/service';
import {HttpKnowledgePort} from '../../assistant/knowledge/http-port';
import type {KnowledgeContext,KnowledgeCommand,VerifiedKnowledgeClaim} from '../../assistant/knowledge/contracts';
type Ref={id:string;revision:number;version:number;hash:string};
export async function runKnowledgeServiceProof(db:D1Database,token:string){
 const run=crypto.randomUUID(),predicate='synthetic-leads-'+run;
 const context:KnowledgeContext={scope:{installationId:'synthetic-cf-knowledge',generation:'proof-'+run,sourceEpoch:'synthetic-e1',sourceGeneration:'synthetic-sg1'},client:'owner_mcp'};
 const config={endpoint:'https://assistente-memoria.robsonlins.com/knowledge',token,
  namespace:{installationId:context.scope.installationId,generation:'knowledge-v1'},operationalGeneration:context.scope.generation,client:context.client};
 const service=()=>new KnowledgeService(db,()=>context,new HttpKnowledgePort(config));
 const text='Synthetic Nora leads synthetic Cedar.';
 // A retired source origin remains retired across operational generations.
 // Each independent synthetic run supplies genuinely new report operations.
 async function report(id:string){const result=await service().execute({kind:'context.report',operationId:run+':'+id,text});
  if(result.state!=='recorded')throw Error('synthetic_report_failed');return result.sourceRef as Ref;}
 const a=await report('a'),b=await report('b'),c=await report('c');
 const first:KnowledgeCommand={kind:'remember',operationId:'joint',entities:[{key:'nora',kind:'person',name:'Synthetic Nora '+run},{key:'cedar',kind:'project',name:'Synthetic Cedar '+run}],
  relations:[{subjectId:'nora',predicate,objectId:'cedar',classification:'reported',evidence:[{sourceRef:a,quote:text},{sourceRef:b,quote:text}]}]};
 const joint=await service().execute(first);
 const query=async()=>await service().execute({kind:'query',predicate}) as {claims:VerifiedKnowledgeClaim[]};
 const initial=await query(),one=initial.claims[0];
 if(!one)throw Error('synthetic_native_claim_missing');
 const alternative=await service().execute({kind:'remember',operationId:'independent',entities:[{key:'nora',ref:one.subject.id},{key:'cedar',ref:one.object.id}],
  relations:[{subjectId:'nora',predicate,objectId:'cedar',classification:'reported',evidence:[{sourceRef:c,quote:text}]}]});
 const two=await query();
 const withdrawn=await service().execute({kind:'withdraw',operationId:'remove-a',sourceRef:a});
 const afterWithdrawal=await query();
 const revised=await service().execute({kind:'context.correct',operationId:'correct-c',sourceId:c.id,expectedRevision:c.revision,text:'Synthetic Cedar has a new lead.'});
 const afterCorrection=await query();
 const replay=await service().execute({kind:'status',operationId:'correct-c'});
 const otherRuntime=new HttpKnowledgePort({...config,operationalGeneration:'other-'+context.scope.generation});
 const separateReceipt=await otherRuntime.status('joint');
 let wrongNamespaceDenied=false;
 try{await new HttpKnowledgePort({...config,namespace:{...config.namespace,generation:'wrong-space'}}).query({limit:20});}
 catch{wrongNamespaceDenied=true;}
 return {run,paidModelCalls:0,checks:{jointStored:joint.state==='ready',separateRequestRecall:initial.claims.length===1&&one.supportGroups[0].evidence.length===2,
  independentStored:alternative.state==='ready',twoAlternativeGroups:two.claims[0]?.supportGroups.length===2,
  sourceWithdrawalConfirmed:withdrawn.state==='source_withdrawn'&&withdrawn.cleanup?.state==='ready',
  onlyIndependentGroupSurvives:afterWithdrawal.claims.length===1&&afterWithdrawal.claims[0].supportGroups.length===1&&afterWithdrawal.claims[0].evidence.every(e=>e.sourceRef.id===c.id),
  sourceCorrectionConfirmed:revised.state==='source_corrected'&&revised.cleanup?.state==='ready',
  lastSupportGone:afterCorrection.claims.length===0,correctionReceiptRecovered:replay.state==='source_corrected',
  runtimeReceiptsIsolated:separateReceipt.state==='not_found',wrongNamespaceDenied}};
}
