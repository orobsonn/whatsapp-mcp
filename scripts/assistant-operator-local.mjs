// Shared local diagnostics only. No Cloudflare URLs, credentials or commands.
import {open,lstat,realpath} from "node:fs/promises";
import {dirname,resolve} from "node:path";
import {request as httpRequest} from "node:http";
/** Node fetch adds Sec-Fetch-Mode:cors, which the operator correctly denies.
 * This fixed loopback transport sends neither browser headers nor arbitrary URLs.
 * A timeout after dispatch stays uncertain: one request, never an automatic retry. */
export async function postOperatorCommand(port,token,command,{signal,timeoutMs=40000,maxResponseBytes=2097152,allowLongStep=false}={}){
 if(typeof allowLongStep!=="boolean"||!Number.isSafeInteger(port)||port<1024||port>65535||typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>(allowLongStep?300000:40000)||!Number.isSafeInteger(maxResponseBytes)||maxResponseBytes<1||maxResponseBytes>2097152)throw Error("operator_transport_parameters");
 if(signal?.aborted)throw Error("operator_aborted");
 const encoded=JSON.stringify(command);if(typeof encoded!=="string")throw Error("operator_command_json");
 const body=Buffer.from(encoded);if(!body.length||body.length>16777216)throw Error("operator_command_limit");
 const deadline=Date.now()+timeoutMs;
 return new Promise((resolve,reject)=>{
  let request,response,timer,settled=false;
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",aborted);if(error){response?.destroy();request?.destroy();reject(Error(error));}else resolve(result);};
  const aborted=()=>finish("operator_aborted_uncertain");
  signal?.addEventListener("abort",aborted,{once:true});
  if(signal?.aborted){finish("operator_aborted");return;}
  timer=setTimeout(()=>finish("operator_timeout_uncertain"),timeoutMs);
  try{
   request=httpRequest({hostname:"127.0.0.1",family:4,port,path:"/command",method:"POST",agent:false,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","Content-Length":body.length}},incoming=>{
    response=incoming;if(settled){response.destroy();return;}
    if(Date.now()>=deadline){finish("operator_timeout_uncertain");return;}
    if(!Number.isInteger(response.statusCode)||response.statusCode<200||response.statusCode>=600){finish("operator_response_status");return;}
    if(response.statusCode>=300&&response.statusCode<400){finish("operator_redirect_denied_uncertain");return;}
    if(Number(response.headers["content-length"]??0)>maxResponseBytes){finish("operator_response_limit_uncertain");return;}
    const parts=[];let bytes=0;
    response.on("data",part=>{if(settled)return;bytes+=part.length;if(bytes>maxResponseBytes){finish("operator_response_limit_uncertain");return;}parts.push(part);});
    response.once("aborted",()=>finish("operator_response_aborted_uncertain"));response.once("error",()=>finish("operator_response_unknown"));
    response.once("end",()=>{
     if(settled)return;if(signal?.aborted||Date.now()>=deadline){finish("operator_timeout_uncertain");return;}
     try{const result=JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(Buffer.concat(parts)));finish(null,{status:response.statusCode,ok:response.statusCode>=200&&response.statusCode<300,result});}catch{finish("operator_response_invalid_uncertain");}
    });
   });
   request.once("error",()=>finish("operator_request_unknown"));
   if(signal?.aborted||Date.now()>=deadline){finish("operator_aborted_uncertain");return;}
   request.end(body);
  }catch{finish("operator_request_unknown");}
 });
}
export async function createOperatorLog(path){
 const parent=dirname(resolve(path)),info=await lstat(parent);
 if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||await realpath(parent)!==parent)throw Error("private_operator_log_directory");
 const file=await open(path,"wx",0o600);let tail=Buffer.alloc(0),closing;
 return {
  capture(chunk){if(closing)return;const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);tail=Buffer.concat([tail,bytes.subarray(Math.max(0,bytes.length-32768))]).subarray(-32768);},
  close(){return closing??=(async()=>{try{let offset=0;while(offset<tail.length){const {bytesWritten}=await file.write(tail,offset,tail.length-offset,offset);if(!bytesWritten)throw Error("operator_log_write");offset+=bytesWritten;}await file.truncate(tail.length);await file.sync();}finally{await file.close();}})();},
 };
}
/** GET is rejected by each local handler before auth or OWNER lookup. No token,
 * request body, redirect, model/Cloudflare route or mutating retry is involved. */
export async function localOperatorReady(port,signal){
 if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error("operator_port");
 let response;
 try{
  response=await fetch("http://127.0.0.1:"+port+"/command",{method:"GET",redirect:"error",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(500)]):AbortSignal.timeout(500)});
  if(response.status!==403||response.headers.get("Cache-Control")!=="no-store"||response.headers.get("X-Content-Type-Options")!=="nosniff")return false;
  const reader=response.body?.getReader();if(!reader)return false;let text="",size=0;const decoder=new TextDecoder();
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1024)return false;text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});}
  const value=JSON.parse(text);return value?.state==="denied"&&Object.keys(value).length===1;
 }catch{return false;}finally{await response?.body?.cancel().catch(()=>{});}
}
export async function waitForOperator(port,{signal,failed,deadline=Date.now()+45000}){
 while(!failed()&&!signal.aborted&&Date.now()<deadline){
  const remaining=deadline-Date.now();if(remaining<=0)break;
  if(await localOperatorReady(port,AbortSignal.any([signal,AbortSignal.timeout(remaining)])))return !failed()&&!signal.aborted&&Date.now()<deadline;
  await new Promise(done=>setTimeout(done,Math.max(1,Math.min(50,deadline-Date.now()))));
 }
 return false;
}
