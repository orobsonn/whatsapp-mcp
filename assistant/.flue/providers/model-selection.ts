import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {deepseekProvider} from '@earendil-works/pi-ai/providers/deepseek';
import type {Provider} from '@earendil-works/pi-ai/models';
import type {AssistantEnv} from '../../env';

export type NativeModelProvider='openai'|'deepseek';
export type NativeModelApi='openai-responses'|'openai-completions';
export const NATIVE_OPENAI_MODELS=['gpt-6-luna','gpt-6.1-sol'] as const;
export type NativeOpenAIModel=typeof NATIVE_OPENAI_MODELS[number];
/** Host configuration, never inferred from a prompt or tool output. Existing
 * installations retain their provider until explicitly migrated. */
export function nativeModelSelection(env:Pick<AssistantEnv,'NATIVE_MODEL_PROVIDER'|'NATIVE_OPENAI_MODEL'|'OPENAI_API_KEY'|'DEEPSEEK_API_KEY'>):{provider:NativeModelProvider;apiKey:string|undefined;model:string;openaiModel:NativeOpenAIModel;thinkingLevel:'high'|'low'}{
 const provider=env.NATIVE_MODEL_PROVIDER??'openai';
 if(provider!=='openai'&&provider!=='deepseek')throw Error('native_model_configuration_invalid');
 const openaiModel=env.NATIVE_OPENAI_MODEL??'gpt-6-luna';
 if(!NATIVE_OPENAI_MODELS.includes(openaiModel as NativeOpenAIModel))throw Error('native_model_configuration_invalid');
 const apiKey=provider==='deepseek'?env.DEEPSEEK_API_KEY:env.OPENAI_API_KEY;
 if(provider==='deepseek'&&!apiKey)throw Error('native_model_key_missing');
 return {provider,apiKey,openaiModel:openaiModel as NativeOpenAIModel,model:provider==='deepseek'?'deepseek/deepseek-flash':'openai/'+openaiModel,thinkingLevel:provider==='deepseek'?'high' as const:'low' as const};
}
export function nativeModelCatalog(provider:NativeModelProvider,openaiModel:NativeOpenAIModel='gpt-6-luna'){
 if(!NATIVE_OPENAI_MODELS.includes(openaiModel))throw Error('native_model_configuration_invalid');
 const native:Provider<NativeModelApi>=provider==='deepseek'?deepseekProvider():openaiProvider();
 const id=provider==='deepseek'?'deepseek-flash':openaiModel,model=native.getModels().find(m=>m.id===id);
 const baseUrl=provider==='deepseek'?'https://api.deepseek.com':'https://api.openai.com/v1';
 if(!model||model.baseUrl!==baseUrl||model.provider!==provider)throw Error('native_model_catalog_missing');
 // Keep the installed short-context window. Longer-context tiers require a
 // separate tariff change, including reservations and uncertainty custody.
 if(id==='gpt-6.1-sol'&&model.contextWindow>272000)throw Error('native_model_catalog_window_changed');
 return {native,model:structuredClone(model),endpoint:baseUrl+(provider==='deepseek'?'/chat/completions':'/responses'),
  priceVersion:provider==='deepseek'?'pi-ai-1.1.0-deepseek-v41-flash-1017-peak-input030-output120-v1':id==='gpt-6.1-sol'?'pi-ai-1.1.0-gpt-6.1-sol-upper-input250-output1000-long500-1500-v1':'pi-ai-1.1.0-gpt-6-luna-upper-input025-output075-v1',
  longContextPrice:id==='gpt-6.1-sol'?{inputTokensAbove:272000,inputMicroUSD:5,outputMicroUSD:15}:undefined,
  inputMicroUSD:provider==='deepseek'?.30:id==='gpt-6.1-sol'?2.5:.25,outputMicroUSD:provider==='deepseek'?1.20:id==='gpt-6.1-sol'?10:.75};
}
