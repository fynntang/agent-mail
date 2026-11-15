import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {seedMessages} from '../helpers/mail-fixtures.mjs';
import {createMailbox,issueToken,revokeToken,retireMailbox,updateMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {approveDraft,cancelOutbound,getDraft,listDrafts,listOutbound,requestSend,saveDraft} from '../../src/lib/server/core/outbound';
import {externalAddress,localSentCopy,normalizedContent,providerMessage,replyHeader} from '../../src/lib/server/core/outbound-content';
import {runSendJobs} from '../../src/lib/server/core/outbound-jobs';
import {ingestDeliveryEvent} from '../../src/lib/server/core/delivery-events';
import {authenticateMailbox} from '../../src/lib/server/core/auth';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext,schema:string[];
beforeAll(async()=>{
  schema=[];
  for(const migration of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())
    schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${migration}`,'utf8')));
});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'outbound-core'},r2Buckets:{MAIL_BLOBS:'outbound-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  await db.batch(schema.map(sql=>db.prepare(sql)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',
    EMAIL:{send:async()=>({messageId:crypto.randomUUID()})}} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);

const box=()=>createMailbox(ctx,{name:'Sender',localPart:`sender-${crypto.randomUUID()}`});
const content=(overrides:Record<string,unknown>={})=>({to:['recipient@example.net'],subject:'构建完成 😀',text:'你好，邮件已准备好。\nBuild complete.',...overrides});
const count=(query:string,...args:(string|number)[])=>ctx.env.DB.prepare(query).bind(...args).first<number>('n');
async function token(mailboxId:string,scopes=['mail:read','mail:draft','mail:send'],requiresApproval=true) {
  const issued=await issueToken(ctx,mailboxId,{name:'Test Agent',scopes,requiresApproval});
  const actor={kind:'token' as const,mailboxId,tokenId:issued.token.id,canRead:scopes.includes('mail:read'),
    canDraft:scopes.includes('mail:draft'),canSend:scopes.includes('mail:send'),requiresApproval};
  return {issued,ctx:{...ctx,actor,requestId:crypto.randomUUID()}};
}
async function approved(mailboxId:string,overrides:Record<string,unknown>={}) {
  const draft=await saveDraft(ctx,mailboxId,content(overrides));
  return approveDraft(ctx,mailboxId,draft.id,{expectedVersion:draft.version,contentSha256:draft.contentSha256});
}
async function queue(mailboxId:string,overrides:Record<string,unknown>={}) {
  const draft=await approved(mailboxId,overrides);
  const result=await requestSend(ctx,mailboxId,draft.id,{expectedVersion:draft.version},crypto.randomUUID());
  expect(result.status).toBe('queued');
  return {draft,id:result.outboundId!};
}
function sender() {return vi.fn(async(_message:EmailMessageBuilder)=>({messageId:crypto.randomUUID()} as EmailSendResult));}
async function counter(mailboxId:string) {
  return ctx.env.DB.prepare('SELECT reserved_units,used_units FROM daily_send_counters WHERE mailbox_id=?').bind(mailboxId)
    .first<{reserved_units:number;used_units:number}>();
}
async function expectStoredObjects(mailboxId:string,drafts:number,sends:number) {
  const {results}=await ctx.env.DB.prepare('SELECT object_key,purpose FROM objects WHERE mailbox_id=?').bind(mailboxId)
    .all<{object_key:string;purpose:string}>();
  expect(results.filter(row=>row.purpose==='draft')).toHaveLength(drafts);
  for(const purpose of ['raw_email','body','outbound']) expect(results.filter(row=>row.purpose===purpose)).toHaveLength(sends);
  expect(results).toHaveLength(drafts+3*sends);
  const stored=await ctx.env.MAIL_BLOBS.list({prefix:`${mailboxId}/`});
  expect(stored.truncated).toBe(false);
  expect(stored.objects.map(object=>object.key).sort()).toEqual(results.map(row=>row.object_key).sort());
}
/** Both requests finish a real R2 upload before either can claim the send transaction. */
function simultaneousUploads() {
  let rawUploads=0,release!:()=>void;
  const barrier=new Promise<void>(resolve=>release=resolve);
  const bucket=new Proxy(ctx.env.MAIL_BLOBS,{get(target,key){
    if(key==='put') return async(...args:unknown[])=>{
      const result=await Reflect.apply(target.put,target,args);
      if(typeof args[0]==='string'&&args[0].includes('/raw_email/v1/')&&rawUploads<2) {
        rawUploads++;if(rawUploads===2)release();await barrier;
      }
      return result;
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  return {ctx:{...ctx,env:{...ctx.env,MAIL_BLOBS:bucket}},uploaded:()=>rawUploads};
}

it('rejects header injection, unsupported client fields and oversized UTF-8 payloads',async()=>{
  const mailbox=await box();
  for(const invalid of [
    {to:['a@example.net\r\nBcc: victim@example.net']},{subject:'hello\nBcc: victim@example.net'},
    {subject:'nul\0subject'},{subject:'x'.repeat(513)},{text:'界'.repeat(21846)},{text:'\ud800'},
    {to:['Name <a@example.net>']},{to:['a@例子.example']},{to:['a..b@example.net']},
    {to:Array.from({length:51},(_,index)=>`a${index}@example.net`)},
    {from:'attacker@example.net'},{headers:{'Message-ID':'<client@example.net>'}}
  ]) await expect(saveDraft(ctx,mailbox.id,content(invalid))).rejects.toMatchObject({status:400});
  expect(await count('SELECT count(*) n FROM drafts')).toBe(0);
  const draft=await saveDraft(ctx,mailbox.id,content({to:['User@EXAMPLE.NET'],cc:['User@example.net'],bcc:['user@example.net']}));
  expect(draft.content.to).toEqual(['User@example.net']);expect(draft.content.cc).toEqual([]);
  expect(draft.content.bcc).toEqual(['user@example.net']);
  expect(externalAddress('User@EXAMPLE.NET')).toBe('User@example.net');
});

it('keeps empty drafts private, read-only tokens unprivileged, and token responses free of storage secrets',async()=>{
  const a=await box(),b=await box(),read=await token(a.id,['mail:read']);
  const empty=await saveDraft(ctx,a.id,{});
  expect(empty).toMatchObject({version:1,state:'editing',requiresApproval:true,
    content:{to:[],cc:[],bcc:[],subject:'',text:'',replyMessageId:null,inReplyTo:null}});
  await expect(requestSend(ctx,a.id,empty.id,{expectedVersion:1},'empty')).rejects.toMatchObject({code:'incomplete_draft'});
  await expect(saveDraft(read.ctx,a.id,content())).rejects.toMatchObject({code:'insufficient_scope'});
  await expect(listDrafts(read.ctx,a.id)).rejects.toMatchObject({code:'insufficient_scope'});
  const agent=await token(a.id),other=await token(a.id);
  const mine=await saveDraft(agent.ctx,a.id,content()),theirs=await saveDraft(other.ctx,a.id,content());
  expect((await listDrafts(agent.ctx,a.id)).map(draft=>draft.id)).toEqual([mine.id]);
  await expect(getDraft(agent.ctx,a.id,theirs.id)).rejects.toMatchObject({status:404});
  await expect(getDraft(ctx,b.id,mine.id)).rejects.toMatchObject({status:404});
  await expect(listDrafts(agent.ctx,b.id)).rejects.toMatchObject({status:404});
  const serialized=JSON.stringify(await getDraft(agent.ctx,a.id,mine.id));
  for(const privateValue of ['object_key','content_object_id','secret_sha256',agent.issued.secret,'/draft/v1/']) expect(serialized).not.toContain(privateValue);
  expect(await authenticateMailbox(new Request('https://api.example.net',{headers:{authorization:`Bearer ${agent.issued.secret}`}}),ctx.env))
    .toMatchObject({canRead:true,canDraft:true,canSend:true,requiresApproval:true});
});

it('enforces a closed token scope set, approval defaults and exact mailbox recipient policy',async()=>{
  let mailbox=await box();
  for(const input of [
    {scopes:[]},{scopes:['attachments:read']},{scopes:['mail:send']},{scopes:['mail:draft'],requiresApproval:false},
    {scopes:['mail:read','mail:read']},{scopes:['mail:read'],requiresApproval:'false'}
  ]) await expect(issueToken(ctx,mailbox.id,{name:'Invalid',...input})).rejects.toMatchObject({status:400});
  expect((await issueToken(ctx,mailbox.id,{name:'Default',scopes:['mail:draft','mail:send']})).token.requiresApproval).toBe(true);
  for(const policy of [{dailyRecipientLimit:-1},{dailyRecipientLimit:1001},{allowedRecipients:['a@*.example.net']},
    {allowedRecipients:Array(101).fill('a@example.net')}]) {
    await expect(updateMailbox(ctx,mailbox.id,{...policy,expectedUpdatedAt:mailbox.updatedAt})).rejects.toMatchObject({status:400});
  }
  mailbox=await updateMailbox(ctx,mailbox.id,{dailyRecipientLimit:2,allowedRecipients:['User@EXAMPLE.NET','User@example.net'],expectedUpdatedAt:mailbox.updatedAt});
  expect(mailbox.allowedRecipients).toEqual(['User@example.net']);
  const denied=await approved(mailbox.id,{to:['user@example.net']});
  await expect(requestSend(ctx,mailbox.id,denied.id,{expectedVersion:1},'denied')).rejects.toMatchObject({code:'recipient_not_allowed'});
  await queue(mailbox.id,{to:['User@example.net']});
  mailbox=await updateMailbox(ctx,mailbox.id,{dailyRecipientLimit:0,allowedRecipients:[],expectedUpdatedAt:mailbox.updatedAt});
  const stopped=await approved(mailbox.id);
  await expect(requestSend(ctx,mailbox.id,stopped.id,{expectedVersion:1},'stopped')).rejects.toMatchObject({code:'send_limit_exceeded'});
});

it('scopes reply sources to the same mailbox and builds threading headers only from the indexed message',async()=>{
  const a=await box(),b=await box();
  const runtime={db:ctx.env.DB,bucket:ctx.env.MAIL_BLOBS};
  const [source]=await seedMessages(runtime,a.id),[foreign]=await seedMessages(runtime,b.id);
  await ctx.env.DB.prepare('UPDATE messages SET rfc_message_id=? WHERE id=?').bind('<original@example.net>',source.id).run();
  const reply=await saveDraft(ctx,a.id,{replyMessageId:source.id,text:'Reply body'});
  expect(reply.content).toMatchObject({to:['build@example.net'],subject:`Re: ${source.subject}`,inReplyTo:'<original@example.net>'});
  await expect(saveDraft(ctx,a.id,{replyMessageId:foreign.id,text:'No'})).rejects.toMatchObject({status:404});
  const draftOnly=await token(a.id,['mail:draft']);
  await expect(saveDraft(draftOnly.ctx,a.id,{replyMessageId:source.id})).rejects.toMatchObject({code:'insufficient_scope'});
  await ctx.env.DB.prepare('UPDATE messages SET rfc_message_id=? WHERE id=?').bind('<ok@example.net>\r\nBcc: victim@example.net',source.id).run();
  expect((await saveDraft(ctx,a.id,{replyMessageId:source.id,text:'Reply'})).content.inReplyTo).toBeNull();
});

it('binds Owner approval to the preview version and content, and invalidates it on any edit',async()=>{
  const mailbox=await box(),draft=await saveDraft(ctx,mailbox.id,content());
  await expect(approveDraft(ctx,mailbox.id,draft.id,{expectedVersion:1,contentSha256:'0'.repeat(64)})).rejects.toMatchObject({code:'draft_changed'});
  const signed=await approveDraft(ctx,mailbox.id,draft.id,{expectedVersion:1,contentSha256:draft.contentSha256});
  expect(signed.state).toBe('approved');
  const edited=await saveDraft(ctx,mailbox.id,content({expectedVersion:1,text:'Changed after review'}),draft.id);
  expect(edited).toMatchObject({version:2,state:'editing'});
  const row=await ctx.env.DB.prepare('SELECT approved_version,approved_sha256,approved_at FROM drafts WHERE id=?').bind(draft.id).first();
  expect(row).toMatchObject({approved_version:null,approved_sha256:null,approved_at:null});
  await expect(requestSend(ctx,mailbox.id,edited.id,{expectedVersion:2},'stale-approval')).rejects.toMatchObject({code:'approval_required'});
  await expect(approveDraft(ctx,mailbox.id,draft.id,{expectedVersion:1,contentSha256:draft.contentSha256})).rejects.toMatchObject({code:'draft_changed'});
  expect(await count('SELECT count(*) n FROM outbound_messages')).toBe(0);
});

it('requires Owner approval for Agent mail, then rechecks the original token before dispatch',async()=>{
  const mailbox=await box(),agent=await token(mailbox.id),draft=await saveDraft(agent.ctx,mailbox.id,content());
  const response=await requestSend(agent.ctx,mailbox.id,draft.id,{expectedVersion:1},'ask-owner');
  expect(response).toEqual({status:'approval_required',draftId:draft.id});
  expect(await count('SELECT count(*) n FROM send_reservations')).toBe(0);
  await expect(approveDraft(agent.ctx,mailbox.id,draft.id,{expectedVersion:1,contentSha256:draft.contentSha256})).rejects.toMatchObject({code:'owner_required'});
  await approveDraft(ctx,mailbox.id,draft.id,{expectedVersion:1,contentSha256:draft.contentSha256});
  const queued=await requestSend(ctx,mailbox.id,draft.id,{expectedVersion:1},'owner-reviewed');
  await revokeToken(ctx,mailbox.id,agent.issued.token.id);
  const send=sender();await runSendJobs(ctx.env,{sender:send});
  expect(send).not.toHaveBeenCalled();
  const outgoing=(await listOutbound(ctx,mailbox.id)).find(item=>item.id===queued.outboundId)!;
  expect(['failed','cancelled']).toContain(outgoing.status);
  expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:0});
  expect(await count("SELECT count(*) n FROM messages WHERE direction='outbound'")).toBe(0);
});

it('permits explicitly unapproved send tokens while preventing Owner escalation of a draft-only token',async()=>{
  const mailbox=await box(),automatic=await token(mailbox.id,['mail:draft','mail:send'],false);
  const draft=await saveDraft(automatic.ctx,mailbox.id,content());
  expect((await requestSend(automatic.ctx,mailbox.id,draft.id,{expectedVersion:1},'automatic')).status).toBe('queued');
  const draftOnly=await token(mailbox.id,['mail:draft']),restricted=await saveDraft(draftOnly.ctx,mailbox.id,content());
  await approveDraft(ctx,mailbox.id,restricted.id,{expectedVersion:1,contentSha256:restricted.contentSha256});
  await expect(requestSend(ctx,mailbox.id,restricted.id,{expectedVersion:1},'no-escalation')).rejects.toMatchObject({code:'insufficient_scope'});
});

it('concurrent identical idempotency keys return one queue record, reservation, job and audit',async()=>{
  const mailbox=await box(),draft=await approved(mailbox.id),race=simultaneousUploads();
  const send=()=>requestSend(race.ctx,mailbox.id,draft.id,{expectedVersion:1},'retry-key');
  const results=await Promise.all([send(),send()]);
  expect(race.uploaded()).toBe(2);
  expect(results[0]).toEqual(results[1]);expect(results[0].status).toBe('queued');
  expect(await count('SELECT count(*) n FROM outbound_messages')).toBe(1);
  expect(await count('SELECT count(*) n FROM send_reservations')).toBe(1);
  expect(await count("SELECT count(*) n FROM jobs WHERE kind='send_email'")).toBe(1);
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='outbound.queued'")).toBe(1);
  expect(await counter(mailbox.id)).toEqual({reserved_units:1,used_units:0});
  await expectStoredObjects(mailbox.id,1,1);
  const other=await approved(mailbox.id,{text:'A different draft'});
  await expect(requestSend(ctx,mailbox.id,other.id,{expectedVersion:1},'retry-key')).rejects.toMatchObject({code:'idempotency_conflict'});
  await expectStoredObjects(mailbox.id,2,1);
});

it('competing different keys cannot submit a draft twice and quota races roll back the losing operation',async()=>{
  let mailbox=await box();
  const draft=await approved(mailbox.id);
  const competing=await Promise.allSettled(['first','second'].map(key=>requestSend(ctx,mailbox.id,draft.id,{expectedVersion:1},key)));
  expect(competing.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect((competing.find(result=>result.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'draft_changed'});
  await expectStoredObjects(mailbox.id,1,1);
  await cancelOutbound(ctx,mailbox.id,(await listOutbound(ctx,mailbox.id))[0].id);
  mailbox=await updateMailbox(ctx,mailbox.id,{dailyRecipientLimit:1,expectedUpdatedAt:mailbox.updatedAt});
  const a=await approved(mailbox.id),b=await approved(mailbox.id),race=simultaneousUploads();
  const quota=await Promise.allSettled([a,b].map(item=>requestSend(race.ctx,mailbox.id,item.id,{expectedVersion:1},item.id)));
  expect(race.uploaded()).toBe(2);
  expect(quota.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect((quota.find(result=>result.status==='rejected') as PromiseRejectedResult).reason).toMatchObject({code:'send_limit_exceeded'});
  expect(await counter(mailbox.id)).toEqual({reserved_units:1,used_units:0});
  expect(await count("SELECT count(*) n FROM outbound_messages WHERE status='queued'")).toBe(1);
  expect(await count("SELECT count(*) n FROM idempotency_keys WHERE key IN(?,?)",a.id,b.id)).toBe(1);
  expect(await count("SELECT count(*) n FROM send_reservations WHERE state='reserved'")).toBe(1);
  await expectStoredObjects(mailbox.id,3,2); // Includes the first, deliberately cancelled winner.
  const loser=[a,b][quota.findIndex(result=>result.status==='rejected')];
  for(let retry=0;retry<3;retry++) {
    await expect(requestSend(ctx,mailbox.id,loser.id,{expectedVersion:1},`exhausted-${retry}`)).rejects.toMatchObject({code:'send_limit_exceeded'});
  }
  await expectStoredObjects(mailbox.id,3,2);
});

it('cancels queued mail atomically and blocks mailbox retirement while a send is pending',async()=>{
  const mailbox=await box(),queued=await queue(mailbox.id);
  await expect(retireMailbox(ctx,mailbox.id,{confirmAddress:mailbox.address,expectedUpdatedAt:mailbox.updatedAt})).rejects.toMatchObject({code:'pending_sends'});
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='mailbox.retired'")).toBe(0);
  await cancelOutbound(ctx,mailbox.id,queued.id);
  expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:0});
  expect(await ctx.env.DB.prepare("SELECT state FROM jobs WHERE kind='send_email'").first('state')).toBe('cancelled');
  await expect(cancelOutbound(ctx,mailbox.id,queued.id)).rejects.toMatchObject({code:'send_not_cancellable'});
  await retireMailbox(ctx,mailbox.id,{confirmAddress:mailbox.address,expectedUpdatedAt:mailbox.updatedAt});
});

it('sends structured mail with a private local sent copy and commits each recipient once',async()=>{
  const mailbox=await box(),queued=await queue(mailbox.id,{bcc:['hidden@example.net']});
  const send=sender();await runSendJobs(ctx.env,{sender:send});await runSendJobs(ctx.env,{sender:send});
  expect(send).toHaveBeenCalledTimes(1);
  const payload=send.mock.calls[0][0];
  expect(payload).toMatchObject({from:mailbox.address,to:['recipient@example.net'],bcc:['hidden@example.net'],subject:'构建完成 😀'});
  const headers=Object.keys(payload.headers??{}).map(key=>key.toLowerCase());
  for(const managed of ['date','message-id','mime-version','content-type','content-transfer-encoding']) expect(headers).not.toContain(managed);
  expect((await listOutbound(ctx,mailbox.id))[0]).toMatchObject({id:queued.id,status:'accepted'});
  expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:2});
  const sent=await ctx.env.DB.prepare(`SELECT m.is_read,m.folder,o.object_key FROM messages m JOIN objects o ON o.id=m.raw_object_id
    WHERE m.mailbox_id=? AND m.direction='outbound'`).bind(mailbox.id).first<{is_read:number;folder:string;object_key:string}>();
  expect(sent).toMatchObject({is_read:1,folder:'sent'});
  const eml=await(await ctx.env.MAIL_BLOBS.get(sent!.object_key))!.text();
  const [publicHeaders,body]=eml.split('\r\n\r\n');
  expect(publicHeaders).not.toMatch(/^Bcc:/im);expect(publicHeaders).not.toContain('hidden@example.net');
  expect(publicHeaders).toContain('X-Agent-Mail-Copy: local-not-provider-mime');
  expect(publicHeaders).toMatch(/Message-ID: <[^>]+\.local@agent-mail\.invalid>/);
  expect(Buffer.from(body.replace(/\s/g,''),'base64').toString('utf8')).toBe(content().text);
  expect(await count("SELECT count(*) n FROM messages WHERE direction='outbound'")).toBe(1);
});

it('encodes long Unicode subjects without breaking characters and omits Bcc from local MIME',()=>{
  const subject='😀中文'.repeat(90),draft=normalizedContent(content({subject,bcc:['hidden@example.net']}));
  const mime=localSentCopy(crypto.randomUUID(),'sender@agent.example.com',draft,Date.now());
  const [headers]=mime.split('\r\n\r\n');
  const encoded=headers.match(/=\?UTF-8\?B\?([^?]+)\?=/g)!;
  const decoded=encoded.map(word=>Buffer.from(word.slice(10,-2),'base64').toString('utf8')).join('');
  expect(decoded).toBe(subject);expect(decoded).not.toContain('\ufffd');
  for(const line of headers.split('\r\n').filter(line=>line.startsWith('Subject:')||line.startsWith(' =?'))) expect(line.length).toBeLessThanOrEqual(78);
  expect(headers).not.toMatch(/^Bcc:/im);expect(headers).not.toContain('hidden@example.net');
  expect(providerMessage('sender@agent.example.com',draft)).not.toHaveProperty('date');
  expect(replyHeader('<safe@example.net>\r\nX-Evil: yes')).toBeNull();
});

it('marks a timed-out provider call unknown and never automatically repeats it',async()=>{
  const mailbox=await box(),queued=await queue(mailbox.id);
  const send=vi.fn((_message:EmailMessageBuilder)=>new Promise<EmailSendResult>(()=>{}));
  await runSendJobs(ctx.env,{sender:send,timeoutMs:10});await runSendJobs(ctx.env,{sender:send,timeoutMs:10});
  expect(send).toHaveBeenCalledTimes(1);
  expect((await listOutbound(ctx,mailbox.id))[0]).toMatchObject({id:queued.id,status:'unknown'});
  expect(await ctx.env.DB.prepare('SELECT state FROM send_reservations WHERE operation_id=?').bind(queued.id).first('state')).toBe('reconciling');
  expect(await counter(mailbox.id)).toEqual({reserved_units:1,used_units:0});
  expect(await count("SELECT count(*) n FROM messages WHERE direction='outbound'")).toBe(0);
  await expect(retireMailbox(ctx,mailbox.id,{confirmAddress:mailbox.address,expectedUpdatedAt:mailbox.updatedAt})).rejects.toMatchObject({code:'pending_sends'});
});

it('reaps an expired submitting lease as unknown without resending or releasing its reservation',async()=>{
  const mailbox=await box(),queued=await queue(mailbox.id),lease=crypto.randomUUID(),expired=Date.now()-120_000;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE outbound_messages SET status='submitting' WHERE id=?").bind(queued.id),
    ctx.env.DB.prepare("UPDATE jobs SET state='running',lease_token=?,lease_until=?,attempts=1 WHERE kind='send_email' AND dedupe_key=?").bind(lease,expired,queued.id),
    ctx.env.DB.prepare(`INSERT INTO send_attempts(id,mailbox_id,outbound_id,attempt_no,lease_token,started_at)
      VALUES(?,?,?,1,?,?)`).bind(crypto.randomUUID(),mailbox.id,queued.id,lease,expired-1000)
  ]);
  const send=sender();await runSendJobs(ctx.env,{sender:send});await runSendJobs(ctx.env,{sender:send});
  expect(send).not.toHaveBeenCalled();
  expect((await listOutbound(ctx,mailbox.id))[0].status).toBe('unknown');
  expect(await ctx.env.DB.prepare('SELECT outcome FROM send_attempts WHERE outbound_id=?').bind(queued.id).first('outcome')).toBe('unknown');
  expect(await counter(mailbox.id)).toEqual({reserved_units:1,used_units:0});
});

it('releases quota after a known provider validation rejection and never creates sent mail',async()=>{
  const mailbox=await box();await queue(mailbox.id);
  const send=vi.fn(async(_message:EmailMessageBuilder):Promise<EmailSendResult>=>{
    throw Object.assign(new Error('private provider diagnostic'),{code:'E_RECIPIENT_NOT_ALLOWED'});
  });
  await runSendJobs(ctx.env,{sender:send});await runSendJobs(ctx.env,{sender:send});
  expect(send).toHaveBeenCalledTimes(1);expect((await listOutbound(ctx,mailbox.id))[0].status).toBe('failed');
  expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:0});
  expect(await ctx.env.DB.prepare('SELECT state FROM send_reservations').first('state')).toBe('released');
  expect(await count("SELECT count(*) n FROM messages WHERE direction='outbound'")).toBe(0);
});

it('holds quota as unknown if publishing the provider ACK fails, without ever resending',async()=>{
  const mailbox=await box(),queued=await queue(mailbox.id);
  await ctx.env.DB.prepare(`CREATE TRIGGER fail_sent_publication BEFORE INSERT ON messages
    WHEN NEW.direction='outbound' BEGIN SELECT RAISE(ABORT,'local publication unavailable'); END`).run();
  const send=sender();await runSendJobs(ctx.env,{sender:send});
  expect(send).toHaveBeenCalledTimes(1);
  expect((await listOutbound(ctx,mailbox.id))[0]).toMatchObject({id:queued.id,status:'unknown',providerMessageId:null});
  expect(await counter(mailbox.id)).toEqual({reserved_units:1,used_units:0});
  expect(await ctx.env.DB.prepare('SELECT state FROM send_reservations WHERE operation_id=?').bind(queued.id).first('state')).toBe('reconciling');
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='outbound.accepted'")).toBe(0);
  expect(await count("SELECT count(*) n FROM messages WHERE direction='outbound'")).toBe(0);
  await ctx.env.DB.prepare('DROP TRIGGER fail_sent_publication').run();
  await runSendJobs(ctx.env,{sender:send});
  expect(send).toHaveBeenCalledTimes(1);
  expect((await listOutbound(ctx,mailbox.id))[0].status).toBe('unknown');
});

it('fences a late provider ACK after another invocation has reaped its expired submitting lease',async()=>{
  const mailbox=await box(),queued=await queue(mailbox.id),unexpected=sender();
  const send=vi.fn(async(_message:EmailMessageBuilder):Promise<EmailSendResult>=>{
    await ctx.env.DB.prepare("UPDATE jobs SET lease_until=? WHERE kind='send_email' AND dedupe_key=?")
      .bind(Date.now()-1,queued.id).run();
    await runSendJobs(ctx.env,{sender:unexpected});
    expect((await listOutbound(ctx,mailbox.id))[0].status).toBe('unknown');
    return {messageId:'late-provider-ack'};
  });
  await runSendJobs(ctx.env,{sender:send});await runSendJobs(ctx.env,{sender:send});
  expect(send).toHaveBeenCalledTimes(1);expect(unexpected).not.toHaveBeenCalled();
  expect((await listOutbound(ctx,mailbox.id))[0]).toMatchObject({id:queued.id,status:'unknown',providerMessageId:null});
  expect(await counter(mailbox.id)).toEqual({reserved_units:1,used_units:0});
  expect(await ctx.env.DB.prepare('SELECT outcome FROM send_attempts WHERE outbound_id=?').bind(queued.id).first('outcome')).toBe('unknown');
  expect(await count("SELECT count(*) n FROM audit_events WHERE action='outbound.accepted'")).toBe(0);
  expect(await count("SELECT count(*) n FROM messages WHERE direction='outbound'")).toBe(0);
});

it('records the provider ACK after token revocation and mailbox pause that occur beyond the send boundary',async()=>{
  const mailbox=await box(),agent=await token(mailbox.id,['mail:draft','mail:send'],false);
  const draft=await saveDraft(agent.ctx,mailbox.id,content());
  const queued=await requestSend(agent.ctx,mailbox.id,draft.id,{expectedVersion:1},'before-revocation');
  const send=vi.fn(async(_message:EmailMessageBuilder):Promise<EmailSendResult>=>{
    await revokeToken(ctx,mailbox.id,agent.issued.token.id);
    await updateMailbox(ctx,mailbox.id,{status:'paused',expectedUpdatedAt:mailbox.updatedAt});
    return {messageId:'ack-after-authorization-change'};
  });
  await runSendJobs(ctx.env,{sender:send});await runSendJobs(ctx.env,{sender:send});
  expect(send).toHaveBeenCalledTimes(1);
  expect((await listOutbound(ctx,mailbox.id))[0]).toMatchObject({id:queued.outboundId,status:'accepted',providerMessageId:'ack-after-authorization-change'});
  expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:1});
  expect(await count("SELECT count(*) n FROM messages WHERE mailbox_id=? AND direction='outbound'",mailbox.id)).toBe(1);
  expect(await ctx.env.DB.prepare('SELECT revoked_at FROM mailbox_tokens WHERE id=?').bind(agent.issued.token.id).first('revoked_at')).not.toBeNull();
  expect(await ctx.env.DB.prepare('SELECT status FROM mailboxes WHERE id=?').bind(mailbox.id).first('status')).toBe('paused');
});

it('rejects an overwritten immutable R2 snapshot before contacting the provider and releases its reservation',async()=>{
  const mailbox=await box(),queued=await queue(mailbox.id);
  const key=await ctx.env.DB.prepare(`SELECT o.object_key FROM outbound_messages m JOIN objects o
    ON o.id=m.frozen_object_id AND o.mailbox_id=m.mailbox_id WHERE m.id=?`).bind(queued.id).first<string>('object_key');
  await ctx.env.MAIL_BLOBS.put(key!,'{"v":1,"from":"attacker@example.net"}');
  const send=sender();await runSendJobs(ctx.env,{sender:send});await runSendJobs(ctx.env,{sender:send});
  expect(send).not.toHaveBeenCalled();
  expect((await listOutbound(ctx,mailbox.id))[0]).toMatchObject({id:queued.id,status:'failed',lastErrorCode:'content_corrupt'});
  expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:0});
  expect(await ctx.env.DB.prepare('SELECT state FROM send_reservations WHERE operation_id=?').bind(queued.id).first('state')).toBe('released');
  expect(await count('SELECT count(*) n FROM send_attempts')).toBe(0);
});

it('expires an older queued reservation while a new UTC day has its own recipient limit',async()=>{
  let mailbox=await box();mailbox=await updateMailbox(ctx,mailbox.id,{dailyRecipientLimit:1,expectedUpdatedAt:mailbox.updatedAt});
  await queue(mailbox.id);
  const yesterday=new Date(Date.now()-86400_000).toISOString().slice(0,10),today=new Date().toISOString().slice(0,10);
  await ctx.env.DB.prepare('UPDATE daily_send_counters SET day_utc=? WHERE mailbox_id=?').bind(yesterday,mailbox.id).run();
  await queue(mailbox.id);
  const send=sender();await runSendJobs(ctx.env,{sender:send});
  expect(send).toHaveBeenCalledTimes(1);
  const {results}=await ctx.env.DB.prepare('SELECT day_utc,reserved_units,used_units FROM daily_send_counters WHERE mailbox_id=? ORDER BY day_utc').bind(mailbox.id).all();
  expect(results).toEqual([{day_utc:yesterday,reserved_units:0,used_units:0},{day_utc:today,reserved_units:0,used_units:1}]);
});

async function suppressRecipient(mailboxId:string,address='recipient@example.net'){
  const now=Date.now();
  await ctx.env.DB.prepare(`INSERT INTO recipient_suppressions(id,mailbox_id,address,reason,last_event_at,last_event_id,created_at,updated_at)
    VALUES(?,?,?,'hard_bounce',?,?,?,?)`).bind(crypto.randomUUID(),mailboxId,address,now,crypto.randomUUID(),now,now).run();
}
it('blocks the whole approved message for suppressed To, Cc or Bcc before reserving quota or storing send objects',async()=>{
  for(const kind of ['to','cc','bcc']){
    const mailbox=await box(),address=`blocked-${kind}@example.net`;await suppressRecipient(mailbox.id,address);
    const draft=await approved(mailbox.id,{to:['safe@example.net'],[kind]:[address]});
    await expect(requestSend(ctx,mailbox.id,draft.id,{expectedVersion:draft.version},crypto.randomUUID())).rejects.toMatchObject({code:'recipient_suppressed',status:409});
    expect((await getDraft(ctx,mailbox.id,draft.id)).state).toBe('approved');expect(await counter(mailbox.id)).toBeNull();
    expect(await count('SELECT count(*) n FROM outbound_messages WHERE mailbox_id=?',mailbox.id)).toBe(0);
    expect(await count("SELECT count(*) n FROM objects WHERE mailbox_id=? AND purpose<>'draft'",mailbox.id)).toBe(0);
  }
});
it('blocks an Agent approval request without consuming its idempotency key and isolates suppression to its mailbox',async()=>{
  const a=await box(),b=await box(),agent=await token(a.id);await suppressRecipient(a.id);
  const draft=await saveDraft(agent.ctx,a.id,content()),key=crypto.randomUUID();
  await expect(requestSend(agent.ctx,a.id,draft.id,{expectedVersion:draft.version},key)).rejects.toMatchObject({code:'recipient_suppressed'});
  expect((await getDraft(agent.ctx,a.id,draft.id)).state).toBe('editing');
  expect(await count('SELECT count(*) n FROM idempotency_keys WHERE mailbox_id=?',a.id)).toBe(0);
  await queue(b.id);const send=sender();await runSendJobs(ctx.env,{sender:send});expect(send).toHaveBeenCalledOnce();
});
it('fences a suppression received while R2 send snapshots are being prepared and cleans uncommitted objects',async()=>{
  const mailbox=await box(),draft=await approved(mailbox.id);let injected=false;
  const bucket=new Proxy(ctx.env.MAIL_BLOBS,{get(target,key){
    if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{
      const result=await target.put(...args);
      if(!injected&&String(args[0]).includes('/outbound/')){injected=true;await suppressRecipient(mailbox.id);}
      return result;
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(requestSend({...ctx,env:{...ctx.env,MAIL_BLOBS:bucket}},mailbox.id,draft.id,{expectedVersion:draft.version},crypto.randomUUID())).rejects.toMatchObject({code:'recipient_suppressed'});
  expect(injected).toBe(true);expect(await counter(mailbox.id)).toBeNull();
  expect(await count('SELECT count(*) n FROM jobs')).toBe(0);expect(await count('SELECT count(*) n FROM idempotency_keys')).toBe(0);
  await expectStoredObjects(mailbox.id,1,0);
});
it('rechecks a queued message, fails without native submission, and releases its complete recipient reservation',async()=>{
  const mailbox=await box(),queued=await queue(mailbox.id,{cc:['cc@example.net'],bcc:['blocked@example.net']});
  expect(await counter(mailbox.id)).toEqual({reserved_units:3,used_units:0});await suppressRecipient(mailbox.id,'blocked@example.net');
  const send=sender();await runSendJobs(ctx.env,{sender:send});await runSendJobs(ctx.env,{sender:send});
  expect(send).not.toHaveBeenCalled();expect((await listOutbound(ctx,mailbox.id))[0]).toMatchObject({id:queued.id,status:'failed',lastErrorCode:'recipient_suppressed'});
  expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:0});expect(await count('SELECT count(*) n FROM send_attempts')).toBe(0);
  expect(await ctx.env.DB.prepare('SELECT state FROM send_reservations WHERE operation_id=?').bind(queued.id).first('state')).toBe('released');
});
it('fences suppression committed after preflight and before the irreversible submission claim',async()=>{
  const mailbox=await box(),queued=await queue(mailbox.id);let injected=false;
  const db=new Proxy(ctx.env.DB,{get(target,key){
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{
      if(!injected){injected=true;await suppressRecipient(mailbox.id);}return target.batch(statements);
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const send=sender();await runSendJobs({...ctx.env,DB:db},{sender:send});
  expect(injected).toBe(true);expect(send).not.toHaveBeenCalled();expect(await count('SELECT count(*) n FROM send_attempts')).toBe(0);
  expect((await listOutbound(ctx,mailbox.id))[0]).toMatchObject({id:queued.id,lastErrorCode:'recipient_suppressed',status:'failed'});
  expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:0});
});

function enableDeliveryEvents(){Object.assign(ctx.env,{EMAIL_EVENT_QUEUE:'email-events',EMAIL_EVENT_ACCOUNT_ID:'a'.repeat(32),EMAIL_EVENT_ZONE_ID:'b'.repeat(32),EMAIL_EVENT_SUBSCRIPTION_ID:'c'.repeat(32),EMAIL_EVENT_DOMAIN:'agent.example.com'});}
function hardBounce(senderAddress:string,providerId:string){return {type:'cf.email.sending.message.bounced',
  source:{type:'email.sending',zoneId:ctx.env.EMAIL_EVENT_ZONE_ID,domain:ctx.env.EMAIL_EVENT_DOMAIN},
  payload:{eventId:crypto.randomUUID(),messageId:providerId,sender:senderAddress,recipient:'recipient@example.net',terminal:true,delivery:{status:'bounced'},bounce:{type:'hard'}},
  metadata:{accountId:ctx.env.EMAIL_EVENT_ACCOUNT_ID,eventSubscriptionId:ctx.env.EMAIL_EVENT_SUBSCRIPTION_ID,eventSchemaVersion:1,eventTimestamp:new Date().toISOString()}};}
it('applies hard bounce received before ACK before the next message in the same send batch',async()=>{
  enableDeliveryEvents();const mailbox=await box();await queue(mailbox.id);await queue(mailbox.id);
  const send=vi.fn(async()=>{const providerId=crypto.randomUUID();expect((await ingestDeliveryEvent(ctx.env,hardBounce(mailbox.address,providerId))).outcome).toBe('pending');return {messageId:providerId} as EmailSendResult;});
  expect(await runSendJobs(ctx.env,{sender:send})).toEqual({sendProcessed:1,sendUnknown:0});
  expect(send).toHaveBeenCalledOnce();const rows=await listOutbound(ctx,mailbox.id);
  expect(rows.map(row=>row.status).sort()).toEqual(['bounced','failed']);expect(rows.find(row=>row.status==='failed')!.lastErrorCode).toBe('recipient_suppressed');
  expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:1});expect(await count('SELECT count(*) n FROM send_attempts')).toBe(1);
});
it('preserves a recorded ACK and stops the batch if receipt storage fails, then blocks the next send on recovery',async()=>{
  enableDeliveryEvents();const mailbox=await box();await queue(mailbox.id);await queue(mailbox.id);
  const send=vi.fn(async()=>{const providerId=crypto.randomUUID();await ingestDeliveryEvent(ctx.env,hardBounce(mailbox.address,providerId));return {messageId:providerId} as EmailSendResult;});
  const db=new Proxy(ctx.env.DB,{get(target,key){
    if(key==='prepare')return(query:string)=>{if(query.startsWith('SELECT * FROM email_delivery_events WHERE provider_message_id='))throw new Error('injected receipt read failure');return target.prepare(query);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const warning=vi.spyOn(console,'warn').mockImplementation(()=>{});
  expect(await runSendJobs({...ctx.env,DB:db},{sender:send})).toEqual({sendProcessed:1,sendUnknown:0});
  expect((await listOutbound(ctx,mailbox.id)).map(row=>row.status).sort()).toEqual(['accepted','queued']);
  expect(await counter(mailbox.id)).toEqual({reserved_units:1,used_units:1});expect(send).toHaveBeenCalledOnce();
  expect(JSON.stringify(warning.mock.calls)).not.toContain('injected receipt read failure');warning.mockRestore();
  await runSendJobs(ctx.env,{sender:send});expect(send).toHaveBeenCalledOnce();
  expect((await listOutbound(ctx,mailbox.id)).map(row=>row.status).sort()).toEqual(['bounced','failed']);expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:1});
});

function enableProviderPolicy(){Object.assign(ctx.env,{EMAIL_SUPPRESSIONS_ACCOUNT_ID:'a'.repeat(32),EMAIL_SUPPRESSIONS_DOMAIN:'agent.example.com',EMAIL_SUPPRESSIONS_API_TOKEN:'private-worker-only-token-for-tests'});}
async function providerSuppression(address='recipient@example.net',options:{expiresAt?:number;status?:string;domain?:string}={}){
  const now=Date.now(),domain=options.domain??'agent.example.com';
  await ctx.env.DB.prepare(`INSERT INTO cloudflare_suppression_cache(account_id,configured_domain,remote_id,address,scope_type,scope_value,reason,read_only,status,version_hash,expires_at,provider_created_at,seen_at,updated_at,last_sync_id)
    VALUES(?,?,?,?,'sending_domain',?,'policy',1,?,?,?,?,?,?,'complete-sync')`)
    .bind('a'.repeat(32),domain,crypto.randomUUID(),address,domain,options.status??'active','a'.repeat(64),options.expiresAt??null,now,now,now).run();
}
it('enforces known provider suppressions only for the configured sending domain and unexpired active records',async()=>{
  enableProviderPolicy();const mailbox=await box();await providerSuppression('hidden@example.net');
  const draft=await approved(mailbox.id,{bcc:['hidden@example.net']});
  await expect(requestSend(ctx,mailbox.id,draft.id,{expectedVersion:draft.version},crypto.randomUUID())).rejects.toMatchObject({code:'cloudflare_recipient_suppressed'});
  expect(await counter(mailbox.id)).toBeNull();expect(await count('SELECT count(*) n FROM outbound_messages')).toBe(0);
  await providerSuppression('expired@example.net',{expiresAt:Date.now()-1});await providerSuppression('absent@example.net',{status:'absent'});
  await providerSuppression('foreign@example.net',{domain:'other.example.com'});
  await queue(mailbox.id,{to:['expired@example.net','absent@example.net','foreign@example.net']});
  const send=sender();await runSendJobs(ctx.env,{sender:send});expect(send).toHaveBeenCalledOnce();
});
it('fences a provider sync that adds a suppression during snapshot preparation',async()=>{
  enableProviderPolicy();const mailbox=await box(),draft=await approved(mailbox.id);let injected=false;
  const bucket=new Proxy(ctx.env.MAIL_BLOBS,{get(target,key){
    if(key==='put')return async(...args:Parameters<R2Bucket['put']>)=>{const result=await target.put(...args);if(!injected&&String(args[0]).includes('/outbound/')){injected=true;await providerSuppression();}return result;};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  await expect(requestSend({...ctx,env:{...ctx.env,MAIL_BLOBS:bucket}},mailbox.id,draft.id,{expectedVersion:draft.version},crypto.randomUUID())).rejects.toMatchObject({code:'cloudflare_recipient_suppressed'});
  expect(injected).toBe(true);expect(await counter(mailbox.id)).toBeNull();expect(await count('SELECT count(*) n FROM jobs')).toBe(0);await expectStoredObjects(mailbox.id,1,0);
});
it('fences provider cache updates after preflight, releases quota and never calls EMAIL',async()=>{
  enableProviderPolicy();const mailbox=await box(),queued=await queue(mailbox.id);let injected=false;
  const db=new Proxy(ctx.env.DB,{get(target,key){
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!injected){injected=true;await providerSuppression();}return target.batch(statements);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const send=sender();await runSendJobs({...ctx.env,DB:db},{sender:send});
  expect(injected).toBe(true);expect(send).not.toHaveBeenCalled();expect(await count('SELECT count(*) n FROM send_attempts')).toBe(0);
  expect((await listOutbound(ctx,mailbox.id))[0]).toMatchObject({id:queued.id,status:'failed',lastErrorCode:'cloudflare_recipient_suppressed'});
  expect(await counter(mailbox.id)).toEqual({reserved_units:0,used_units:0});
});
