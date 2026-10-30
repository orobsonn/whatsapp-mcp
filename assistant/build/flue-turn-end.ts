import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type {Plugin} from 'vite';
const version='2.3.0';
const chunk='/node_modules/@flue/runtime/dist/conversation-stream-store-CXrgv-b0.mjs';
const digest='a4c828953e70bde8673e25c1e5e30cf7d49d42a8f38e4c82851382fd2260515b';
const before='\t\t\t\t\tawait this.applyQueuedJoins();\n\t\t\t\t\tthis.emit({\n\t\t\t\t\t\ttype: "turn_messages",';
const after='\t\t\t\t\tif (event.message.stopReason !== "error" && event.message.stopReason !== "aborted") await this.applyQueuedJoins();\n\t\t\t\t\tthis.emit({\n\t\t\t\t\t\ttype: "turn_messages",';
/** Pinned upstream seam, applied only by the assistant build. Never rewrites an
 * installed package. Version/source/target changes require explicit review. */
export function patchFlueTurnEnd(code:string,installedVersion:string){
 if(installedVersion!==version)throw Error('assistant_flue_seam_version');
 if(code.split(before).length!==2)throw Error('assistant_flue_seam_target');
 if(createHash('sha256').update(code).digest('hex')!==digest)throw Error('assistant_flue_seam_hash');
 return code.replace(before,after);
}
export function flueTurnEndSeam():Plugin{
 const transformed=new Map<string,number>();let installedVersion:string;
 return {name:'assistant-flue-turn-end-seam',enforce:'pre',apply:'build',
  applyToEnvironment:environment=>environment.config.consumer==='server',
  buildStart(){
   installedVersion=JSON.parse(readFileSync(new URL('../../node_modules/@flue/runtime/package.json',import.meta.url),'utf8')).version;
   if(installedVersion!==version)throw Error('assistant_flue_seam_version');
   transformed.set(this.environment.name,0);
  },
  transform(code,id){
   if(!id.replaceAll('\\','/').split('?')[0].endsWith(chunk))return;
   const name=this.environment.name,count=(transformed.get(name)??0)+1;
   if(count!==1)throw Error('assistant_flue_seam_transform_count');
   const patched=patchFlueTurnEnd(code,installedVersion);transformed.set(name,count);
   return {code:patched,map:null};
  },
  generateBundle(){if(transformed.get(this.environment.name)!==1)throw Error('assistant_flue_seam_transform_count');},
 };
}
