import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {authenticateMailbox} from '../../src/lib/server/core/auth';
import {createMailbox,issueToken,type OwnerContext} from '../../src/lib/server/core/owner';
import {handleMcp} from '../../src/lib/server/mcp/server';
import type {RuntimeEnv} from '../../src/lib/server/core/types';
import {seedMessages} from '../helpers/mail-fixtures.mjs';
import {seedAttachment} from '../helpers/attachment-fixtures.mjs';

let mf:Miniflare,owner:OwnerContext,schema:string[];
beforeAll(async()=>{
  schema=[];
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));
});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'mcp-tools'},r2Buckets:{MAIL_BLOBS:'mcp-tools'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(sql=>db.prepare(sql)));
  owner={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);

async function caller(scopes=['mail:read','mail:draft']) {
  const box=await createMailbox(owner,{name:'MCP tool safety',localPart:`mcp-tool-${crypto.randomUUID()}`});
  const issued=await issueToken(owner,box.id,{name:'MCP caller',scopes});
  const actor=await authenticateMailbox(new Request('https://api.example.com/mcp',{
    headers:{Authorization:`Bearer ${issued.secret}`}
  }),owner.env);
  const ctx:OwnerContext={...owner,actor,requestId:crypto.randomUUID()};
  return {ctx,box,tokenId:issued.token.id};
}

interface ToolResult {
  isError?:boolean;
  structuredContent:Record<string,any>;
  content:{type:string;text?:string}[];
}
async function call(ctx:OwnerContext,name:string,args:Record<string,unknown>={}):Promise<ToolResult> {
  const request=new Request('https://api.example.com/mcp',{method:'POST',headers:{
    Accept:'application/json, text/event-stream','Content-Type':'application/json',
    'MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':name
  },body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args,_meta:{
    'io.modelcontextprotocol/protocolVersion':'2026-07-28',
    'io.modelcontextprotocol/clientInfo':{name:'mcp-tool-safety-tests',version:'1.0.0'},
    'io.modelcontextprotocol/clientCapabilities':{}
  }}})});
  const response=await handleMcp(request,ctx);
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toContain('application/json');
  const envelope=await response.json() as {result?:ToolResult;error?:unknown};
  expect(envelope.error).toBeUndefined();expect(envelope.result).toBeDefined();
  return envelope.result!;
}

it('does not trust a previously authenticated actor after live draft grants are removed or revoked',async()=>{
  for(const change of ['downgraded','revoked'] as const) {
    const {ctx,box,tokenId}=await caller();
    expect(ctx.actor).toMatchObject({kind:'token',canDraft:true});
    // Bypass only the HTTP hook to simulate the gap after authentication and before a callback.
    // The actual Actor above came from the real Token verifier and still carries its stale grant.
    if(change==='downgraded') await owner.env.DB.prepare('UPDATE mailbox_tokens SET can_draft=0 WHERE id=?').bind(tokenId).run();
    else await owner.env.DB.prepare('UPDATE mailbox_tokens SET revoked_at=? WHERE id=?').bind(Date.now(),tokenId).run();
    const result=await call(ctx,'create_draft',{subject:'must not persist',text:'must not persist'});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({error:{code:change==='downgraded'?'insufficient_scope':'unauthorized',status:change==='downgraded'?403:401},requestId:ctx.requestId});
    expect(await owner.env.DB.prepare('SELECT count(*) n FROM drafts WHERE mailbox_id=?').bind(box.id).first('n')).toBe(0);
    expect(await owner.env.DB.prepare("SELECT count(*) n FROM audit_events WHERE mailbox_id=? AND action='draft.created'").bind(box.id).first('n')).toBe(0);
  }
});

it('sanitizes unexpected database failures in both MCP content and logs',async()=>{
  const {ctx}=await caller();
  const privateDiagnostic='D1 SQL secret_sha256 am_PRIVATE_TOKEN R2/mailbox/private-object.eml';
  const brokenDb=new Proxy(ctx.env.DB,{get(target,key){
    if(key==='prepare') return ()=>{throw new Error(privateDiagnostic);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const failing={...ctx,env:{...ctx.env,DB:brokenDb}};
  const errorLog=vi.spyOn(console,'error').mockImplementation(()=>{});
  const result=await call(failing,'create_draft',{subject:'No write'});
  const expected={error:{code:'internal_error',status:500},requestId:ctx.requestId};
  expect(result.isError).toBe(true);expect(result.structuredContent).toEqual(expected);
  expect(result.content).toEqual([{type:'text',text:JSON.stringify(expected)}]);
  expect(errorLog).toHaveBeenCalledWith(JSON.stringify({code:'internal_error',requestId:ctx.requestId}));
  for(const privateValue of [privateDiagnostic,'secret_sha256','am_PRIVATE_TOKEN','private-object.eml']) {
    expect(JSON.stringify(result)).not.toContain(privateValue);expect(JSON.stringify(errorLog.mock.calls)).not.toContain(privateValue);
  }
  expect(await owner.env.DB.prepare('SELECT count(*) n FROM drafts').first('n')).toBe(0);
});

it('enforces the UTF-8 tool result budget before duplicating oversized private metadata',async()=>{
  const {ctx,box}=await caller();
  const [mail]=await seedMessages({db:owner.env.DB,bucket:owner.env.MAIL_BLOBS},box.id,{text:'ordinary body'});
  const marker='PRIVATE_UTF8_METADATA_',hugeName=marker+'秘'.repeat(100_000);
  expect(hugeName.length).toBeLessThan(256*1024);
  expect(new TextEncoder().encode(hugeName).byteLength).toBeGreaterThan(256*1024);
  await owner.env.DB.prepare("UPDATE message_addresses SET display_name=? WHERE message_id=? AND kind='from'").bind(hugeName,mail.id).run();
  const result=await call(ctx,'read_message',{messageId:mail.id});
  const expected={error:{code:'result_too_large',status:413},requestId:ctx.requestId};
  expect(result.isError).toBe(true);expect(result.structuredContent).toEqual(expected);
  expect(result.content).toEqual([{type:'text',text:JSON.stringify(expected)}]);
  const serialized=JSON.stringify(result);
  expect(serialized).not.toContain(marker);expect(serialized).not.toContain('ordinary body');
  expect(serialized).not.toContain(mail.id);expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(4096);
});

it('pages Unicode body text without broken surrogate pairs and preserves unavailable-body status',async()=>{
  const {ctx,box}=await caller();
  const [mail]=await seedMessages({db:owner.env.DB,bucket:owner.env.MAIL_BLOBS},box.id,{text:'A😀B'});
  const first=await call(ctx,'read_message',{messageId:mail.id,limit:2});
  expect(first.isError).not.toBe(true);expect(first.structuredContent.body).toMatchObject({status:'ready',text:'A😀',offset:0,totalLength:4,nextOffset:3,truncated:true});
  const emoji=await call(ctx,'read_message',{messageId:mail.id,offset:1,limit:1});
  expect(emoji.structuredContent.body).toMatchObject({text:'😀',nextOffset:3});
  const last=await call(ctx,'read_message',{messageId:mail.id,offset:3,limit:1});
  expect(last.structuredContent.body).toMatchObject({text:'B',nextOffset:null,truncated:false});
  expect(first.structuredContent.body.text+last.structuredContent.body.text).toBe(mail.text);
  const middle=await call(ctx,'read_message',{messageId:mail.id,offset:2,limit:1});
  expect(middle.isError).toBe(true);expect(middle.structuredContent.error).toEqual({code:'invalid_offset',status:400});
  await owner.env.MAIL_BLOBS.delete(mail.bodyKey);
  const unavailable=await call(ctx,'read_message',{messageId:mail.id});
  expect(unavailable.isError).not.toBe(true);
  expect(unavailable.structuredContent.body).toEqual({status:'unavailable',text:null,htmlStatus:'unavailable',offset:0,totalLength:0,nextOffset:null,truncated:false});
  expect(await owner.env.DB.prepare('SELECT is_read FROM messages WHERE id=?').bind(mail.id).first('is_read')).toBe(0);
});

it('pages exact attachment bytes, requires separate grants and rechecks live attachment permissions',async()=>{
  const {ctx,box,tokenId}=await caller(['mail:read','attachments:read']);
  const fixture={db:owner.env.DB,bucket:owner.env.MAIL_BLOBS};
  const [mail]=await seedMessages(fixture,box.id);
  const original=Uint8Array.from({length:70_001},(_,index)=>index%256);
  const attachment=await seedAttachment(fixture,box.id,mail.id,{bytes:original,filename:'../报告<script>.bin'});
  const listed=await call(ctx,'list_attachments',{messageId:mail.id});
  expect(listed.isError).not.toBe(true);expect(listed.structuredContent).toMatchObject({status:'ready',canDownload:true});
  expect(listed.structuredContent.attachments[0]).toMatchObject({id:attachment.id,sizeBytes:original.byteLength,scanStatus:'unscanned',downloadable:true});
  const chunks:Uint8Array[]=[];let offset:number|null=0;
  while(offset!==null) {
    const result=await call(ctx,'read_attachment',{messageId:mail.id,attachmentId:attachment.id,offset,limit:32*1024});
    expect(result.isError).not.toBe(true);expect(result.structuredContent.encoding).toBe('base64');
    expect(result.structuredContent.totalBytes).toBe(original.byteLength);
    const chunk=new Uint8Array(Buffer.from(result.structuredContent.data,'base64'));expect(chunk.byteLength).toBeLessThanOrEqual(32*1024);
    chunks.push(chunk);offset=result.structuredContent.nextOffset;
  }
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(original));
  expect(await owner.env.DB.prepare('SELECT is_read FROM messages WHERE id=?').bind(mail.id).first('is_read')).toBe(0);
  const denied=await call(ctx,'read_attachment',{messageId:mail.id,attachmentId:attachment.id,offset:original.length+1});
  expect(denied.structuredContent.error).toMatchObject({code:'invalid_offset',status:400});
  await owner.env.DB.prepare('UPDATE mailbox_tokens SET can_read_attachments=0 WHERE id=?').bind(tokenId).run();
  const removed=await call(ctx,'read_attachment',{messageId:mail.id,attachmentId:attachment.id});
  expect(removed.structuredContent.error).toMatchObject({code:'insufficient_scope',status:403});
  const metadata=await call(ctx,'list_attachments',{messageId:mail.id});
  expect(metadata.structuredContent.canDownload).toBe(false);expect(metadata.structuredContent.attachments[0].downloadable).toBe(false);
});

it('does not widen a narrowed actor from its broader database principal and isolates attachment messages',async()=>{
  const {ctx,box,tokenId}=await caller(['mail:read','attachments:read']);
  const fixture={db:owner.env.DB,bucket:owner.env.MAIL_BLOBS},[mail]=await seedMessages(fixture,box.id);
  const attachment=await seedAttachment(fixture,box.id,mail.id);
  const other=await createMailbox(owner,{name:'Other private attachment',localPart:`other-${crypto.randomUUID()}`});
  const [otherMail]=await seedMessages(fixture,other.id);
  const privateFile=await seedAttachment(fixture,other.id,otherMail.id,{bytes:new TextEncoder().encode('OTHER_PRIVATE_FILE')});
  const cross=await call(ctx,'read_attachment',{messageId:otherMail.id,attachmentId:privateFile.id});
  expect(cross.structuredContent.error).toMatchObject({code:'not_found',status:404});expect(JSON.stringify(cross)).not.toContain('OTHER_PRIVATE_FILE');
  const blocked=await seedAttachment(fixture,box.id,mail.id,{scanStatus:'blocked'});
  expect((await call(ctx,'read_attachment',{messageId:mail.id,attachmentId:blocked.id})).structuredContent.error).toMatchObject({code:'attachment_blocked',status:403});
  const narrow={...ctx,actor:{...ctx.actor!,canReadAttachments:false}} as OwnerContext;
  const info=await call(narrow,'get_mailbox');expect(info.structuredContent.permissions.canReadAttachments).toBe(false);
  const narrowMetadata=await call(narrow,'list_attachments',{messageId:mail.id});expect(narrowMetadata.structuredContent.canDownload).toBe(false);
  await owner.env.DB.prepare('UPDATE mailbox_tokens SET revoked_at=? WHERE id=?').bind(Date.now(),tokenId).run();
  expect((await call(ctx,'read_attachment',{messageId:mail.id,attachmentId:attachment.id})).structuredContent.error).toMatchObject({code:'unauthorized',status:401});
});
