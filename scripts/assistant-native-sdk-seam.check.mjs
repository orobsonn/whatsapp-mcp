import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {patchFlueTurnEnd,flueTurnEndSeam} from '../assistant/build/flue-turn-end.ts';
const original=readFileSync(new URL('../node_modules/@flue/runtime/dist/conversation-stream-store-CXrgv-b0.mjs',import.meta.url),'utf8');
test('failed or aborted native turns leave queued inputs for the next prompt; ordinary turns still join',async()=>{
 const patched=patchFlueTurnEnd(original,'2.3.0');
 assert.ok(patched!==original,'the pinned native turn_end must be patched');
 const target=patched.match(/if \(event\.message\.stopReason !== "error" && event\.message\.stopReason !== "aborted"\) await this\.applyQueuedJoins\(\);/g);
 assert.equal(target?.length,1);
 const clause=target[0],run=new Function('event',`return (async function(){${clause}}).call(this)`);
 for(const stopReason of ['stop','toolUse','length','error','aborted']){let joins=0;await run.call({async applyQueuedJoins(){joins++;}},{message:{stopReason}});assert.equal(joins,['error','aborted'].includes(stopReason)?0:1);}
});
test('unknown SDK version, source drift, missing or duplicate target fails closed',()=>{
 assert.throws(()=>patchFlueTurnEnd(original,'2.3.1'),/version/);
 assert.throws(()=>patchFlueTurnEnd(original+'\n','2.3.0'),/hash/);
 const target='\t\t\t\t\tawait this.applyQueuedJoins();\n\t\t\t\t\tthis.emit({\n\t\t\t\t\t\ttype: "turn_messages",';
 assert.throws(()=>patchFlueTurnEnd(original.replace(target,''),'2.3.0'),/target/);
 assert.throws(()=>patchFlueTurnEnd(original+target,'2.3.0'),/target/);
});

test('the server build requires exactly one pinned chunk; client and unrelated modules are untouched',()=>{
 const plugin=flueTurnEndSeam(),ctx={environment:{name:'worker'}};
 assert.equal(plugin.applyToEnvironment({config:{consumer:'client'}}),false);
 assert.equal(plugin.applyToEnvironment({config:{consumer:'server'}}),true);
 plugin.buildStart.call(ctx);
 assert.equal(plugin.transform.call(ctx,'unrelated','/src/ordinary.ts'),undefined);
 assert.throws(()=>plugin.generateBundle.call(ctx),/transform_count/);
 const path=new URL('../node_modules/@flue/runtime/dist/conversation-stream-store-CXrgv-b0.mjs',import.meta.url).pathname;
 const output=plugin.transform.call(ctx,original,path);assert.ok(output.code!==original);
 assert.doesNotThrow(()=>plugin.generateBundle.call(ctx));
 assert.throws(()=>plugin.transform.call(ctx,original,path),/transform_count/);
});
