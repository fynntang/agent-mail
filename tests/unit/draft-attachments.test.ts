import {readFile,readdir} from 'node:fs/promises';
import {beforeAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {authenticateMailbox} from '../../src/lib/server/core/auth';
import {createMailbox,issueToken,type OwnerContext} from '../../src/lib/server/core/owner';
import {saveDraft,getDraft,approveDraft,discardDraft} from '../../src/lib/server/core/outbound';
import {addDraftAttachment,removeDraftAttachment,readDraftAttachment,loadDraftAttachmentBytes,
  beginDraftAttachmentUpload,appendDraftAttachmentChunk,completeDraftAttachmentUpload,
  DRAFT_ATTACHMENT_MAX_BYTES,DRAFT_ATTACHMENT_CHUNK_BYTES} from '../../src/lib/server/core/draft-attachments';
import type {RuntimeEnv} from '../../src/lib/server/core/types';
import {sha256} from '../../src/lib/server/core/crypto';

let mf:Miniflare,owner:OwnerContext,schema:string[];
beforeAll(async()=>{
  schema=[];
  for(const name of (await readdir('migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort())schema.push(...unstable_splitSqlQuery(await readFile(`migrations/${name}`,'utf8')));
});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture");}}',
    compatibilityDate:'2026-11-10',d1Databases:{DB:'draft-attachment-core'},r2Buckets:{MAIL_BLOBS:'draft-attachment-core'},log:new Log(LogLevel.ERROR)}));
  const db=await mf.getD1Database('DB');await db.batch(schema.map(query=>db.prepare(query)));
  owner={env:{DB:db,MAIL_BLOBS:await mf.getR2Bucket('MAIL_BLOBS'),MAIL_DOMAIN:'agent.example.com'} as unknown as RuntimeEnv,
    actor:{kind:'owner',email:'owner@example.com'},requestId:crypto.randomUUID()};
},60_000);
afterEach(async()=>{vi.restoreAllMocks();await mf?.dispose();},60_000);

async function fixture(){
  const box=await createMailbox(owner,{name:'Draft attachments',localPart:`upload-${crypto.randomUUID()}`});
  const draft=await saveDraft(owner,box.id,{to:['recipient@example.net'],subject:'Files',text:'Please review files.'});
  return {box,draft};
}
const metadata=(expectedVersion:number,filename='report.bin')=>({expectedVersion,filename,contentType:'application/octet-stream'});
const bytes=new Uint8Array([0,1,2,127,128,255]);
const b64=(data:Uint8Array)=>Buffer.from(data).toString('base64');
async function tokenContext(box:string,scopes=['mail:draft']) {
  const issued=await issueToken(owner,box,{name:'Draft-only uploader',scopes});
  return {...owner,actor:await authenticateMailbox(new Request('https://api.example.com/mcp',{headers:{Authorization:`Bearer ${issued.secret}`}}),owner.env)};
}

it('uploads immutable binary metadata and bytes; every add/delete increments version and clears old approval',async()=>{
  const {box,draft}=await fixture();
  await approveDraft(owner,box.id,draft.id,{expectedVersion:draft.version,contentSha256:draft.contentSha256});
  const added=await addDraftAttachment(owner,box.id,draft.id,metadata(draft.version,'../../报告.bin'),bytes);
  expect(added.version).toBe(draft.version+1);expect(added.state).toBe('editing');expect(added.contentSha256).not.toBe(draft.contentSha256);
  expect(added.content.attachments).toHaveLength(1);expect(added.content.attachments![0].filename).toBe('报告.bin');
  expect(await owner.env.DB.prepare('SELECT approved_version,approved_sha256,approved_at FROM drafts WHERE id=?').bind(draft.id).first())
    .toEqual({approved_version:null,approved_sha256:null,approved_at:null});
  const file=await readDraftAttachment(owner,box.id,draft.id,added.content.attachments![0].id);expect(file.bytes).toEqual(bytes);
  expect(JSON.stringify(added)).not.toContain('object_key');expect(JSON.stringify(added)).not.toContain('/draft-attachment/');
  await approveDraft(owner,box.id,draft.id,{expectedVersion:added.version,contentSha256:added.contentSha256});
  const removed=await removeDraftAttachment(owner,box.id,draft.id,file.attachment.id,{expectedVersion:added.version});
  expect(removed.version).toBe(added.version+1);expect(removed.state).toBe('editing');expect(removed.content.attachments).toEqual([]);
  await expect(readDraftAttachment(owner,box.id,draft.id,file.attachment.id)).rejects.toMatchObject({code:'not_found'});
  expect(await owner.env.DB.prepare('SELECT count(*) n FROM draft_attachments').first('n')).toBe(1);
});

it('requires mail:draft and private draft ownership; received attachment scope does not confer upload rights',async()=>{
  const {box,draft}=await fixture(),a=await tokenContext(box.id),b=await tokenContext(box.id),reader=await tokenContext(box.id,['mail:read','attachments:read']);
  const owned=await saveDraft(a,box.id,{subject:'Private',text:'owned'});
  const uploaded=await addDraftAttachment(a,box.id,owned.id,metadata(owned.version),bytes);
  expect(uploaded.content.attachments).toHaveLength(1);
  await expect(addDraftAttachment(b,box.id,owned.id,metadata(uploaded.version),bytes)).rejects.toMatchObject({status:404});
  await expect(readDraftAttachment(b,box.id,owned.id,uploaded.content.attachments![0].id)).rejects.toMatchObject({status:404});
  await expect(addDraftAttachment(a,box.id,draft.id,metadata(draft.version),bytes)).rejects.toMatchObject({status:404});
  await expect(addDraftAttachment(reader,box.id,owned.id,metadata(uploaded.version),bytes)).rejects.toMatchObject({status:403});
  const other=await fixture();await expect(addDraftAttachment(a,other.box.id,other.draft.id,metadata(other.draft.version),bytes)).rejects.toMatchObject({status:404});
  const narrowed={...a,actor:{...a.actor!,canDraft:false}} as OwnerContext;
  await expect(readDraftAttachment(narrowed,box.id,owned.id,uploaded.content.attachments![0].id)).rejects.toMatchObject({status:403});
});

it('optimistic attachment mutations cannot overwrite a concurrently saved manifest or submitted/discarded draft',async()=>{
  const {box,draft}=await fixture();
  const outcomes=await Promise.allSettled([
    addDraftAttachment(owner,box.id,draft.id,metadata(draft.version,'a.bin'),bytes),
    addDraftAttachment(owner,box.id,draft.id,metadata(draft.version,'b.bin'),bytes)
  ]);
  expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(outcomes.filter(result=>result.status==='rejected')).toHaveLength(1);
  const current=await getDraft(owner,box.id,draft.id);expect(current.content.attachments).toHaveLength(1);expect(current.version).toBe(2);
  await expect(addDraftAttachment(owner,box.id,draft.id,metadata(1),bytes)).rejects.toMatchObject({code:'draft_changed'});
  await discardDraft(owner,box.id,draft.id);
  await expect(removeDraftAttachment(owner,box.id,draft.id,current.content.attachments![0].id,{expectedVersion:current.version})).rejects.toMatchObject({code:'draft_changed'});
});

it('enforces per-file, total decoded and active-count limits before attaching data',async()=>{
  const {box,draft}=await fixture();
  await expect(addDraftAttachment(owner,box.id,draft.id,metadata(draft.version),new Uint8Array(DRAFT_ATTACHMENT_MAX_BYTES+1))).rejects.toMatchObject({status:413});
  let current=await addDraftAttachment(owner,box.id,draft.id,metadata(draft.version),new Uint8Array(DRAFT_ATTACHMENT_MAX_BYTES));
  await expect(addDraftAttachment(owner,box.id,draft.id,metadata(current.version),new Uint8Array(1))).rejects.toMatchObject({code:'attachments_too_large'});
  const empty=await fixture();current=empty.draft;
  for(let index=0;index<32;index++)current=await addDraftAttachment(owner,empty.box.id,current.id,metadata(current.version,`empty-${index}.bin`),new Uint8Array());
  await expect(addDraftAttachment(owner,empty.box.id,current.id,metadata(current.version),new Uint8Array())).rejects.toMatchObject({code:'too_many_attachments'});
},60_000);

it('sequential upload sessions accept canonical byte chunks and exact retries, then attach once',async()=>{
  const {box,draft}=await fixture(),first=new Uint8Array(DRAFT_ATTACHMENT_CHUNK_BYTES).map((_,index)=>index%256),last=new Uint8Array([255,0,1]);
  let {upload}=await beginDraftAttachmentUpload(owner,box.id,draft.id,{...metadata(draft.version),totalBytes:first.byteLength+last.byteLength});
  expect(upload.receivedBytes).toBe(0);expect(JSON.stringify(upload)).not.toContain('object_key');
  await expect(appendDraftAttachmentChunk(owner,box.id,draft.id,upload.id,{offset:1,data:b64(first)})).rejects.toMatchObject({code:'invalid_upload_offset'});
  ({upload}=await appendDraftAttachmentChunk(owner,box.id,draft.id,upload.id,{offset:0,data:b64(first)}));
  expect(upload.receivedBytes).toBe(first.byteLength);
  expect((await appendDraftAttachmentChunk(owner,box.id,draft.id,upload.id,{offset:0,data:b64(first)})).upload.receivedBytes).toBe(first.byteLength);
  await expect(appendDraftAttachmentChunk(owner,box.id,draft.id,upload.id,{offset:0,data:b64(new Uint8Array([1]))})).rejects.toMatchObject({code:'upload_chunk_conflict'});
  await expect(completeDraftAttachmentUpload(owner,box.id,draft.id,upload.id)).rejects.toMatchObject({code:'upload_incomplete'});
  await appendDraftAttachmentChunk(owner,box.id,draft.id,upload.id,{offset:first.byteLength,data:b64(last)});
  const done=await completeDraftAttachmentUpload(owner,box.id,draft.id,upload.id);expect(done.draft.version).toBe(2);
  const loaded=await readDraftAttachment(owner,box.id,draft.id,upload.id);
  expect(loaded.bytes).toEqual(new Uint8Array([...first,...last]));
  expect((await completeDraftAttachmentUpload(owner,box.id,draft.id,upload.id)).draft.version).toBe(2);
  const removed=await removeDraftAttachment(owner,box.id,draft.id,upload.id,{expectedVersion:2});
  expect((await completeDraftAttachmentUpload(owner,box.id,draft.id,upload.id)).draft.content.attachments).toEqual([]);
  expect(removed.version).toBe(3);
});

it('zero-byte sessions complete without chunks and strict base64 rejects alternate encodings and oversize chunks',async()=>{
  const {box,draft}=await fixture();
  const {upload}=await beginDraftAttachmentUpload(owner,box.id,draft.id,{...metadata(draft.version,'empty.txt'),totalBytes:0});
  const done=await completeDraftAttachmentUpload(owner,box.id,draft.id,upload.id);expect(done.draft.content.attachments![0].sizeBytes).toBe(0);
  const next=await beginDraftAttachmentUpload(owner,box.id,draft.id,{...metadata(done.draft.version),totalBytes:1});
  for(const data of ['', 'AA', 'AA==\n','AB==','-A==',b64(new Uint8Array(DRAFT_ATTACHMENT_CHUNK_BYTES+1))])
    await expect(appendDraftAttachmentChunk(owner,box.id,draft.id,next.upload.id,{offset:0,data})).rejects.toMatchObject({code:'invalid_upload_chunk'});
});

it('bounds sessions to128parts and refuses corrupt oversized part indexes before reading their R2 blobs',async()=>{
  const {box,draft}=await fixture(),{upload}=await beginDraftAttachmentUpload(owner,box.id,draft.id,{...metadata(1),totalBytes:129});
  const hash=await sha256(new Uint8Array([0])),now=Date.now();
  await owner.env.DB.batch(Array.from({length:127},(_,offset)=>owner.env.DB.prepare(`INSERT INTO draft_attachment_upload_parts(upload_id,mailbox_id,offset_bytes,size_bytes,object_key,sha256,created_at)
    VALUES(?,?,?,1,?,?,?)`).bind(upload.id,box.id,offset,`fixture/${upload.id}/${offset}`,hash,now)));
  await owner.env.DB.prepare('UPDATE draft_attachment_uploads SET received_bytes=127 WHERE id=?').bind(upload.id).run();
  const last=await appendDraftAttachmentChunk(owner,box.id,draft.id,upload.id,{offset:127,data:'AA=='});
  expect(last.upload.receivedBytes).toBe(128);
  expect((await appendDraftAttachmentChunk(owner,box.id,draft.id,upload.id,{offset:127,data:'AA=='})).upload.receivedBytes).toBe(128);
  const before=(await owner.env.MAIL_BLOBS.list()).objects.length;
  await expect(appendDraftAttachmentChunk(owner,box.id,draft.id,upload.id,{offset:128,data:'AA=='})).rejects.toMatchObject({code:'upload_too_many_parts',status:413});
  expect((await owner.env.MAIL_BLOBS.list()).objects.length).toBe(before);
  expect(await owner.env.DB.prepare('SELECT count(*) n FROM draft_attachment_upload_parts WHERE upload_id=?').bind(upload.id).first('n')).toBe(128);
  // Simulate a legacy/corrupt index with too many parts; no R2 read may precede its bounded-index rejection.
  await owner.env.DB.prepare(`INSERT INTO draft_attachment_upload_parts(upload_id,mailbox_id,offset_bytes,size_bytes,object_key,sha256,created_at)
    VALUES(?,?,128,1,?,?,?)`).bind(upload.id,box.id,`fixture/${upload.id}/128`,hash,now).run();
  await owner.env.DB.prepare('UPDATE draft_attachment_uploads SET received_bytes=129 WHERE id=?').bind(upload.id).run();
  let reads=0;
  const bucket=new Proxy(owner.env.MAIL_BLOBS,{get(target,key){
    if(key==='get')return async(objectKey:string)=>{if(objectKey.startsWith('fixture/')){reads++;throw new Error('Part data must not be read');}return target.get(objectKey);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}) as R2Bucket;
  await expect(completeDraftAttachmentUpload({...owner,env:{...owner.env,MAIL_BLOBS:bucket}},box.id,draft.id,upload.id)).rejects.toMatchObject({code:'upload_too_many_parts',status:413});
  expect(reads).toBe(0);expect((await getDraft(owner,box.id,draft.id)).version).toBe(1);
});

it('staged sessions remain private, expire, and cannot silently attach after another draft edit',async()=>{
  const {box}=await fixture(),a=await tokenContext(box.id),b=await tokenContext(box.id);
  const draft=await saveDraft(a,box.id,{subject:'Upload',text:'original'});
  const {upload}=await beginDraftAttachmentUpload(a,box.id,draft.id,{...metadata(draft.version),totalBytes:bytes.byteLength});
  await expect(appendDraftAttachmentChunk(b,box.id,draft.id,upload.id,{offset:0,data:b64(bytes)})).rejects.toMatchObject({status:404});
  await expect(completeDraftAttachmentUpload(owner,box.id,draft.id,upload.id)).rejects.toMatchObject({status:404});
  await appendDraftAttachmentChunk(a,box.id,draft.id,upload.id,{offset:0,data:b64(bytes)});
  await saveDraft(a,box.id,{expectedVersion:1,subject:'Edited during upload',text:'changed'},draft.id);
  await expect(completeDraftAttachmentUpload(a,box.id,draft.id,upload.id)).rejects.toMatchObject({code:'draft_changed'});
  const later=await fixture(),session=await beginDraftAttachmentUpload(owner,later.box.id,later.draft.id,{...metadata(1),totalBytes:1});
  vi.spyOn(Date,'now').mockReturnValue(Date.now()+3600_001);
  await expect(appendDraftAttachmentChunk(owner,later.box.id,later.draft.id,session.upload.id,{offset:0,data:'AA=='})).rejects.toMatchObject({code:'upload_expired',status:410});
});

it('corrupt or missing staged data cannot publish a draft attachment',async()=>{
  const {box,draft}=await fixture(),{upload}=await beginDraftAttachmentUpload(owner,box.id,draft.id,{...metadata(1),totalBytes:bytes.byteLength});
  await appendDraftAttachmentChunk(owner,box.id,draft.id,upload.id,{offset:0,data:b64(bytes)});
  const part=await owner.env.DB.prepare('SELECT object_key FROM draft_attachment_upload_parts WHERE upload_id=?').bind(upload.id).first<{object_key:string}>();
  await owner.env.MAIL_BLOBS.put(part!.object_key,'bad');
  await expect(completeDraftAttachmentUpload(owner,box.id,draft.id,upload.id)).rejects.toMatchObject({code:'upload_corrupt'});
  expect((await getDraft(owner,box.id,draft.id)).version).toBe(1);
  expect(await owner.env.DB.prepare('SELECT count(*) n FROM draft_attachments').first('n')).toBe(0);
});

it('a failed completion journal update is recovered without adding a second attachment or incrementing twice',async()=>{
  const {box,draft}=await fixture(),{upload}=await beginDraftAttachmentUpload(owner,box.id,draft.id,{...metadata(1),totalBytes:bytes.byteLength});
  await appendDraftAttachmentChunk(owner,box.id,draft.id,upload.id,{offset:0,data:b64(bytes)});
  let failed=false;
  const db=new Proxy(owner.env.DB,{get(target,key){
    if(key==='prepare')return (query:string)=>{if(!failed&&query.includes("SET state='completed',attachment_id")){failed=true;throw new Error('simulated_journal_failure');}return target.prepare(query);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}) as D1Database;
  const broken={...owner,env:{...owner.env,DB:db}};
  await expect(completeDraftAttachmentUpload(broken,box.id,draft.id,upload.id)).rejects.toThrow('simulated_journal_failure');
  expect((await getDraft(owner,box.id,draft.id)).version).toBe(2);
  const recovered=await completeDraftAttachmentUpload(owner,box.id,draft.id,upload.id);
  expect(recovered.draft.version).toBe(2);expect(recovered.draft.content.attachments).toHaveLength(1);
  expect(await owner.env.DB.prepare('SELECT state FROM draft_attachment_uploads WHERE id=?').bind(upload.id).first('state')).toBe('completed');
});

it('validates immutable metadata and content before read or approval, yet still permits detaching blocked files',async()=>{
  const {box,draft}=await fixture();let current=await addDraftAttachment(owner,box.id,draft.id,metadata(1),bytes);
  const file=current.content.attachments![0];
  await expect(loadDraftAttachmentBytes(owner.env,box.id,draft.id,[{...file,filename:'forged.bin'}])).rejects.toMatchObject({code:'content_corrupt'});
  const object=await owner.env.DB.prepare('SELECT o.object_key FROM objects o JOIN draft_attachments a ON a.object_id=o.id WHERE a.id=?').bind(file.id).first<{object_key:string}>();
  await owner.env.MAIL_BLOBS.put(object!.object_key,'corrupt');
  await expect(readDraftAttachment(owner,box.id,draft.id,file.id)).rejects.toMatchObject({code:'attachment_unavailable'});
  await expect(approveDraft(owner,box.id,draft.id,{expectedVersion:current.version,contentSha256:current.contentSha256})).rejects.toMatchObject({code:'attachment_unavailable'});
  await owner.env.DB.prepare("UPDATE draft_attachments SET scan_status='blocked' WHERE id=?").bind(file.id).run();
  await expect(readDraftAttachment(owner,box.id,draft.id,file.id)).rejects.toMatchObject({code:'attachment_blocked'});
  current=await removeDraftAttachment(owner,box.id,draft.id,file.id,{expectedVersion:current.version});
  expect(current.content.attachments).toEqual([]);
});
