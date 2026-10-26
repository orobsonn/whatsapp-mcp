import { readFile,lstat,mkdtemp,open,rm } from "node:fs/promises";
import { resolve,dirname,join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes,createHash } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),commands={affinity:"installation.affinity",plan:"installation.retention_plan",bootstrap:"installation.retention_bootstrap"};
async function privateRead(path){const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>65536)throw Error("private_config");return JSON.parse(await readFile(path,"utf8"));}
async function privateCreate(path,body){const file=await open(path,"wx",0o600);try{await file.writeFile(body);await file.sync();}finally{await file.close();}}
export function operatorConfig(installed,port,token,expires){
 if(installed?.name!=="personal-assistant-shadow"||installed.account_id!=="ab9f6d8988145943bf8bbab313e45e6e"||installed.workers_dev!==false||installed.preview_urls!==false||installed.vars?.FLUE_EPISODES_ENABLED!=="shadow")throw Error("installation_owner_configuration");
 const vars={INSTALLATION_ID:installed.vars.INSTALLATION_ID,OPERATIONAL_GENERATION:installed.vars.OPERATIONAL_GENERATION};
 if(Object.values(vars).some(v=>typeof v!=="string"||!v||v.length>256||v.trim()!==v||/[\x00-\x1f\x7f]/.test(v))||!Number.isSafeInteger(port)||port<1024||port>65535||!/^[a-f0-9]{64}$/.test(token)||!Number.isSafeInteger(expires)||expires<=Date.now()||expires>Date.now()+900000)throw Error("installation_operator_parameters");
 return {name:"assistant-installation-operator-local",main:join(root,"assistant/installation-operator.ts"),account_id:installed.account_id,compatibility_date:"2026-10-26",compatibility_flags:["nodejs_compat"],workers_dev:false,preview_urls:false,observability:{enabled:false},services:[{binding:"OWNER",service:"personal-assistant-shadow",entrypoint:"OwnerAssistant",remote:true}],vars:{...vars,INSTALLATION_OPERATOR_PORT:String(port),INSTALLATION_OPERATOR_EXPIRES:String(expires)}};
}
// Local worker execution + remote:true SERVICE binding. --local disables that
// binding, while --remote uploads the operator; neither belongs in these argv.
export const operatorArgv=(config,port)=>[join(root,"node_modules/wrangler/bin/wrangler.js"),"dev","--config",config,"--ip","127.0.0.1","--port",String(port),"--show-interactive-dev-session","false"];
async function freePort(){const server=createServer();await new Promise((done,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",done);});const port=server.address().port;await new Promise(done=>server.close(done));return port;}
export async function main(args=process.argv.slice(2)){
 if(!args.length||args.includes("--help")){console.log("Private installation operator: affinity|plan|bootstrap --installedconfig PRIVATE_CONFIG --output NEW_PRIVATE_FILE. One fixed remote OwnerAssistant service via local loopback, fresh token <=15min. No deploy or automatic retry; result bodies stay in the private output.");return;}
 const [action,...rest]=args,options={};if(!Object.hasOwn(commands,action))throw Error("installation_command");
 for(let i=0;i<rest.length;i+=2){const key=rest[i],value=rest[i+1];if(!["--installedconfig","--output"].includes(key)||!value||key in options)throw Error("installation_arguments");options[key]=value;}
 if(Object.keys(options).length!==2)throw Error("installation_arguments");const installed=await privateRead(options["--installedconfig"]),directory=await mkdtemp(join(tmpdir(),"assistant-installation-operator-"));let child,interrupt,output;
 try{
  const destination=resolve(options["--output"]),parent=await lstat(dirname(destination));if(!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077)throw Error("private_output_directory");output=await open(destination,"wx",0o600);
  const token=randomBytes(32).toString("hex"),port=await freePort(),expires=Date.now()+900000,config=operatorConfig(installed,port,token,expires);
  await privateCreate(join(directory,"wrangler.json"),JSON.stringify(config));await privateCreate(join(directory,".dev.vars"),"INSTALLATION_OPERATOR_TOKEN="+token+"\n");
  child=spawn(process.execPath,operatorArgv(join(directory,"wrangler.json"),port),{cwd:root,stdio:["ignore","pipe","pipe"],env:{...process.env,WRANGLER_SEND_METRICS:"false"}});
  const controller=new AbortController();interrupt=()=>{controller.abort();child?.kill("SIGTERM");};process.once("SIGINT",interrupt);process.once("SIGTERM",interrupt);
  let logs="",ready=false,failed=false;const capture=part=>{logs=(logs+part.toString()).slice(-32768);if(logs.includes("127.0.0.1:"+port))ready=true;};child.stdout.on("data",capture);child.stderr.on("data",capture);child.once("error",()=>{failed=true;});child.once("exit",()=>{failed=true;});
  const startup=Date.now()+45000;while(!ready&&!failed&&!controller.signal.aborted&&Date.now()<startup)await new Promise(done=>setTimeout(done,50));if(!ready||failed||expires<=Date.now())throw Error("installation_operator_start_failed");
  let result;
  try{const response=await fetch("http://127.0.0.1:"+port+"/command",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify(commands[action]),redirect:"error",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(40000)])});const reader=response.body?.getReader();if(!reader)throw Error("response");let size=0,text="";const decoder=new TextDecoder("utf-8",{fatal:true});try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>2097152)throw Error("response_limit");text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}result={command:commands[action],status:response.status,result:JSON.parse(text)};}
  catch{result={command:commands[action],state:"uncertain",reason:"inspect_same_installation_and_configured_seal_before_repeating"};}
  // Save the exact RPC result so affinity feeds the existing pin-affinity CLI.
  const bytes=JSON.stringify(result.result??result)+"\n";await output.writeFile(bytes);await output.sync();console.log(JSON.stringify({state:"private_result_saved",sha256:createHash("sha256").update(bytes).digest("hex")}));if(result.state==="uncertain"||result.status!==200)process.exitCode=1;
 }finally{await output?.close();if(interrupt){process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",interrupt);}if(child&&child.exitCode===null){if(!child.killed)child.kill("SIGTERM");await Promise.race([new Promise(done=>child.once("exit",done)),new Promise(done=>setTimeout(done,1000))]);if(child.exitCode===null)child.kill("SIGKILL");}await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error("Installation operator stopped. Preserve the private output and inspect the same installation/seal; no automatic retry, activation, secret rotation or budget reset.");process.exitCode=1;});
