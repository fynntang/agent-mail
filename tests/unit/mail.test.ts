import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {seedMessages} from '../helpers/mail-fixtures.mjs';
import {createMailbox,retireMailbox,updateMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {getMessage,listMessages,messageQuery,setMessageRead} from '../../src/lib/server/core/mail';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,runtime:Parameters<typeof seedMessages>[0];
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'mail-core'},r2Buckets:{MAIL_BLOBS:'mail-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  for(const migration of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${migration}`,'utf8')).map(sql=>db.prepare(sql)));
  }
  const bucket=await mf.getR2Bucket('MAIL_BLOBS');
  runtime={db,bucket};ctx={env:{DB:db,MAIL_BLOBS:bucket,MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterAll(async()=>{await mf?.dispose();});
async function mailbox(){return createMailbox(ctx,{name:'Reader',localPart:`reader-${crypto.randomUUID()}`});}
const query=(search='')=>messageQuery(new URLSearchParams(search));

it('validates page sizes, duplicate parameters and filter names',()=>{
  expect(query().limit).toBe(20);
  for(const search of ['limit=0','limit=-1','limit=101','limit=2.5','limit=2&limit=3','folder=bad','read=maybe','cursor=','folder=inbox&folder=all']) {
    expect(()=>query(search)).toThrow();
  }
});

it('paginates equal timestamps without duplication and supports a real previous cursor',async()=>{
  const box=await mailbox();
  const seeded=await seedMessages(runtime,box.id,{count:11,sameTime:true});
  const expected=seeded.map(value=>value.id).sort().reverse();
  const seen:string[]=[];
  let page=await listMessages(ctx,box.id,query('limit=3'));
  expect(page.previousCursor).toBeNull();
  const first=page.messages.map(value=>value.id);
  const next=await listMessages(ctx,box.id,{...query('limit=3'),cursor:page.nextCursor!});
  const back=await listMessages(ctx,box.id,{...query('limit=3'),cursor:next.previousCursor!});
  expect(back.messages.map(value=>value.id)).toEqual(first);
  for(;;) {
    seen.push(...page.messages.map(value=>value.id));
    if(!page.nextCursor)break;
    page=await listMessages(ctx,box.id,{...query('limit=3'),cursor:page.nextCursor});
  }
  expect(seen).toEqual(expected);expect(new Set(seen).size).toBe(11);
  const empty=await mailbox();expect((await listMessages(ctx,empty.id,query())).messages).toEqual([]);
});

it('positions survive a changed/deleted boundary and newly arriving newer mail',async()=>{
  const box=await mailbox(),at=Date.now();
  const seeded=await seedMessages(runtime,box.id,{count:8,receivedAt:at});
  const first=await listMessages(ctx,box.id,query('limit=3&read=unread'));
  const boundary=first.messages.at(-1)!;
  await setMessageRead(ctx,box.id,boundary.id,{isRead:true});
  await ctx.env.DB.prepare('UPDATE messages SET deleted_at=? WHERE id=?').bind(Date.now(),boundary.id).run();
  const fresh=await seedMessages(runtime,box.id,{count:1,receivedAt:at+1000});
  const remaining:string[]=[];
  let cursor=first.nextCursor;
  while(cursor) {
    const page=await listMessages(ctx,box.id,{...query('limit=3&read=unread'),cursor});
    remaining.push(...page.messages.map(value=>value.id));cursor=page.nextCursor;
  }
  expect(remaining).toEqual(seeded.slice(3).map(value=>value.id));expect(remaining).not.toContain(fresh[0].id);
});

it('binds cursors to mailbox, read filter, folder, limit and version',async()=>{
  const a=await mailbox(),b=await mailbox();await seedMessages(runtime,a.id,{count:3});
  const page=await listMessages(ctx,a.id,query('limit=2'));
  const cursor=page.nextCursor!;
  for(const [box,options] of [[b.id,query('limit=2')],[a.id,query('limit=3')],[a.id,query('limit=2&read=unread')],[a.id,query('limit=2&folder=inbox')]] as const) {
    await expect(listMessages(ctx,box,{...options,cursor})).rejects.toMatchObject({code:'invalid_cursor',status:400});
  }
  const changed=JSON.parse(atob(cursor.replaceAll('-','+').replaceAll('_','/')));changed.v=2;
  for(const invalid of ['bad','!'.repeat(20),'a'.repeat(1025),btoa(JSON.stringify(changed))]) {
    await expect(listMessages(ctx,a.id,{...query('limit=2'),cursor:invalid})).rejects.toMatchObject({code:'invalid_cursor'});
  }
});

it('authorizes the message and its same-mailbox body purpose before reading R2',async()=>{
  const a=await mailbox(),b=await mailbox();
  const [own]=await seedMessages(runtime,a.id,{text:'A_PRIVATE_BODY'}),[other]=await seedMessages(runtime,b.id,{text:'B_PRIVATE_BODY'});
  const tokenCtx={...ctx,actor:{kind:'token',mailboxId:a.id,tokenId:crypto.randomUUID(),canRead:true} as const};
  const detail=await getMessage(tokenCtx,a.id,own.id);expect(detail.body.text).toBe('A_PRIVATE_BODY');
  expect(JSON.stringify(detail)).not.toContain(own.bodyKey);expect(JSON.stringify(detail)).not.toContain('sha256');
  await expect(getMessage(ctx,a.id,other.id)).rejects.toMatchObject({status:404});
  await expect(getMessage(tokenCtx,b.id,other.id)).rejects.toMatchObject({status:404});
  await expect(listMessages(tokenCtx,b.id,query())).rejects.toMatchObject({status:404});
  await ctx.env.DB.prepare('UPDATE messages SET body_object_id=? WHERE id=?').bind(own.rawId,own.id).run();
  expect((await getMessage(ctx,a.id,own.id)).body.status).toBe('unavailable');
});

it('distinguishes unavailable, corrupt, unextracted, empty and pending bodies',async()=>{
  const box=await mailbox();
  const [normal]=await seedMessages(runtime,box.id);
  await runtime.bucket.delete(normal.bodyKey);
  expect((await getMessage(ctx,box.id,normal.id)).body.status).toBe('unavailable');
  const [corrupt]=await seedMessages(runtime,box.id);
  await runtime.bucket.put(corrupt.bodyKey,'wrong bytes');
  expect((await getMessage(ctx,box.id,corrupt.id)).body.status).toBe('unavailable');
  const [empty]=await seedMessages(runtime,box.id,{text:''});
  expect((await getMessage(ctx,box.id,empty.id)).body.status).toBe('empty');
  const [unextracted]=await seedMessages(runtime,box.id,{text:null});
  expect((await getMessage(ctx,box.id,unextracted.id)).body.status).toBe('not_extracted');
  await ctx.env.DB.prepare("UPDATE messages SET parse_state='pending' WHERE id=?").bind(empty.id).run();
  expect((await getMessage(ctx,box.id,empty.id)).body.status).toBe('pending');
  await ctx.env.DB.prepare("UPDATE messages SET parse_state='failed' WHERE id=?").bind(empty.id).run();
  expect((await getMessage(ctx,box.id,empty.id)).body.status).toBe('failed');
});

it('keeps GET read-only and applies explicit, idempotent Owner read-state changes with atomic audit',async()=>{
  const box=await mailbox(),[message]=await seedMessages(runtime,box.id);
  expect((await getMessage(ctx,box.id,message.id)).message.is_read).toBe(0);
  expect((await listMessages(ctx,box.id,query())).messages[0].is_read).toBe(0);
  expect((await setMessageRead(ctx,box.id,message.id,{isRead:true})).is_read).toBe(1);
  expect((await setMessageRead(ctx,box.id,message.id,{isRead:true})).is_read).toBe(1);
  expect(await ctx.env.DB.prepare("SELECT count(*) n FROM audit_events WHERE mailbox_id=? AND action='message.read_state_changed'").bind(box.id).first('n')).toBe(1);
  expect((await setMessageRead(ctx,box.id,message.id,{isRead:false})).is_read).toBe(0);
  const tokenCtx={...ctx,actor:{kind:'token',mailboxId:box.id,tokenId:crypto.randomUUID(),canRead:true} as const};
  await expect(setMessageRead(tokenCtx,box.id,message.id,{isRead:true})).rejects.toMatchObject({status:403});
  for(const input of [{isRead:1},{isRead:'true'},{toggle:true},{isRead:true,mailboxId:box.id}]) {
    await expect(setMessageRead(ctx,box.id,message.id,input)).rejects.toMatchObject({status:400});
  }
  expect((await getMessage(ctx,box.id,message.id)).message.is_read).toBe(0);
});

it('lets Owner read paused mailboxes, while retired messages and soft-deleted mail remain inaccessible',async()=>{
  let box=await mailbox();const [message]=await seedMessages(runtime,box.id);
  box=await updateMailbox(ctx,box.id,{status:'paused',expectedUpdatedAt:box.updatedAt});
  expect((await getMessage(ctx,box.id,message.id)).body.status).toBe('ready');
  await ctx.env.DB.prepare('UPDATE messages SET deleted_at=? WHERE id=?').bind(Date.now(),message.id).run();
  await expect(getMessage(ctx,box.id,message.id)).rejects.toMatchObject({status:404});
  await retireMailbox(ctx,box.id,{confirmAddress:box.address,expectedUpdatedAt:box.updatedAt});
  await expect(listMessages(ctx,box.id,query())).rejects.toMatchObject({status:404});
});

it('searches subject/address metadata with scoped Unicode cursors and treats SQL wildcards literally',async()=>{
  const own=await mailbox(),other=await mailbox();
  await seedMessages(runtime,own.id,{count:5,prefix:'中文构建报告'});
  await seedMessages(runtime,other.id,{count:3,prefix:'中文构建报告'});
  const options=query('q=中文构建&limit=2');
  const first=await listMessages(ctx,own.id,options);
  expect(first.messages).toHaveLength(2);expect(first.filters.q).toBe('中文构建');
  const second=await listMessages(ctx,own.id,{...options,cursor:first.nextCursor!});
  const previous=await listMessages(ctx,own.id,{...options,cursor:second.previousCursor!});
  expect(previous.messages.map(item=>item.id)).toEqual(first.messages.map(item=>item.id));
  expect(new Set([...first.messages,...second.messages].map(item=>item.id)).size).toBe(4);
  for(const modified of [query('q=中文&limit=2'),query('limit=2')]) {
    await expect(listMessages(ctx,own.id,{...modified,cursor:first.nextCursor!})).rejects.toMatchObject({code:'invalid_cursor'});
  }
  await expect(listMessages(ctx,other.id,{...options,cursor:first.nextCursor!})).rejects.toMatchObject({code:'invalid_cursor'});
  expect((await listMessages(ctx,own.id,query('q=build@example.net'))).messages).toHaveLength(5);
  expect((await listMessages(ctx,own.id,query('q=%25'))).messages).toEqual([]);
  expect((await listMessages(ctx,own.id,query('q=_'))).messages).toEqual([]);
  const [literal]=await seedMessages(runtime,own.id,{prefix:'100%_done\\report'});
  expect((await listMessages(ctx,own.id,query('q=%25_done%5C'))).messages.map(item=>item.id)).toEqual([literal.id]);
  expect((await listMessages(ctx,own.id,query('q=%27%20OR%201%3D1%20--'))).messages).toEqual([]);
  for(const invalid of ['q=','q=one&q=two','q=%00',`q=${'x'.repeat(201)}`]) expect(()=>query(invalid)).toThrow();
});
