import {readFile,lstat,realpath,mkdtemp,open,rm} from "node:fs/promises";
import {resolve,dirname,join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {randomBytes,createHash} from "node:crypto";
import {createServer} from "node:net";
import {spawn} from "node:child_process";
import {onceCommand} from "../assistant/owner-once-contract.ts";
import {createOperatorLog,waitForOperator,postOperatorCommand} from "./assistant-operator-local.mjs";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
async function privateRead(path){const absolute=resolve(path),stat=await lstat(absolute);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>65536||await realpath(absolute)!==absolute)throw Error("private_input");return JSON.parse(await readFile(absolute,"utf8"));}
async function privateCreate(path,body){const f=await open(path,"wx",0o600);try{await f.writeFile(body);await f.sync();}finally{await f.close();}}
export function ownerOperatorConfig(installed,operationId,port,token,expires){
 if(installed?.name!=="personal-assistant-shadow"||installed.account_id!=="ab9f6d8988145943bf8bbab313e45e6e"||typeof installed.workers_dev!=="boolean"||installed.preview_urls!==false
   ||installed.vars?.FLUE_EPISODES_ENABLED!=="shadow"||installed.vars.ROUTINES_ENABLED!=="shadow"||installed.vars.ROUTINES_PAUSED!=="true"||installed.vars.SEMANTIC_SEARCH_MODE!=="required")throw Error("owner_operator_configuration");
 const vars=Object.fromEntries(["INSTALLATION_ID","OPERATIONAL_GENERATION","BRIDGE_SOURCE_EPOCH","BRIDGE_SOURCE_GENERATION"].map(key=>[key,installed.vars[key]]));
 if(Object.values(vars).some(v=>typeof v!=="string"||!v||v.length>256||v.trim()!==v||/[\x00-\x1f\x7f]/.test(v))||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)
   ||!Number.isSafeInteger(port)||port<1024||port>65535||!/^[a-f0-9]{64}$/.test(token)||!Number.isSafeInteger(expires)||expires<=Date.now()||expires>Date.now()+900000)throw Error("owner_operator_parameters");
 return {name:"assistant-owner-once-operator-local",main:join(root,"assistant/owner-once-operator.ts"),account_id:installed.account_id,compatibility_date:"2026-10-26",compatibility_flags:["nodejs_compat"],workers_dev:false,preview_urls:false,observability:{enabled:false},
   services:[{binding:"OWNER",service:installed.name,entrypoint:"OwnerAssistant",remote:true}],vars:{...vars,OWNER_ONCE_OPERATION_ID:operationId,OWNER_ONCE_OPERATOR_PORT:String(port),OWNER_ONCE_OPERATOR_EXPIRES:String(expires)}};
}
export const ownerOperatorArgv=(config,port)=>[join(root,"node_modules/wrangler/bin/wrangler.js"),"dev","--config",config,"--ip","127.0.0.1","--port",String(port),"--show-interactive-dev-session","false"];
export const ownerOperatorExitCode=result=>result.status===200&&["planned","admitted","pending","complete"].includes(result.result?.state)?0:1;
async function freePort(){const s=createServer();await new Promise((done,reject)=>{s.once("error",reject);s.listen(0,"127.0.0.1",done);});const port=s.address().port;await new Promise(done=>s.close(done));return port;}
export async function main(args=process.argv.slice(2)){
 if(!args.length||args.includes("--help")){console.log("Owner shadow operator: --installedconfig PRIVATE_CONFIG --request PRIVATE_COMMAND --output NEW_PRIVATE_FILE. One pinned operation via local loopback. One RPC; no automatic retry or deployment.");return;}
 const opts={};for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!["--installedconfig","--request","--output"].includes(key)||!value||key in opts)throw Error("owner_operator_arguments");opts[key]=value;}
 if(Object.keys(opts).length!==3)throw Error("owner_operator_arguments");
 const installed=await privateRead(opts["--installedconfig"]),command=onceCommand.parse(await privateRead(opts["--request"])),directory=await mkdtemp(join(await realpath(tmpdir()),"assistant-owner-once-"));
 let child,interrupt,output,log;
 try{
  const destination=resolve(opts["--output"]),parent=dirname(destination),stat=await lstat(parent);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077||await realpath(parent)!==parent)throw Error("private_output_directory");
  output=await open(destination,"wx",0o600);log=await createOperatorLog(destination+".worker.private.log");
  const token=randomBytes(32).toString("hex"),port=await freePort(),expires=Date.now()+900000,config=ownerOperatorConfig(installed,command.operationId,port,token,expires);
  await privateCreate(join(directory,"wrangler.json"),JSON.stringify(config));await privateCreate(join(directory,".dev.vars"),"OWNER_ONCE_OPERATOR_TOKEN="+token+"\n");
  child=spawn(process.execPath,ownerOperatorArgv(join(directory,"wrangler.json"),port),{cwd:root,stdio:["ignore","pipe","pipe"],env:{...process.env,WRANGLER_SEND_METRICS:"false"}});
  const controller=new AbortController();interrupt=()=>{controller.abort();child?.kill("SIGTERM");};process.once("SIGINT",interrupt);process.once("SIGTERM",interrupt);
  let failed=false;child.stdout.on("data",log.capture);child.stderr.on("data",log.capture);child.once("error",()=>{failed=true;});child.once("exit",()=>{failed=true;});
  if(!await waitForOperator(port,{signal:controller.signal,failed:()=>failed})||expires<=Date.now())throw Error("owner_operator_start_failed");
  let result;
  try{const response=await postOperatorCommand(port,token,command,{signal:controller.signal,maxResponseBytes:8192,timeoutMs:290000,allowLongStep:true});
    result={command:command.kind,operationId:command.operationId,status:response.status,result:response.result};}
  catch{result={command:command.kind,operationId:command.operationId,state:"uncertain",reason:"inspect_same_operation_before_advancing"};}
  const bytes=JSON.stringify(result)+"\n";await output.writeFile(bytes);await output.sync();console.log(JSON.stringify({state:"private_result_saved",sha256:createHash("sha256").update(bytes).digest("hex")}));
  process.exitCode=ownerOperatorExitCode(result);
 }finally{try{try{await output?.close();}finally{if(interrupt){process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",interrupt);}if(child&&child.exitCode===null){if(!child.killed)child.kill("SIGTERM");await Promise.race([new Promise(done=>child.once("exit",done)),new Promise(done=>setTimeout(done,1000))]);if(child.exitCode===null)child.kill("SIGKILL");}}}
  finally{try{await log?.close();}finally{await rm(directory,{recursive:true,force:true});}}}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error("Owner operator stopped. Preserve the private output and inspect the same operation. No automatic retry, new operation, budget reset or deployment.");process.exitCode=1;});
