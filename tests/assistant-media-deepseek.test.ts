import {expect,it,vi} from 'vitest';
import {mediaModelConfig,mediaPayload,mediaUsage,mediaOutput,createMediaModelPort,MEDIA_MODEL_CONFIG} from '../assistant/media-model';
const bytes=new Uint8Array([255,216,255,217]);
const response=(finish='stop',content=JSON.stringify({observations:'Há uma mensagem de erro no painel.',pages:[{page:1,state:'readable',text:'Não foi possível atualizar as pendências.'}]}))=>({choices:[{finish_reason:finish,message:{role:'assistant',content}}],usage:{prompt_tokens:1000,completion_tokens:50,total_tokens:1050,prompt_cache_hit_tokens:800,prompt_cache_miss_tokens:200}});
it('uses the selected DeepSeek model with one inline image and bounded JSON observations',async()=>{
 const body=mediaPayload(bytes,'image/jpeg',{kind:'image_context',pages:1,width:100,height:100},'deepseek');const parsed=JSON.parse(body);
 expect(parsed.model).toBe('deepseek-flash');expect(parsed.thinking).toEqual({type:'disabled'});expect(parsed.response_format).toEqual({type:'json_object'});
 expect(parsed.messages[1].content.find((x:any)=>x.type==='image_url').image_url.url).toBe('data:image/jpeg;base64,/9j/2Q==');
 expect(parsed.tools).toBeUndefined();expect(parsed.stream).toBe(false);
 const request=vi.fn<typeof fetch>(async()=>Response.json(response()));await createMediaModelPort('synthetic-key',request,'deepseek')({body,signal:AbortSignal.timeout(1000)});
 expect(request.mock.calls).toHaveLength(1);expect(request.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions');expect(request.mock.calls[0][1]).toMatchObject({redirect:'manual',method:'POST'});
});
it('charges full prompt tokens once and retains known usage when an image answer is truncated or malformed',()=>{
 expect(mediaUsage(response(),'deepseek')).toBe(360);expect(mediaUsage(response('length'),'deepseek')).toBe(360);
 expect(()=>mediaOutput(response('length'),1,'deepseek')).toThrow();expect(mediaUsage(response('stop','not JSON'),'deepseek')).toBe(360);
 expect(()=>mediaOutput(response('stop','not JSON'),1,'deepseek')).toThrow();
 expect(()=>mediaUsage({...response(),usage:{prompt_tokens:1000,completion_tokens:50,total_tokens:1051}},'deepseek')).toThrow();
 expect(mediaOutput(response(),1,'deepseek')).toMatchObject({pages:[{page:1,state:'readable'}]});
});
it('gives the new model a distinct price configuration while retaining the existing OpenAI identity',()=>{
 expect(mediaModelConfig('openai')).toEqual(MEDIA_MODEL_CONFIG);const ds=mediaModelConfig('deepseek');
 expect(ds.priceVersion).not.toBe(MEDIA_MODEL_CONFIG.priceVersion);expect(ds.ceilingUnits).toBeGreaterThanOrEqual(Math.ceil(ds.maxInputTokens*.3+ds.maxOutputTokens*1.2));
 expect(mediaUsage({usage:{input_tokens:1000,output_tokens:50,total_tokens:1050}})).toBe(550);
});
it('does not send PDFs through an image-only provider or fall back to another endpoint',()=>{
 expect(()=>mediaPayload(bytes,'application/pdf',{kind:'pdf_context',pages:1},'deepseek')).toThrow('media_pdf_model_unavailable');
});
