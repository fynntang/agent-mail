import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import PostalMime from 'postal-mime';
import {createMailbox,type OwnerContext} from '../../src/lib/server/core/owner';
import {saveDraft,approveDraft,getDraft,listOutbound,requestSend,readObject,putObject} from '../../src/lib/server/core/outbound';
import {addDraftAttachment,removeDraftAttachment} from '../../src/lib/server/core/draft-attachments';
import {runSendJobs} from '../../src/lib/server/core/outbound-jobs';
import {normalizedContent} from '../../src/lib/server/core/outbound-content';
import {listAttachments} from '../../src/lib/server/core/attachments';
import {sha256} from '../../src/lib/server/core/crypto';
import type {DraftDTO,DraftContent} from '../../src/lib/types/outbound';
import type {RuntimeEnv} from '../../src/lib/server/core/types';

let mf:Miniflare,ctx:OwnerContext;
const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),char=>char.charCodeAt(0));
beforeAll(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'html-send-core'},r2Buckets:{MAIL_BLOBS:'html-send-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())
    await db.batch(unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')).map(query=>db.prepare(query)));
  ctx={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com',
    EMAIL:{send:async()=>({messageId:crypto.randomUUID()})}} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterAll(async()=>{await mf?.dispose();});
const mailbox=()=>createMailbox(ctx,{name:'HTML sender',localPart:`html-send-${crypto.randomUUID()}`});
const content=(extra:Record<string,unknown>={})=>({to:['recipient@example.net'],subject:'HTML delivery',text:'Plain fallback.',...extra});
const approve=(box:string,draft:DraftDTO)=>approveDraft(ctx,box,draft.id,{expectedVersion:draft.version,contentSha256:draft.contentSha256});
const update=(box:string,draft:DraftDTO,extra:Record<string,unknown>)=>saveDraft(ctx,box,content({expectedVersion:draft.version,...extra}),draft.id);
async function attach(box:string,draft:DraftDTO,bytes=png,contentType='image/png') {
  return addDraftAttachment(ctx,box,draft.id,{expectedVersion:draft.version,filename:'image.png',contentType},bytes);
}
async function inlineDraft(box:string) {
  let draft=await saveDraft(ctx,box,content({html:'<p>HTML fallback.</p><img src="cid:Logo%40Agent">'}));
  draft=await attach(box,draft);
  return update(box,draft,{inlineImages:[{attachmentId:draft.content.attachments![0].id,contentId:'Logo@Agent'}]});
}
const sender=()=>vi.fn(async(_message:EmailMessageBuilder):Promise<EmailSendResult>=>({messageId:crypto.randomUUID()}));
type Frozen={v:number;from:string;content:DraftContent;version:number;rawObjectId:string;bodyObjectId:string};
async function frozen(box:string,id:string) {
  const objectId=await ctx.env.DB.prepare('SELECT frozen_object_id FROM outbound_messages WHERE mailbox_id=? AND id=?').bind(box,id).first<string>('frozen_object_id');
  return readObject<Frozen>(ctx.env,box,objectId!,'outbound');
}

it('stores and hashes the original outbound HTML while requiring the plain fallback for submission',async()=>{
  const box=await mailbox(),html='<p style="color:red">Original &amp; HTML</p><script>senderMarkup()</script>';
  const draft=await saveDraft(ctx,box.id,content({html}));
  expect(draft.content.html).toBe(html);expect(draft.contentSha256).toBe(await sha256(JSON.stringify(draft.content)));
  const approved=await approve(box.id,draft),queued=await requestSend(ctx,box.id,draft.id,{expectedVersion:approved.version},'raw-html');
  const snapshot=await frozen(box.id,queued.outboundId!);expect(snapshot.v).toBe(3);expect(snapshot.content.html).toBe(html);
  expect(await readObject(ctx.env,box.id,snapshot.bodyObjectId,'body')).toEqual({text:draft.content.text,html,htmlExtracted:true,attachmentsExtracted:true});
  const send=sender();await runSendJobs(ctx.env,{sender:send});
  expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).toMatchObject({text:draft.content.text,html});
  const empty=await saveDraft(ctx,box.id,content({html:'<p>HTML only</p>',text:''}));
  await expect(requestSend(ctx,box.id,empty.id,{expectedVersion:empty.version},'html-without-text')).rejects.toMatchObject({code:'incomplete_draft'});
});

it('preserves omitted HTML/CID fields and includes every HTML or CID edit in versioned Owner approval',async()=>{
  const box=await mailbox();let draft=await inlineDraft(box.id);
  const html=draft.content.html,bindings=draft.content.inlineImages;
  draft=await approve(box.id,draft);const reviewed=draft;
  draft=await update(box.id,draft,{subject:'Edited subject'});
  expect(draft.content.html).toBe(html);expect(draft.content.inlineImages).toEqual(bindings);
  expect(draft.state).toBe('editing');expect(draft.version).toBe(reviewed.version+1);expect(draft.contentSha256).not.toBe(reviewed.contentSha256);
  draft=await approve(box.id,draft);const beforeMap=draft;
  draft=await update(box.id,draft,{inlineImages:[{attachmentId:bindings![0].attachmentId,contentId:'New@Agent'}]});
  expect(draft.version).toBe(beforeMap.version+1);expect(draft.contentSha256).not.toBe(beforeMap.contentSha256);expect(draft.state).toBe('editing');
  await expect(approve(box.id,draft)).rejects.toMatchObject({code:'unresolved_cid'});
  draft=await update(box.id,draft,{html:'<p>Changed HTML</p><img src="cid:New%40Agent">'});
  draft=await approve(box.id,draft);const beforeHtml=draft;
  draft=await update(box.id,draft,{html:'<b>Another revision</b><img src="cid:New%40Agent">'});
  expect(draft.contentSha256).not.toBe(beforeHtml.contentSha256);expect(draft.state).toBe('editing');
  await expect(approveDraft(ctx,box.id,draft.id,{expectedVersion:beforeHtml.version,contentSha256:beforeHtml.contentSha256})).rejects.toMatchObject({code:'draft_changed'});
  expect(await ctx.env.DB.prepare('SELECT approved_version,approved_sha256,approved_at FROM drafts WHERE id=?').bind(draft.id).first())
    .toEqual({approved_version:null,approved_sha256:null,approved_at:null});
});

it('clears bindings with HTML, allows explicit unbinding, and removes mappings automatically with a removed attachment',async()=>{
  const box=await mailbox();let draft=await inlineDraft(box.id);
  await expect(update(box.id,draft,{html:null,inlineImages:draft.content.inlineImages})).rejects.toMatchObject({code:'invalid_inline_images'});
  draft=await update(box.id,draft,{inlineImages:[]});
  expect(draft.content.inlineImages).toEqual([]);expect(draft.content.attachments).toHaveLength(1);
  await expect(approve(box.id,draft)).rejects.toMatchObject({code:'unresolved_cid'});
  draft=await update(box.id,draft,{html:'<p>Now a normal attachment.</p>',inlineImages:[{attachmentId:draft.content.attachments![0].id,contentId:'Logo@Agent'}]});
  draft=await update(box.id,draft,{html:null});
  expect(draft.content.html).toBeNull();expect(draft.content.inlineImages).toEqual([]);expect(draft.content.attachments).toHaveLength(1);
  const other=await inlineDraft(box.id),removed=await removeDraftAttachment(ctx,box.id,other.id,other.content.attachments![0].id,{expectedVersion:other.version});
  expect(removed.content.attachments).toEqual([]);expect(removed.content.inlineImages).toEqual([]);expect(removed.content.html).toContain('cid:');
  await expect(approve(box.id,removed)).rejects.toMatchObject({code:'unresolved_cid'});
});

it('never binds an attachment from another draft/mailbox or accepts public attachment references',async()=>{
  const box=await mailbox(),other=await mailbox();
  const own=await attach(box.id,await saveDraft(ctx,box.id,content({html:'<p>Draft</p>'}))),foreign=await inlineDraft(other.id);
  const id=foreign.content.attachments![0].id;
  await expect(update(box.id,own,{inlineImages:[{attachmentId:id,contentId:'foreign'}]})).rejects.toMatchObject({code:'invalid_inline_images'});
  await expect(saveDraft(ctx,box.id,content({attachments:foreign.content.attachments,html:'<p>Injected refs</p>'}))).rejects.toMatchObject({code:'invalid_input'});
  const ref=own.content.attachments![0].id;
  await expect(update(box.id,own,{inlineImages:[{attachmentId:ref,contentId:'same'},{attachmentId:ref,contentId:'other'}]})).rejects.toMatchObject({code:'invalid_inline_images'});
});

it('allows unfinished CID references to be saved while rejecting approval and send until bytes form an allowed raster',async()=>{
  const box=await mailbox(),dangling=await saveDraft(ctx,box.id,content({html:'<img src="cid:missing">'}));
  await expect(approve(box.id,dangling)).rejects.toMatchObject({code:'unresolved_cid'});
  let bad=await saveDraft(ctx,box.id,content({html:'<img src="cid:bad">'}));
  bad=await attach(box.id,bad,new TextEncoder().encode('<svg onload="alert(1)"/>'),'image/svg+xml');
  bad=await update(box.id,bad,{inlineImages:[{attachmentId:bad.content.attachments![0].id,contentId:'bad'}]});
  await expect(approve(box.id,bad)).rejects.toMatchObject({code:'inline_image_invalid'});
  await expect(requestSend(ctx,box.id,bad.id,{expectedVersion:bad.version},'bad-raster')).rejects.toMatchObject({code:'inline_image_invalid'});
  expect(await ctx.env.DB.prepare('SELECT count(*) n FROM outbound_messages WHERE mailbox_id=?').bind(box.id).first('n')).toBe(0);
});

it('sends a v3 immutable HTML/CID snapshot and indexes Sent CID metadata from that snapshot after provider acceptance',async()=>{
  const box=await mailbox();let draft=await inlineDraft(box.id);
  draft=await addDraftAttachment(ctx,box.id,draft.id,{expectedVersion:draft.version,filename:'report.bin',contentType:'application/octet-stream'},new Uint8Array([1,2,3]));
  draft=await approve(box.id,draft);
  const queued=await requestSend(ctx,box.id,draft.id,{expectedVersion:draft.version},'frozen-inline'),snapshot=await frozen(box.id,queued.outboundId!);
  expect(snapshot.v).toBe(3);expect(snapshot.content.inlineImages).toEqual(draft.content.inlineImages);
  const rawId=snapshot.rawObjectId,rawKey=await ctx.env.DB.prepare('SELECT object_key FROM objects WHERE id=?').bind(rawId).first<string>('object_key');
  const eml=await (await ctx.env.MAIL_BLOBS.get(rawKey!))!.text(),parsed=await PostalMime.parse(eml);
  expect(eml).toContain('multipart/alternative');expect(eml).toContain('multipart/related');expect(eml).toContain('multipart/mixed');
  expect(parsed.html?.trim()).toBe(draft.content.html);expect(parsed.text?.trim()).toBe(draft.content.text);
  expect(parsed.attachments.map(part=>[part.disposition,part.contentId??null])).toEqual([['inline','<Logo@Agent>'],['attachment',null]]);
  const send=vi.fn(async(message:EmailMessageBuilder):Promise<EmailSendResult>=>{
    expect(message).toMatchObject({html:draft.content.html,text:draft.content.text});
    expect(message.attachments?.[0]).toMatchObject({disposition:'inline',contentId:'Logo@Agent'});
    expect(message.attachments?.[1]).toMatchObject({disposition:'attachment'});
    // Simulate a post-submission local content change. Settlement must use the already approved snapshot.
    const changed={...draft.content,inlineImages:[{attachmentId:draft.content.attachments![0].id,contentId:'Changed@Agent'}]};
    const blob=await putObject(ctx.env,box.id,'draft',JSON.stringify(changed));
    await ctx.env.DB.prepare('UPDATE drafts SET content_object_id=?,content_sha256=? WHERE id=?').bind(blob.id,blob.hash,draft.id).run();
    return {messageId:crypto.randomUUID()};
  });
  await runSendJobs(ctx.env,{sender:send});expect(send).toHaveBeenCalledTimes(1);
  expect((await listOutbound(ctx,box.id))[0].status).toBe('accepted');
  const metadata=await listAttachments(ctx,box.id,queued.outboundId!);
  expect(metadata.attachments.map(part=>[part.disposition,part.contentId])).toEqual([['inline','<Logo@Agent>'],['attachment',null]]);
});

it('revalidates queued inline attachment scan/integrity before provider invocation and releases reserved quota on failure',async()=>{
  const box=await mailbox(),draft=await approve(box.id,await inlineDraft(box.id));
  await requestSend(ctx,box.id,draft.id,{expectedVersion:draft.version},'blocked-inline-preflight');
  await ctx.env.DB.prepare("UPDATE draft_attachments SET scan_status='blocked' WHERE id=?").bind(draft.content.attachments![0].id).run();
  const send=sender();await runSendJobs(ctx.env,{sender:send});expect(send).not.toHaveBeenCalled();
  expect((await listOutbound(ctx,box.id))[0]).toMatchObject({status:'failed',lastErrorCode:'attachment_blocked'});
  expect(await ctx.env.DB.prepare('SELECT reserved_units,used_units FROM daily_send_counters WHERE mailbox_id=?').bind(box.id).first()).toEqual({reserved_units:0,used_units:0});
});

it('keeps absent legacy HTML fields and legacy content hashes stable through read and v2 delivery',async()=>{
  const box=await mailbox(),input=content(),draft=await saveDraft(ctx,box.id,input),hash=await sha256(JSON.stringify(normalizedContent(input)));
  expect(draft.content).not.toHaveProperty('html');expect(draft.content).not.toHaveProperty('inlineImages');expect(draft.contentSha256).toBe(hash);
  expect((await getDraft(ctx,box.id,draft.id)).contentSha256).toBe(hash);
  const approved=await approve(box.id,draft),queued=await requestSend(ctx,box.id,draft.id,{expectedVersion:approved.version},'legacy-plain-v2');
  expect((await frozen(box.id,queued.outboundId!)).v).toBe(2);
  const send=sender();await runSendJobs(ctx.env,{sender:send});expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0]).not.toHaveProperty('html');
  expect((await getDraft(ctx,box.id,draft.id)).contentSha256).toBe(hash);
});

it('bounds serialized immutable JSON before any R2 write, including escaping expansion',async()=>{
  const box=await mailbox(),html=`<p>${'\n'.repeat(65529)}</p>`;
  await expect(saveDraft(ctx,box.id,content({html,text:'\n'.repeat(65536)}))).rejects.toMatchObject({code:'content_too_large',status:413});
  expect(await ctx.env.DB.prepare('SELECT count(*) n FROM objects WHERE mailbox_id=?').bind(box.id).first('n')).toBe(0);
  expect((await ctx.env.MAIL_BLOBS.list({prefix:`${box.id}/`})).objects).toHaveLength(0);
});

it('rejects a frozen envelope above the readable JSON limit and cleans all newly prepared send objects',async()=>{
  const box=await mailbox(),input=content({html:`<p>${'\n'.repeat(65529)}</p>`,text:`X${'\n'.repeat(65535)}`});
  const size=new TextEncoder().encode(JSON.stringify(normalizedContent(input))).byteLength;
  input.text=String(input.text).slice(0,-Math.ceil((size-(256*1024-100))/2));
  const draft=await approve(box.id,await saveDraft(ctx,box.id,input));
  await expect(requestSend(ctx,box.id,draft.id,{expectedVersion:draft.version},'frozen-json-limit')).rejects.toMatchObject({code:'content_too_large',status:413});
  expect((await getDraft(ctx,box.id,draft.id)).state).toBe('approved');
  expect(await ctx.env.DB.prepare("SELECT count(*) n FROM objects WHERE mailbox_id=? AND purpose IN('raw_email','body','outbound')").bind(box.id).first('n')).toBe(0);
  expect(await ctx.env.DB.prepare('SELECT count(*) n FROM outbound_messages WHERE mailbox_id=?').bind(box.id).first('n')).toBe(0);
  const rows=await ctx.env.DB.prepare('SELECT object_key FROM objects WHERE mailbox_id=?').bind(box.id).all<{object_key:string}>();
  expect((await ctx.env.MAIL_BLOBS.list({prefix:`${box.id}/`})).objects.map(object=>object.key).sort()).toEqual(rows.results.map(row=>row.object_key).sort());
});
