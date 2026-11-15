import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,beforeEach,afterEach,it,expect} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import type {Attachment} from 'postal-mime';
import {ingestEmail} from '../../src/lib/server/core/ingest';
import {claimParseJob,parseEmail,type ParseJob} from '../../src/lib/server/core/jobs';
import {prepareAttachments,MAX_ATTACHMENT_BYTES} from '../../src/lib/server/core/attachment-ingest';
import {safeAttachmentFilename,safeAttachmentContentType} from '../../src/lib/server/core/attachment-metadata';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,env:RuntimeEnv,statements:string[];
beforeAll(async()=>{
  statements=[];
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()){
    statements.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));
  }
});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'attachment-test'},r2Buckets:{MAIL_BLOBS:'attachment-test'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(statements.map(sql=>db.prepare(sql)));
  env={DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv;
},60_000);
afterEach(async()=>{await mf?.dispose();},60_000);

type Part={name?:string;filenameHeader?:string;type?:string;inline?:boolean;cid?:string;bytes?:Uint8Array};
function mime(parts:Part[]):Uint8Array {
  const sections=['From: sender@example.net','To: recipient@agent.example.com','Subject: Attachments',
    'MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="attachment-test"','','--attachment-test',
    'Content-Type: text/plain; charset=utf-8','','A body with attachments.'];
  for(const part of parts){
    sections.push('--attachment-test',`Content-Type: ${part.type??'application/octet-stream'}`,
      `Content-Disposition: ${part.inline?'inline':'attachment'}${part.filenameHeader??`; filename="${part.name??'same.bin'}"`}`,
      ...(part.cid?[`Content-ID: <${part.cid}>`]:[]),'Content-Transfer-Encoding: base64','',
      Buffer.from(part.bytes??new Uint8Array([0,1,127,128,255])).toString('base64'));
  }
  sections.push('--attachment-test--','');
  return new TextEncoder().encode(sections.join('\r\n'));
}
async function receive(parts:Part[],rawOverride?:Uint8Array){
  const mailboxId=crypto.randomUUID(),address=`attachment-${mailboxId}@agent.example.com`,now=Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO mailboxes(id,name,created_at,updated_at) VALUES(?,?,?,?)').bind(mailboxId,'Attachments',now,now),
    env.DB.prepare('INSERT INTO mailbox_addresses(id,mailbox_id,address,created_at) VALUES(?,?,?,?)').bind(crypto.randomUUID(),mailboxId,address,now)
  ]);
  const raw=rawOverride??mime(parts);
  const receiptId=await ingestEmail({from:'sender@example.net',to:address,rawSize:raw.byteLength,
    raw:new Response(raw as Uint8Array<ArrayBuffer>).body,setReject(){throw new Error('unexpected_rejection');}} as unknown as ForwardableEmailMessage,env);
  const job=await claimParseJob(env,Date.now()) as ParseJob;
  expect(job.mailbox_id).toBe(mailboxId);
  return {mailboxId,receiptId,job};
}
const count=(table:string,mailboxId:string)=>env.DB.prepare(`SELECT count(*) n FROM ${table} WHERE mailbox_id=?`).bind(mailboxId).first<number>('n');
it('preserves valid Content-ID identity and never repairs invalid headers into CID aliases',async()=>{
  const ids=['<Logo@Agent>','image001.png',`<${'A'.repeat(998)}>`,'<safe\u0001id>',`<${'A'.repeat(999)}>`, '<bad id>','<broken',undefined];
  const parts=ids.map(contentId=>({contentId,content:new Uint8Array([1]),mimeType:'image/png',filename:'image.png'})) as Attachment[];
  const prepared=await prepareAttachments(parts,crypto.randomUUID(),crypto.randomUUID());
  expect(prepared.map(part=>part.contentId)).toEqual([...ids.slice(0,3),null,null,null,null,null]);
});
function bucket(overrides:Record<string,unknown>){
  return new Proxy(env.MAIL_BLOBS,{get(target,key){
    if(Object.hasOwn(overrides,key))return overrides[key as string];
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}) as R2Bucket;
}

it('extracts binary, inline, empty and duplicate-named MIME parts as distinct private objects',async()=>{
  const binary=new Uint8Array([0,1,2,128,255]);
  const {mailboxId,receiptId,job}=await receive([
    {name:'same.bin',bytes:binary},{name:'same.bin',bytes:new Uint8Array()},
    {name:'inline.svg',type:'image/svg+xml',inline:true,cid:'image-id',bytes:new TextEncoder().encode('<svg onload="alert(1)"/>')},
    {filenameHeader:"; filename*=utf-8''%E6%8A%A5%E5%91%8A.pdf",type:'application/pdf'}
  ]);
  expect(await parseEmail(env,job)).toBe(true);
  const {results}=await env.DB.prepare(`SELECT a.*,o.object_key,o.size_bytes,o.content_type FROM attachments a
    JOIN objects o ON o.id=a.object_id AND o.mailbox_id=a.mailbox_id WHERE a.mailbox_id=? ORDER BY CAST(a.part_id AS INTEGER)`).bind(mailboxId).all();
  expect(results).toHaveLength(4);expect(new Set(results.map(row=>row.id)).size).toBe(4);
  expect(results.map(row=>row.filename)).toEqual(['same.bin','same.bin','inline.svg','报告.pdf']);
  expect(results.map(row=>row.scan_status)).toEqual(['unscanned','unscanned','unscanned','unscanned']);
  expect(results[2]).toMatchObject({disposition:'inline',content_id:'<image-id>',content_type:'image/svg+xml'});
  expect(results[1].size_bytes).toBe(0);
  for(const row of results){
    expect(row.object_key).toBe(`${mailboxId}/attachment/v1/${receiptId}/${row.part_id}`);
    expect((await env.MAIL_BLOBS.get(row.object_key as string))!.httpMetadata?.contentType).toBe('application/octet-stream');
  }
  expect(new Uint8Array(await (await env.MAIL_BLOBS.get(results[0].object_key as string))!.arrayBuffer())).toEqual(binary);
  expect(await env.DB.prepare('SELECT attachments_state FROM messages WHERE id=?').bind(receiptId).first('attachments_state')).toBe('ready');
  expect(await parseEmail(env,job)).toBe(false);
  expect(await count('attachments',mailboxId)).toBe(4);
});

it('marks an actually parsed message with zero attachments as extracted',async()=>{
  const {receiptId,job,mailboxId}=await receive([]);expect(await parseEmail(env,job)).toBe(true);
  expect(await count('attachments',mailboxId)).toBe(0);
  expect(await env.DB.prepare('SELECT attachments_state FROM messages WHERE id=?').bind(receiptId).first('attachments_state')).toBe('ready');
});

it('rejects excessive attachment counts before any derived write or message publication',async()=>{
  const {mailboxId,job}=await receive(Array.from({length:51},()=>({bytes:new Uint8Array()})));
  await expect(parseEmail(env,job)).rejects.toMatchObject({code:'too_many_attachments'});
  expect(await count('messages',mailboxId)).toBe(0);expect(await count('attachments',mailboxId)).toBe(0);
  expect((await env.MAIL_BLOBS.list({prefix:`${mailboxId}/attachment/`})).objects).toHaveLength(0);
  expect((await env.MAIL_BLOBS.list({prefix:`${mailboxId}/body/`})).objects).toHaveLength(0);
});

it('validates aggregate/per-file decoded limits without writing objects',async()=>{
  const part=(content:Uint8Array):Attachment=>({filename:null,mimeType:'application/octet-stream',disposition:'attachment',content});
  await expect(prepareAttachments([part(new Uint8Array(MAX_ATTACHMENT_BYTES+1))],'box','receipt')).rejects.toMatchObject({code:'attachments_too_large'});
  await expect(prepareAttachments([part(new Uint8Array(MAX_ATTACHMENT_BYTES)),part(new Uint8Array([1]))],'box','receipt')).rejects.toMatchObject({code:'attachments_too_large'});
  await expect(prepareAttachments([{...part(new Uint8Array()),content:'unrequested encoding'}],'box','receipt')).rejects.toMatchObject({code:'invalid_attachment_encoding'});
});

it('enforces MIME header and part budgets before deriving objects',async()=>{
  const excessive=mime(Array.from({length:201},()=>({bytes:new Uint8Array()})));
  const first=await receive([],excessive);
  await expect(parseEmail(env,first.job)).rejects.toMatchObject({code:'EMAXPARTCOUNT'});
  expect(await count('messages',first.mailboxId)).toBe(0);
  const oversizedHeaders=new TextEncoder().encode(`From: sender@example.net\r\nX-Large: ${'x'.repeat(1024*1024)}\r\n\r\nText`);
  const second=await receive([],oversizedHeaders);
  await expect(parseEmail(env,second.job)).rejects.toMatchObject({code:'EMAXHEADERSIZE'});
  expect(await count('messages',second.mailboxId)).toBe(0);
  expect((await env.MAIL_BLOBS.list({prefix:`${second.mailboxId}/body/`})).objects).toHaveLength(0);
});

it('keeps an attached RFC822 message as one binary attachment instead of flattening its files',async()=>{
  const forwarded=mime([{name:'inside.bin'}]);
  const {mailboxId,job}=await receive([{name:'forwarded.eml',type:'message/rfc822',bytes:forwarded}]);
  expect(await parseEmail(env,job)).toBe(true);
  const row=await env.DB.prepare(`SELECT a.filename,o.object_key,o.content_type FROM attachments a JOIN objects o ON o.id=a.object_id WHERE a.mailbox_id=?`).bind(mailboxId).first();
  expect(await count('attachments',mailboxId)).toBe(1);expect(row).toMatchObject({filename:'forwarded.eml',content_type:'message/rfc822'});
  expect(new Uint8Array(await (await env.MAIL_BLOBS.get(row!.object_key as string))!.arrayBuffer())).toEqual(forwarded);
});

it('partial R2 failure leaves no published attachments and retries verified immutable objects',async()=>{
  const {mailboxId,job,receiptId}=await receive([{name:'first.bin'},{name:'second.bin'}]);
  const failing={...env,MAIL_BLOBS:bucket({put:async(key:string,value:ReadableStream|ArrayBuffer|string,options:R2PutOptions)=>{
    if(key.endsWith('/attachment/v1/'+receiptId+'/2'))throw new Error('injected_attachment_write');
    return env.MAIL_BLOBS.put(key,value,options);
  }})};
  await expect(parseEmail(failing,job)).rejects.toThrow('injected_attachment_write');
  expect(await count('attachments',mailboxId)).toBe(0);expect(await count('messages',mailboxId)).toBe(0);
  expect((await env.MAIL_BLOBS.list({prefix:`${mailboxId}/attachment/`})).objects).toHaveLength(1);
  expect(await parseEmail(env,job)).toBe(true);expect(await count('attachments',mailboxId)).toBe(2);
});

it('a lost lease cannot publish any attachment rows or ready objects or ACK another lease',async()=>{
  const {mailboxId,job}=await receive([{name:'lease.bin'}]);
  await env.DB.prepare("UPDATE jobs SET lease_token='new-lease',lease_until=? WHERE id=?").bind(Date.now()+60_000,job.id).run();
  expect(await parseEmail(env,job)).toBe(false);
  expect(await count('attachments',mailboxId)).toBe(0);expect(await count('messages',mailboxId)).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) n FROM objects WHERE mailbox_id=? AND purpose='attachment'").bind(mailboxId).first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT lease_token FROM jobs WHERE id=?').bind(job.id).first('lease_token')).toBe('new-lease');
});

it('a failing attachment publication rolls back the entire D1 batch and safely retries',async()=>{
  const {mailboxId,job}=await receive([{name:'transaction.bin'}]);
  await env.DB.prepare("CREATE TRIGGER fail_attachment_publication BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'injected_attachment_publication'); END").run();
  await expect(parseEmail(env,job)).rejects.toThrow('injected_attachment_publication');
  expect(await count('attachments',mailboxId)).toBe(0);expect(await count('messages',mailboxId)).toBe(0);expect(await count('threads',mailboxId)).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) n FROM objects WHERE mailbox_id=? AND purpose IN('body','attachment')").bind(mailboxId).first('n')).toBe(0);
  expect(await env.DB.prepare('SELECT state FROM jobs WHERE id=?').bind(job.id).first('state')).toBe('running');
  await env.DB.prepare('DROP TRIGGER fail_attachment_publication').run();
  expect(await parseEmail(env,job)).toBe(true);expect(await count('attachments',mailboxId)).toBe(1);
});

it('rejects an existing conflicting immutable attachment instead of overwriting it',async()=>{
  const {mailboxId,receiptId,job}=await receive([{name:'conflict.bin'}]);
  const key=`${mailboxId}/attachment/v1/${receiptId}/1`;await env.MAIL_BLOBS.put(key,'unexpected content');
  await expect(parseEmail(env,job)).rejects.toMatchObject({code:'attachment_object_conflict'});
  expect(await count('attachments',mailboxId)).toBe(0);expect(await count('messages',mailboxId)).toBe(0);
  expect(await (await env.MAIL_BLOBS.get(key))!.text()).toBe('unexpected content');
});

it('sanitizes file names and MIME labels without turning sender data into paths or headers',()=>{
  expect(safeAttachmentFilename('..\\folder/report\r\n\u202e.pdf')).toBe('report.pdf');
  expect(safeAttachmentFilename('CON.txt')).toBe('_CON.txt');expect(safeAttachmentFilename('../...')).toBe('attachment.bin');
  expect(safeAttachmentFilename('\ud800bad😀.txt')).toBe('bad😀.txt');
  expect(Array.from(safeAttachmentFilename('名'.repeat(200))).length).toBe(180);
  expect(safeAttachmentContentType('IMAGE/PNG')).toBe('image/png');
  expect(safeAttachmentContentType('text/html\r\nX-Injected: yes')).toBe('application/octet-stream');
});
