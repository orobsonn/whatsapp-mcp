import { beforeEach, expect, it, vi } from 'vitest';
import type { ConversationCohort } from '../assistant/agent-runtime/conversation-cohorts';

// A callback-buffer fixture, not a claim about Flue persistence. The separate
// native controlled-provider test exercises these hooks on a real SQLite DO.
const hooks=vi.hoisted(()=>({state:undefined as unknown,
 starts:[] as ((ctx:{metadata:Record<string,unknown>})=>Record<string,unknown>|void)[],
 finishes:[] as ((ctx:{metadata:Record<string,unknown>})=>Record<string,unknown>|void)[]}));
vi.mock('@flue/runtime',()=>({
 usePersistentState:(_name:string,initial:unknown)=>[hooks.state??initial,(next:unknown)=>{
  hooks.state=typeof next==='function'?next(hooks.state??initial):next;
 }],
 useResponseStart:(run:typeof hooks.starts[number])=>hooks.starts.push(run),
 useResponseFinish:(run:typeof hooks.finishes[number])=>hooks.finishes.push(run),
}));
import { appendConsumedTask, consumedTaskRefs, startConversationCohort, useConversationCohort } from '../assistant/agent-runtime/conversation-cohorts';
beforeEach(()=>{hooks.state=undefined;hooks.starts=[];hooks.finishes=[];});
function render(){hooks.starts=[];hooks.finishes=[];const cohort=useConversationCohort();return {cohort,start:hooks.starts[0],finish:hooks.finishes[0]};}
const empty:ConversationCohort={version:1,responseToken:null,taskRefs:[]};

it('records only consumed cursors in order, deduplicates retry, and freezes prior cursor snapshots',()=>{
 expect(()=>appendConsumedTask(empty,'A')).toThrow('conversation_cohort_unobserved');
 const a=appendConsumedTask(startConversationCohort(empty,'response-1'),'A'),refs=consumedTaskRefs(a,'A');
 expect(()=>consumedTaskRefs(a,'B-pending')).toThrow('conversation_cohort_unobserved');
 const ab=appendConsumedTask(a,'B');expect(consumedTaskRefs(ab,'B')).toEqual(['A','B']);
 expect(consumedTaskRefs(ab,'A')).toEqual(['A']);expect(refs).toEqual(['A']);expect(Object.isFrozen(refs)).toBe(true);
 expect(appendConsumedTask(ab,'A')).toBe(ab);expect(startConversationCohort(ab,'response-1')).toBe(ab);
 expect(startConversationCohort(ab,'response-2').taskRefs).toEqual([]);
});
it('uses the metadata marker across a reconstructed render, includes joins, and starts a clean next response',()=>{
 const first=render(),metadata=first.start({metadata:{}})!;
 first.cohort.observe('A');expect(first.cohort.refsFor('A')).toEqual(['A']);
 const retry=render();expect(retry.start({metadata})).toEqual(metadata);
 retry.cohort.observe('A');expect(retry.cohort.refsFor('A')).toEqual(['A']);
 const joined=render();joined.cohort.observe('B');
 expect(joined.cohort.refsFor('B')).toEqual(['A','B']);expect(first.cohort.refsFor('A')).toEqual(['A']);
 expect(joined.finish({metadata})).toEqual({conversationCohort:{...(metadata.conversationCohort as object),taskRefs:['A','B']}});
 const next=render(),nextMetadata=next.start({metadata:{}})!;next.cohort.observe('C');
 expect(nextMetadata).not.toEqual(metadata);expect(next.cohort.refsFor('C')).toEqual(['C']);
 expect(()=>next.cohort.refsFor('B')).toThrow('conversation_cohort_unobserved');
 // A captured tool binding stays on its previous immutable cursor.
 expect(joined.cohort.refsFor('B')).toEqual(['A','B']);
});
it('fails closed when finish metadata belongs to another response or stored state is malformed',()=>{
 const current=render();current.start({metadata:{}});current.cohort.observe('A');
 expect(()=>current.finish({metadata:{conversationCohort:{version:1,responseToken:'another-response'}}})).toThrow('conversation_cohort_metadata_denied');
 expect(()=>startConversationCohort({...empty,taskRefs:['A','A']},'response')).toThrow('conversation_cohort_state_denied');
});
