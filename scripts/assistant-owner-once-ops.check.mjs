import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {ownerOperatorConfig,ownerOperatorArgv,ownerOperatorExitCode,main} from "./assistant-owner-once-ops.mjs";
import {postOperatorCommand} from "./assistant-operator-local.mjs";
const token="1".repeat(64),installed={name:"personal-assistant-shadow",account_id:"ab9f6d8988145943bf8bbab313e45e6e",workers_dev:true,preview_urls:false,
 vars:{INSTALLATION_ID:"synthetic-install",OPERATIONAL_GENERATION:"g1",BRIDGE_SOURCE_EPOCH:"synthetic-e",BRIDGE_SOURCE_GENERATION:"g1",FLUE_EPISODES_ENABLED:"shadow",ROUTINES_ENABLED:"shadow",ROUTINES_PAUSED:"true",SEMANTIC_SEARCH_MODE:"required"}};
test("Owner operator is private loopback with one pinned remote service and no resource or credential copy",()=>{
 const config=ownerOperatorConfig(installed,"synthetic-once",8978,token,Date.now()+10000),argv=ownerOperatorArgv("/private/config.json",8978);
 assert.equal(config.workers_dev,false);assert.equal(config.preview_urls,false);
 assert.deepEqual(config.services,[{binding:"OWNER",service:installed.name,entrypoint:"OwnerAssistant",remote:true}]);
 assert.equal(config.vars.OWNER_ONCE_OPERATION_ID,"synthetic-once");assert.equal(config.vars.BRIDGE_SOURCE_EPOCH,"synthetic-e");
 for(const key of ["durable_objects","d1_databases","r2_buckets","triggers"])assert.equal(config[key],undefined);
 assert.equal(config.vars.OPENAI_API_KEY,undefined);assert.equal(JSON.stringify(config).includes(token),false);
 assert.equal(argv.includes("--remote"),false);assert.equal(argv.includes("--local"),false);
 assert.deepEqual(argv.slice(-6),["--ip","127.0.0.1","--port","8978","--show-interactive-dev-session","false"]);
});
test("unsafe targets, active routines and malformed affinity cannot start a local Owner operator",()=>{
 for(const change of [{name:"elo"},{account_id:"foreign"},{preview_urls:true},{workers_dev:undefined},
  ...["FLUE_EPISODES_ENABLED","ROUTINES_ENABLED","ROUTINES_PAUSED","SEMANTIC_SEARCH_MODE","BRIDGE_SOURCE_EPOCH"].map(key=>({vars:{...installed.vars,[key]:""}}))])
  assert.throws(()=>ownerOperatorConfig({...installed,...change},"synthetic-once",8978,token,Date.now()+10000));
 for(const operation of ["","../operation","has space","x".repeat(129)])assert.throws(()=>ownerOperatorConfig(installed,operation,8978,token,Date.now()+10000));
 assert.throws(()=>ownerOperatorConfig(installed,"same",8978,token,Date.now()+901000));
});
test("CLI help is inert and unexpected destination flags are rejected before input files",async()=>{
 const previous=console.log;let printed="";console.log=value=>{printed+=value;};
 try{await main([]);assert.match(printed,/One RPC/);await assert.rejects(()=>main(["--url","https://foreign.invalid"]),/arguments/);}finally{console.log=previous;}
});
test("HTTP acceptance cannot mark blocked or uncertain Owner work as a successful operator step",()=>{
 for(const state of ["uncertain","blocked","unavailable"])assert.equal(ownerOperatorExitCode({status:200,result:{state}}),1);
 assert.equal(ownerOperatorExitCode({state:"uncertain"}),1);assert.equal(ownerOperatorExitCode({status:502,result:{state:"complete"}}),1);
 assert.equal(ownerOperatorExitCode({status:200,result:{state:"pending"}}),0);
});
async function pipe(handler,run){const server=createServer(handler);await new Promise((done,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",done);});
 try{await run(server.address().port);}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}}
test("long selected step requires explicit opt-in; real HTTP still sends one fixed nonbrowser POST",async()=>{
 let calls=0;
 await pipe((req,res)=>{calls++;assert.equal(req.url,"/command");assert.equal(req.method,"POST");assert.equal(req.headers.origin,undefined);assert.equal(req.headers["sec-fetch-mode"],undefined);res.end(JSON.stringify({state:"pending"}));},async port=>{
  await assert.rejects(()=>postOperatorCommand(port,token,{}, {timeoutMs:290000}),/parameters/);
  await assert.rejects(()=>postOperatorCommand(port,token,{}, {timeoutMs:300001,allowLongStep:true}),/parameters/);assert.equal(calls,0);
  assert.deepEqual(await postOperatorCommand(port,token,{kind:"owner_once.advance",operationId:"same"},{timeoutMs:290000,allowLongStep:true}),{status:200,ok:true,result:{state:"pending"}});assert.equal(calls,1);
 });
});
test("selected step timeout preserves uncertainty and never retries its dispatched request",async()=>{
 let calls=0;
 await pipe((_req,_res)=>{calls++;},async port=>{await assert.rejects(()=>postOperatorCommand(port,token,{}, {timeoutMs:50,allowLongStep:true}),/timeout_uncertain/);assert.equal(calls,1);});
});
