import {openaiProvider} from '@earendil-works/pi-ai/providers/openai';
import {deepseekProvider} from '@earendil-works/pi-ai/providers/deepseek';
import type {Provider} from '@earendil-works/pi-ai/models';
import type {AssistantEnv} from '../env';

export type NativeModelProvider='openai'|'deepseek';
export type NativeModelApi='openai-responses'|'openai-completions';
/** Host configuration, never inferred from a prompt or tool output. Existing
 * installations retain their provider until explicitly migrated. */
export function nativeModelSelection(env:Pick<AssistantEnv,'NATIVE_MODEL_PROVIDER'|'OPENAI_API_KEY'|'DEEPSEEK_API_KEY'>):{provider:NativeModelProvider;apiKey:string|undefined;model:string;thinkingLevel:'high'|'low'}{
 const provider=env.NATIVE_MODEL_PROVIDER??'openai';
 if(provider!=='openai'&&provider!=='deepseek')throw Error('native_model_configuration_invalid');
 const apiKey=provider==='deepseek'?env.DEEPSEEK_API_KEY:env.OPENAI_API_KEY;
 if(provider==='deepseek'&&!apiKey)throw Error('native_model_key_missing');
 return {provider,apiKey,model:provider==='deepseek'?'deepseek/deepseek-flash':'openai/gpt-6-luna',thinkingLevel:provider==='deepseek'?'high' as const:'low' as const};
}
export function nativeModelCatalog(provider:NativeModelProvider){
 const native:Provider<NativeModelApi>=provider==='deepseek'?deepseekProvider():openaiProvider();
 const id=provider==='deepseek'?'deepseek-flash':'gpt-6-luna',model=native.getModels().find(m=>m.id===id);
 const baseUrl=provider==='deepseek'?'https://api.deepseek.com':'https://api.openai.com/v1';
 if(!model||model.baseUrl!==baseUrl||model.provider!==provider)throw Error('native_model_catalog_missing');
 return {native,model:structuredClone(model),endpoint:baseUrl+(provider==='deepseek'?'/chat/completions':'/responses'),
  priceVersion:provider==='deepseek'?'pi-ai-1.1.0-deepseek-v41-flash-1017-peak-input030-output120-v1':'pi-ai-1.1.0-gpt-6-luna-upper-input025-output075-v1',
  inputMicroUSD:provider==='deepseek'?.30:.25,outputMicroUSD:provider==='deepseek'?1.20:.75};
}
