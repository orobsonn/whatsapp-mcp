import {SourceAccess,type AccessGuard,type SourceFence} from '../access';
import type {AssistantEnv} from '../env';
import {bridgeHash} from '../ingress';
import type {OriginScope} from '../origin-guard';
import {scopeKeys} from '../origin-guard';
import {telegramLinkGuard,type TelegramLinkFence} from '../telegram-auth';
import {calendarConfiguration} from '../connectors/calendar';
import {calendarOAuthName,oauthAffinity} from '../connectors/calendar-oauth';
import {calendarMutation,runCalendarAction} from '../connectors/calendar-actions';
import {ConnectorAccess,type ReadFetch} from '../connectors/read-only';
import type {TaskContext} from './conversation';
import * as v from 'valibot';

const owner={kind:'owner'} as const;
const together=(...guards:AccessGuard[]):AccessGuard=>({sql:guards.map(g=>`(${g.sql})`).join(' AND '),values:guards.flatMap(g=>g.values)});
const title=v.pipe(v.string(),v.minLength(1),v.maxLength(256)),instant=v.pipe(v.string(),v.minLength(1),v.maxLength(128));
export const nativeCalendarMutationInput=v.variant('verb',[
 v.strictObject({verb:v.literal('create'),summary:title,start:instant,end:instant}),
 v.strictObject({verb:v.literal('edit'),target:title,dayStart:instant,dayEnd:instant,changes:v.strictObject({summary:v.optional(title),start:v.optional(v.strictObject({dateTime:instant,timeZone:v.literal('America/Fortaleza')})),end:v.optional(v.strictObject({dateTime:instant,timeZone:v.literal('America/Fortaleza')}))})}),
 v.strictObject({verb:v.literal('delete'),target:title,dayStart:instant,dayEnd:instant}),
]);
export type NativeCalendarHost={db:D1Database;env:AssistantEnv;scope:OriginScope;getScope:()=>OriginScope;task:TaskContext;
 assertCurrent:()=>Promise<void>;authorityGuard:()=>Promise<AccessGuard>|AccessGuard;
 ownerFence:()=>Promise<TelegramLinkFence>;expose:(proof:{sources:SourceFence[];origins:[]})=>Promise<void>;request?:ReadFetch};

/** Owner-only capability. The model interprets the authenticated owner's
 * natural request, while the host fixes actor, calendar, canonical request,
 * credential and one-attempt custody. Archive/tool text cannot become owner
 * input. No WhatsApp participant or private curator gets this effect. */
export function createNativeCalendarCapability(host:NativeCalendarHost){
 const {env,task,db,scope}=host;
 const configured=[env.CALENDAR_OAUTH,env.CALENDAR_OAUTH_PERMISSION,env.CALENDAR_WRITE_CALENDAR,env.CALENDAR_OAUTH_CONFIGURATION_VERSION,env.CALENDAR_OAUTH_SECRET_EPOCH];
 function currentConfiguration(){
  if(JSON.stringify(scopeKeys(host.getScope()))!==JSON.stringify(scopeKeys(scope))||[env.CALENDAR_OAUTH,env.CALENDAR_OAUTH_PERMISSION,env.CALENDAR_WRITE_CALENDAR,env.CALENDAR_OAUTH_CONFIGURATION_VERSION,env.CALENDAR_OAUTH_SECRET_EPOCH].some((value,index)=>value!==configured[index]))throw Error('native_calendar_configuration_changed');
 }
 return {async change(raw:unknown){
  const mutation=calendarMutation.parse(raw);currentConfiguration();await host.assertCurrent();
  const last=task.cohort.at(-1),ref=last?.sourceRef;
  if(task.identity.channel!=='telegram'||task.returnChannel.channel!=='telegram'||!last||last.kind!=='incoming'||last.author.kind!=='owner'||!ref)throw Error('native_calendar_owner_required');
  const fence=await host.ownerFence();
  if(fence.userId!==task.ownerId||fence.userId!==last.author.id||fence.userId!==task.returnChannel.id)throw Error('native_calendar_owner_required');
  const event=await db.prepare(`SELECT e.event_json,h.owner_link_json,h.source_ref_json FROM assistant_native_conversation_events e
   JOIN assistant_native_host_events h ON h.conversation_id=e.conversation_id AND h.event_id=e.event_id AND h.event_revision=e.revision
   WHERE e.task_ref=? AND e.conversation_id=? AND e.sequence=? AND e.state<>'withdrawn'
   AND h.installation_id=? AND h.generation=?`).bind(last.taskRef,task.sessionId,last.sequence,scope.installationId,scope.generation).first<{event_json:string;owner_link_json:string|null;source_ref_json:string}>();
  if(!event||event.owner_link_json!==JSON.stringify(fence)||event.source_ref_json!==JSON.stringify(ref))throw Error('native_calendar_owner_required');
  const access=new SourceAccess(db,scope,Date.now,'knowledge'),input=await access.read(owner,ref.id,ref.revision);
  if(!input||input.fence.source.origin!=='owner_report'||input.fence.source.version!==ref.version||input.fence.source.hash!==ref.hash||input.text!==JSON.parse(event.event_json).body)throw Error('native_calendar_input_changed');
  if(!env.CALENDAR_OAUTH||env.CALENDAR_OAUTH_PERMISSION!=='write_owned'||!env.CALENDAR_WRITE_CALENDAR)return {state:'pending_configuration',dependency:'calendar_write_owned'};
  const calendar=calendarConfiguration.parse(JSON.parse(env.CALENDAR_WRITE_CALENDAR));
  if(calendar.calendarId!=='primary')throw Error('native_calendar_configuration');
  const connectors=new ConnectorAccess(db,scope),grant=await connectors.admit(owner,calendar);
  if(!grant)throw Error('native_calendar_grant_denied');
  const normalizedGrant=await access.read(owner,grant.source.id,grant.source.revision);
  if(!normalizedGrant||normalizedGrant.fence.source.version!==grant.source.version||normalizedGrant.fence.source.hash!==grant.source.hash)throw Error('native_calendar_grant_denied');
  await host.expose({sources:[input.fence,normalizedGrant.fence],origins:[]});
  const authority=await host.authorityGuard(),link=telegramLinkGuard(fence),grantAccess=new SourceAccess(db,scope);
  const guard=together(authority,link,access.guard(owner,input.fence,Date.now()),grantAccess.guard(owner,grant,Date.now()),{
   sql:`EXISTS(SELECT 1 FROM assistant_projects WHERE installation_id=? AND generation=? AND id=?)
    AND EXISTS(SELECT 1 FROM assistant_native_host_events h JOIN assistant_native_conversation_events e
     ON e.conversation_id=h.conversation_id AND e.event_id=h.event_id AND e.revision=h.event_revision
     WHERE h.conversation_id=? AND h.event_id=? AND h.event_revision=? AND h.owner_link_json=? AND h.source_ref_json=?
     AND e.task_ref=? AND e.state<>'withdrawn' AND e.sequence=(SELECT MAX(sequence) FROM assistant_native_conversation_events WHERE conversation_id=e.conversation_id))`,
   values:[scope.installationId,scope.generation,grant.source.projectId,task.sessionId,last.eventId,last.revision,JSON.stringify(fence),JSON.stringify(ref),last.taskRef]});
  async function check(){currentConfiguration();await host.assertCurrent();currentConfiguration();if(!await db.prepare(`SELECT 1 WHERE ${guard.sql}`).bind(...guard.values).first())throw Error('native_calendar_authority_changed');}
  await check();
  const affinity=oauthAffinity.parse({installationId:scope.installationId,generation:scope.generation,configurationVersion:Number(env.CALENDAR_OAUTH_CONFIGURATION_VERSION),secretEpoch:env.CALENDAR_OAUTH_SECRET_EPOCH});
  const token=await env.CALENDAR_OAUTH.get(env.CALENDAR_OAUTH.idFromName(calendarOAuthName(affinity,'write_owned'))).token(affinity,'write_owned');
  await check();if(token.state!=='ready'||token.expiresAt<=Date.now())throw Error('native_calendar_consent_unavailable');
  // Retry with the same interpreted mutation retains the exact action. A model
  // cannot defeat dedupe by changing an invented operation ID. Distinct single
  // events requested together remain distinct legitimate mutations.
  const id=await bridgeHash(['native-calendar-action-v1',scope,task.contextRef,mutation]);
  const result=await runCalendarAction(db,scope,mutation,{id,requestId:ref.id,authorityId:grant.source.id,
   affinity:{...affinity,permission:'write_owned',calendar},guard:()=>{currentConfiguration();return guard;},token:token.accessToken,
   request:async request=>{await check();return (host.request??globalThis.fetch.bind(globalThis))(request);}});
  await check();return {actionId:id,...result.outcome};
 }};
}
