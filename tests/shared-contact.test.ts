import {describe,it,expect} from 'vitest';
import {env} from 'cloudflare:test';
import {normalizeZapiEvent,ingestEvent,queryMessages} from '../src/capture';
import {upsertDirectoryPage} from '../src/directory';
import {ownerToolProvenance} from '../src/owner-tool-provenance';
import {resolveRecipient} from '../src/recipients';
import {prepareAction} from '../src/actions';
import type {Env} from '../src/env';
const base={phone:'5585999990001',messageId:'synthetic-card',fromMe:false,isGroup:false,momment:10};
const card=(contact:unknown)=>normalizeZapiEvent({...base,contact});
const body=(contact:unknown)=>JSON.parse(card(contact).text!);
describe('shared contact webhook capture',()=>{
 it('keeps explicit card numbers distinct from the sender and drops unrelated vCard PII',()=>{
  const event=card({displayName:'Contato sintético',phones:['5585999990002'],vCard:'BEGIN:VCARD\nVERSION:3.0\nFN:Contato sintético\nTEL;type=CELL;waid=5585999990002:+55 85 99999-0002\nEMAIL:private@example.invalid\nPHOTO:https://private.invalid/photo\nEND:VCARD'});
  expect(event.kind).toBe('text');expect(event.chatExternalId).toBe(base.phone);
  expect(JSON.parse(event.text!)).toEqual({type:'shared_contact',untrusted:true,displayName:'Contato sintético',phones:['+5585999990002'],phoneExtractionComplete:true});
  expect(event.text).not.toMatch(/EMAIL|PHOTO|private\.invalid|BEGIN:VCARD/);
 });
 it('reads folded TEL and waid without guessing a country or discarding conflicting numbers',()=>{
  expect(body({vCard:'BEGIN:VCARD\r\nFN:Teste\r\nTEL;waid=5585999990003:99999-0003\r\nTEL;TYPE=CELL:tel:+55 85\r\n 99999-0004\r\nTEL:99999-0005\r\nEND:VCARD'})).toEqual({type:'shared_contact',untrusted:true,displayName:'Teste',phones:['+5585999990003','+5585999990004'],phoneExtractionComplete:false});
 });
 it('does not turn LIDs, prose, extensions, or empty cards into an address',()=>{
  const result=body({displayName:'Teste',phones:['12345678@lid','call 5585999990002','+5585999990002 ext 3']});
  expect(result.phones).toEqual([]);expect(result.phoneExtractionComplete).toBe(false);
  expect(card({displayName:'Sem telefone'}).kind).toBe('text');
 });
 it('ignores a null contact on a valid text webhook',()=>{
  expect(normalizeZapiEvent({...base,contact:null,text:{message:'Texto válido'}})).toMatchObject({kind:'text',text:'Texto válido'});
 });
 it('reads grouped vCard telephone properties instead of claiming a partial number list is complete',()=>{
  expect(body({phones:['5585999990002'],vCard:'BEGIN:VCARD\nitem1.TEL:+5585999990003\nEND:VCARD'}).phones).toEqual(['+5585999990002','+5585999990003']);
 });
 it('does not silently publish a partial oversized card',()=>{
  expect(card({displayName:'Teste',vCard:'X'.repeat(17000)})).toMatchObject({kind:'unavailable',unavailableReason:'shared_contact_too_large'});
 });
 it('archives and returns a card with the sender identity and exact read provenance',async()=>{
  const e:Env={...env,OWNER_SUB:'owner',INSTALLATION_EPOCH:'card-e',CONNECTION_GENERATION:'card-g',CONNECTED_PHONE:'synthetic-device',MAINTENANCE:'false',RUNTIME_CONFIG:'static',DEVELOPMENT:'true',ASSISTANT_READER_SECRET:'shared-contact-synthetic-reader-secret-long'};
  const fence={epoch:'card-e',generation:'card-g'};
  const {items}=await upsertDirectoryPage(e,fence,{items:[{externalId:base.phone,kind:'individual',name:'Remetente sintético'}],complete:true});
  const event=card({displayName:'Contato sintético',phones:['5585999990002']});
  await ingestEvent(e,fence,event);
  const result=await queryMessages(e,{chatId:items[0].id});
  expect(result.items).toHaveLength(1);expect(JSON.parse(result.items[0].text!).phones).toEqual(['+5585999990002']);
  const proof=await ownerToolProvenance(e,{installationId:'synthetic',generation:'g',sourceEpoch:'card-e',sourceGeneration:'card-g'},'consultar_mensagens',{content:[{type:'text',text:JSON.stringify(result)}]});
  expect(proof.origins).toEqual([expect.objectContaining({sourceKind:'message',sourceId:result.items[0].id,chatId:items[0].id,sourceVersion:1})]);
  expect(await env.DB.prepare('SELECT COUNT(*) n FROM actions WHERE chat_id=?').bind(items[0].id).first('n')).toBe(0);
  const selected=JSON.parse(result.items[0].text!).phones[0];
  const recipient=await resolveRecipient(e,{phone:selected,alias:'Contato sintético'},{status:async()=>({connected:true,phone:'synthetic-device'})});
  expect(recipient.chatId).not.toBe(items[0].id);expect(recipient.messageAttempted).toBe(false);
  const action=await prepareAction(e,{chatId:recipient.chatId,kind:'text',text:'Mensagem sintética solicitada pelo dono'});
  expect(await env.DB.prepare('SELECT attempted_at FROM actions WHERE id=?').bind(action.id).first('attempted_at')).toBeNull();
  expect(await env.DB.prepare('SELECT external_id FROM chats WHERE id=?').bind(recipient.chatId).first('external_id')).toBe('5585999990002');
 });
});
