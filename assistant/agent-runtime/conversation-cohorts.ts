import { usePersistentState, useResponseFinish, useResponseStart } from '@flue/runtime';

export type ConversationCohort={version:1;responseToken:string|null;taskRefs:readonly string[]};
const empty:ConversationCohort={version:1,responseToken:null,taskRefs:[]};
const metadataKey='conversationCohort';
function checked(state:ConversationCohort){
 if(state.version!==1||!(state.responseToken===null||typeof state.responseToken==='string'&&state.responseToken.length>0)||
  !Array.isArray(state.taskRefs)||state.taskRefs.some(ref=>typeof ref!=='string'||!ref)||new Set(state.taskRefs).size!==state.taskRefs.length)
  throw Error('conversation_cohort_state_denied');
 return state;
}
/** A native response marker, never an event, actor, destination or grant. */
export function startConversationCohort(state:ConversationCohort,responseToken:string):ConversationCohort{
 checked(state);if(!responseToken)throw Error('conversation_cohort_state_denied');
 return state.responseToken===responseToken?state:{version:1,responseToken,taskRefs:[]};
}
/** Call only after the current delivery was resolved and checked by the host. */
export function appendConsumedTask(state:ConversationCohort,taskRef:string):ConversationCohort{
 checked(state);if(!state.responseToken||!taskRef)throw Error('conversation_cohort_unobserved');
 return state.taskRefs.includes(taskRef)?state:{...state,taskRefs:[...state.taskRefs,taskRef]};
}
/** An older render retains its own cursor; a later join cannot retarget it. */
export function consumedTaskRefs(state:ConversationCohort,taskRef:string):readonly string[]{
 checked(state);const cursor=state.taskRefs.indexOf(taskRef);
 if(!state.responseToken||cursor<0)throw Error('conversation_cohort_unobserved');
 return Object.freeze(state.taskRefs.slice(0,cursor+1));
}
function metadataToken(metadata:Record<string,unknown>){
 const cohort=metadata[metadataKey];if(cohort===undefined)return undefined;
 if(!cohort||typeof cohort!=='object'||Array.isArray(cohort)||
  (cohort as Record<string,unknown>).version!==1||typeof (cohort as Record<string,unknown>).responseToken!=='string'||
  !(cohort as Record<string,unknown>).responseToken)throw Error('conversation_cohort_metadata_denied');
 return (cohort as {responseToken:string}).responseToken;
}

/** Observes public native seams only. State and metadata are model-invisible.
 * State writes commit with the native hook seam, so retry rolls both back or
 * resumes both. No queued event or mutable application task pointer is read. */
export function useConversationCohort(){
 const [state,setState]=usePersistentState<ConversationCohort>('conversation-consumed-cohort-v1',empty);
 // Local to this render. Old tool closures keep their observed cohort even
 // after a join or a different response updates the durable state.
 let observed=checked(state);
 function read(){
  // Functional updaters see the attempt buffer at call time. A deep-equal
  // update is a documented no-op, including inside synchronous observers.
  setState(previous=>{observed=checked(previous);return previous;});return observed;
 }
 useResponseStart(({metadata})=>{
  const token=metadataToken(metadata)??crypto.randomUUID();
  setState(previous=>observed=startConversationCohort(previous,token));
  return {[metadataKey]:{version:1,responseToken:token}};
 });
 useResponseFinish(({metadata})=>{
  const current=read();
  if(metadataToken(metadata)!==current.responseToken)throw Error('conversation_cohort_metadata_denied');
  return {[metadataKey]:{version:1,responseToken:current.responseToken,taskRefs:[...current.taskRefs]}};
 });
 return {
  observe(taskRef:string){setState(previous=>observed=appendConsumedTask(previous,taskRef));},
  refsFor(taskRef:string){
   if(!observed.taskRefs.includes(taskRef))read();
   return consumedTaskRefs(observed,taskRef);
  },
 };
}
