// Shared local diagnostics only. No Cloudflare URLs, credentials or commands.
import {open,lstat,realpath} from "node:fs/promises";
import {dirname,resolve} from "node:path";
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
