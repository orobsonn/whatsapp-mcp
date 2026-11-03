/** Bounded structural JPEG inspection; no decoding or byte repair. EOI must
 * follow a scan, never a marker-looking byte pair inside EXIF/APP metadata. */
export function jpegStructure(bytes:Uint8Array):{width:number;height:number;end:number}|null{
 if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)return null;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let at=2,width=0,height=0,scan=false,inScan=false;
 while(at<bytes.length){
  if(inScan){
   while(at<bytes.length&&bytes[at]!==0xff)at++;
  }
  if(at>=bytes.length||bytes[at++]!==0xff)return null;
  while(at<bytes.length&&bytes[at]===0xff)at++;
  if(at>=bytes.length)return null;
  const marker=bytes[at++];
  if(inScan&&(marker===0x00||(marker>=0xd0&&marker<=0xd7)))continue;
  inScan=false;
  if(marker===0xd9)return scan&&width>0&&height>0?{width,height,end:at}:null;
  if(marker===0x00||marker===0xd8||(marker>=0xd0&&marker<=0xd7))return null;
  if(marker===0x01)continue;
  if(at+2>bytes.length)return null;
  const length=view.getUint16(at);if(length<2||at+length>bytes.length)return null;
  if([0xc0,0xc1,0xc2].includes(marker)){
   if(length<8)return null;
   height=view.getUint16(at+3);width=view.getUint16(at+5);
  }
  if(marker===0xda){if(length<6||!width||!height)return null;scan=true;inScan=true;}
  at+=length;
 }
 return null;
}
