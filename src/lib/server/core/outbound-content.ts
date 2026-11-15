import {ServiceError} from './types';
import {safeAttachmentFilename,safeAttachmentContentType} from './attachment-metadata';
import {Parser} from 'htmlparser2';
import {normalizeMailCidUrl,normalizeMailContentId} from './mail-cid';
import {sanitizeMailHtml} from './mail-html';
import {rasterImageDataUri} from './mail-images';
import type {DraftContent,DraftAttachmentRef,DraftInlineImage} from '../../types/outbound';
export type {DraftContent,DraftAttachmentRef} from '../../types/outbound';

export interface LoadedDraftAttachment {attachment:DraftAttachmentRef;bytes:Uint8Array}
const encoder=new TextEncoder();
const controls=/[\x00-\x1f\x7f]/;
export const OUTBOUND_HTML_MAX_BYTES=64*1024;
export function normalizedHtml(value:unknown):string|null {
  if(value===null)return null;
  if(typeof value!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)||/[\uD800-\uDFFF]/u.test(value))throw new ServiceError('invalid_html',400);
  if(encoder.encode(value).byteLength>OUTBOUND_HTML_MAX_BYTES)throw new ServiceError('html_too_large',413);
  // Apply the existing complexity budget without changing the bytes that the Owner approves and sends.
  try{sanitizeMailHtml(value);}catch{throw new ServiceError('invalid_html',400);}
  return value.trim()?value:null;
}
export function normalizedInlineImages(value:unknown):DraftInlineImage[] {
  if(!Array.isArray(value)||value.length>8)throw new ServiceError('invalid_inline_images',400);
  const attachments=new Set<string>(),ids=new Set<string>();
  return value.map(item=>{
    const data=objectInput(item,['attachmentId','contentId']);
    if(typeof data.attachmentId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(data.attachmentId)
      ||typeof data.contentId!=='string'||data.contentId.length>984||normalizeMailContentId(data.contentId)!==data.contentId
      ||attachments.has(data.attachmentId)||ids.has(data.contentId))throw new ServiceError('invalid_inline_images',400);
    attachments.add(data.attachmentId);ids.add(data.contentId);
    return {attachmentId:data.attachmentId,contentId:data.contentId};
  });
}
/** A saved draft may temporarily reference missing CIDs; approval and submission require complete verified images. */
export function validateInlineImages(content:DraftContent,files?:LoadedDraftAttachment[],{complete=false}:{complete?:boolean}={}):void {
  if(content.html!==undefined)normalizedHtml(content.html);
  const bindings=content.inlineImages===undefined?[]:normalizedInlineImages(content.inlineImages),refs=content.attachments??[];
  if(bindings.length&&(!content.html||!content.html.trim()))throw new ServiceError('invalid_inline_images',400);
  if(bindings.some(binding=>!refs.some(ref=>ref.id===binding.attachmentId)))throw new ServiceError('invalid_inline_images',400);
  if(!complete)return;
  const byCid=new Map(bindings.map(binding=>[binding.contentId,binding]));
  const parser=new Parser({onopentag(name,attrs){
    if(name==='img'&&attrs.src&&/^cid:/i.test(attrs.src.trim())){
      const id=normalizeMailCidUrl(attrs.src);
      if(!id||!byCid.has(id))throw new ServiceError('unresolved_cid',400);
    }
  }},{decodeEntities:true,xmlMode:false});
  parser.end(content.html??'');
  let total=0;
  for(const binding of bindings){
    const file=files?.find(item=>item.attachment.id===binding.attachmentId);
    if(!file||!rasterImageDataUri(file.bytes,file.attachment.contentType))throw new ServiceError('inline_image_invalid',400);
    total+=file.bytes.byteLength;if(total>4*1024*1024)throw new ServiceError('inline_images_too_large',413);
  }
}
export function normalizedAttachmentRefs(value:unknown):DraftAttachmentRef[] {
  if(!Array.isArray(value)||value.length>32)throw new ServiceError('invalid_attachments',400);
  const ids=new Set<string>();let total=0;
  return value.map(part=>{
    const item=objectInput(part,['id','filename','contentType','sizeBytes','sha256']);
    if(typeof item.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id)||ids.has(item.id)
      ||typeof item.filename!=='string'||item.filename!==safeAttachmentFilename(item.filename)
      ||typeof item.contentType!=='string'||item.contentType!==safeAttachmentContentType(item.contentType)
      ||typeof item.sizeBytes!=='number'||!Number.isSafeInteger(item.sizeBytes)||item.sizeBytes<0||item.sizeBytes>5*1024*1024
      ||typeof item.sha256!=='string'||!/^[0-9a-f]{64}$/.test(item.sha256))throw new ServiceError('invalid_attachments',400);
    total+=item.sizeBytes;if(total>5*1024*1024)throw new ServiceError('attachments_too_large',413);ids.add(item.id);
    return {id:item.id,filename:item.filename,contentType:item.contentType,sizeBytes:item.sizeBytes,sha256:item.sha256};
  });
}
export function externalAddress(value:unknown):string {
  if(typeof value!=='string'||controls.test(value)) throw new ServiceError('invalid_recipient',400);
  const address=value.trim(),parts=address.split('@');
  if(parts.length!==2) throw new ServiceError('invalid_recipient',400);
  const [local,host]=parts,domain=host.toLowerCase();
  if(address.length>254||!local||local.length>64||!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    ||local.startsWith('.')||local.endsWith('.')||local.includes('..')||!domain.includes('.')||domain.length>253
    ||!domain.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new ServiceError('invalid_recipient',400);
  return `${local}@${domain}`;
}
export function objectInput(input:unknown,keys:string[]):Record<string,unknown> {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key))) throw new ServiceError('invalid_input',400);
  return input as Record<string,unknown>;
}
export function normalizedContent(input:Record<string,unknown>):DraftContent {
  const seen=new Set<string>();
  const groups={to:[] as string[],cc:[] as string[],bcc:[] as string[]};
  for(const kind of ['to','cc','bcc'] as const) {
    const values=input[kind]??[];
    if(!Array.isArray(values)||values.length>50) throw new ServiceError('invalid_recipients',400);
    for(const value of values) {
      const address=externalAddress(value);
      if(!seen.has(address)) {seen.add(address);groups[kind].push(address);}
    }
  }
  if(seen.size>50) throw new ServiceError('too_many_recipients',400);
  const subject=input.subject??'',text=input.text??'';
  if(typeof subject!=='string'||subject.length>512||controls.test(subject)||/[\uD800-\uDFFF]/u.test(subject)) throw new ServiceError('invalid_subject',400);
  if(typeof text!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||/[\uD800-\uDFFF]/u.test(text)||encoder.encode(text).length>64*1024) throw new ServiceError('invalid_text',400);
  return {...groups,subject,text,replyMessageId:null,inReplyTo:null,
    ...(input.attachments===undefined?{}:{attachments:normalizedAttachmentRefs(input.attachments)}),
    ...(input.html===undefined?{}:{html:normalizedHtml(input.html)}),
    ...(input.inlineImages===undefined?{}:{inlineImages:normalizedInlineImages(input.inlineImages)})};
}
export function replyHeader(value:unknown):string|null {
  return typeof value==='string'&&value.length<=900&&/^[\x21-\x7e]+$/.test(value)&&/^<[^@\s<>]+@[^@\s<>]+>$/.test(value)?value:null;
}
function materialized(content:DraftContent,files:LoadedDraftAttachment[]):LoadedDraftAttachment[] {
  const refs=content.attachments??[];
  normalizedAttachmentRefs(refs);
  if(refs.length!==files.length||refs.some((ref,index)=>JSON.stringify(ref)!==JSON.stringify(files[index].attachment)||files[index].bytes.byteLength!==ref.sizeBytes))throw new ServiceError('content_corrupt',409);
  return files;
}
export function binaryBase64(bytes:Uint8Array):string {
  const chunks:string[]=[];
  for(let offset=0;offset<bytes.byteLength;offset+=32768)chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+32768)));
  return btoa(chunks.join(''));
}
export function providerMessage(from:string,content:DraftContent,files:LoadedDraftAttachment[]=[]):EmailMessageBuilder {
  materialized(content,files);
  validateInlineImages(content,files,{complete:true});
  const inline=new Map((content.inlineImages??[]).map(binding=>[binding.attachmentId,binding.contentId]));
  return {from,to:content.to,cc:content.cc,bcc:content.bcc,subject:content.subject,text:content.text,
    ...(content.html?{html:content.html}:{}),
    ...(files.length?{attachments:files.map(({attachment,bytes})=>{
      const file={content:binaryBase64(bytes),filename:attachment.filename,type:attachment.contentType},contentId=inline.get(attachment.id);
      return contentId?{...file,disposition:'inline' as const,contentId}:{...file,disposition:'attachment' as const};
    })}:{}),
    ...(content.inReplyTo?{headers:{'In-Reply-To':content.inReplyTo,References:content.inReplyTo}}:{})};
}
function base64(text:string):string {let binary='';for(const byte of encoder.encode(text)) binary+=String.fromCharCode(byte);return btoa(binary);}
function encodedSubject(text:string):string {
  const words:string[]=[];let chunk='',size=0;
  for(const char of text) {
    const bytes=encoder.encode(char).length;
    if(size+bytes>42&&chunk) {words.push(`=?UTF-8?B?${base64(chunk)}?=`);chunk='';size=0;}
    chunk+=char;size+=bytes;
  }
  if(chunk) words.push(`=?UTF-8?B?${base64(chunk)}?=`);
  return words.join('\r\n ');
}
function attachmentDisposition(filename:string,disposition:'inline'|'attachment'='attachment'):string {
  const ascii=filename.replace(/[^\x20-\x7e]|["\\]/g,'_');
  if(/^[\x20-\x7e]+$/.test(filename))return `Content-Disposition: ${disposition}; filename="${ascii}"`;
  const encoded=encodeURIComponent(filename).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const chunks:string[]=[];let current='';
  for(const token of encoded.match(/%[0-9A-F]{2}|./g)??[]){if(current.length+token.length>54){chunks.push(current);current='';}current+=token;}
  if(current)chunks.push(current);
  // Use one unambiguous RFC2231 spelling; parsers differ on precedence when plain and extended names coexist.
  return `Content-Disposition: ${disposition};\r\n `+chunks.map((chunk,index)=>`filename*${index}*=${index===0?"UTF-8''":''}${chunk}`).join(';\r\n ');
}
export function localSentCopy(id:string,from:string,content:DraftContent,now:number,files:LoadedDraftAttachment[]=[]):string {
  materialized(content,files);
  validateInlineImages(content,files,{complete:true});
  const addressLine=(name:string,values:string[])=>values.length?`${name}: ${values.join(',\r\n ')}`:null;
  const headers=[`From: ${from}`,addressLine('To',content.to),addressLine('Cc',content.cc),`Subject: ${encodedSubject(content.subject)}`,
    `Date: ${new Date(now).toUTCString()}`,`Message-ID: <${id}.local@agent-mail.invalid>`,
    ...(content.inReplyTo?[`In-Reply-To: ${content.inReplyTo}`,`References: ${content.inReplyTo}`]:[]),
    'X-Agent-Mail-Copy: local-not-provider-mime','MIME-Version: 1.0'];
  if(content.html){
    const wrap=(type:string,value:string)=>`Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(value).match(/.{1,76}/g)?.join('\r\n')??''}\r\n`;
    const multipart=(type:string,suffix:string,parts:string[])=>{
      const boundary=`agent-mail-${id}-${suffix}`;
      return `Content-Type: multipart/${type}; boundary="${boundary}"\r\n\r\n${parts.map(part=>`--${boundary}\r\n${part}`).join('')}--${boundary}--\r\n`;
    };
    const inline=new Map((content.inlineImages??[]).map(binding=>[binding.attachmentId,binding.contentId]));
    const part=({attachment,bytes}:LoadedDraftAttachment)=>`Content-Type: ${attachment.contentType}\r\n${attachmentDisposition(attachment.filename,inline.has(attachment.id)?'inline':'attachment')}\r\n${inline.has(attachment.id)?`Content-ID: <${inline.get(attachment.id)}>\r\n`:''}Content-Transfer-Encoding: base64\r\n\r\n${binaryBase64(bytes).match(/.{1,76}/g)?.join('\r\n')??''}\r\n`;
    const related=files.filter(file=>inline.has(file.attachment.id)),attachments=files.filter(file=>!inline.has(file.attachment.id));
    const html=wrap('text/html',content.html);
    const alternative=multipart('alternative','alternative',[wrap('text/plain',content.text),related.length?multipart('related','related',[html,...related.map(part)]):html]);
    const body=attachments.length?multipart('mixed','mixed',[alternative,...attachments.map(part)]):alternative;
    return headers.filter(value=>value!==null).join('\r\n')+'\r\n'+body;
  }
  if(files.length){
    const boundary=`agent-mail-${id}`;
    const text=`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(content.text).match(/.{1,76}/g)?.join('\r\n')??''}\r\n`;
    const parts=files.map(({attachment,bytes})=>`--${boundary}\r\nContent-Type: ${attachment.contentType}\r\n${attachmentDisposition(attachment.filename)}\r\nContent-Transfer-Encoding: base64\r\n\r\n${binaryBase64(bytes).match(/.{1,76}/g)?.join('\r\n')??''}\r\n`).join('');
    return [...headers,`Content-Type: multipart/mixed; boundary="${boundary}"`].filter(value=>value!==null).join('\r\n')+`\r\n\r\n${text}${parts}--${boundary}--\r\n`;
  }
  return [...headers,'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64'].filter(x=>x!==null).join('\r\n')+'\r\n\r\n'+(base64(content.text).match(/.{1,76}/g)?.join('\r\n')??'')+'\r\n';
}
