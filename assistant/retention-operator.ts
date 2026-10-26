import { z } from "zod";
import { bridgeHash } from "./ingress";
import { snapshotCommand } from "./retention-snapshot";
import { restoreCommand } from "./retention-restore-contract";
import type { OwnerAssistantRPC, OwnerAffinity } from "./mcp";
const command = z.union([snapshotCommand, restoreCommand]);
export type RetentionOperatorEnv = {
 OWNER: Pick<OwnerAssistantRPC, "retention">; RETENTION_OPERATOR_TOKEN: string; RETENTION_OPERATOR_EXPIRES: string; RETENTION_OPERATOR_PORT: string;
 INSTALLATION_ID: string; OPERATIONAL_GENERATION: string; BRIDGE_SOURCE_EPOCH: string; BRIDGE_SOURCE_GENERATION: string;
};
async function bounded(request: Request) {
 const reader=request.body?.getReader();if(!reader)throw Error("body");let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>16777216)throw Error("limit");chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:true}).decode(bytes));
}
/** LOCAL ONLY. The generated Wrangler config binds loopback and one fixed named
 * owner service. There is no deployment config, browser route or model tool. */
export async function handleRetentionOperator(request: Request, env: RetentionOperatorEnv): Promise<Response> {
 const headers={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};const denied=()=>Response.json({state:"denied"},{status:403,headers});
 const url=new URL(request.url),expires=Number(env.RETENTION_OPERATOR_EXPIRES);
 if(request.method!=="POST"||url.protocol!=="http:"||url.hostname!=="127.0.0.1"||url.port!==env.RETENTION_OPERATOR_PORT||url.pathname!=="/command"||url.search||request.headers.has("Origin")||request.headers.has("Sec-Fetch-Mode")||!Number.isSafeInteger(expires)||expires<=Date.now()||expires>Date.now()+900000||!/^[a-f0-9]{64}$/.test(env.RETENTION_OPERATOR_TOKEN))return denied();
 const [actual,wanted]=await Promise.all([bridgeHash(request.headers.get("Authorization")??""),bridgeHash("Bearer "+env.RETENTION_OPERATOR_TOKEN)]);let diff=0;for(let i=0;i<64;i++)diff|=actual.charCodeAt(i)^wanted.charCodeAt(i);if(diff)return denied();
 let input:z.infer<typeof command>;try{input=command.parse(await bounded(request));}catch{return Response.json({state:"invalid_command"},{status:400,headers});}
 if(expires<=Date.now())return denied();
 const affinity:OwnerAffinity={installationId:env.INSTALLATION_ID,generation:env.OPERATIONAL_GENERATION,sourceEpoch:env.BRIDGE_SOURCE_EPOCH,sourceGeneration:env.BRIDGE_SOURCE_GENERATION};
 if(!env.OWNER?.retention)return Response.json({state:"unavailable"},{status:503,headers});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {
  const result=await Promise.race([env.OWNER.retention(affinity,input),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("uncertain")),35000);})]);
  const serialized=JSON.stringify(result);if(!serialized||new TextEncoder().encode(serialized).length>262144)throw Error("response_limit");
  return new Response(serialized,{headers:{...headers,"Content-Type":"application/json"}});
 }catch{return Response.json({state:"uncertain",operationId:input.operationId,reason:"lookup_same_operation_receipt_required"},{status:502,headers});}finally{clearTimeout(timer);}
}
export default {fetch:handleRetentionOperator};
