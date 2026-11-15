import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {seedMessages} from '../helpers/mail-fixtures.mjs';
import {seedAttachment} from '../helpers/attachment-fixtures.mjs';
import {loadCidImages} from '../../src/lib/server/core/mail-cid-images';
import {readAttachment} from '../../src/lib/server/core/attachments';
import {MAIL_IMAGE_MAX_BYTES} from '../../src/lib/server/core/mail-images';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,runtime:Parameters<typeof seedMessages>[0];
const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),char=>char.charCodeAt(0));
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'cid-core'},r2Buckets:{MAIL_BLOBS:'cid-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())
    await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(query=>db.prepare(query)));
  const bucket=await mf.getR2Bucket('MAIL_BLOBS');runtime={db,bucket};
  ctx={env:{DB:db,MAIL_BLOBS:bucket,MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterAll(async()=>{await mf?.dispose();});
async function fixture() {
  const box=await createMailbox(ctx,{name:'CID',localPart:`cid-${crypto.randomUUID()}`});
  const [message]=await seedMessages(runtime,box.id);
  return {box,message};
}
async function attachment(boxId:string,messageId:string,cid:string|null,{bytes=png,contentType='image/png',disposition='inline',scanStatus='unscanned'}={}) {
  const part=await seedAttachment(runtime,boxId,messageId,{bytes,contentType,disposition,scanStatus});
  await runtime.db.prepare('UPDATE attachments SET content_id=? WHERE id=?').bind(cid,part.id).run();
  return part;
}
function trackedContext() {
  const get=vi.fn((...args:unknown[])=>Reflect.apply(ctx.env.MAIL_BLOBS.get,ctx.env.MAIL_BLOBS,args));
  const bucket=new Proxy(ctx.env.MAIL_BLOBS,{get(target,key){
    if(key==='get')return get;
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  return {context:{...ctx,env:{...ctx.env,MAIL_BLOBS:bucket}},get};
}

it('resolves canonical current-message IDs with either attachment disposition, without network or writes',async()=>{
  const {box,message}=await fixture();
  await attachment(box.id,message.id,'<Logo@Agent>',{disposition:'attachment'});
  await attachment(box.id,message.id,'image001.png',{scanStatus:'clean'});
  const {context,get}=trackedContext();
  const loaded=await loadCidImages(context,box.id,message.id,['Logo@Agent','Logo@Agent','image001.png','logo@Agent']);
  expect([...loaded.keys()]).toEqual(['Logo@Agent','image001.png']);
  for(const data of loaded.values())expect(data).toMatch(/^data:image\/png;base64,/);
  expect(get).toHaveBeenCalledTimes(2);
  expect(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read')).toBe(0);
});

it('rejects ambiguous normalized IDs before blob selection even if one duplicate is blocked or not an image',async()=>{
  const {box,message}=await fixture();
  await attachment(box.id,message.id,'<Logo>');
  await attachment(box.id,message.id,'Logo',{scanStatus:'blocked',contentType:'text/plain'});
  await attachment(box.id,message.id,'<logo>');
  const {context,get}=trackedContext();
  const loaded=await loadCidImages(context,box.id,message.id,['Logo','logo']);
  expect([...loaded.keys()]).toEqual(['logo']);expect(get).toHaveBeenCalledTimes(1);
});

it('matches raw persisted IDs rather than display-sanitized control stripping or truncation',async()=>{
  const {box,message}=await fixture();
  await attachment(box.id,message.id,'<safe\u0001id>');
  await attachment(box.id,message.id,'A'.repeat(999));
  const {context,get}=trackedContext();
  expect((await loadCidImages(context,box.id,message.id,['safeid','A'.repeat(998)])).size).toBe(0);
  expect(get).not.toHaveBeenCalled();
});

it('never resolves missing CIDs by searching another message or mailbox and preserves Owner authorization',async()=>{
  const first=await fixture(),second=await fixture();
  const [sameBoxMessage]=await seedMessages(runtime,first.box.id);
  await attachment(first.box.id,sameBoxMessage.id,'<same>');await attachment(second.box.id,second.message.id,'<same>');
  const {context,get}=trackedContext();
  expect((await loadCidImages(context,first.box.id,first.message.id,['same'])).size).toBe(0);expect(get).not.toHaveBeenCalled();
  await expect(loadCidImages(context,first.box.id,second.message.id,['same'])).rejects.toMatchObject({status:404});
  const token={kind:'token' as const,mailboxId:first.box.id,tokenId:crypto.randomUUID(),canRead:true,canReadAttachments:true};
  await expect(loadCidImages({...context,actor:token},first.box.id,first.message.id,['same'])).rejects.toMatchObject({code:'owner_required',status:403});
  await expect(loadCidImages({...context,actor:null},first.box.id,first.message.id,[])).rejects.toMatchObject({status:401});
  await expect(loadCidImages(context,first.box.id,crypto.randomUUID(),[])).rejects.toMatchObject({status:404});
});

it('prefilters oversize, blocked, wrong-purpose/state and unsupported MIME attachments without R2 reads',async()=>{
  const {box,message}=await fixture();
  const tooLarge=new Uint8Array(MAIL_IMAGE_MAX_BYTES+1);tooLarge.set(png);
  await attachment(box.id,message.id,'large',{bytes:tooLarge});
  await attachment(box.id,message.id,'blocked',{scanStatus:'blocked'});
  await attachment(box.id,message.id,'svg',{contentType:'image/svg+xml'});
  await attachment(box.id,message.id,'plain',{contentType:'text/plain'});
  const wrongPurpose=await attachment(box.id,message.id,'purpose'),badState=await attachment(box.id,message.id,'state');
  await runtime.db.prepare('UPDATE attachments SET object_id=? WHERE id=?').bind(message.bodyId,wrongPurpose.id).run();
  await runtime.db.prepare("UPDATE objects SET state='deleted' WHERE id=?").bind(badState.objectId).run();
  const {context,get}=trackedContext();
  expect((await loadCidImages(context,box.id,message.id,['large','blocked','svg','plain','purpose','state'])).size).toBe(0);
  expect(get).not.toHaveBeenCalled();
});

it('keeps missing/corrupt/mismatched raster blobs as placeholders while loading another valid image',async()=>{
  const {box,message}=await fixture();
  const missing=await attachment(box.id,message.id,'missing');await runtime.bucket.delete(missing.key);
  const corrupt=await attachment(box.id,message.id,'corrupt');const altered=png.slice();altered[40]^=1;await runtime.bucket.put(corrupt.key,altered);
  await attachment(box.id,message.id,'wrong-magic',{bytes:new TextEncoder().encode('<svg onload="alert(1)"/>')});
  const largeDimensions=png.slice();largeDimensions.set([0,0,16,1],16);await attachment(box.id,message.id,'dimensions',{bytes:largeDimensions});
  await attachment(box.id,message.id,'valid');
  const loaded=await loadCidImages(ctx,box.id,message.id,['missing','corrupt','wrong-magic','dimensions','valid']);
  expect([...loaded.keys()]).toEqual(['valid']);
});

it('bounds a corrupt physical R2 stream to the CID limit while normal attachment downloads keep their existing limit',async()=>{
  const {box,message}=await fixture(),part=await attachment(box.id,message.id,'corrupt-size');
  let cancelled=false;
  const oversizedBody=new ReadableStream<Uint8Array>({start(stream){stream.enqueue(new Uint8Array(MAIL_IMAGE_MAX_BYTES));stream.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}});
  const bucket=new Proxy(ctx.env.MAIL_BLOBS,{get(target,key){
    if(key==='get')return async()=>({body:oversizedBody});
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}) as R2Bucket;
  expect((await loadCidImages({...ctx,env:{...ctx.env,MAIL_BLOBS:bucket}},box.id,message.id,['corrupt-size'])).size).toBe(0);expect(cancelled).toBe(true);
  const big=new Uint8Array(MAIL_IMAGE_MAX_BYTES+1),large=await attachment(box.id,message.id,'large-file',{bytes:big,contentType:'application/octet-stream'});
  expect((await readAttachment(ctx,box.id,message.id,large.id)).bytes.byteLength).toBe(big.byteLength);
  await expect(readAttachment(ctx,box.id,message.id,large.id,{maxBytes:MAIL_IMAGE_MAX_BYTES})).rejects.toMatchObject({code:'attachment_unavailable'});
  expect((await readAttachment(ctx,box.id,message.id,part.id)).bytes).toEqual(png);
});

it('bounds referenced distinct IDs and total decoded bytes before additional R2 reads',async()=>{
  const {box,message}=await fixture();
  const ids=Array.from({length:9},(_,index)=>`part${index}`);
  for(const id of ids)await attachment(box.id,message.id,id);
  const {context,get}=trackedContext();
  expect((await loadCidImages(context,box.id,message.id,[ids[0],...ids])).size).toBe(8);expect(get).toHaveBeenCalledTimes(8);
  const next=await fixture(),full=new Uint8Array(MAIL_IMAGE_MAX_BYTES);full.set(png);
  for(let index=0;index<5;index++)await attachment(next.box.id,next.message.id,`full${index}`,{bytes:full});
  get.mockClear();
  expect((await loadCidImages(context,next.box.id,next.message.id,Array.from({length:5},(_,index)=>`full${index}`))).size).toBe(4);
  expect(get).toHaveBeenCalledTimes(4);
});

it('does not turn an unavailable attachment index into a whole-message failure or a partial ambiguous result',async()=>{
  const {box,message}=await fixture();
  await attachment(box.id,message.id,'one');
  await runtime.db.prepare("UPDATE messages SET attachments_state='not_extracted' WHERE id=?").bind(message.id).run();
  const {context,get}=trackedContext();
  expect((await loadCidImages(context,box.id,message.id,['one'])).size).toBe(0);expect(get).not.toHaveBeenCalled();
  for(let index=0;index<50;index++)await attachment(box.id,message.id,`part${index}`);
  expect((await loadCidImages(context,box.id,message.id,['one'])).size).toBe(0);expect(get).not.toHaveBeenCalled();
});
