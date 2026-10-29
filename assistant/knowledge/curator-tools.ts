import {useTool} from '@flue/runtime';
import * as v from 'valibot';
import type {KnowledgeCurator} from './curator';
type Binding={curator:KnowledgeCurator;runId:string};
const sequence=v.pipe(v.number(),v.integer(),v.minValue(1),v.safeInteger());
/** Only a host-authenticated private curator frame receives these tools.
 * Learning itself uses the SAME knowledge tools/service as every other client. */
export function useCuratorTools(resolve:()=>Promise<Binding>){
 useTool({name:'curator_next',description:'Read authorized original evidence in this pinned daily window. Follow nextAfter or acknowledge items then continue. Missing/pending is not full coverage.',input:v.strictObject({after:v.optional(v.pipe(v.number(),v.integer(),v.minValue(0),v.safeInteger())),limit:v.optional(v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(100)))}),async run({data}){const b=await resolve();return {output:await b.curator.next(b.runId,data)};}});
 useTool({name:'curator_acknowledge',description:'Record that you evaluated this original. learned/indexing require actual shared knowledge operationIds carrying its evidence; never label a proposal as learned.',input:v.strictObject({sequence,state:v.picklist(['evaluated','learned','indexing','unavailable']),operationIds:v.optional(v.array(v.pipe(v.string(),v.minLength(1),v.maxLength(256))))}),async run({data}){const b=await resolve();return {output:await b.curator.acknowledge(b.runId,data.sequence,{state:data.state,operationIds:data.operationIds})};}});
 useTool({name:'curator_finish',description:'Finish this passage with honest counts and explicit pending evidence. The host controls the private owner summary; this grants no sending to any conversation.',input:v.strictObject({needsHelp:v.optional(v.boolean())}),async run({data}){const b=await resolve();return {output:await b.curator.finish(b.runId,data)};}});
}
