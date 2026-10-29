import type {AssistantEnv} from '../env';
import {activeOrigin,OriginGuard,type OriginScope} from '../origin-guard';
import {configuredRetirementGuard} from '../retention-authority';
import {assertRestoredGeneration} from '../retention-runtime';
import {KnowledgeService} from './service';
import {HttpKnowledgePort} from './http-port';
import type {KnowledgeCommand,KnowledgeContext} from './contracts';

/** The same host adapter serves owner MCP, native bots and daily curation.
 * Neither service location, credentials nor knowledge-space identity are tools. */
export function configuredKnowledge(env:AssistantEnv,expected:OriginScope,client:KnowledgeContext['client']){
 const db=env.DB,endpoint=env.KNOWLEDGE_SERVICE_URL,token=env.KNOWLEDGE_SERVICE_TOKEN,space=env.KNOWLEDGE_SPACE_GENERATION;
 if(!db||!endpoint||!token||!space)throw Error('knowledge_unconfigured');
 const reader=env.CAPTURE_READER,bridgeSecret=env.BRIDGE_SECRET;
 const current=()=>{
  const scope=activeOrigin(()=>({installationId:env.INSTALLATION_ID!,generation:env.OPERATIONAL_GENERATION!,
   sourceEpoch:env.BRIDGE_SOURCE_EPOCH!,sourceGeneration:env.BRIDGE_SOURCE_GENERATION!}));
  if(db!==env.DB||endpoint!==env.KNOWLEDGE_SERVICE_URL||token!==env.KNOWLEDGE_SERVICE_TOKEN||space!==env.KNOWLEDGE_SPACE_GENERATION||
   reader!==env.CAPTURE_READER||bridgeSecret!==env.BRIDGE_SECRET||Object.keys(expected).some(k=>scope[k as keyof OriginScope]!==expected[k as keyof OriginScope]))throw Error('knowledge_configuration_changed');
  return scope;
 };
 const scope=current(),port=new HttpKnowledgePort({endpoint,token,namespace:{installationId:scope.installationId,generation:space},
  operationalGeneration:scope.generation,client});
 // KnowledgeSourcePolicy owns group opt-in; this guard verifies source reads only.
 const origin=reader&&bridgeSecret?new OriginGuard(db,current,reader,bridgeSecret,2000,'owner_read'):undefined;
 const service=new KnowledgeService(db,()=>({scope:current(),client}),port,Date.now,configuredRetirementGuard(env),origin);
 return {async execute(command:KnowledgeCommand){
  current();await assertRestoredGeneration(env);current();
  const result=await service.execute(command);
  current();await assertRestoredGeneration(env);current();return result;
 }};
}
