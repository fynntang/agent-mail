import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {seedMessages} from '../helpers/mail-fixtures.mjs';
import {createMailbox,updateMailbox,retireMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {getMessage,getOwnerMessageHtml} from '../../src/lib/server/core/mail';
import {ingestEmail} from '../../src/lib/server/core/ingest';
import {claimParseJob,parseEmail} from '../../src/lib/server/core/jobs';
import {sha256} from '../../src/lib/server/core/crypto';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,runtime:Parameters<typeof seedMessages>[0];
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'html-body-core'},r2Buckets:{MAIL_BLOBS:'html-body-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())
    await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(query=>db.prepare(query)));
  const bucket=await mf.getR2Bucket('MAIL_BLOBS');runtime={db,bucket};
  ctx={env:{DB:db,MAIL_BLOBS:bucket,MAIL_DOMAIN:'agent.example.com',CONSOLE_ORIGIN:'https://console.example.com',API_ORIGIN:'https://api.example.com'} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterAll(async()=>{await mf?.dispose();});
const mailbox=()=>createMailbox(ctx,{name:'HTML reader',localPart:`html-${crypto.randomUUID()}`});
async function replaceBody(boxId:string,messageId:string,body:unknown,{raw=false,format='v3'}={}) {
  const id=crypto.randomUUID(),key=`${boxId}/body/${format}/${id}.json`,now=Date.now();
  const serialized=raw?String(body):JSON.stringify(body);
  await runtime.bucket.put(key,serialized,{httpMetadata:{contentType:'application/json'}});
  await runtime.db.batch([
    runtime.db.prepare(`INSERT INTO objects(id,mailbox_id,object_key,purpose,state,size_bytes,sha256,content_type,created_at,ready_at)
      VALUES(?,?,?,'body','ready',?,?,'application/json',?,?)`).bind(id,boxId,key,Buffer.byteLength(serialized),await sha256(serialized),now,now),
    runtime.db.prepare('UPDATE messages SET body_object_id=? WHERE id=? AND mailbox_id=?').bind(id,messageId,boxId)
  ]);
  return {id,key,serialized};
}
async function fixture(body:unknown) {
  const box=await mailbox(),[message]=await seedMessages(runtime,box.id);
  const object=await replaceBody(box.id,message.id,body);return {box,message,object};
}
async function receive(raw:string) {
  const box=await mailbox(),bytes=new TextEncoder().encode(raw);
  const receiptId=await ingestEmail({from:'sender@example.net',to:box.address,rawSize:bytes.byteLength,
    raw:new Response(bytes).body,setReject(){throw new Error('Unexpected reject');}} as unknown as ForwardableEmailMessage,ctx.env);
  const job=await claimParseJob(ctx.env,Date.now());expect(job?.mailbox_id).toBe(box.id);
  expect(await parseEmail(ctx.env,job!)).toBe(true);
  return {box,messageId:receiptId!,job:job!};
}

it('returns cleaned HTML only through the Owner service, while API/MCP DTOs keep untrusted plain text only',async()=>{
  const {box,message}=await fixture({text:'PLAIN_TEXT_BODY',html:'<h2>Report</h2><script>PRIVATE_HTML_MARKER</script><img src="https://cdn.public.net/pixel.png"><a href="https://docs.public.net/report">Docs</a><img src="https://console.example.com/owner/api/setup">',htmlExtracted:true});
  const detail=await getMessage(ctx,box.id,message.id);
  expect(detail.body).toMatchObject({status:'ready',text:'PLAIN_TEXT_BODY',htmlStatus:'available'});expect(detail.capabilities.htmlRendering).toBe(true);
  expect(JSON.stringify(detail)).not.toContain('PRIVATE_HTML_MARKER');expect(JSON.stringify(detail)).not.toContain('<h2>');
  const cleaned=await getOwnerMessageHtml(ctx,box.id,message.id);
  expect(cleaned.status).toBe('available');expect(cleaned.html).toContain('Report');expect(cleaned.html).not.toContain('PRIVATE_HTML_MARKER');
  expect(cleaned.html).not.toContain('cdn.public.net');expect(cleaned.blockedImages).toBe(2);expect(cleaned.remoteImages).toBe(1);
  expect(cleaned.links).toEqual([{label:'Docs',url:'https://docs.public.net/report'}]);
  const fetchImage=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=','base64'),{headers:{'Content-Type':'image/png'}}));
  try{
    const allowed=await getOwnerMessageHtml(ctx,box.id,message.id,{allowRemoteImages:true});
    expect(allowed.html).toContain('data:image/png;base64,');expect(allowed.html).not.toContain('https://cdn.public.net');expect(allowed.blockedImages).toBe(1);expect(allowed.loadedImages).toBe(1);
    expect(fetchImage).toHaveBeenCalledTimes(1);expect(allowed).not.toHaveProperty('remoteImageUrls');
  }finally{fetchImage.mockRestore();}
  const token={...ctx,actor:{kind:'token',mailboxId:box.id,tokenId:crypto.randomUUID(),canRead:true} as const};
  const api=await getMessage(token,box.id,message.id);expect(api.capabilities.htmlRendering).toBe(false);
  expect(JSON.stringify(api)).not.toContain('<h2>');expect(JSON.stringify(api)).not.toContain('PRIVATE_HTML_MARKER');
  await expect(getOwnerMessageHtml(token,box.id,message.id)).rejects.toMatchObject({code:'owner_required',status:403});
  await expect(getOwnerMessageHtml({...ctx,actor:null},box.id,message.id)).rejects.toMatchObject({status:401});
  expect(await runtime.db.prepare('SELECT is_read FROM messages WHERE id=?').bind(message.id).first('is_read')).toBe(0);
});

it('distinguishes legacy unextracted HTML, newly absent HTML, oversized and malformed HTML without losing valid plain text',async()=>{
  for(const [body,status] of [
    [{text:'Legacy',htmlExtracted:false},'not_extracted'],
    [{text:'Old body without marker'},'not_extracted'],
    [{text:'New plain mail',html:null,htmlExtracted:true},'not_present'],
    [{text:'Whitespace HTML',html:' \n ',htmlExtracted:true},'not_present'],
    [{text:'Oversized HTML',html:'x'.repeat(512*1024+1),htmlExtracted:true},'too_large'],
    [{text:'Already bounded',html:null,htmlExtracted:true,htmlStatus:'too_large'},'too_large'],
    [{text:'Malformed HTML field',html:123,htmlExtracted:true},'unavailable']
  ] as const){
    const {box,message}=await fixture(body),detail=await getMessage(ctx,box.id,message.id);
    expect(detail.body.status).toBe('ready');expect(detail.body.text).toBe(body.text);expect(detail.body.htmlStatus).toBe(status);
    expect(await getOwnerMessageHtml(ctx,box.id,message.id)).toMatchObject({status,html:null,links:[]});
  }
});

it('checks the same-mailbox message and body purpose before reading private markup, and rejects deleted/retired resources',async()=>{
  const a=await fixture({text:'A',html:'<p>A private HTML</p>',htmlExtracted:true}),b=await fixture({text:'B',html:'<p>B private HTML</p>',htmlExtracted:true});
  await expect(getOwnerMessageHtml(ctx,a.box.id,b.message.id)).rejects.toMatchObject({status:404});
  await runtime.db.prepare('UPDATE messages SET body_object_id=? WHERE id=?').bind(a.message.rawId,a.message.id).run();
  expect(await getOwnerMessageHtml(ctx,a.box.id,a.message.id)).toMatchObject({status:'unavailable',html:null});
  const paused=await updateMailbox(ctx,b.box.id,{status:'paused',expectedUpdatedAt:b.box.updatedAt});
  expect((await getOwnerMessageHtml(ctx,b.box.id,b.message.id)).html).toContain('B private HTML');
  await runtime.db.prepare('UPDATE messages SET deleted_at=? WHERE id=?').bind(Date.now(),b.message.id).run();
  await expect(getOwnerMessageHtml(ctx,b.box.id,b.message.id)).rejects.toMatchObject({status:404});
  await retireMailbox(ctx,paused.id,{confirmAddress:paused.address,expectedUpdatedAt:paused.updatedAt});
  await expect(getOwnerMessageHtml(ctx,paused.id,b.message.id)).rejects.toMatchObject({status:404});
});

it('fails closed on missing, corrupt or malformed body objects without returning private object identities',async()=>{
  for(const failure of ['missing','corrupt','invalid_json','invalid_text'] as const){
    const {box,message,object}=await fixture({text:'Private text',html:'<p>Private markup</p>',htmlExtracted:true});
    if(failure==='missing')await runtime.bucket.delete(object.key);
    if(failure==='corrupt')await runtime.bucket.put(object.key,'CORRUPT_PRIVATE_PAYLOAD');
    if(failure==='invalid_json')await replaceBody(box.id,message.id,'{broken',{raw:true});
    if(failure==='invalid_text')await replaceBody(box.id,message.id,{text:123,html:'<p>Must not escape validation</p>',htmlExtracted:true});
    const html=await getOwnerMessageHtml(ctx,box.id,message.id),detail=await getMessage(ctx,box.id,message.id);
    expect(html).toEqual({status:'unavailable',html:null,blockedImages:0,remoteImages:0,loadedImages:0,inlineImages:0,loadedInlineImages:0,links:[]});
    expect(detail.body).toMatchObject({status:'unavailable',text:null,htmlStatus:'unavailable'});
    expect(JSON.stringify(html)).not.toContain(object.key);expect(JSON.stringify(html)).not.toContain('PRIVATE_PAYLOAD');
  }
});

it('persists versioned HTML-only mail and a bounded plain-text projection without serving original markup through message DTOs',async()=>{
  const {box,messageId}=await receive('From: sender@example.net\r\nSubject: HTML only\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<h1>Readable &amp; safe</h1><p>Hello <b>world</b>.</p><script>EVIL_PROJECTION_SCRIPT</script>');
  const indexed=await runtime.db.prepare('SELECT o.object_key FROM messages m JOIN objects o ON o.id=m.body_object_id AND o.mailbox_id=m.mailbox_id WHERE m.id=?').bind(messageId).first() as {object_key:string}|null;
  expect(indexed?.object_key).toBe(`${box.id}/body/v3/${messageId}.json`);
  const stored=JSON.parse(await (await runtime.bucket.get(indexed!.object_key))!.text());
  expect(stored.htmlExtracted).toBe(true);expect(stored.html).toContain('<h1>');expect(stored.text).toContain('Readable & safe');
  const detail=await getMessage(ctx,box.id,messageId);expect(detail.body.status).toBe('ready');expect(detail.body.text).toContain('Hello world.');
  expect(detail.message.preview).toContain('Readable & safe');expect(detail.body.text).not.toContain('EVIL_PROJECTION_SCRIPT');expect(detail.body.htmlStatus).toBe('available');
  expect(JSON.stringify(detail)).not.toContain('<h1>');expect((await getOwnerMessageHtml(ctx,box.id,messageId)).html).toContain('Readable &amp; safe');
});

it('preserves the MIME text part and indexes mail even when HTML is too large for rendering',async()=>{
  const source=['From: sender@example.net','Subject: Large HTML','MIME-Version: 1.0','Content-Type: multipart/alternative; boundary="large-html"','',
    '--large-html','Content-Type: text/plain; charset=utf-8','','MIME text survives.',
    '--large-html','Content-Type: text/html; charset=utf-8','','<p>'+('x'.repeat(512*1024))+'</p>','--large-html--',''].join('\r\n');
  const {box,messageId}=await receive(source),detail=await getMessage(ctx,box.id,messageId);
  expect(detail.body.text).toContain('MIME text survives.');expect(detail.body.htmlStatus).toBe('too_large');
  expect(await getOwnerMessageHtml(ctx,box.id,messageId)).toMatchObject({status:'too_large',html:null});
  expect(await runtime.db.prepare('SELECT status FROM ingest_receipts WHERE id=?').bind(messageId).first('status')).toBe('indexed');
});

it('never rewrites an old immutable body pointer during an explicit receipt retry',async()=>{
  const {box,messageId,job}=await receive('From: sender@example.net\r\nSubject: Retry HTML\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Retry body</p>');
  const legacy=await replaceBody(box.id,messageId,{text:'LEGACY_TEXT',htmlExtracted:false,attachmentsExtracted:true},{format:'v2'});
  await runtime.db.prepare("UPDATE jobs SET state='pending',available_at=0,lease_token=NULL,lease_until=NULL WHERE id=?").bind(job.id).run();
  const next=await claimParseJob(ctx.env,Date.now());expect(next?.id).toBe(job.id);expect(await parseEmail(ctx.env,next!)).toBe(true);
  expect(await runtime.db.prepare('SELECT body_object_id FROM messages WHERE id=?').bind(messageId).first('body_object_id')).toBe(legacy.id);
  expect(await (await runtime.bucket.get(legacy.key))!.text()).toBe(legacy.serialized);
  const detail=await getMessage(ctx,box.id,messageId);expect(detail.body).toMatchObject({text:'LEGACY_TEXT',htmlStatus:'not_extracted'});
  expect(await runtime.db.prepare('SELECT count(*) n FROM messages WHERE mailbox_id=?').bind(box.id).first('n')).toBe(1);
});
