import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
test('outgoing host DTO has no transitive action, sender, provider or archive runtime import',async()=>{
 const result=await build({entryPoints:['assistant/outgoing.ts'],bundle:true,platform:'browser',format:'esm',write:false,metafile:true,logLevel:'silent'});
 const local=Object.keys(result.metafile.inputs).filter(path=>!path.includes('node_modules/'));
 assert.deepEqual(local.sort(),['assistant/outgoing.ts','src/core.ts','src/send-envelope.ts'].sort());
});
