import {env} from 'cloudflare:test';
import {beforeEach,expect,it} from 'vitest';
import {SourceController,sourceTextHash} from '../assistant/sources';
import {OriginGuard,type OriginScope} from '../assistant/origin-guard';
import {ConversationArchive} from '../assistant/knowledge/archive';
import {createConversationReadCapabilities} from '../assistant/agent-runtime/conversation-connectors';
let scope:OriginScope,sources:SourceController,archive:ConversationArchive;
const owner={kind:'owner'} as const;
// Explicit synthetic host boundary; production supplies its native epoch guard.
const publication=()=>({getScope:()=>scope,authorityGuard:()=>({sql:'1',values:[] as (string|number|null)[]})});
beforeEach(()=>{
 scope={installationId:crypto.randomUUID(),generation:'g',sourceEpoch:'e',sourceGeneration:'sg'};
 sources=new SourceController(env.DB,scope,owner,()=>100);
 archive=new ConversationArchive(env.DB,scope,{fence:async()=>null,localContextGuard:()=>({sql:'1',values:[]}),checkContext:async()=>({state:'unavailable'})},async()=>{},async()=>{},publication());
});
async function note(text:string,i:number){return sources.create({originKey:'note-'+i,text,occurredAt:i});}
it('search pages beyond old corpus limits and reads exact original ranges',async()=>{
 for(let base=0;base<270;base+=5)await Promise.all(Array.from({length:Math.min(5,270-base)},(_,i)=>note('Cedar commitment '+(base+i),base+i)));
 let cursor:string|undefined;const ids=new Set<string>();
 do{const result=await archive.search({query:'Cedar',limit:50,...(cursor?{cursor}:{})});
  for(const item of result.items)ids.add(item.sourceRef.id);
  cursor=result.nextCursor;
 }while(cursor);
 expect(ids.size).toBe(270);
 const source=await note('Cedar '+ 'abc'.repeat(10000),300);
 const first=await archive.read({sourceRef:{id:source.id,revision:source.revision,version:1,hash:await sourceTextHash('Cedar '+ 'abc'.repeat(10000))},offset:0,limit:100});
 expect(first.text).toHaveLength(100);expect(first.coverage.complete).toBe(false);
 expect((await archive.read({sourceRef:first.sourceRef,offset:first.nextOffset!,limit:100})).text).toBe(('Cedar '+ 'abc'.repeat(10000)).slice(100,200));
});
it('exclusions and groups without opt-in never consume search page slots',async()=>{
 const keep=await note('Cedar authorized',1);
 for(const [chat,kind,excluded] of [['private','private',1],['group','group',0]] as const){
  const source=await sources.create({originKey:chat,text:'Cedar secret',occurredAt:99,conversationId:chat});
  await env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId,scope.generation,source.id).run();
  await env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,?,'available')").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,chat,kind).run();
  await env.DB.prepare("INSERT INTO assistant_conversation_policies VALUES(?,?,?,?,?,'ignore',1)").bind(scope.installationId,scope.generation,chat,kind,excluded).run();
 }
 const page=await archive.search({query:'Cedar',limit:1});
 expect(page.items.map(item=>item.sourceRef.id)).toEqual([keep.id]);expect(page.coverage.complete).toBe(true);
});
it('literal search input cannot inject MATCH grammar and changed references deny range reads',async()=>{
 const source=await note('Cedar OR secret',1);
 expect((await archive.search({query:'Cedar" OR * NOT secret'})).items).toEqual([]);
 const found=(await archive.search({query:'Cedar'})).items[0];
 await sources.withdraw(source.id,1);
 await expect(archive.read({sourceRef:found.sourceRef})).rejects.toThrow('archive_source_changed');
});
it('exposure callback runs before any archive output and may block a concurrent withdrawal',async()=>{
 const source=await note('Cedar promise',1);
 const guarded=new ConversationArchive(env.DB,scope,{fence:async()=>null,localContextGuard:()=>({sql:'1',values:[]}),checkContext:async()=>({state:'unavailable'})},async()=>{},async proof=>{
  expect(proof.sources[0].source.id).toBe(source.id);await sources.withdraw(source.id,1);
 },publication());
 await expect(guarded.search({query:'Cedar'})).rejects.toThrow('archive_source_changed');
});
it('GitHub and Calendar missing configuration remain pending instead of empty',async()=>{
 const task={knowledge:{scope},identity:{...scope},contextRef:'ctx'} as any;
 const reads=createConversationReadCapabilities({...publication(),env:{DB:env.DB} as any,task,origin:{fence:async()=>null,localContextGuard:()=>({sql:'1',values:[]}),checkContext:async()=>({state:'unavailable'})},assertCurrent:async()=>{},expose:async()=>{}});
 expect(await reads.github.resolve({repository:'repo'})).toMatchObject({state:'pending_configuration'});
 expect(await reads.calendar.availability({start:'2026-10-29T08:00:00-03:00',end:'2026-10-29T09:00:00-03:00',timeZone:'America/Fortaleza'})).toMatchObject({state:'pending_configuration'});
});
async function configuredHost(expose:Parameters<typeof createConversationReadCapabilities>[0]['expose']=async()=>{}){
 await env.DB.prepare('INSERT INTO assistant_projects VALUES(?,?,?,?)').bind(scope.installationId,scope.generation,'project','Synthetic project').run();
 const authorization=await sources.create({originKey:'external-consent',text:'Synthetic readonly external authorization',occurredAt:1,projectId:'project'});
 const task={knowledge:{scope},identity:{...scope},contextRef:'ctx'} as any;
 const descriptor={projectId:'project',version:1,authorization:{sourceId:authorization.id,revision:1}};
 const settings={DB:env.DB,GITHUB_READ_TOKEN:'synthetic-secret-token',GITHUB_READ_OWNER:JSON.stringify({...descriptor,owner:'synthetic-owner',ownerId:101}),
  CALENDAR_READ_CALENDARS:JSON.stringify([{...descriptor,id:'primary',calendarId:'primary'}]),CALENDAR_OAUTH_CONFIGURATION_VERSION:'1',CALENDAR_OAUTH_SECRET_EPOCH:'synthetic-epoch',
  CALENDAR_OAUTH:{idFromName:()=>({}),get:()=>({token:async()=>({state:'ready',accessToken:'synthetic-calendar-token',expiresAt:Date.now()+60000})})}} as any;
 return {authorization,settings,options:{...publication(),env:settings,task,origin:{fence:async()=>null,localContextGuard:()=>({sql:'1',values:[]}),checkContext:async()=>({state:'unavailable' as const})},assertCurrent:async()=>{},expose}};
}
it('GitHub explores real reader list/read at host-observed SHA with only fixed readonly endpoints',async()=>{
 const f=await configuredHost(),requests:Request[]=[],proofs:any[]=[],sha='a'.repeat(40),blob='b'.repeat(40),text='export const answer = 42;';
 const reads=createConversationReadCapabilities({...f.options,expose:async proof=>{proofs.push(proof);},request:async request=>{
  requests.push(request);const url=new URL(request.url);
  if(url.pathname.endsWith('/git/ref/heads/main'))return Response.json({ref:'refs/heads/main',object:{type:'commit',sha}});
  if(url.pathname.endsWith('/contents/'))return Response.json([{type:'file',name:'index.ts',path:'index.ts',size:text.length,sha:blob}]);
  if(url.pathname.endsWith('/contents/index.ts'))return Response.json({type:'file',name:'index.ts',path:'index.ts',size:text.length,sha:blob,encoding:'base64',content:btoa(text)});
  return Response.json({name:'repo',owner:{id:101,login:'synthetic-owner'},default_branch:'main'});
 }});
 await expect(reads.github.read({repository:'repo',commit:'main',path:'index.ts'})).rejects.toThrow();
 expect(requests).toHaveLength(0);
 const pointer=await reads.github.resolve({repository:'repo'});
 expect(pointer).toMatchObject({state:'available',repository:'synthetic-owner/repo',commit:sha,refScope:'default_branch_only'});
 expect(await reads.github.list({repository:'synthetic-owner/repo',commit:sha})).toMatchObject({items:[{path:'index.ts'}]});
 const restarted=createConversationReadCapabilities({...f.options,expose:async proof=>{proofs.push(proof);},request:async request=>{requests.push(request);if(request.url.includes('/contents/'))return Response.json({type:'file',name:'index.ts',path:'index.ts',size:text.length,sha:blob,encoding:'base64',content:btoa(text)});return Response.json({name:'repo',owner:{id:101,login:'synthetic-owner'}});}});
 const result=await restarted.github.read({repository:'synthetic-owner/repo',commit:sha,path:'index.ts'});
 expect(result).toMatchObject({state:'available',text,commit:sha,hash:await sourceTextHash(text)});
 expect(JSON.stringify([pointer,result,proofs])).not.toContain('synthetic-secret-token');
 expect(proofs).toHaveLength(3);expect(proofs[2].sources[0]).toMatchObject({actor:'knowledge:owner',source:{id:f.authorization.id,origin:'owner_note'}});
 expect(requests.every(request=>request.method==='GET'&&new URL(request.url).origin==='https://api.github.com')).toBe(true);
 expect(requests.filter(request=>request.url.includes('/contents/')).every(request=>new URL(request.url).searchParams.get('ref')===sha)).toBe(true);
 await expect(reads.github.read({repository:'repo',commit:sha,path:'index.ts',url:'https://evil.invalid'})).rejects.toThrow();
});
it('GitHub discovers owner-authorized private repositories with honest provider pagination',async()=>{
 const f=await configuredHost(),requests:Request[]=[],proofs:any[]=[];
 const reads=createConversationReadCapabilities({...f.options,expose:async p=>{proofs.push(p);},request:async r=>{
  requests.push(r);const page=Number(new URL(r.url).searchParams.get('page'));
  return Response.json(page===1?Array.from({length:20},(_,i)=>({name:'repo-'+i,full_name:'synthetic-owner/repo-'+i,owner:{id:101,login:'synthetic-owner'},private:true,description:'Recipe app',default_branch:'main',temp_clone_token:'never-publish'})):[]);
 }});
 const first=await reads.github.repositories({page:1});expect(first).toMatchObject({state:'available',nextPage:2,coverage:{complete:false}});
 expect(first).toHaveProperty('items.0',expect.objectContaining({repository:'synthetic-owner/repo-0',private:true,description:'Recipe app'}));
 expect(await reads.github.repositories({page:2})).toMatchObject({items:[],coverage:{complete:true}});
 expect(new URL(requests[0].url).pathname).toBe('/user/repos');expect(new URL(requests[0].url).searchParams.get('affiliation')).toBe('owner');
 expect(requests.every(r=>r.method==='GET'&&new URL(r.url).origin==='https://api.github.com')).toBe(true);
 expect(proofs[0].sources[0].source.id).toBe(f.authorization.id);expect(JSON.stringify(first)).not.toMatch(/never-publish|synthetic-secret-token/);
});
it('GitHub repository discovery rejects a response for another owner',async()=>{
 const f=await configuredHost();let published=false;
 const reads=createConversationReadCapabilities({...f.options,expose:async()=>{published=true;},request:async()=>Response.json([{name:'repo',full_name:'other/repo',owner:{id:202,login:'other'},private:true,description:null,default_branch:'main'}])});
 await expect(reads.github.repositories({})).rejects.toThrow('github_owner_mismatch');expect(published).toBe(false);
});
it('GitHub repository discovery checks grant withdrawal at final publication',async()=>{
 const f=await configuredHost();const reads=createConversationReadCapabilities({...f.options,expose:async()=>{await sources.withdraw(f.authorization.id,1);},request:async()=>Response.json([{name:'repo',full_name:'synthetic-owner/repo',owner:{id:101,login:'synthetic-owner'},private:true,description:null,default_branch:'main'}])});
 await expect(reads.github.repositories({})).rejects.toThrow('connector_source_changed');
});
it('GitHub discovery without owner-wide authority lists only explicit descriptors without fetching',async()=>{
 const f=await configuredHost(),ownerGrant=JSON.parse(f.settings.GITHUB_READ_OWNER);let fetched=false;
 const settings={...f.settings,GITHUB_READ_OWNER:undefined,GITHUB_READ_REPOSITORIES:JSON.stringify([{...ownerGrant,id:'explicit',repo:'only-repo'}])};
 const reads=createConversationReadCapabilities({...f.options,env:settings,request:async()=>{fetched=true;throw Error('unexpected_fetch');}});
 expect(await reads.github.repositories({})).toMatchObject({items:[{repository:'explicit',name:'only-repo'}],coverage:{scope:'configured_repositories',complete:true}});expect(fetched).toBe(false);
});
it('GitHub owner-wide discovery without its credential remains unavailable rather than empty',async()=>{
 const f=await configuredHost();const reads=createConversationReadCapabilities({...f.options,env:{...f.settings,GITHUB_READ_TOKEN:undefined},request:async()=>{throw Error('unexpected_fetch');}});
 expect(await reads.github.repositories({})).toMatchObject({state:'unavailable',reason:'github_credential_unconfigured'});
});
it('Calendar returns event titles and host grant proofs before release without exposing OAuth credentials',async()=>{
 const f=await configuredHost(),proofs:any[]=[],requests:Request[]=[];
 const reads=createConversationReadCapabilities({...f.options,expose:async proof=>{proofs.push(proof);},request:async request=>{
  requests.push(request);return Response.json({items:[{status:'confirmed',summary:'Cedar review',start:{dateTime:'2026-10-29T08:00:00-03:00'},end:{dateTime:'2026-10-29T08:30:00-03:00'}}]});
 }});
 const result=await reads.calendar.availability({start:'2026-10-29T08:00:00-03:00',end:'2026-10-29T09:00:00-03:00',timeZone:'America/Fortaleza'});
 expect(result).toMatchObject({state:'available',events:[{title:'Cedar review'}],eventsCoverage:{complete:true},availability:'conflict_observed'});
 expect(proofs[0].sources[0].source.id).toBe(f.authorization.id);
 expect(JSON.stringify(result)).not.toContain('synthetic-calendar-token');
 expect(requests[0].method).toBe('GET');expect(new URL(requests[0].url).searchParams.get('fields')).toContain('summary');
});
it('connector grant withdrawal inside the final exposure callback suppresses provider text',async()=>{
 const f=await configuredHost(),sha='a'.repeat(40);let exposures=0;
 const reads=createConversationReadCapabilities({...f.options,expose:async()=>{if(++exposures===2)await sources.withdraw(f.authorization.id,1);},request:async request=>{
  if(request.url.includes('/git/ref/'))return Response.json({ref:'refs/heads/main',object:{type:'commit',sha}});
  if(request.url.includes('/contents/'))return Response.json({type:'file',name:'x',path:'x',size:6,sha:'b'.repeat(40),encoding:'base64',content:btoa('secret')});
  return Response.json({name:'repo',owner:{id:101,login:'synthetic-owner'},default_branch:'main'});
 }});
 await reads.github.resolve({repository:'repo'});
 await expect(reads.github.read({repository:'repo',commit:sha,path:'x'})).rejects.toThrow('connector_source_changed');
});
it('FTS correction, physical deletion and canonical rebuild preserve current-version authority',async()=>{
 const source=await note('UniqueOldTerm',1);
 await sources.correct(source.id,1,{text:'UniqueCurrentTerm',occurredAt:2});
 expect((await archive.search({query:'UniqueOldTerm'})).items).toEqual([]);
 expect((await archive.search({query:'UniqueCurrentTerm'})).items[0].sourceRef.version).toBe(2);
 await env.DB.prepare("INSERT INTO assistant_archive_text(assistant_archive_text) VALUES('rebuild')").run();
 expect((await archive.search({query:'UniqueCurrentTerm'})).items).toHaveLength(1);
 await sources.withdraw(source.id,2);
 await env.DB.prepare('UPDATE assistant_sources SET current_version=NULL WHERE installation_id=? AND generation=? AND id=?').bind(scope.installationId,scope.generation,source.id).run();
 await env.DB.prepare('DELETE FROM assistant_source_versions WHERE installation_id=? AND generation=? AND source_id=?').bind(scope.installationId,scope.generation,source.id).run();
 expect(await env.DB.prepare('SELECT COUNT(*) n FROM assistant_archive_text WHERE assistant_archive_text MATCH ?').bind('"UniqueCurrentTerm"').first<number>('n')).toBe(0);
});
it('a final external origin withdrawal denies the selected original before tool publication',async()=>{
 const source=await sources.create({originKey:'direct',text:'Cedar promise',occurredAt:1,conversationId:'direct'});
 await env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId,scope.generation,source.id).run();
 await env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,'private','available')").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,'direct').run();
 await env.DB.prepare("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,tombstoned) VALUES(?,?,?,?,'message','external','direct',?,1,0)").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,source.id).run();
 let current=true;
 const origin={fence:async()=>({...scope,canonicalId:source.id,sourceKind:'message' as const,sourceId:'external',chatId:'direct',revision:1,version:1,watermark:1,hash:'a'.repeat(64),conversationKind:'private' as const,policyRevision:0,policyMode:'attend'}),localContextGuard:()=>({sql:'1',values:[]}),checkContext:async()=>({state:current?'current' as const:'changed' as const})};
 const guarded=new ConversationArchive(env.DB,scope,origin,async()=>{},async proof=>{expect(proof.origins).toHaveLength(1);current=false;},publication());
 await expect(guarded.search({query:'Cedar'})).rejects.toThrow('archive_origin_unavailable');
});
it('an explicitly observed group is searchable through the real policy view and OriginGuard',async()=>{
 const source=await sources.create({originKey:'included-group',text:'Cedar group agreement',occurredAt:1,conversationId:'included-group'});
 const snapshot={observation:'capture_snapshot',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:'message',sourceId:'group-message',chatId:'included-group',sourceVersion:1,watermark:1,conversationKind:'group',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text:'Cedar group agreement',messageId:'group-message',messageVersion:1}};
 const guard=new OriginGuard(env.DB,()=>scope,{readSnapshot:async()=>snapshot},'synthetic-secret');
 const observation=await guard.observe(scope,{sourceKind:'message',sourceId:'group-message',chatId:'included-group'});
 await env.DB.batch([
  env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId,scope.generation,source.id),
  env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,'group','available')").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,'included-group'),
  env.DB.prepare("INSERT INTO assistant_conversation_policies(installation_id,generation,conversation_id,kind,group_mode) VALUES(?,?,'included-group','group','observe')").bind(scope.installationId,scope.generation),
  env.DB.prepare("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,observation_hash,tombstoned) VALUES(?,?,?,?,'message','group-message','included-group',?,1,?,0)").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,source.id,observation.hash),
 ]);
 expect(await env.DB.prepare('SELECT effective_mode FROM assistant_conversation_modes WHERE installation_id=? AND generation=? AND conversation_id=?').bind(scope.installationId,scope.generation,'included-group').first<string>('effective_mode')).toBe('observe');
 const enabled=new ConversationArchive(env.DB,scope,guard,async()=>{},async proof=>{expect(proof.origins[0].canonicalId).toBe(source.id);},publication());
 expect((await enabled.search({query:'Cedar'})).items.map(item=>item.sourceRef.id)).toEqual([source.id]);
});

it('archive final host callback cannot withdraw an earlier selected source and still publish snippets',async()=>{
 const first=await note('Cedar first',2);await note('Cedar second',1);let exposed=false,mutated=false;
 const guarded=new ConversationArchive(env.DB,scope,{fence:async()=>null,localContextGuard:()=>({sql:'1',values:[]}),checkContext:async()=>({state:'unavailable'})},async()=>{
  if(exposed&&!mutated){mutated=true;await sources.withdraw(first.id,1);}
 },async()=>{exposed=true;},publication());
 await expect(guarded.search({query:'Cedar'})).rejects.toThrow('archive_source_changed');expect(mutated).toBe(true);
});
it('archive rechecks all selected sources after the last remote origin check changes an earlier source',async()=>{
 const first=await note('Cedar first',2),second=await sources.create({originKey:'last-remote',text:'Cedar second',occurredAt:1,conversationId:'last-remote'});
 let exposed=false,mutated=false;
 const snapshot={observation:'capture_snapshot',state:'available',sourceEpoch:scope.sourceEpoch,sourceGeneration:scope.sourceGeneration,sourceKind:'message',sourceId:'last-message',chatId:'last-remote',sourceVersion:1,watermark:1,conversationKind:'private',access:{captureEnabled:true,captureSince:0,discontinuous:false},content:{kind:'text',text:'Cedar second',messageId:'last-message',messageVersion:1}};
 const guard=new OriginGuard(env.DB,()=>scope,{readSnapshot:async()=>{if(exposed&&!mutated){mutated=true;await sources.withdraw(first.id,1);}return snapshot;}},'synthetic-secret');
 const observation=await guard.observe(scope,{sourceKind:'message',sourceId:'last-message',chatId:'last-remote'});
 await env.DB.batch([
  env.DB.prepare("UPDATE assistant_sources SET origin='whatsapp' WHERE installation_id=? AND generation=? AND id=?").bind(scope.installationId,scope.generation,second.id),
  env.DB.prepare("INSERT INTO assistant_origin_conversations VALUES(?,?,?,?,?,1,'private','available')").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,'last-remote'),
  env.DB.prepare("INSERT INTO assistant_source_origins(installation_id,generation,source_epoch,source_generation,source_kind,source_id,chat_id,canonical_id,watermark,observation_hash,tombstoned) VALUES(?,?,?,?,'message','last-message','last-remote',?,1,?,0)").bind(scope.installationId,scope.generation,scope.sourceEpoch,scope.sourceGeneration,second.id,observation.hash),
 ]);
 const guarded=new ConversationArchive(env.DB,scope,guard,async()=>{},async()=>{exposed=true;},publication());
 await expect(guarded.search({query:'Cedar'})).rejects.toThrow('archive_source_changed');expect(mutated).toBe(true);
});
it('Calendar multiple grants are checked together after the last host callback before provider titles return',async()=>{
 const f=await configuredHost(),second=await sources.create({originKey:'calendar-second-grant',text:'Synthetic readonly secondary calendar authorization',occurredAt:1,projectId:'project'});
 f.settings.CALENDAR_READ_CALENDARS=JSON.stringify([...JSON.parse(f.settings.CALENDAR_READ_CALENDARS),{id:'second',calendarId:'second',projectId:'project',version:1,authorization:{sourceId:second.id,revision:1}}]);
 let exposed=false,mutated=false;
 const reads=createConversationReadCapabilities({...f.options,assertCurrent:async()=>{if(exposed&&!mutated){mutated=true;await sources.withdraw(f.authorization.id,1);}},expose:async()=>{exposed=true;},request:async()=>Response.json({items:[{status:'confirmed',summary:'Cedar stale meeting',start:{dateTime:'2026-10-29T08:00:00-03:00'},end:{dateTime:'2026-10-29T08:30:00-03:00'}}]})});
 await expect(reads.calendar.availability({start:'2026-10-29T08:00:00-03:00',end:'2026-10-29T09:00:00-03:00',timeZone:'America/Fortaleza'})).rejects.toThrow('connector_source_changed');expect(mutated).toBe(true);
});
it('archive denies a live source-scope change while the final database snapshot returns',async()=>{
 await note('Cedar current body',1);
 const db={prepare:env.DB.prepare.bind(env.DB),batch:async(statements:D1PreparedStatement[])=>{const result=await env.DB.batch(statements);scope={...scope,sourceEpoch:'replaced-epoch'};return result;}} as unknown as D1Database;
 const guarded=new ConversationArchive(db,scope,{fence:async()=>null,localContextGuard:()=>({sql:'1',values:[]}),checkContext:async()=>({state:'unavailable'})},async()=>{},async()=>{},publication());
 await expect(guarded.search({query:'Cedar'})).rejects.toThrow('archive_source_changed');
});
it.each(['hold','generation'])('archive final publication enforces restore execution %s after the last host await',async state=>{
 await note('Cedar current body',1);let exposed=false,changed=false;
 const guarded=new ConversationArchive(env.DB,scope,{fence:async()=>null,localContextGuard:()=>({sql:'1',values:[]}),checkContext:async()=>({state:'unavailable'})},async()=>{
  if(exposed&&!changed){changed=true;
   if(state==='hold')await env.DB.prepare("INSERT INTO assistant_retention_runtime_hold VALUES(?,'restore','next',1,1)").bind(scope.installationId).run();
   else await env.DB.prepare("INSERT INTO assistant_retention_active_generation VALUES(?,'next','seal','ticket','command',1)").bind(scope.installationId).run();
  }
 },async()=>{exposed=true;},publication());
 await expect(guarded.search({query:'Cedar'})).rejects.toThrow('archive_source_changed');expect(changed).toBe(true);
});
it('archive final snapshot denies a tombstoned native epoch even when every source stays current',async()=>{
 await note('Cedar current body',1);let exposed=false;
 const epoch='synthetic-host-epoch';
 await env.DB.prepare('INSERT INTO assistant_native_conversations(id,installation_id,generation,identity_json,created_at) VALUES(?,?,?,?,1)').bind(epoch,scope.installationId,scope.generation,'{}').run();
 const boundary={getScope:()=>scope,authorityGuard:()=>({sql:'EXISTS(SELECT 1 FROM assistant_native_conversations WHERE id=? AND installation_id=? AND generation=? AND tombstoned_at IS NULL)',values:[epoch,scope.installationId,scope.generation]})};
 const guarded=new ConversationArchive(env.DB,scope,{fence:async()=>null,localContextGuard:()=>({sql:'1',values:[]}),checkContext:async()=>({state:'unavailable'})},async()=>{
  if(exposed)await env.DB.prepare('UPDATE assistant_native_conversations SET tombstoned_at=1 WHERE id=?').bind(epoch).run();
 },async()=>{exposed=true;},boundary);
 await expect(guarded.search({query:'Cedar'})).rejects.toThrow('archive_source_changed');
});
