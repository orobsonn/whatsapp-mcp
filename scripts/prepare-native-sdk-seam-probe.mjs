/** Prepare the existing disposable worker; never deploy or change bindings. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),folder=resolve(process.argv[2]??'');
if(!process.argv[2])throw Error('Pass the existing native-context-cf-probe folder');
const appPath=join(folder,'app.ts'),configPath=join(folder,'vite.config.mts');
let app=readFileSync(appPath,'utf8'),config=readFileSync(configPath,'utf8');
const marker='// sdk-seam-probe-v1';
if(app.includes(marker)){if(!config.includes('flueTurnEndSeam'))throw Error('probe_partial_wiring');console.log('SDK seam probe already prepared');process.exit(0);}
function one(text,before,after){if(text.split(before).length!==2)throw Error('probe_source_drift');return text.replace(before,after);}
app=`${marker}\nimport {findSeamRun,seamRuntime,seamConsumed,seamModelHost,seamResponsesFetch,seamProbeAction} from ${JSON.stringify(join(root,'tests/fixtures/assistant-native-sdk-seam-probe.ts'))};\n`+app;
app=one(app,` if(operation.type!=='model')return next();
 const {env}=getCloudflareContext(),identity=getDurableObjectIdentity();
 if(identity.className!=='FlueConversationRuntimeAgent'||!operation.turnId)throw Error('native_probe_model_instrument');
 return modelOperation.run(Object.freeze({env,sessionId:identity.name,turnId:operation.turnId}),next);`,
` const {env}=getCloudflareContext(),identity=getDurableObjectIdentity();
 if(identity.className!=='FlueConversationRuntimeAgent')return next();
 const defined=Object.fromEntries(Object.entries(ctx).filter(([,value])=>value!==undefined));
 return modelOperation.run(Object.freeze({...modelOperation.getStore(),...defined,env,sessionId:identity.name,...(operation.type==='model'?{turnId:operation.turnId}:{})}),next);`);
app=one(app,`async function registered(env,sessionId){`, `async function registered(env,sessionId){
 const seam=await findSeamRun(env.DB,sessionId);if(seam)return {seam,identity:JSON.parse(seam.identity_json),runtime:seamRuntime(env.DB,seam,open)};`);
app=one(app,` return {runtime:binding.runtime};`,` return {runtime:binding.runtime,...(binding.seam?{consumed:task=>seamConsumed(env.DB,binding.seam,task,modelOperation.getStore()?.submissionId)}:{})};`);
app=one(app,`return nativeProbeModelHost(op.env.DB,binding.run,binding.identity,op.sessionId,op.turnId,binding.retention);`,`return binding.seam?seamModelHost(op.env.DB,binding.seam,op):nativeProbeModelHost(op.env.DB,binding.run,binding.identity,op.sessionId,op.turnId,binding.retention);`);
app=one(app,`return nativeProbeResponsesFetch(op.env.DB,()=>({run:binding.run.run,sessionId:op.sessionId,turnId:op.turnId}))(url,options);`,`return binding.seam?seamResponsesFetch(op.env.DB,binding.seam,op)(url,options):nativeProbeResponsesFetch(op.env.DB,()=>({run:binding.run.run,sessionId:op.sessionId,turnId:op.turnId}))(url,options);`);
app=one(app,`  const body=await request.json();`,`  const body=await request.json();
  if(typeof body.action==='string'&&body.action.startsWith('sdk-seam-'))return Response.json(await seamProbeAction(env.DB,body,open));`);
app=one(app,`revision:'native-p2p5-protocol-r6'`,`revision:'native-sdk-seam-v1',seamPatch:'flue-2.3.0-error-aborted-turn-end'`);
config=`import {flueTurnEndSeam} from ${JSON.stringify(join(root,'assistant/build/flue-turn-end.ts'))};\n`+one(config,'plugins:[flue(','plugins:[flueTurnEndSeam(),flue(');
for(const [path,text] of [[appPath,app],[configPath,config]]){if(!existsSync(path+'.before-sdk-seam'))writeFileSync(path+'.before-sdk-seam',readFileSync(path));writeFileSync(path,text);}
console.log(JSON.stringify({prepared:true,folder,paidModelCalls:0,deploy:false}));
