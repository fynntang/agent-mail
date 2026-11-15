import {publicMailHttpsUrl} from './mail-html';

export const MAIL_IMAGE_MAX_COUNT=8;
export const MAIL_IMAGE_MAX_BYTES=1024*1024;
export const MAIL_IMAGE_TOTAL_BYTES=4*1024*1024;
export const MAIL_IMAGE_DEADLINE_MS=8000;
const MAX_REDIRECTS=2,MAX_DIMENSION=4096,MAX_PIXELS=16_000_000;
const redirectStatuses=new Set([301,302,303,307,308]);
const mimeTypes=new Set(['image/png','image/jpeg','image/gif','image/webp']);

const be16=(bytes:Uint8Array,index:number)=>bytes[index]*256+bytes[index+1];
const le16=(bytes:Uint8Array,index:number)=>bytes[index]+bytes[index+1]*256;
const le24=(bytes:Uint8Array,index:number)=>le16(bytes,index)+bytes[index+2]*65536;
const le32=(bytes:Uint8Array,index:number)=>le24(bytes,index)+bytes[index+3]*16777216;
const be32=(bytes:Uint8Array,index:number)=>be16(bytes,index)*65536+be16(bytes,index+2);
const matches=(bytes:Uint8Array,index:number,values:number[])=>values.every((value,offset)=>bytes[index+offset]===value);
const ascii=(bytes:Uint8Array,index:number,value:string)=>Array.from(value).every((char,offset)=>bytes[index+offset]===char.charCodeAt(0));

/** Read raster headers, without decoding pixels or claiming to validate a full image codec. */
function dimensions(bytes:Uint8Array,mime:string):[number,number]|null {
  if(mime==='image/png') {
    if(bytes.length<33||!matches(bytes,0,[137,80,78,71,13,10,26,10])||be32(bytes,8)!==13||!ascii(bytes,12,'IHDR'))return null;
    return [be32(bytes,16),be32(bytes,20)];
  }
  if(mime==='image/gif') {
    if(bytes.length<13||(!ascii(bytes,0,'GIF87a')&&!ascii(bytes,0,'GIF89a')))return null;
    return [le16(bytes,6),le16(bytes,8)];
  }
  if(mime==='image/webp') {
    if(bytes.length<20||!ascii(bytes,0,'RIFF')||!ascii(bytes,8,'WEBP')||le32(bytes,4)+8!==bytes.length)return null;
    const length=le32(bytes,16);
    if(length>bytes.length-20)return null;
    if(ascii(bytes,12,'VP8X')&&length===10&&bytes.length>=30)return [le24(bytes,24)+1,le24(bytes,27)+1];
    if(ascii(bytes,12,'VP8 ')&&length>=10&&bytes.length>=30&&(bytes[20]&1)===0&&matches(bytes,23,[157,1,42]))return [le16(bytes,26)&0x3fff,le16(bytes,28)&0x3fff];
    if(ascii(bytes,12,'VP8L')&&length>=5&&bytes.length>=25&&bytes[20]===47) {
      const packed=le32(bytes,21);
      if(Math.floor(packed/536870912)!==0)return null;
      return [(packed&0x3fff)+1,((packed>>>14)&0x3fff)+1];
    }
    return null;
  }
  if(mime==='image/jpeg') {
    if(bytes.length<4||!matches(bytes,0,[255,216,255]))return null;
    let index=2;
    while(index<bytes.length) {
      if(bytes[index++]!==255)return null;
      while(bytes[index]===255)index++;
      const marker=bytes[index++];
      if(marker===undefined||marker===0||marker===216||marker===217||marker===218)return null;
      if(marker===1||(marker>=208&&marker<=215))continue;
      if(index+2>bytes.length)return null;
      const length=be16(bytes,index);
      if(length<2||index+length>bytes.length)return null;
      if(marker>=192&&marker<=207&&![196,200,204].includes(marker)) {
        if(length<8)return null;
        const components=bytes[index+7];
        if(components<1||components>4||length!==8+components*3)return null;
        return [be16(bytes,index+5),be16(bytes,index+3)];
      }
      index+=length;
    }
  }
  return null;
}
/** MIME + raster canvas header validation; shared by remote and private CID images. */
export function rasterImageDataUri(bytes:Uint8Array,mime:string):string|null {
  mime=mime.split(';',1)[0].trim().toLowerCase();
  if(bytes.byteLength<1||bytes.byteLength>MAIL_IMAGE_MAX_BYTES||!mimeTypes.has(mime))return null;
  const size=dimensions(bytes,mime);
  if(!size||size.some(value=>!Number.isInteger(value)||value<1||value>MAX_DIMENSION)||size[0]*size[1]>MAX_PIXELS)return null;
  // Avoid a spread of a megabyte-sized array, which exceeds JS argument limits.
  let binary='';
  for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
  return `data:${mime};base64,${btoa(binary)}`;
}
function cancelBody(response:Response):void {void response.body?.cancel().catch(()=>{});}

/**
 * Call only after the Owner explicitly opts into this verified message's image URLs.
 * SSRF's network boundary is Cloudflare's global fetch, with global_fetch_strictly_public
 * enabled and no private/global-outbound override. Never replace it with a service/VPC/origin
 * binding. A separate DNS check is not address pinning and is intentionally not used here.
 * Only bounded raster bytes are returned; sender URLs and upstream headers never reach the frame.
 */
export async function fetchMailImages(urls:string[],blockedOrigins:string[],budget:{maxCount?:number;maxBytes?:number}={}):Promise<Map<string,string>> {
  const limit=(value:number|undefined,cap:number)=>value===undefined?cap:Number.isSafeInteger(value)&&value>=0?Math.min(value,cap):0;
  const maxCount=limit(budget.maxCount,MAIL_IMAGE_MAX_COUNT),maxBytes=limit(budget.maxBytes,MAIL_IMAGE_TOTAL_BYTES);
  const blocked=new Set(blockedOrigins.flatMap(value=>{try{return [new URL(value).origin];}catch{return [];}}));
  const replacements=new Map<string,string>(),seen=new Set<string>();
  const controller=new AbortController();
  let timedOut=false,totalBytes=0,timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_resolve,reject)=>{
    timer=setTimeout(()=>{timedOut=true;controller.abort();reject(new Error('mail_image_timeout'));},MAIL_IMAGE_DEADLINE_MS);
  });
  const bounded=<T>(operation:Promise<T>):Promise<T>=>Promise.race([operation,deadline]);
  try {
    for(const original of urls) {
      if(timedOut||totalBytes>=maxBytes||seen.size>=maxCount)break;
      let current=publicMailHttpsUrl(original,blocked);
      if(!current||seen.has(current))continue;
      seen.add(current);
      try {
        let response:Response|undefined;
        for(let redirects=0;redirects<=MAX_REDIRECTS;redirects++) {
          // A fresh request has no Owner cookies/JWT, Origin, Referer, or upstream credentials.
          const fetched=await bounded(fetch(current,{method:'GET',redirect:'manual',cache:'no-store',signal:controller.signal,
            headers:{Accept:'image/png,image/jpeg,image/gif,image/webp','Accept-Encoding':'identity'}}).then(value=>{
              if(controller.signal.aborted){cancelBody(value);throw new Error('mail_image_timeout');}
              return value;
            }));
          response=fetched;
          if(!redirectStatuses.has(fetched.status))break;
          cancelBody(fetched);
          const location=fetched.headers.get('Location');
          if(!location||redirects===MAX_REDIRECTS)throw new Error('mail_image_redirect');
          // Resolve relative locations first, then apply the entire URL policy to every hop.
          current=publicMailHttpsUrl(new URL(location,current).href,blocked);
          if(!current)throw new Error('mail_image_redirect');
        }
        if(!response)continue;
        const mime=(response.headers.get('Content-Type')??'').split(';',1)[0].trim().toLowerCase();
        const encoding=response.headers.get('Content-Encoding');
        const length=response.headers.get('Content-Length');
        if(response.status!==200||!mimeTypes.has(mime)||(encoding&&encoding.toLowerCase()!=='identity')
          ||(length!==null&&(!/^\d+$/.test(length)||Number(length)>Math.min(MAIL_IMAGE_MAX_BYTES,maxBytes-totalBytes)))||!response.body) {
          cancelBody(response);continue;
        }
        const reader=response.body.getReader(),chunks:Uint8Array[]=[];
        let bytesRead=0;
        try {
          while(true) {
            const chunk=await bounded(reader.read());
            if(chunk.done)break;
            bytesRead+=chunk.value.byteLength;totalBytes+=chunk.value.byteLength;
            if(bytesRead>MAIL_IMAGE_MAX_BYTES||totalBytes>maxBytes)throw new Error('mail_image_too_large');
            chunks.push(chunk.value);
          }
        }finally {void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
        const bytes=new Uint8Array(bytesRead);
        let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
        const uri=rasterImageDataUri(bytes,mime);
        if(uri)replacements.set(original,uri);
      }catch {
        // A broken/blocked/slow image keeps its placeholder; other eligible images may still load.
      }
    }
  }finally {clearTimeout(timer!);controller.abort();}
  return replacements;
}
