import {useTool} from '@flue/runtime';
import * as v from 'valibot';
import type {KnowledgeCurator} from './curator';
type Binding={curator:KnowledgeCurator;runId:string;finish?:(input:{needsHelp?:boolean},signal?:AbortSignal)=>Promise<unknown>};
const sequence=v.pipe(v.number(),v.integer(),v.minValue(1),v.safeInteger());
/** Only a host-authenticated private curator frame receives these tools.
 * Learning itself uses the SAME knowledge tools/service as every other client. */
export function useCuratorTools(resolve:()=>Promise<Binding>){
 useTool({name:'curator_next',description:'Read authorized original evidence in this pinned daily window. Follow nextAfter or acknowledge items then continue. Missing/pending is not full coverage.',input:v.strictObject({after:v.optional(v.pipe(v.number(),v.integer(),v.minValue(0),v.safeInteger())),limit:v.optional(v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(100)))}),async run({data,signal}){signal?.throwIfAborted();const b=await resolve();signal?.throwIfAborted();return {output:await b.curator.next(b.runId,data,signal)};}});
 useTool({name:'curator_acknowledge_page',description:'Record the originals you actually evaluated in ONE call for the page, instead of parallel individual confirmations. Each item returns recorded or refused; check refusals and do not claim complete coverage. learned/indexing require real shared knowledge operationIds carrying that exact evidence.',input:v.strictObject({items:v.pipe(v.array(v.strictObject({sequence,state:v.picklist(['evaluated','learned','indexing','unavailable']),operationIds:v.optional(v.pipe(v.array(v.pipe(v.string(),v.minLength(1),v.maxLength(256))),v.maxLength(100)))})),v.minLength(1),v.maxLength(100))}),async run({data,signal}){signal?.throwIfAborted();const b=await resolve();signal?.throwIfAborted();return {output:await b.curator.acknowledgePage(b.runId,data.items,signal)};}});
 useTool({name:'curator_finish',description:'Finish this passage with honest counts and explicit pending evidence. The host controls the private owner summary; this grants no sending to any conversation.',input:v.strictObject({needsHelp:v.optional(v.boolean())}),async run({data,signal}){signal?.throwIfAborted();const b=await resolve();signal?.throwIfAborted();return {output:JSON.stringify(await(b.finish?b.finish(data,signal):b.curator.finish(b.runId,data)))};}});
}
