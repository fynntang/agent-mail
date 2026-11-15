import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {createMailbox,getMailbox,issueToken,listMailboxes,retireMailbox,updateMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {ingestEmail,finalizeReceipt,type Receipt} from '../../src/lib/server/core/ingest';
import {claimParseJob,parseEmail,runScheduled} from '../../src/lib/server/core/jobs';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,raw:Uint8Array<ArrayBuffer>;
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'owner-core'},r2Buckets:{MAIL_BLOBS:'owner-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  for(const migration of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()) {
    await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${migration}`,'utf8')).map(sql=>db.prepare(sql)));
  }
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
  raw=new Uint8Array(await readFile('tests/fixtures/inbound.eml'));
},60_000);
afterAll(async()=>{vi.restoreAllMocks();await mf?.dispose();});
const count=(sql:string,...args:(string|number)[])=>ctx.env.DB.prepare(sql).bind(...args).first<number>('n');

it('requires an Owner actor at the service boundary',async()=>{
  for(const actor of [null,{kind:'token',mailboxId:crypto.randomUUID(),tokenId:crypto.randomUUID(),canRead:true}] as const) {
    await expect(createMailbox({...ctx,actor},{name:'Denied',localPart:'denied'})).rejects.toMatchObject({status:actor?403:401});
    await expect(listMailboxes({...ctx,actor})).rejects.toMatchObject({status:actor?403:401});
  }
});

it('concurrent address creation cannot leave an orphan mailbox or a success audit for the loser',async()=>{
  const before=await count('SELECT count(*) n FROM mailboxes');
  const results=await Promise.allSettled([
    createMailbox(ctx,{name:'First',localPart:'same-address'}),createMailbox(ctx,{name:'Second',localPart:'same-address'})
  ]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const rejected=results.find(result=>result.status==='rejected') as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({code:'address_unavailable',status:409});
  expect(await count('SELECT count(*) n FROM mailboxes')).toBe(before!+1);
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='mailbox.created' AND metadata_json LIKE '%same-address%' ")).toBe(1);
});

it('same-millisecond competing updates publish only the winning operation audit',async()=>{
  const mailbox=await createMailbox(ctx,{name:'Concurrent',localPart:'concurrent'});
  const clock=vi.spyOn(Date,'now').mockReturnValue(mailbox.updatedAt+1000);
  // Both reads must observe the old version before either is allowed to batch its mutation.
  let reads=0,release!:()=>void;
  const barrier=new Promise<void>(resolve=>release=resolve);
  const database=new Proxy(ctx.env.DB,{get(target,key){
    if(key==='prepare')return(sql:string)=>{
      const statement=target.prepare(sql);
      if(!sql.includes('FROM mailboxes m JOIN mailbox_addresses'))return statement;
      return new Proxy(statement,{get(prepared,method){
        if(method==='bind')return(...args:unknown[])=>{
          const bound=prepared.bind(...args);
          return new Proxy(bound,{get(selected,operation){
            if(operation==='first')return async()=>{const row=await selected.first();if(reads<2){reads++;if(reads===2)release();await barrier;}return row;};
            const value=Reflect.get(selected,operation,selected);return typeof value==='function'?value.bind(selected):value;
          }});
        };
        const value=Reflect.get(prepared,method,prepared);return typeof value==='function'?value.bind(prepared):value;
      }});
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  try {
    const concurrent={...ctx,env:{...ctx.env,DB:database}};
    const results=await Promise.allSettled([
      updateMailbox(concurrent,mailbox.id,{name:'Winner A',expectedUpdatedAt:mailbox.updatedAt}),
      updateMailbox(concurrent,mailbox.id,{name:'Winner B',expectedUpdatedAt:mailbox.updatedAt})
    ]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
    expect((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'mailbox_changed'});
    expect(await count("SELECT count(*) n FROM audit_events WHERE mailbox_id=? AND action='mailbox.updated'",mailbox.id)).toBe(1);
  }finally{clock.mockRestore();}
});

it('a stale retirement does not revoke tokens, retire addresses or cancel jobs',async()=>{
  const mailbox=await createMailbox(ctx,{name:'Keep',localPart:'keep'});
  const issued=await issueToken(ctx,mailbox.id,{name:'Keep token',scopes:['mail:read']});
  const jobId=crypto.randomUUID(),now=Date.now();
  await ctx.env.DB.prepare("INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,available_at,created_at) VALUES(?,?,'parse_email','keep',?,?)").bind(jobId,mailbox.id,now,now).run();
  await updateMailbox(ctx,mailbox.id,{name:'Keep updated',expectedUpdatedAt:mailbox.updatedAt});
  await expect(retireMailbox(ctx,mailbox.id,{confirmAddress:mailbox.address,expectedUpdatedAt:mailbox.updatedAt})).rejects.toMatchObject({code:'mailbox_changed'});
  expect(await ctx.env.DB.prepare('SELECT revoked_at FROM mailbox_tokens WHERE id=?').bind(issued.token.id).first('revoked_at')).toBeNull();
  expect(await ctx.env.DB.prepare('SELECT status FROM mailbox_addresses WHERE mailbox_id=?').bind(mailbox.id).first('status')).toBe('active');
  expect(await ctx.env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(jobId).first('state')).toBe('pending');
  expect(await count("SELECT count(*) n FROM audit_events WHERE mailbox_id=? AND action='mailbox.retired'",mailbox.id)).toBe(0);
  await ctx.env.DB.prepare("UPDATE jobs SET state='cancelled' WHERE id=?").bind(jobId).run();
});

function incoming(to:string):ForwardableEmailMessage {
  return {from:'sender@example.net',to,rawSize:raw.byteLength,raw:new Response(raw).body,
    setReject(){throw new Error('unexpected rejection');}} as unknown as ForwardableEmailMessage;
}

it('retirement seals late ingestion finalization and prevents an old parsing worker from publishing',async()=>{
  const pending=await createMailbox(ctx,{name:'Late',localPart:'late'});
  const receiptId=await ingestEmail(incoming(pending.address),ctx.env);
  const receipt=await ctx.env.DB.prepare('SELECT r.*,o.object_key,o.sha256,o.size_bytes FROM ingest_receipts r JOIN objects o ON o.id=r.raw_object_id WHERE r.id=?')
    .bind(receiptId).first<Receipt&{sha256:string;size_bytes:number}>();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(receiptId),
    ctx.env.DB.prepare("UPDATE ingest_receipts SET status='pending_blob',received_at=? WHERE id=?").bind(Date.now()-60_000,receiptId)
  ]);
  await retireMailbox(ctx,pending.id,{confirmAddress:pending.address,expectedUpdatedAt:pending.updatedAt});
  // Reconciliation and the original email handler can each finalize after retirement.
  await runScheduled(ctx.env);
  await finalizeReceipt(ctx.env,receipt!,receipt!.size_bytes,receipt!.sha256,Date.now());
  expect(await count('SELECT count(*) n FROM jobs WHERE mailbox_id=?',pending.id)).toBe(0);
  expect(await count('SELECT count(*) n FROM messages WHERE mailbox_id=?',pending.id)).toBe(0);

  const running=await createMailbox(ctx,{name:'Running',localPart:'running'});
  await ingestEmail(incoming(running.address),ctx.env);
  const job=await claimParseJob(ctx.env,Date.now());expect(job!.mailbox_id).toBe(running.id);
  await retireMailbox(ctx,running.id,{confirmAddress:running.address,expectedUpdatedAt:running.updatedAt});
  expect(await parseEmail(ctx.env,job!)).toBe(false);
  expect(await ctx.env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(job!.id).first('state')).toBe('cancelled');
  expect(await count('SELECT count(*) n FROM messages WHERE mailbox_id=?',running.id)).toBe(0);
  await expect(getMailbox(ctx,running.id)).rejects.toMatchObject({status:404});
});
