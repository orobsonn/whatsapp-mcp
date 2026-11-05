/** A small projection of the documented Z-API contact webhook, never a vCard
 * interpreter or an authorization grant. No URLs, notes or other PII survive. */
export function sharedContactText(value: unknown): {text?:string;reason?:string} {
 if(!value||typeof value!=='object'||Array.isArray(value))return {reason:'shared_contact_invalid'};
 const contact=value as Record<string,unknown>;
 if(new TextEncoder().encode(JSON.stringify(contact)).length>16384)return {reason:'shared_contact_too_large'};
 const vcard=typeof contact.vCard==='string'?contact.vCard:'';
 const lines=vcard.replace(/\r\n[ \t]|\n[ \t]/g,'').split(/\r\n|\n|\r/);
 if(lines.length>256)return {reason:'shared_contact_too_large'};
 if(lines.filter(line=>/^BEGIN:VCARD$/i.test(line)).length>1)return {reason:'shared_contact_invalid'};
 let complete=true;
 const phones=new Set<string>();
 function add(value:unknown,internationalDigits:boolean){
  if(typeof value!=='string'||value.length>64){complete=false;return;}
  const raw=value.trim().replace(/^tel:/i,'');
  // Strip only visual phone separators, never letters, extensions or LIDs.
  if(!/^\+?[0-9 ()-]+$/.test(raw)){complete=false;return;}
  const number=raw.replace(/[ ()-]/g,'');
  const e164=number.startsWith('+')?number:internationalDigits?'+'+number:'';
  if(!/^\+[1-9][0-9]{7,14}$/.test(e164)){complete=false;return;}
  phones.add(e164);
 }
 if(contact.phones!==undefined){
  if(!Array.isArray(contact.phones))complete=false;
  else {
   if(contact.phones.length>20)return {reason:'shared_contact_too_large'};
   for(const phone of contact.phones)add(phone,true);
  }
 }
 let fallbackName='';
 for(const line of lines){
  const colon=line.indexOf(':');if(colon<0)continue;
  const header=line.slice(0,colon).replace(/^[a-z0-9-]+\./i,''),body=line.slice(colon+1);
  if(/^FN$/i.test(header))fallbackName=body.replace(/\\[nN]/g,' ').replace(/\\([,;\\])/g,'$1');
  if(!/^TEL(?:;|$)/i.test(header))continue;
  for(const parameter of header.split(';').slice(1)){
   const match=/^waid=([1-9][0-9]{7,14})$/i.exec(parameter);
   if(match)add(match[1],true);
  }
  add(body,false);
  if(phones.size>20)return {reason:'shared_contact_too_large'};
 }
 const name=typeof contact.displayName==='string'?contact.displayName:fallbackName;
 const displayName=name.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,128);
 return {text:JSON.stringify({type:'shared_contact',untrusted:true,displayName,phones:[...phones],phoneExtractionComplete:complete&&phones.size>0})};
}
