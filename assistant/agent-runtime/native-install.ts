import {setProvider,type FlueExecutionContext} from '@flue/runtime';
import {getCloudflareContext,getDurableObjectIdentity} from '@flue/runtime/cloudflare';
import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import type {Provider} from '@earendil-works/pi-ai/models';
import {createConversationProvider} from './conversation-provider';
import {configureConversationResolver} from './conversation-profiles';
import {NativeApplicationHost} from './native-host';
import type {AssistantEnv} from '../env';

/** Registration only. Host construction, keys and admission resolve inside the
 * actual DO operation; merely bundling the new profile activates nothing. */
export function installNativeConversations(context:()=>FlueExecutionContext|undefined){
 configureConversationResolver(async(raw,sessionId,delivery)=>new NativeApplicationHost(raw as AssistantEnv).resolve(sessionId,delivery));
 const base=openaiProvider(),model=base.getModels().find(m=>m.id==='gpt-6-luna');if(!model)throw Error('native_model_catalog_missing');
 function provider(){
  const identity=getDurableObjectIdentity(),operation=context(),{env:raw}=getCloudflareContext(),env=raw as AssistantEnv;
  if(identity.className!=='FlueConversationRuntimeAgent'||operation?.agentName!=='conversation-runtime'||!operation.turnId||!env.DB||!env.OPENAI_API_KEY)throw Error('native_model_operation_denied');
  const sessionId=identity.name,turnId=operation.turnId,host=new NativeApplicationHost(env);
  return createConversationProvider({db:env.DB,apiKey:env.OPENAI_API_KEY,resolveHost:()=>host.modelHost(sessionId,turnId),fetch:globalThis.fetch.bind(globalThis)});
 }
 const installed:Provider<'openai-responses'>={id:base.id,name:base.name,baseUrl:base.baseUrl,auth:{apiKey:{name:'Host admission',resolve:async()=>({auth:{}})}},
  getModels:()=>[structuredClone(model)],stream:(requested,messages,options)=>provider().stream(requested,messages,options),
  streamSimple:(requested,messages,options)=>provider().streamSimple(requested,messages,options)};
 setProvider(installed);
}
