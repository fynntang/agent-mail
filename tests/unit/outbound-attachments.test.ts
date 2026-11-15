import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import PostalMime from 'postal-mime';
import {createMailbox,updateMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {saveDraft,approveDraft,requestSend,listOutbound,getDraft,putObject} from '../../src/lib/server/core/outbound';
import {addDraftAttachment,removeDraftAttachment} from '../../src/lib/server/core/draft-attachments';
import {normalizedContent,localSentCopy} from '../../src/lib/server/core/outbound-content';
import {runSendJobs} from '../../src/lib/server/core/outbound-jobs';
import {listAttachments,readAttachment} from '../../src/lib/server/core/attachments';
import {sha256} from '../../src/lib/server/core/crypto';
import {safeAttachmentFilename} from '../../src/lib/server/core/attachment-metadata';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,schema:string[];
beforeAll(async()=>{
  schema=[];
  for(const migration of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())
    schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${migration}`,'utf8')));
});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'outbound-files'},r2Buckets:{MAIL_BLOBS:'outbound-files'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(sql=>db.prepare(sql)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',
    EMAIL:{send:async()=>({messageId:crypto.randomUUID()})}} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);
const content=(extra:Record<string,unknown>={})=>({to:['recipient@example.net'],subject:'附件报告 😀',text:'Please review the attachment.',...extra});
const mailbox=()=>createMailbox(ctx,{name:'Attachment sender',localPart:`sender-${crypto.randomUUID()}`});
const bytes=(values=[0,1,127,128,254,255])=>new Uint8Array(values);
async function attach(box:string,draft:Awaited<ReturnType<typeof saveDraft>>,data=bytes(),filename='资料_报告.bin') {
  return addDraftAttachment(ctx,box,draft.id,{expectedVersion:draft.version,filename,contentType:'application/octet-stream'},data);
}
const approval=(box:string,draft:Awaited<ReturnType<typeof saveDraft>>)=>approveDraft(ctx,box,draft.id,{expectedVersion:draft.version,contentSha256:draft.contentSha256});
const sender=()=>vi.fn(async(_message:EmailMessageBuilder):Promise<EmailSendResult>=>({messageId:crypto.randomUUID()}));
const counter=(box:string)=>ctx.env.DB.prepare('SELECT reserved_units,used_units FROM daily_send_counters WHERE mailbox_id=?').bind(box).first();

it('round-trips short Unicode and quoted ASCII names through standards MIME parameters',async()=>{
  const data=bytes([0,255,1]);
  for(const rawName of ['资料.bin','ASCII report.txt','quote"semi;colon.txt']) {
    const filename=safeAttachmentFilename(rawName),attachment={id:crypto.randomUUID(),filename,contentType:'application/octet-stream',sizeBytes:data.byteLength,sha256:await sha256(data)};
    const draft=normalizedContent({...content(),attachments:[attachment]});
    const parsed=await PostalMime.parse(localSentCopy(crypto.randomUUID(),'sender@agent.example.com',draft,Date.now(),[{attachment,bytes:data}]));
    expect(parsed.attachments[0].filename).toBe(filename);
    expect(Buffer.from(parsed.attachments[0].content as ArrayBuffer)).toEqual(Buffer.from(data));
  }
});

it('hashes file identity and bytes into approval; all attachment edits and text edits invalidate review without dropping files',async()=>{
  const box=await mailbox();let draft=await saveDraft(ctx,box.id,content());
  expect(draft.content).not.toHaveProperty('attachments');
  expect(draft.contentSha256).toBe(await sha256(JSON.stringify(normalizedContent(content()))));
  const old=draft;draft=await attach(box.id,draft);const first=draft.content.attachments![0];
  expect(draft.version).toBe(2);expect(draft.contentSha256).not.toBe(old.contentSha256);
  draft=await approval(box.id,draft);expect(draft.state).toBe('approved');
  draft=await attach(box.id,draft,bytes([42]),first.filename);
  expect(draft.version).toBe(3);expect(draft.state).toBe('editing');expect(draft.content.attachments).toHaveLength(2);
  expect(draft.content.attachments![0].filename).toBe(draft.content.attachments![1].filename);
  expect(draft.content.attachments![0].id).not.toBe(draft.content.attachments![1].id);
  await expect(approveDraft(ctx,box.id,draft.id,{expectedVersion:2,contentSha256:old.contentSha256})).rejects.toMatchObject({code:'draft_changed'});
  draft=await saveDraft(ctx,box.id,content({text:'Body edited after adding files.',expectedVersion:draft.version}),draft.id);
  expect(draft.content.attachments).toHaveLength(2);expect(draft.content.attachments![0]).toEqual(first);
  await expect(saveDraft(ctx,box.id,content({attachments:[],expectedVersion:draft.version}),draft.id)).rejects.toMatchObject({code:'invalid_input'});
  const refs=draft.content.attachments!;
  for(const ref of refs)await ctx.env.DB.prepare("UPDATE draft_attachments SET scan_status='blocked' WHERE id=?").bind(ref.id).run();
  draft=await removeDraftAttachment(ctx,box.id,draft.id,refs[0].id,{expectedVersion:draft.version});
  expect(draft.content.attachments).toHaveLength(1);
  await expect(approval(box.id,draft)).rejects.toMatchObject({code:'attachment_blocked'});
  draft=await removeDraftAttachment(ctx,box.id,draft.id,refs[1].id,{expectedVersion:draft.version});
  expect(draft.content.attachments).toEqual([]);expect((await approval(box.id,draft)).state).toBe('approved');
});

it('sends exact approved binary bytes and publishes RFC2231 multipart Sent attachments without Bcc or public object keys',async()=>{
  const box=await mailbox();let draft=await saveDraft(ctx,box.id,content({bcc:['hidden@example.net']}));
  const first=bytes(),second=bytes([9,8,7,0]);
  const filename='报告😀'.repeat(35)+'.bin';
  draft=await attach(box.id,draft,first,filename);draft=await attach(box.id,draft,second,'duplicate.bin');
  draft=await approval(box.id,draft);
  const queued=await requestSend(ctx,box.id,draft.id,{expectedVersion:draft.version},'send-files');
  await expect(removeDraftAttachment(ctx,box.id,draft.id,draft.content.attachments![0].id,{expectedVersion:draft.version})).rejects.toMatchObject({code:'draft_changed'});
  const send=sender();await runSendJobs(ctx.env,{sender:send});await runSendJobs(ctx.env,{sender:send});
  expect(send).toHaveBeenCalledTimes(1);
  const payload=send.mock.calls[0][0];expect(payload.bcc).toEqual(['hidden@example.net']);
  expect(payload.attachments).toHaveLength(2);
  for(const [index,data] of [first,second].entries()) {
    expect(payload.attachments![index]).toMatchObject({filename:draft.content.attachments![index].filename,type:'application/octet-stream',disposition:'attachment'});
    expect(Buffer.from(payload.attachments![index].content as string,'base64')).toEqual(Buffer.from(data));
  }
  const sent=await ctx.env.DB.prepare('SELECT m.*,o.object_key FROM messages m JOIN objects o ON o.id=m.raw_object_id WHERE m.id=?').bind(queued.outboundId!).first<{id:string;object_key:string}>();
  const eml=await(await ctx.env.MAIL_BLOBS.get(sent!.object_key))!.text();
  expect(eml).not.toMatch(/^Bcc:/im);expect(eml).not.toContain('hidden@example.net');expect(eml).toContain('multipart/mixed');
  const parsed=await PostalMime.parse(eml);expect(parsed.text?.trim()).toBe(draft.content.text);expect(parsed.attachments).toHaveLength(2);
  expect(parsed.attachments[0].filename).toBe(draft.content.attachments![0].filename);
  expect(Buffer.from(parsed.attachments[0].content as ArrayBuffer)).toEqual(Buffer.from(first));
  const metadata=await listAttachments(ctx,box.id,sent!.id);expect(metadata.status).toBe('ready');expect(metadata.attachments).toHaveLength(2);
  for(const [index,data] of [first,second].entries())expect(Buffer.from((await readAttachment(ctx,box.id,sent!.id,metadata.attachments[index].id)).bytes)).toEqual(Buffer.from(data));
  expect((await listOutbound(ctx,box.id))[0].status).toBe('accepted');expect(await counter(box.id)).toEqual({reserved_units:0,used_units:2});
});

it('fails approval or queued preflight for corrupt attachment bytes before provider invocation and releases quota',async()=>{
  const box=await mailbox();let draft=await attach(box.id,await saveDraft(ctx,box.id,content()));
  const ref=draft.content.attachments![0];
  const key=await ctx.env.DB.prepare('SELECT o.object_key FROM objects o JOIN draft_attachments a ON a.object_id=o.id AND a.mailbox_id=o.mailbox_id WHERE a.id=?').bind(ref.id).first<string>('object_key');
  await ctx.env.MAIL_BLOBS.put(key!,'corrupted');await expect(approval(box.id,draft)).rejects.toMatchObject({code:'attachment_unavailable'});
  await ctx.env.MAIL_BLOBS.put(key!,bytes());draft=await approval(box.id,draft);
  await requestSend(ctx,box.id,draft.id,{expectedVersion:draft.version},'before-corruption');
  await ctx.env.MAIL_BLOBS.put(key!,'corrupted again');
  const send=sender();await runSendJobs(ctx.env,{sender:send});
  expect(send).not.toHaveBeenCalled();expect((await listOutbound(ctx,box.id))[0]).toMatchObject({status:'failed',lastErrorCode:'attachment_unavailable'});
  expect(await counter(box.id)).toEqual({reserved_units:0,used_units:0});
  expect(await ctx.env.DB.prepare('SELECT count(*) n FROM send_attempts').first('n')).toBe(0);
});

it('checks MIME encoded size before queueing, while Base64 expansion and multipart headers count toward mailbox limits',async()=>{
  let box=await mailbox();box=await updateMailbox(ctx,box.id,{maxMessageBytes:1024,expectedUpdatedAt:box.updatedAt});
  let draft=await attach(box.id,await saveDraft(ctx,box.id,content()),new Uint8Array(800));draft=await approval(box.id,draft);
  await expect(requestSend(ctx,box.id,draft.id,{expectedVersion:draft.version},'too-large-mime')).rejects.toMatchObject({code:'message_too_large'});
  expect(await ctx.env.DB.prepare('SELECT count(*) n FROM outbound_messages').first('n')).toBe(0);
  expect(await ctx.env.DB.prepare('SELECT count(*) n FROM send_reservations').first('n')).toBe(0);
  expect(await ctx.env.DB.prepare("SELECT count(*) n FROM objects WHERE purpose IN('raw_email','outbound','body')").first('n')).toBe(0);
});

it('preserves unknown-result no-retry behavior for binary mail and recognizes known attachment validation rejections',async()=>{
  const box=await mailbox();let draft=await attach(box.id,await saveDraft(ctx,box.id,content()));draft=await approval(box.id,draft);
  await requestSend(ctx,box.id,draft.id,{expectedVersion:draft.version},'binary-timeout');
  const never=vi.fn((_message:EmailMessageBuilder)=>new Promise<EmailSendResult>(()=>{}));
  await runSendJobs(ctx.env,{sender:never,timeoutMs:10});await runSendJobs(ctx.env,{sender:never,timeoutMs:10});
  expect(never).toHaveBeenCalledTimes(1);expect((await listOutbound(ctx,box.id))[0].status).toBe('unknown');
  expect(await counter(box.id)).toEqual({reserved_units:1,used_units:0});
  const other=await mailbox();let rejected=await attach(other.id,await saveDraft(ctx,other.id,content()));rejected=await approval(other.id,rejected);
  await requestSend(ctx,other.id,rejected.id,{expectedVersion:rejected.version},'known-file-rejection');
  const reject=vi.fn(async(_message:EmailMessageBuilder):Promise<EmailSendResult>=>{throw Object.assign(new Error('private provider error'),{code:'E_TOO_MANY_ATTACHMENTS'});});
  await runSendJobs(ctx.env,{sender:reject});
  expect(reject).toHaveBeenCalledTimes(1);expect((await listOutbound(ctx,other.id))[0].status).toBe('failed');
  expect(await counter(other.id)).toEqual({reserved_units:0,used_units:0});
});

it('never records a partially indexed Sent message when an attachment reference disappears beyond the send boundary',async()=>{
  const box=await mailbox();let draft=await attach(box.id,await saveDraft(ctx,box.id,content()));draft=await approval(box.id,draft);
  await requestSend(ctx,box.id,draft.id,{expectedVersion:draft.version},'missing-after-acceptance');
  const send=vi.fn(async(_message:EmailMessageBuilder):Promise<EmailSendResult>=>{
    await ctx.env.DB.prepare('DELETE FROM draft_attachments WHERE id=?').bind(draft.content.attachments![0].id).run();
    return {messageId:'accepted-while-local-reference-disappeared'};
  });
  await runSendJobs(ctx.env,{sender:send});await runSendJobs(ctx.env,{sender:send});
  expect(send).toHaveBeenCalledTimes(1);expect((await listOutbound(ctx,box.id))[0].status).toBe('unknown');
  expect(await ctx.env.DB.prepare("SELECT count(*) n FROM messages WHERE folder='sent'").first('n')).toBe(0);
  expect(await ctx.env.DB.prepare('SELECT count(*) n FROM attachments').first('n')).toBe(0);
  expect(await counter(box.id)).toEqual({reserved_units:1,used_units:0});
});

it('dispatches a legacy v1 frozen text job without rewriting its content digest',async()=>{
  const box=await mailbox(),draft=await approval(box.id,await saveDraft(ctx,box.id,content()));
  const id=crypto.randomUUID(),now=Date.now(),day=new Date(now).toISOString().slice(0,10),counterId=crypto.randomUUID(),reservation=crypto.randomUUID();
  const raw=await putObject(ctx.env,box.id,'raw_email',localSentCopy(id,box.address,draft.content,now),'message/rfc822');
  const body=await putObject(ctx.env,box.id,'body',JSON.stringify({text:draft.content.text,htmlExtracted:false,attachmentsExtracted:false}));
  const frozen=await putObject(ctx.env,box.id,'outbound',JSON.stringify({v:1,from:box.address,content:draft.content,version:draft.version,rawObjectId:raw.id,bodyObjectId:body.id}));
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO daily_send_counters(id,mailbox_id,day_utc,limit_snapshot) VALUES(?,?,?,10)').bind(counterId,box.id,day),
    ctx.env.DB.prepare('INSERT INTO send_reservations(id,mailbox_id,counter_id,operation_id,units,created_at) VALUES(?,?,?,?,1,?)').bind(reservation,box.id,counterId,id,now),
    ctx.env.DB.prepare(`INSERT INTO outbound_messages(id,mailbox_id,sender_address_id,draft_id,frozen_object_id,reservation_id,request_sha256,created_at,updated_at)
      SELECT ?,?,id,?,?,?,?,?,? FROM mailbox_addresses WHERE mailbox_id=? AND is_primary=1`).bind(id,box.id,draft.id,frozen.id,reservation,draft.contentSha256,now,now,box.id),
    ctx.env.DB.prepare("INSERT INTO outbound_recipients(id,mailbox_id,outbound_id,kind,address) VALUES(?,?,?,'to','recipient@example.net')").bind(crypto.randomUUID(),box.id,id),
    ctx.env.DB.prepare("INSERT INTO jobs(id,mailbox_id,kind,dedupe_key,payload_json,available_at,created_at,max_attempts) VALUES(?,?,'send_email',?,?,?, ?,3)").bind(crypto.randomUUID(),box.id,id,JSON.stringify({outboundId:id}),now,now),
    ctx.env.DB.prepare("UPDATE drafts SET state='submitted' WHERE id=?").bind(draft.id)
  ]);
  const send=sender();await runSendJobs(ctx.env,{sender:send});expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].attachments).toBeUndefined();expect((await getDraft(ctx,box.id,draft.id)).contentSha256).toBe(draft.contentSha256);
  expect((await listOutbound(ctx,box.id))[0].status).toBe('accepted');
});
