import {expect,it} from 'vitest';
import {nativeModelCatalog,nativeModelSelection} from '../assistant/.flue/providers/model-selection';

it('selects Sol only through trusted host configuration and keeps legacy defaults',()=>{
 expect(nativeModelSelection({NATIVE_MODEL_PROVIDER:'openai',NATIVE_OPENAI_MODEL:'gpt-6.1-sol',OPENAI_API_KEY:'synthetic'})).toMatchObject({provider:'openai',model:'openai/gpt-6.1-sol',thinkingLevel:'low'});
 expect(nativeModelSelection({})).toMatchObject({model:'openai/gpt-6-luna'});
 expect(()=>nativeModelSelection({NATIVE_OPENAI_MODEL:'untrusted-model'})).toThrow('native_model_configuration_invalid');
});
it('pins Sol Responses, its installed context window and matching conservative prices',()=>{
 const selected=nativeModelCatalog('openai','gpt-6.1-sol');
 expect(selected.model).toMatchObject({id:'gpt-6.1-sol',api:'openai-responses',contextWindow:272000});
 expect(selected).toMatchObject({endpoint:'https://api.openai.com/v1/responses',inputMicroUSD:2.5,outputMicroUSD:10});
 expect(selected.priceVersion).toContain('gpt-6.1-sol');
 expect(nativeModelCatalog('openai').model.id).toBe('gpt-6-luna');
});
