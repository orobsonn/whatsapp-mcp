/** Execute the already-built disposable probe locally. No build/deploy/network. */
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync,readdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {proveNativeSdkSeam} from './assistant-native-sdk-seam-cf.mjs';
const root=fileURLToPath(new URL('..',import.meta.url)),path=resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('Pass the built disposable probe wrangler.json');
const config=JSON.parse(readFileSync(path,'utf8')),folder=dirname(path),main=resolve(folder,config.main);
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(dir,entry.name)):[join(dir,entry.name)]);
const scratch=mkdtempSync(join(tmpdir(),'sdk-seam-local-'));let externalCalls=0;
const runtime=new Miniflare({...convertV4MiniflareOptions({workers:[{name:'sdk-seam-local',modulesRoot:folder,modules:[main,...files(folder).filter(p=>/\.m?js$/.test(p)&&p!==main)].map(path=>({type:'ESModule',path})),compatibilityDate:'2026-10-25',compatibilityFlags:['nodejs_compat'],bindings:{PROBE_BEARER:'synthetic-local-sdk-seam'},d1Databases:['DB'],durableObjects:Object.fromEntries(config.durable_objects.bindings.map(binding=>[binding.name,{className:binding.class_name,useSQLite:true}])),outboundService:()=>{externalCalls++;throw Error('external_forbidden');}}]}),resourcePersistencePath:scratch});
try{
 const db=await runtime.getD1Database('DB');
 for(const file of ['0008_inference_budget.sql','0036_conversation_sessions.sql','0037_native_model_receipts.sql']){
  const sql=readFileSync(join(root,'assistant/migrations',file),'utf8').replace(/^--.*$/gm,'');
  for(const statement of sql.split(';').filter(statement=>statement.trim()))await db.prepare(statement).run();
 }
 const restore=readFileSync(join(root,'assistant/migrations/0025_restore.sql'),'utf8');
 for(const table of ['assistant_retention_installation_gate','assistant_retention_runtime_hold','assistant_retention_active_generation']){
  const start=restore.indexOf('CREATE TABLE IF NOT EXISTS '+table+' ('),end=restore.indexOf('\n);',start);assert.ok(start>=0&&end>start);await db.prepare(restore.slice(start,end+3)).run();
 }
 const call=async body=>{const response=await runtime.dispatchFetch('https://synthetic.invalid/',{method:'POST',headers:{Authorization:'Bearer synthetic-local-sdk-seam','Content-Type':'application/json'},body:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;};
 const result=await proveNativeSdkSeam(call);assert.equal(externalCalls,0);
 console.log(JSON.stringify({state:result.state,externalCalls,paidModelCalls:0,proofs:result.proofs.map(p=>({mode:p.mode,run:p.run,sessionId:p.sessionId,oldOutcome:p.first.outcome,ownerOutcome:p.next.outcome,guardRejectedResolutions:p.guardRejectedResolutions,calls:p.inspect.calls,modelReceipts:p.inspect.modelReceipts,replayStable:p.replayStable}))},null,2));
}finally{await runtime.dispose();rmSync(scratch,{recursive:true,force:true});}
