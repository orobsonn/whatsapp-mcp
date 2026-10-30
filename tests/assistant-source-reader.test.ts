import { createExecutionContext, env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { CaptureReader } from "../src/assistant-source-reader";
import {OriginGuard} from '../assistant/origin-guard';

const secret = "synthetic-reader-secret-exclusive-tests";
const settings = () => ({ ...env, OWNER_SUB: "synthetic-owner", INSTALLATION_EPOCH: "reader-e",
  CONNECTION_GENERATION: "reader-g", MAINTENANCE: "false", RUNTIME_CONFIG: "static" as const,
  DEVELOPMENT: "true", ASSISTANT_READER_SECRET: secret });
const request = (sourceKind = "message", sourceId = "reader-message") => ({
  secret, sourceEpoch: "reader-e", sourceGeneration: "reader-g", chatId: "reader-chat", sourceKind, sourceId,
});
const reader = (configuration: Env = settings()) => new CaptureReader(createExecutionContext(), configuration);
const run = (sql: string) => env.DB.prepare(sql).run();
beforeEach(async () => {
  await env.DB.exec("DELETE FROM connection_state; DELETE FROM media_jobs; DELETE FROM media_derivatives; DELETE FROM media; DELETE FROM message_versions; DELETE FROM messages; DELETE FROM actions; DELETE FROM participants; DELETE FROM chats;");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at)
      VALUES('reader-chat','reader-e','reader-g','synthetic-address','individual','Synthetic conversation',1,10,10)`),
    env.DB.prepare(`INSERT INTO messages(id,chat_id,epoch,generation,external_id,from_me,kind,text,timestamp,received_at)
      VALUES('reader-message','reader-chat','reader-e','reader-g','synthetic-message',0,'audio','Synthetic captured content',10,10)`),
    env.DB.prepare(`INSERT INTO media(id,chat_id,message_id,epoch,generation,kind,mime,size,sha256,object_key,state,source_url,created_at)
      VALUES('reader-media','reader-chat','reader-message','reader-e','reader-g','audio','audio/ogg',100,?,'private/do-not-return','ready','https://provider.example/private?token=synthetic',10)`)
      .bind("a".repeat(64)),
    env.DB.prepare(`INSERT INTO media_derivatives(id,media_id,media_version,epoch,generation,kind,text,state,created_at)
      VALUES('reader-derivative','reader-media',1,'reader-e','reader-g','transcript','Synthetic captured transcript','ready',10)`),
  ]);
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Reader must not use network"); });
});
afterEach(() => vi.restoreAllMocks());
it('returns only the authenticated current Source stream head for a prospective pilot cutoff', async () => {
  const input = { secret, sourceEpoch: 'reader-e', sourceGeneration: 'reader-g' };
  const expected = await env.DB.prepare("SELECT COALESCE(MAX(sequence),0) n FROM assistant_capture_changes WHERE epoch='reader-e' AND generation='reader-g'").first<number>('n');
  expect(await reader().streamHead(input)).toEqual({observation:'capture_stream_head',state:'available',sourceEpoch:'reader-e',sourceGeneration:'reader-g',sequence:expected});
  await expect(reader().streamHead({...input,secret:'invalid'})).rejects.toThrow('reader_denied');
  await expect(reader().streamHead({...input,sourceGeneration:'old'})).rejects.toThrow('reader_denied');
  await expect(reader().streamHead({...input,sql:'SELECT *'})).rejects.toThrow('reader_invalid_input');
  expect(await reader({...settings(),MAINTENANCE:'true'}).streamHead(input)).toMatchObject({state:'blocked'});
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("authenticates a nominal read-only entrypoint and refuses arbitrary input", async () => {
  await expect(reader().readSnapshot({ ...request(), secret: "invalid" })).rejects.toThrow("reader_denied");
  await expect(reader().readSnapshot({ ...request(), sourceGeneration: "old-generation" })).rejects.toThrow("reader_denied");
  await expect(reader().readSnapshot({ ...request(), sql: "SELECT *", url: "https://provider.example" })).rejects.toThrow("reader_invalid_input");
  await expect(reader().readSnapshot({ ...request(), sourceId: "x".repeat(257) })).rejects.toThrow("reader_invalid_input");
  await expect(reader().readSnapshot({ ...request(), sourceKind: "arbitrary" })).rejects.toThrow("reader_invalid_input");
});
it("bootstraps only current installation affinity through the named reader capability", async () => {
  expect(await reader().installationAffinity({ secret })).toEqual({ observation: "capture_installation_affinity", state: "available", fence: { epoch: "reader-e", generation: "reader-g" } });
  await expect(reader().installationAffinity({ secret: "invalid" })).rejects.toThrow("reader_denied");
  await expect(reader().installationAffinity({ secret, sourceEpoch: "invented" })).rejects.toThrow("reader_invalid_input");
  await expect(reader().installationAffinity({ secret, sql: "SELECT *" })).rejects.toThrow("reader_invalid_input");
  expect(await reader({ ...settings(), MAINTENANCE: "true" }).installationAffinity({ secret })).toEqual({ observation: "capture_installation_affinity", state: "blocked", reason: "reader_unavailable" });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("reads current content and conversation watermark without requiring a known author", async () => {
  const snapshot = await reader().readSnapshot(request());
  const latest = await env.DB.prepare("SELECT MAX(sequence) AS watermark FROM assistant_capture_changes WHERE epoch='reader-e' AND generation='reader-g' AND chat_id='reader-chat'").first();
  expect(snapshot).toMatchObject({ observation: "capture_snapshot", state: "available", sourceVersion: 1,
    watermark: latest!.watermark, content: { text: "Synthetic captured content", authorId: null, fromMe: false } });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("identifies private and group conversations in the same source snapshot", async () => {
  expect(await reader().readSnapshot(request())).toMatchObject({conversationKind:"private"});
  await run("UPDATE chats SET kind='group' WHERE id='reader-chat'");
  expect(await reader().readSnapshot(request("derivative","reader-derivative"))).toMatchObject({conversationKind:"group"});
});

it("returns media and derivative dependencies without provider URLs, keys or secrets", async () => {
  const media = await reader().readSnapshot(request("media", "reader-media"));
  expect(media).toMatchObject({ state: "available", content: { media: { id: "reader-media", version: 1, hash: "a".repeat(64) } } });
  const derivative = await reader().readSnapshot(request("derivative", "reader-derivative"));
  expect(derivative).toMatchObject({ state: "available", content: { text: "Synthetic captured transcript", messageVersion: 1, mediaVersion: 1 } });
  expect(JSON.stringify([media, derivative])).not.toMatch(/provider\.example|private\/do-not-return|source_url|object_key|synthetic-reader-secret/);
  await run("UPDATE media SET kind='pdf' WHERE id='reader-media'");
  expect((await reader().readSnapshot(request())).content?.media).toBeUndefined();
});

it("removes content after capture is disabled, privacy protection or withdrawal", async () => {
  await run("UPDATE chats SET capture_enabled=0 WHERE id='reader-chat'");
  for (const [kind, id] of [["message", "reader-message"], ["media", "reader-media"], ["derivative", "reader-derivative"], ["conversation", "reader-chat"]]) {
    const snapshot = await reader().readSnapshot(request(kind, id));
    expect(snapshot).toMatchObject({ state: "withdrawn", reason: "capture_disabled" });
    expect(snapshot.content).toBeUndefined();
  }
  await run("UPDATE chats SET capture_enabled=1 WHERE id='reader-chat'");
  await run("UPDATE messages SET privacy_locked=1 WHERE id='reader-message'");
  expect(await reader().readSnapshot(request())).toMatchObject({ state: "withdrawn", reason: "privacy_protected" });
  await run("UPDATE messages SET privacy_locked=0,deleted_at=20 WHERE id='reader-message'");
  expect(await reader().readSnapshot(request())).toMatchObject({ state: "withdrawn", reason: "source_withdrawn" });
});

it("distinguishes absence and incompatible media/derivative versions", async () => {
  expect(await reader().readSnapshot(request("message", "absent"))).toMatchObject({ state: "withdrawn", reason: "source_missing" });
  await run(`INSERT INTO chats(id,epoch,generation,external_id,kind,name,capture_enabled,created_at,updated_at)
    VALUES('other-reader-chat','reader-e','reader-g','synthetic-other','individual','Other conversation',1,10,10)`);
  expect(await reader().readSnapshot({ ...request("derivative", "reader-derivative"), chatId: "other-reader-chat" }))
    .toMatchObject({ state: "withdrawn", reason: "source_missing" });
  await run("UPDATE messages SET version=2 WHERE id='reader-message'");
  for (const [kind, id] of [["media", "reader-media"], ["derivative", "reader-derivative"]]) {
    const snapshot = await reader().readSnapshot(request(kind, id));
    expect(snapshot).toMatchObject({ state: "blocked", reason: "version_mismatch" });
    expect(snapshot.content).toBeUndefined();
  }
});

it("reports oversized content without truncation while later withdrawal is still readable", async () => {
  await env.DB.prepare("UPDATE media_derivatives SET text=? WHERE id='reader-derivative'").bind("x".repeat(40000)).run();
  const snapshot = await reader().readSnapshot(request("derivative", "reader-derivative"));
  expect(snapshot).toMatchObject({ state: "blocked", reason: "snapshot_too_large" });
  expect(snapshot.content).toBeUndefined();
  await run("UPDATE media_derivatives SET state='deleted' WHERE id='reader-derivative'");
  expect(await reader().readSnapshot(request("derivative", "reader-derivative")))
    .toMatchObject({ state: "withdrawn", reason: "source_withdrawn" });
});

it("uses the live encrypted connection generation instead of raw pending runtime configuration", async () => {
  const configuration = { ...settings(), RUNTIME_CONFIG: "database" as const, DEVELOPMENT: "false",
    CONNECTION_GENERATION: "pending", PUBLIC_ORIGIN: "https://reader.example", ENCRYPTION_KEY: btoa("k".repeat(32)) };
  const generation = "c".repeat(32), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("k".repeat(32)), "AES-GCM", false, ["encrypt"]);
  const payload = JSON.stringify({ instanceId: "synthetic-instance", instanceToken: "synthetic-token", clientToken: "synthetic-client",
    phone: "5511000000000", generation, webhookSecret: "d".repeat(64) });
  const aad = new TextEncoder().encode(JSON.stringify(["whatsapp-mcp/connection/v1", configuration.PUBLIC_ORIGIN, configuration.INSTALLATION_EPOCH]));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new TextEncoder().encode(payload));
  const cipher = `v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...new Uint8Array(encrypted)))}`;
  await env.DB.prepare("INSERT INTO connection_state(id,epoch,cipher,state,attempt_id,step,created_at,updated_at) VALUES(1,'reader-e',?,'active','synthetic','done',10,10)").bind(cipher).run();
  await env.DB.prepare("UPDATE chats SET generation=? WHERE id='reader-chat'").bind(generation).run();
  await env.DB.prepare("UPDATE messages SET generation=? WHERE id='reader-message'").bind(generation).run();
  const snapshot = await reader(configuration).readSnapshot({ ...request(), sourceGeneration: generation });
  expect(snapshot).toMatchObject({ state: "available", sourceGeneration: generation, content: { text: "Synthetic captured content" } });
  expect(JSON.stringify(snapshot)).not.toMatch(/synthetic-token|synthetic-client|5511000000000/);
  expect(await reader(configuration).installationAffinity({ secret })).toEqual({ observation: "capture_installation_affinity", state: "available", fence: { epoch: "reader-e", generation } });
  const affinity = JSON.stringify(await reader(configuration).installationAffinity({ secret }));
  expect(affinity).not.toMatch(/synthetic-token|synthetic-client|5511000000000|instanceId|cipher|ENCRYPTION_KEY/);
});

it("refuses a connection generation or pause changed during the bootstrap recheck", async () => {
  for (const field of ["CONNECTION_GENERATION", "MAINTENANCE", "ASSISTANT_READER_SECRET"] as const) {
    const configuration = settings(); let reads = 0;
    Object.defineProperty(configuration, field, { configurable: true, enumerable: true, get: () => {
      reads++; return reads > (field === "ASSISTANT_READER_SECRET" ? 3 : 1) ? field === "MAINTENANCE" ? "true" : "changed" : field === "MAINTENANCE" ? "false" : field === "CONNECTION_GENERATION" ? "reader-g" : secret;
    } });
    if (field === "ASSISTANT_READER_SECRET") await expect(reader(configuration).installationAffinity({ secret })).rejects.toThrow("reader_denied");
    else expect(await reader(configuration).installationAffinity({ secret })).toMatchObject({ state: "blocked" });
  }
});

it("uses the per-conversation watermark index", async () => {
  const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT MAX(sequence) FROM assistant_capture_changes WHERE epoch='reader-e' AND generation='reader-g' AND chat_id='reader-chat'").all();
  expect(plan.results.some((row) => String(row.detail).includes("assistant_capture_changes_chat"))).toBe(true);
});

it('pins original snapshot digests before the bulk proof optimization',async()=>{
 const refs=[request(),request('media','reader-media'),request('derivative','reader-derivative'),request('conversation','reader-chat')];
 const original=new OriginGuard(env.DB,()=>({installationId:'synthetic',generation:'own',sourceEpoch:'reader-e',sourceGeneration:'reader-g'}),{readSnapshot:input=>reader().readSnapshot(input)},secret);
 for(const ref of refs){const observed=await original.observe({installationId:'synthetic',generation:'own',sourceEpoch:'reader-e',sourceGeneration:'reader-g'},ref as never);expect(observed.state).toBe('available');expect(observed.hash).toBe(({message:'3d1f9ee56a78df34cd94c2e48abc79a56d9f7e99f06132d0d6c0578dfc105b1b',media:'c3c7e016bf9d3b2da97a01527332d974eeac7914d6d488673f47186e8943a30f',derivative:'e6a28a1b136b64c7aabb33174d4c29667f7105aac21c4a62fc96ed6c7feed778',conversation:'5defbd5ff7e7786afd35425b297814cb6116a3fdc2050d1e4e5ab8f6a63057f0'} as Record<string,string>)[ref.sourceKind]);}
});
it('returns one hash-only proof page equivalent to all singular source kinds',async()=>{
 const inputs=[request(),request('media','reader-media'),request('derivative','reader-derivative'),request('conversation','reader-chat')];
 const refs=inputs.map(({sourceKind,sourceId,chatId})=>({sourceKind,sourceId,chatId})),rpc=reader();
 const output=await rpc.readSnapshotProofs({secret,sourceEpoch:'reader-e',sourceGeneration:'reader-g',refs});
 expect(output).toMatchObject({observation:'capture_snapshot_proofs',state:'available',sourceEpoch:'reader-e',sourceGeneration:'reader-g'});
 if(output.state!=='available')throw Error('proofs_unavailable');expect(output.items).toHaveLength(4);
 const original=new OriginGuard(env.DB,()=>({installationId:'synthetic',generation:'own',sourceEpoch:'reader-e',sourceGeneration:'reader-g'}),{readSnapshot:input=>rpc.readSnapshot(input)},secret);
 for(const input of inputs){const observed=await original.observe({installationId:'synthetic',generation:'own',sourceEpoch:'reader-e',sourceGeneration:'reader-g'},input as never);
  const {content,...proof}=observed;expect(output.items.find(x=>x.sourceKind===input.sourceKind)).toEqual({...{sourceKind:input.sourceKind,sourceId:input.sourceId,chatId:input.chatId},...proof});}
 expect(JSON.stringify(output)).not.toMatch(/Synthetic captured|provider\.example|private\/do-not-return|synthetic-reader-secret|source_url|object_key/);
 expect(globalThis.fetch).not.toHaveBeenCalled();
});
it('authenticates and bounds a proof page before querying source rows',async()=>{
 const ref={sourceKind:'message',sourceId:'reader-message',chatId:'reader-chat'},base={secret,sourceEpoch:'reader-e',sourceGeneration:'reader-g',refs:[ref]};
 await expect(reader().readSnapshotProofs({...base,secret:'invalid'})).rejects.toThrow('reader_denied');
 await expect(reader().readSnapshotProofs({...base,sourceGeneration:'old'})).rejects.toThrow('reader_denied');
 for(const value of [{...base,refs:[]},{...base,refs:Array(65).fill(ref)},{...base,refs:[ref,ref]},{...base,expectedHash:'a'.repeat(64)},{...base,refs:[{...ref,sql:'SELECT *'}]}])await expect(reader().readSnapshotProofs(value)).rejects.toThrow('reader_invalid_input');
});
it('keeps blocked and withdrawn proofs distinct without exposing any received body',async()=>{
 await run("UPDATE media SET state='pending' WHERE id='reader-media'");
 const refs=[{sourceKind:'media',sourceId:'reader-media',chatId:'reader-chat'},{sourceKind:'message',sourceId:'absent',chatId:'reader-chat'}];
 const out=await reader().readSnapshotProofs({secret,sourceEpoch:'reader-e',sourceGeneration:'reader-g',refs});
 expect(out).toMatchObject({state:'available',items:[{state:'blocked',reason:'media_unavailable',hash:null},{state:'withdrawn',hash:null}]});
 await run("UPDATE chats SET capture_enabled=0 WHERE id='reader-chat'");
 const withdrawn=await reader().readSnapshotProofs({secret,sourceEpoch:'reader-e',sourceGeneration:'reader-g',refs});expect(withdrawn).toMatchObject({items:[{state:'withdrawn'},{state:'withdrawn'}]});
});
it.each(['capture','privacy','text','media','key','activity'] as const)('rechecks %s changes during a source proof hash before returning any digest',async change=>{
 const configuration=settings(),original=crypto.subtle.digest.bind(crypto.subtle);let reachedHash=false;
 vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{
  if(!reachedHash&&new TextDecoder().decode(args[1]).includes('\"captureEnabled\"')){reachedHash=true;
  if(change==='capture')await run("UPDATE chats SET capture_enabled=0 WHERE id='reader-chat'");
  if(change==='privacy')await run("UPDATE messages SET privacy_locked=1 WHERE id='reader-message'");
  if(change==='text')await run("UPDATE messages SET text='Corrected during hash',version=version+1 WHERE id='reader-message'");
  if(change==='media')await run("UPDATE media SET state='deleted',deleted_at=20 WHERE id='reader-media'");
  if(change==='key')configuration.ASSISTANT_READER_SECRET='rotated-synthetic-key';
  if(change==='activity')await env.DB.prepare("INSERT INTO assistant_capture_changes(epoch,generation,chat_id,source_kind,source_id,operation,recorded_at) VALUES('reader-e','reader-g','reader-chat','message','later-message','upsert',20)").run();
  }return original(...args);
 });
 const sourceKind=change==='media'?'media':'message',sourceId=change==='media'?'reader-media':'reader-message';
 const output=await reader(configuration).readSnapshotProofs({secret,sourceEpoch:'reader-e',sourceGeneration:'reader-g',refs:[{sourceKind,sourceId,chatId:'reader-chat'}]});
 expect(reachedHash).toBe(true);
 if(change==='key')expect(output).toMatchObject({state:'blocked',reason:'reader_changed'});
 else if(change==='activity')expect(output).toMatchObject({state:'available',items:[{state:'available',hash:expect.stringMatching(/^[a-f0-9]{64}$/)}]});
 else expect(output).toMatchObject({state:'available',items:[{state:change==='text'?'blocked':'withdrawn',hash:null,...(change==='text'?{reason:'snapshot_changed'}:{})}]});
 expect(JSON.stringify(output)).not.toContain('Corrected during hash');
});
it('checks the captured connection version/cipher after the hash rather than trusting the env copy',async()=>{
 const configuration={...settings(),RUNTIME_CONFIG:'database' as const,DEVELOPMENT:'false',CONNECTION_GENERATION:'pending',PUBLIC_ORIGIN:'https://reader.example',ENCRYPTION_KEY:btoa('k'.repeat(32))};
 const generation='c'.repeat(32),iv=crypto.getRandomValues(new Uint8Array(12)),key=await crypto.subtle.importKey('raw',new TextEncoder().encode('k'.repeat(32)),'AES-GCM',false,['encrypt']);
 const payload=JSON.stringify({instanceId:'synthetic-instance',instanceToken:'synthetic-token',clientToken:'synthetic-client',phone:'5511000000000',webhookSecret:'d'.repeat(64),generation});
 const aad=new TextEncoder().encode(JSON.stringify(['whatsapp-mcp/connection/v1',configuration.PUBLIC_ORIGIN,configuration.INSTALLATION_EPOCH]));
 const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},key,new TextEncoder().encode(payload)));
 const cipher=`v1.${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...encrypted))}`;
 await env.DB.prepare("INSERT INTO connection_state(id,epoch,cipher,state,attempt_id,step,created_at,updated_at) VALUES(1,'reader-e',?,'active','synthetic-attempt','ready',10,10)").bind(cipher).run();
 for(const table of ['chats','messages','media','media_derivatives'])await run(`UPDATE ${table} SET generation='${generation}'`);
 let reachedHash=false;const original=crypto.subtle.digest.bind(crypto.subtle);vi.spyOn(crypto.subtle,'digest').mockImplementation(async(...args)=>{if(!reachedHash&&new TextDecoder().decode(args[1]).includes('\"captureEnabled\"')){reachedHash=true;await run('UPDATE connection_state SET version=version+1 WHERE id=1');}return original(...args);});
 expect(await reader(configuration).readSnapshotProofs({secret,sourceEpoch:'reader-e',sourceGeneration:generation,refs:[{sourceKind:'message',sourceId:'reader-message',chatId:'reader-chat'}]})).toEqual({observation:'capture_snapshot_proofs',state:'blocked',reason:'reader_changed'});expect(reachedHash).toBe(true);
});
it('uses bounded work pages and explicit unavailable states at the existing snapshot byte boundary',async()=>{
 const refs=[];for(let i=0;i<64;i++)refs.push({sourceKind:'message',sourceId:'absent-'+i,chatId:'reader-chat'});
 const bulk=await reader().readSnapshotProofs({secret,sourceEpoch:'reader-e',sourceGeneration:'reader-g',refs});expect(bulk).toMatchObject({state:'available'});if(bulk.state==='available')expect(bulk.items).toHaveLength(64);
 await env.DB.prepare("UPDATE messages SET text=? WHERE id='reader-message'").bind('x'.repeat(32768)).run();
 expect(await reader().readSnapshotProofs({secret,sourceEpoch:'reader-e',sourceGeneration:'reader-g',refs:[{sourceKind:'message',sourceId:'reader-message',chatId:'reader-chat'}]})).toMatchObject({items:[{state:'blocked',reason:'snapshot_too_large',hash:null}]});
});
