import {setProvider} from '@flue/runtime';
import {getCloudflareContext,getDurableObjectIdentity} from '@flue/runtime/cloudflare';
import type {Provider} from '@earendil-works/pi-ai/models';
import {createConversationProvider} from './conversation';
import {configureConversationResolver} from '../agents/conversation';
import {NativeApplicationHost} from '../../agent-runtime/native-host';
import type {AssistantEnv} from '../../env';
import type {NativeExecutionContext} from '../../agent-runtime/install';
import {nativeModelCatalog,nativeModelSelection,NATIVE_OPENAI_MODELS,type NativeModelProvider,type NativeModelApi} from './model-selection';

/** Registration only. Host construction, keys and admission resolve inside the
 * actual DO operation; merely bundling the new profile activates nothing. */
export function installNativeConversations(context:()=>NativeExecutionContext|undefined){
 configureConversationResolver(async(raw,sessionId,delivery)=>new NativeApplicationHost(raw as AssistantEnv).resolve(sessionId,delivery,context()?.submissionId));
 for(const vendor of ['openai','deepseek'] as const){
 const {native:base}=nativeModelCatalog(vendor);
 const models=vendor==='openai'?NATIVE_OPENAI_MODELS.map(id=>nativeModelCatalog(vendor,id).model):[nativeModelCatalog(vendor).model];
 function provider(vendor:NativeModelProvider){
  const identity=getDurableObjectIdentity(),operation=context(),{env:raw}=getCloudflareContext(),env=raw as AssistantEnv;
  const selected=nativeModelSelection(env);
  if(identity.className!=='FlueConversationRuntimeAgent'||operation?.agentName!=='conversation-runtime'||!operation.turnId||!env.DB||!selected.apiKey||selected.provider!==vendor)throw Error('native_model_operation_denied');
  const sessionId=identity.name,turnId=operation.turnId,host=new NativeApplicationHost(env);
  return createConversationProvider({db:env.DB,apiKey:selected.apiKey,provider:vendor,openaiModel:selected.openaiModel,resolveHost:()=>host.modelHost(sessionId,turnId,operation.submissionId,operation.nativeModelPurpose),fetch:globalThis.fetch.bind(globalThis)});
 }
 const installed:Provider<NativeModelApi>={id:base.id,name:base.name,baseUrl:base.baseUrl,auth:{apiKey:{name:'Host admission',resolve:async()=>({auth:{}})}},
  getModels:()=>models.map(model=>structuredClone(model)),stream:(requested,messages,options)=>provider(vendor).stream(requested,messages,options),
  streamSimple:(requested,messages,options)=>provider(vendor).streamSimple(requested,messages,options)};
 setProvider(installed);
 }
}
