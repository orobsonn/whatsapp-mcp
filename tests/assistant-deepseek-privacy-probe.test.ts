import {env} from 'cloudflare:test';
import {expect,it,vi} from 'vitest';
import {setupPrivacyRun,privacyProbeAction,privacyModelHost} from './fixtures/assistant-deepseek-privacy-probe';
import {SourceAccess} from '../assistant/access';
import {InferenceBudget} from '../assistant/budget';

const noDispatch=()=>{throw Error('native_dispatch_not_expected');};
it('prepares fictitious sources once, keeps its canary on replay and closes before any model transport',async()=>{
 const network=vi.spyOn(globalThis,'fetch');
 try{
  const run=crypto.randomUUID(),a=await setupPrivacyRun(env.DB,run),b=await setupPrivacyRun(env.DB,run);expect(b).toEqual(a);
  const seed=JSON.parse(a.identity_json),access=new SourceAccess(env.DB,{installationId:seed.installationId,generation:seed.generation}),refs=JSON.parse(a.source_refs_json);
  expect((await access.read({kind:'owner'},refs.shared.id))?.text).toContain('6 de novembro de 2026');
  expect((await access.read({kind:'owner'},refs.private.id))?.text).toContain(a.canary);
  expect((await access.read({kind:'owner'},refs.request.id))?.text).toContain('base64');
  expect(await privacyProbeAction(env.DB,{action:'privacy-inspect',run},noDispatch)).toMatchObject({state:'ready',effects:[],receipts:[]});
  await privacyProbeAction(env.DB,{action:'privacy-close',run},noDispatch);
  const host=await privacyModelHost(env.DB,a,'synthetic-turn',noDispatch);await expect(host.assertAuthority()).rejects.toThrow('privacy_run_denied');
  expect(network).not.toHaveBeenCalled();
 }finally{network.mockRestore();}
});
it('the global experiment allocation covers all generations instead of resetting for a new run',async()=>{
 const a=await setupPrivacyRun(env.DB,crypto.randomUUID()),b=await setupPrivacyRun(env.DB,crypto.randomUUID());
 const host=await privacyModelHost(env.DB,b,'synthetic-turn',noDispatch),seed=JSON.parse(a.identity_json);
 const earlier=new InferenceBudget(env.DB,{installationId:seed.installationId,generation:seed.generation,period:'paid-a15-20261030'});
 await earlier.reserve('prior-paid-custody','a'.repeat(64),500000);
 await host.budget.reserve('next-paid-custody','b'.repeat(64),1);
 const guard=host.globalBudgetGuard();expect(await env.DB.prepare('SELECT 1 WHERE '+guard.sql).bind(...guard.values).first()).toBeNull();
});
