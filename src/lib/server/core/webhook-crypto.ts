import {publicMailHttpsUrl} from './mail-html';
import {ServiceError,type RuntimeEnv} from './types';

const encoder=new TextEncoder();
function base64url(bytes:Uint8Array):string{return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function decode(value:unknown,length?:number):Uint8Array<ArrayBuffer> {
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value)||value.length>1024)throw new Error('encoding');
  const bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),char=>char.charCodeAt(0));
  if(base64url(bytes)!==value||length!==undefined&&bytes.byteLength!==length)throw new Error('encoding');return bytes;
}
function keyring(env:RuntimeEnv):{activeKid:string;keys:Record<string,string>} {
  try{
    if(!env.WEBHOOK_KEYRING||env.WEBHOOK_KEYRING.length>4096)throw new Error();
    const data=JSON.parse(env.WEBHOOK_KEYRING);
    if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).sort().join(',')!=='activeKid,keys'
      ||typeof data.activeKid!=='string'||!data.keys||typeof data.keys!=='object'||Array.isArray(data.keys)
      ||Object.keys(data.keys).length<1||Object.keys(data.keys).length>8||!Object.hasOwn(data.keys,data.activeKid))throw new Error();
    for(const [kid,key] of Object.entries(data.keys)){if(!/^[A-Za-z0-9_-]{1,32}$/.test(kid))throw new Error();decode(key,32);}
    return data;
  }catch{throw new ServiceError('webhooks_not_configured',503);}
}
export function webhookConfigured(env:RuntimeEnv):boolean{try{keyring(env);return true;}catch{return false;}}
export function newWebhookSecret():string{return `whsec_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;}
function aad(box:string,endpoint:string,version:number):Uint8Array<ArrayBuffer>{return new Uint8Array(encoder.encode(`agent-mail:webhook:v1:${box}:${endpoint}:${version}`));}
export async function encryptWebhookSecret(env:RuntimeEnv,box:string,endpoint:string,version:number,secret:string):Promise<string>{
  const ring=keyring(env),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await crypto.subtle.importKey('raw',decode(ring.keys[ring.activeKid],32),'AES-GCM',false,['encrypt']);
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(box,endpoint,version)},key,encoder.encode(secret));
  return JSON.stringify({v:1,kid:ring.activeKid,iv:base64url(iv),data:base64url(new Uint8Array(encrypted))});
}
export async function decryptWebhookSecret(env:RuntimeEnv,box:string,endpoint:string,version:number,ciphertext:string):Promise<string>{
  const ring=keyring(env);
  try{
    if(ciphertext.length>1024)throw new Error();const data=JSON.parse(ciphertext);
    if(!data||data.v!==1||typeof data.kid!=='string'||!Object.hasOwn(ring.keys,data.kid)
      ||Object.keys(data).sort().join(',')!=='data,iv,kid,v')throw new Error();
    const key=await crypto.subtle.importKey('raw',decode(ring.keys[data.kid],32),'AES-GCM',false,['decrypt']);
    const result=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(data.iv,12),additionalData:aad(box,endpoint,version)},key,decode(data.data));
    const secret=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(result);
    if(!/^whsec_[A-Za-z0-9_-]{43}$/.test(secret))throw new Error();decode(secret.slice(6),32);return secret;
  }catch{throw new ServiceError('webhook_secret_unavailable',503);}
}
export async function signWebhook(secret:string,timestamp:string,deliveryId:string,body:string):Promise<string>{
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('HMAC',key,encoder.encode(`${timestamp}.${deliveryId}.${body}`));
  return [...new Uint8Array(signature)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function validateWebhookUrl(env:RuntimeEnv,value:unknown):string{
  const origins=new Set([env.CONSOLE_ORIGIN,env.API_ORIGIN].flatMap(value=>{try{return [new URL(value).origin];}catch{return [];}}));
  const url=typeof value==='string'?publicMailHttpsUrl(value,origins):null;
  if(!url||url.includes('#'))throw new ServiceError('invalid_webhook_url',400);return url;
}
