import {setProvider,type FlueExecutionContext} from '@flue/runtime';
import {getCloudflareContext,getDurableObjectIdentity} from '@flue/runtime/cloudflare';
import type {Provider} from '@earendil-works/pi-ai/models';
import {createConversationProvider} from './conversation-provider';
import {configureConversationResolver} from './conversation-profiles';
import {NativeApplicationHost} from './native-host';
import type {AssistantEnv} from '../env';
import {nativeModelCatalog,nativeModelSelection,type NativeModelProvider,type NativeModelApi} from './conversation-model';

/** Registration only. Host construction, keys and admission resolve inside the
 * actual DO operation; merely bundling the new profile activates nothing. */
export function installNativeConversations(context:()=>FlueExecutionContext|undefined){
 configureConversationResolver(async(raw,sessionId,delivery)=>new NativeApplicationHost(raw as AssistantEnv).resolve(sessionId,delivery,context()?.submissionId));
 for(const vendor of ['openai','deepseek'] as const){
 const {native:base,model}=nativeModelCatalog(vendor);
 function provider(vendor:NativeModelProvider){
  const identity=getDurableObjectIdentity(),operation=context(),{env:raw}=getCloudflareContext(),env=raw as AssistantEnv;
  const selected=nativeModelSelection(env);
  if(identity.className!=='FlueConversationRuntimeAgent'||operation?.agentName!=='conversation-runtime'||!operation.turnId||!env.DB||!selected.apiKey||selected.provider!==vendor)throw Error('native_model_operation_denied');
  const sessionId=identity.name,turnId=operation.turnId,host=new NativeApplicationHost(env);
  return createConversationProvider({db:env.DB,apiKey:selected.apiKey,provider:vendor,resolveHost:()=>host.modelHost(sessionId,turnId,operation.submissionId),fetch:globalThis.fetch.bind(globalThis)});
 }
 const installed:Provider<NativeModelApi>={id:base.id,name:base.name,baseUrl:base.baseUrl,auth:{apiKey:{name:'Host admission',resolve:async()=>({auth:{}})}},
  getModels:()=>[structuredClone(model)],stream:(requested,messages,options)=>provider(vendor).stream(requested,messages,options),
  streamSimple:(requested,messages,options)=>provider(vendor).streamSimple(requested,messages,options)};
 setProvider(installed);
 }
}
