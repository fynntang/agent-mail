<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {MailboxSummary} from '#lib/types/owner.ts';
  import type {DraftDTO,DraftSummary,DraftState,OutboundSummary} from '#lib/types/outbound.ts';
  import MailboxTabs from './MailboxTabs.svelte';
  import Icon from './Icon.svelte';
  import DraftAttachments from './DraftAttachments.svelte';
  import './mail.css';
  import './outbound.css';

  let {mailbox,replyMessageId}:{mailbox:MailboxSummary;replyMessageId:string|null}=$props();
  let drafts=$state<DraftSummary[]>([]),outbound=$state<OutboundSummary[]>([]),draft=$state<DraftDTO|null>(null);
  let to=$state(''),cc=$state(''),bcc=$state(''),subject=$state(''),text=$state(''),replyId=$state<string|null>(null);
  type InlineImage={attachmentId:string;contentId:string};
  let htmlEnabled=$state(false),html=$state(''),inlineImages=$state<InlineImage[]>([]),htmlReviewChecked=$state(false);
  let savedSnapshot=$state(''),busy=$state<string|null>(null),loading=$state(true),errorMessage=$state(''),notice=$state('');
  let inMemorySendKey='',inMemorySendFor='';
  const controller=new AbortController();
  const base=$derived(`/owner/api/mailboxes/${mailbox.id}`);
  const editable=$derived(!draft||!['submitted','discarded'].includes(draft.state));
  const dirty=$derived(draft?formSnapshot()!==savedSnapshot:Boolean(to||cc||bcc||subject||text||htmlEnabled));
  const savedHasHtml=$derived(typeof draft?.content.html==='string');
  const textBytes=$derived(new TextEncoder().encode(text).byteLength),htmlBytes=$derived(new TextEncoder().encode(html).byteLength);
  const canApprove=$derived(Boolean(draft&&editable&&!dirty&&draft.state!=='approved'&&(!savedHasHtml||htmlReviewChecked)));
  const canSend=$derived(Boolean(draft&&draft.state==='approved'&&!dirty&&mailbox.status==='active'));
  onMount(()=>{void loadLists().catch(showError);});
  onDestroy(()=>controller.abort());

  function showError(error:unknown) {
    if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'操作未完成，请刷新核对。';
  }
  function formSnapshot():string {return JSON.stringify({to,cc,bcc,subject,text,replyId,htmlEnabled,html:htmlEnabled?html:'',inlineImages:htmlEnabled?inlineImages:[]});}
  function addresses(value:string):string[] {return value.split(/[\n,;，；]+/).map(address=>address.trim()).filter(Boolean);}
  function input() {return {to:addresses(to),cc:addresses(cc),bcc:addresses(bcc),subject,text,...(replyId?{replyMessageId:replyId}:{}),
    ...(htmlEnabled?{html,inlineImages}:savedHasHtml||draft?.content.inlineImages?.length?{html:null}:{})};}
  function previewUrl(value:DraftDTO):string {
    return `${base}/drafts/${value.id}/html?${new URLSearchParams({expectedVersion:String(value.version),contentSha256:value.contentSha256})}`;
  }
  function toggleHtml(event:Event) {htmlEnabled=(event.currentTarget as HTMLInputElement).checked;if(!htmlEnabled)inlineImages=[];}
  function changeInlineImage(attachmentId:string,contentId:string|null) {
    if(busy||!editable||!htmlEnabled)return;
    const next=inlineImages.filter(image=>image.attachmentId!==attachmentId);
    if(contentId!==null)next.push({attachmentId,contentId});
    if(next.length>8){errorMessage='每份草稿最多绑定 8 张内嵌图片。';return;}
    const bytes=next.reduce((sum,image)=>sum+(draft?.content.attachments?.find(file=>file.id===image.attachmentId)?.sizeBytes??0),0);
    if(bytes>4*1024*1024){errorMessage='内嵌图片合计大小不能超过 4 MiB。';return;}
    inlineImages=next;errorMessage='';notice='';
  }
  function insertInlineImage(attachmentId:string,contentId:string) {
    if(busy||!editable||!htmlEnabled)return;
    const filename=draft?.content.attachments?.find(file=>file.id===attachmentId)?.filename??'内嵌图片';
    const alt=filename.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
    html+=`${html.endsWith('\n')||!html?'':'\n'}<img src="cid:${encodeURIComponent(contentId)}" alt="${alt}">`;
  }
  function date(value:number):string {return new Date(value).toISOString().replace('T',' ').slice(0,16)+' UTC';}
  function draftLabel(state:DraftState):string {return {editing:'编辑中',awaiting_approval:'待审批',approved:'已审批',submitted:'已提交',discarded:'已丢弃'}[state];}
  function outboundLabel(status:OutboundSummary['status']):string {
    return {queued:'排队中',submitting:'提交中',accepted:'已接受（非送达）',partial:'收件人状态不一致',delivered:'收件服务器已接收',bounced:'已退信',failed:'失败',cancelled:'已取消',unknown:'结果未知'}[status];
  }
  function recipientStatus(status:OutboundSummary['recipients'][number]['status']):string {
    return {queued:'等待发送',accepted:'服务已接受（非送达）',deferred:'投递暂时延迟',delivered:'收件服务器已接收',bounced:'已退信',failed:'投递失败',unknown:'结果未知'}[status];
  }
  function providerEvent(type:string|null):string {
    return type?({delivered:'收件服务器已接收',deferred:'投递暂时延迟',bounced:'退信',failed:'投递失败',rejected:'发送被拒绝',complained:'收到投诉'} as Record<string,string>)[type]??type:'尚无投递事件';
  }
  function providerDate(value:number):string {return new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function discardChanges():boolean {return !dirty||window.confirm('还有尚未保存的更改。是否放弃这些更改？');}
  function adopt(value:DraftDTO) {
    draft=value;to=value.content.to.join(', ');cc=value.content.cc.join(', ');bcc=value.content.bcc.join(', ');
    subject=value.content.subject;text=value.content.text;replyId=value.content.replyMessageId;
    htmlEnabled=typeof value.content.html==='string';html=value.content.html??'';inlineImages=(value.content.inlineImages??[]).map(image=>({...image}));htmlReviewChecked=false;savedSnapshot=formSnapshot();
  }
  function newDraft() {
    if(busy||!discardChanges())return;
    resetEditor();
  }
  function resetEditor() {
    draft=null;to='';cc='';bcc='';subject='';text='';replyId=null;htmlEnabled=false;html='';inlineImages=[];htmlReviewChecked=false;savedSnapshot='';errorMessage='';notice='';
  }
  async function loadLists() {
    loading=true;
    try {
      const [draftResult,outboundResult]=await Promise.all([
        ownerRequest<{drafts:DraftSummary[]}>(`${base}/drafts`,{signal:controller.signal}),
        ownerRequest<{outbound:OutboundSummary[]}>(`${base}/outbound`,{signal:controller.signal})
      ]);
      if(!controller.signal.aborted){drafts=draftResult.drafts;outbound=outboundResult.outbound;}
    }finally {if(!controller.signal.aborted)loading=false;}
  }
  async function refresh() {
    if(busy||loading||!discardChanges())return;busy='refresh';errorMessage='';
    try {
      await loadLists();
      if(draft){const result=await ownerRequest<{draft:DraftDTO}>(`${base}/drafts/${draft.id}`,{signal:controller.signal});if(!controller.signal.aborted)adopt(result.draft);}
    }catch(error){showError(error);}finally {if(!controller.signal.aborted)busy=null;}
  }
  async function openDraft(id:string) {
    if(busy||!discardChanges())return;busy='open';errorMessage='';notice='';
    try {const result=await ownerRequest<{draft:DraftDTO}>(`${base}/drafts/${id}`,{signal:controller.signal});if(!controller.signal.aborted)adopt(result.draft);}
    catch(error){showError(error);}finally {if(!controller.signal.aborted)busy=null;}
  }
  async function seedReply() {
    if(busy||!replyMessageId||!discardChanges())return;busy='reply';errorMessage='';notice='';
    try {
      const result=await ownerRequest<{draft:DraftDTO}>(`${base}/drafts`,{method:'POST',body:{to:[],cc:[],bcc:[],subject:'',text:'',replyMessageId},signal:controller.signal});
      if(!controller.signal.aborted){adopt(result.draft);notice='回复草稿已创建。请核对收件人并填写正文。';await loadLists();}
    }catch(error){showError(error);}finally {if(!controller.signal.aborted)busy=null;}
  }
  async function save(event:SubmitEvent) {
    event.preventDefault();if(busy||!editable)return;
    if(textBytes>65_536||htmlEnabled&&htmlBytes>65_536){errorMessage='文本正文与 HTML 源码各自不能超过 64 KiB（UTF-8）。';return;}
    busy='save';errorMessage='';notice='';
    try {
      const result=await ownerRequest<{draft:DraftDTO}>(draft?`${base}/drafts/${draft.id}`:`${base}/drafts`,{
        method:draft?'PATCH':'POST',body:{...input(),...(draft?{expectedVersion:draft.version}:{})},signal:controller.signal
      });
      if(!controller.signal.aborted){adopt(result.draft);notice='草稿已保存，请核对当前版本后审批。';await loadLists();}
    }catch(error){showError(error);}finally {if(!controller.signal.aborted)busy=null;}
  }
  async function uploadFiles(files:File[]) {
    if(busy||!draft||!editable||dirty||mailbox.status!=='active')return;
    const current=draft,attachments=current.content.attachments??[],maxBytes=5*1024*1024;
    errorMessage='';notice='';
    if(attachments.length+files.length>32){errorMessage='每份草稿最多添加 32 个附件。';return;}
    if(files.some(file=>file.size>maxBytes)||attachments.reduce((sum,file)=>sum+file.sizeBytes,0)+files.reduce((sum,file)=>sum+file.size,0)>maxBytes){
      errorMessage='单个附件及草稿附件合计大小不能超过 5 MiB。';return;
    }
    busy='attachments-upload';
    let uploaded=0;
    try {
      for(const file of files) {
        if(controller.signal.aborted||!draft)return;
        const response=await fetch(`${base}/drafts/${draft.id}/attachments`,{method:'POST',credentials:'same-origin',redirect:'manual',cache:'no-store',signal:controller.signal,
          headers:{Accept:'application/json','Content-Type':'application/octet-stream','X-Draft-Version':String(draft.version),
            'X-Attachment-Filename':encodeURIComponent(file.name),'X-Attachment-Content-Type':file.type||'application/octet-stream'},body:await file.arrayBuffer()});
        if(response.type==='opaqueredirect'||response.status===401||!response.headers.get('content-type')?.includes('application/json'))throw new Error('登录状态已失效，请重新打开控制台登录。');
        const data=await response.json() as {draft?:DraftDTO;error?:{code?:string}};
        if(!response.ok||!data.draft){
          const code=data.error?.code??'';
          const message:Record<string,string>={draft_changed:'草稿版本已更新，请刷新后重新核对。',draft_not_editable:'此草稿已提交或不能修改。',
            attachments_too_large:'草稿附件合计大小不能超过 5 MiB。',attachment_too_large:'单个附件大小不能超过 5 MiB。',
            too_many_attachments:'每份草稿最多添加 32 个附件。',mailbox_inactive:'邮箱已暂停，恢复后才可上传附件。',
            invalid_attachment_metadata:'附件名称或类型无效，请检查文件后重新选择。',attachment_object_conflict:'附件存储校验失败，请刷新核对后重新上传。',
            attachment_unavailable:'附件数据暂不可用，请刷新核对后重试。',attachment_blocked:'此附件已被阻止，无法添加到发送内容。'};
          throw new Error(message[code]??'附件上传未完成，请刷新核对当前版本后再试。');
        }
        if(!controller.signal.aborted){adopt(data.draft);uploaded++;notice=`已上传 ${uploaded} / ${files.length} 个附件。当前版本需要重新审批。`;}
      }
    }catch(error){showError(error instanceof TypeError?new Error('附件上传请求未完成，请刷新核对当前版本后再操作。'):error);}
    finally{if(!controller.signal.aborted){if(uploaded>0)await loadLists().catch(showError);busy=null;}}
  }
  async function removeAttachment(attachment:NonNullable<DraftDTO['content']['attachments']>[number]) {
    if(busy||!draft||!editable||dirty||mailbox.status!=='active')return;
    busy='attachments-remove';errorMessage='';notice='';
    try {
      const result=await ownerRequest<{draft:DraftDTO}>(`${base}/drafts/${draft.id}/attachments/${attachment.id}`,{
        method:'DELETE',body:{expectedVersion:draft.version},signal:controller.signal
      });
      if(!controller.signal.aborted){adopt(result.draft);notice='附件已从当前草稿移除。当前版本需要重新审批。';await loadLists();}
    }catch(error){showError(error);}finally{if(!controller.signal.aborted)busy=null;}
  }
  async function approve() {
    if(busy||!draft||!canApprove)return;busy='approve';errorMessage='';notice='';
    try {
      const result=await ownerRequest<{draft:DraftDTO}>(`${base}/drafts/${draft.id}/approve`,{method:'POST',body:{expectedVersion:draft.version,contentSha256:draft.contentSha256},signal:controller.signal});
      if(!controller.signal.aborted){adopt(result.draft);notice='当前版本已审批。点击“提交发送”后才会进入发送队列。';await loadLists();}
    }catch(error){showError(error);}finally {if(!controller.signal.aborted)busy=null;}
  }
  function sendStorageKey(value:DraftDTO):string {return `agent-mail:send:${mailbox.id}:${value.id}:${value.version}:${value.contentSha256}`;}
  function sendKey(value:DraftDTO):string {
    const key=sendStorageKey(value);if(inMemorySendFor===key&&inMemorySendKey)return inMemorySendKey;
    let stored:string|null=null;
    try {stored=sessionStorage.getItem(key);}catch {/* A stable in-memory key also protects repeated clicks in this view. */}
    const result=stored&&/^[0-9a-f-]{36}$/i.test(stored)?stored:crypto.randomUUID();
    inMemorySendFor=key;inMemorySendKey=result;
    try {sessionStorage.setItem(key,result);}catch {/* Never store message content or credentials here. */}
    return result;
  }
  async function send() {
    if(busy||!draft||!canSend)return;busy='send';errorMessage='';notice='';
    const sendingDraft=draft;
    try {
      const result=await ownerRequest<{status:'approval_required'|'queued';draftId:string;outboundId?:string}>(`${base}/drafts/${sendingDraft.id}/send`,{
        method:'POST',body:{expectedVersion:sendingDraft.version},idempotencyKey:sendKey(sendingDraft),signal:controller.signal
      });
      if(!controller.signal.aborted){
        if(result.status==='approval_required') {
          draft={...sendingDraft,state:'awaiting_approval'};
          try {sessionStorage.removeItem(sendStorageKey(sendingDraft));}catch {/* No submission was created. */}
          inMemorySendFor='';inMemorySendKey='';notice='当前版本需要重新审批，请核对下方完整内容。';
        }else {draft={...sendingDraft,state:'submitted'};notice='已进入发送队列。请刷新发送记录查看结果；服务接受不代表已经送达。';}
        await loadLists();
      }
    }catch(error){showError(error);}finally {if(!controller.signal.aborted)busy=null;}
  }
  async function cancel(item:OutboundSummary) {
    if(busy||item.status!=='queued')return;busy='cancel';errorMessage='';notice='';
    try {await ownerRequest(`${base}/outbound/${item.id}/cancel`,{method:'POST',body:{},signal:controller.signal});if(!controller.signal.aborted){notice='已取消尚未提交的发送。';await loadLists();}}
    catch(error){showError(error);}finally {if(!controller.signal.aborted)busy=null;}
  }
  async function discard() {
    if(busy||!draft||!editable||!window.confirm('确认丢弃此草稿？尚未保存的修改也会丢失。'))return;
    busy='discard';errorMessage='';notice='';
    try {await ownerRequest(`${base}/drafts/${draft.id}`,{method:'DELETE',body:{},signal:controller.signal});if(!controller.signal.aborted){resetEditor();notice='草稿已丢弃。';await loadLists();}}
    catch(error){showError(error);}finally {if(!controller.signal.aborted)busy=null;}
  }
</script>

<div class="breadcrumb"><a href="/owner/mailboxes">邮箱</a><span>/</span><span>{mailbox.name}</span></div>
<div class="page-heading reader-heading"><div><h1>{mailbox.name}</h1><div class="address-line"><span>{mailbox.address}</span><span class="badge" class:active={mailbox.status==='active'} class:paused={mailbox.status==='paused'}>{mailbox.status==='active'?'启用中':'已暂停'}</span></div></div><button type="button" disabled={Boolean(busy)||loading} onclick={refresh}>刷新</button></div>
<MailboxTabs mailboxId={mailbox.id} active="outbound"/>
{#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
{#if notice}<div class="notice" role="status">{notice}</div>{/if}
{#if mailbox.status!=='active'}<div class="token-note">邮箱已暂停，无法提交发送。恢复邮箱后再操作。</div>{/if}
{#if replyMessageId}<div class="reply-banner"><div><strong>回复邮件</strong><p>点击创建后，将从原邮件生成收件人和回复主题。请在发送前核对。</p></div><button type="button" disabled={Boolean(busy)||mailbox.status!=='active'} onclick={seedReply}>{busy==='reply'?'创建中…':'创建回复草稿'}</button></div>{/if}

<div class="outbound-grid">
  <section class="draft-list" aria-labelledby="draft-list-heading"><div class="mail-list-top"><h2 id="draft-list-heading">草稿</h2><button class="table-action" type="button" disabled={Boolean(busy)} onclick={newDraft}><Icon name="plus" size={16}/>新建</button></div>
    {#if loading&&drafts.length===0}<p class="draft-empty" role="status">正在读取草稿…</p>
    {:else if drafts.length===0}<div class="draft-empty"><p>还没有草稿。</p><p>在右侧填写邮件并保存，或从阅读页面回复。</p></div>
    {:else}<ul>{#each drafts as item (item.id)}<li><button type="button" class:chosen={draft?.id===item.id} disabled={Boolean(busy)} onclick={()=>openDraft(item.id)} aria-current={draft?.id===item.id?'true':undefined}><strong>{item.content?.subject||item.subject||'（无主题）'}</strong><span><span class="badge">{draftLabel(item.state)}</span><small>版本 {item.version}</small></span><small>{item.createdByTokenId?'Agent 创建':'Owner 创建'} · {date(item.updatedAt)}</small></button></li>{/each}</ul>{/if}
  </section>

  <div class="draft-workspace">
    <section aria-labelledby="compose-heading"><div class="section-heading"><div><h2 id="compose-heading">{draft?'编辑草稿':'新邮件'}</h2><p>{draft?`版本 ${draft.version} · ${draftLabel(draft.state)}`:'保存后核对内容，再审批并提交发送。'}</p></div>{#if draft&&editable}<button type="button" class="table-action" disabled={Boolean(busy)} onclick={discard}>丢弃草稿</button>{:else if replyId}<span class="badge">回复邮件</span>{/if}</div>
      <form onsubmit={save}><fieldset class="compose-fields" disabled={Boolean(busy)||!editable}>
        <div class="field"><span class="compose-from-label">发件人</span><div class="scope-label">{mailbox.address}</div></div>
        <div class="field"><label for="compose-to">收件人</label><textarea id="compose-to" bind:value={to} rows="2" spellcheck={false} placeholder="name@example.com，多个地址以逗号或换行分隔"></textarea></div>
        <div class="compose-addresses"><div class="field"><label for="compose-cc">抄送</label><textarea id="compose-cc" bind:value={cc} rows="2" spellcheck={false}></textarea></div><div class="field"><label for="compose-bcc">密送</label><textarea id="compose-bcc" bind:value={bcc} rows="2" spellcheck={false}></textarea></div></div>
        <div class="field"><label for="compose-subject">主题</label><input id="compose-subject" bind:value={subject} maxlength="512" autocomplete="off"/></div>
        <div class="field"><label for="compose-text">文本正文</label><textarea id="compose-text" class="compose-text" bind:value={text} rows="10" placeholder="填写邮件正文"></textarea><small>发送必须保留文本正文，作为纯文本客户端的阅读内容。{textBytes.toLocaleString()} / 65,536 字节（UTF-8）。请先保存草稿，再添加附件。</small></div>
        <label class="compose-html-toggle"><input type="checkbox" checked={htmlEnabled} onchange={toggleHtml}/>添加 HTML 正文</label>
        {#if htmlEnabled}<div class="field compose-html-field"><label for="compose-html">HTML 源码</label><textarea id="compose-html" class="compose-html" bind:value={html} rows="10" spellcheck={false} placeholder="<h2>邮件标题</h2><p>邮件正文</p>"></textarea><small>{htmlBytes.toLocaleString()} / 65,536 字节（UTF-8）。源码以文本方式编辑。保存后可预览；图片可在下方绑定为内嵌附件。</small></div>{/if}
        <button class="primary" type="submit" disabled={draft!==null&&!dirty}>{busy==='save'?'保存中…':draft?'保存新版本':'保存草稿'}</button>
      </fieldset></form>
      {#if !editable}<p class="helper">此草稿已提交或丢弃，内容保持冻结。如需发送另一封邮件，请新建草稿。</p>{/if}
    </section>

    {#if draft}<section class="approval-preview" aria-labelledby="approval-heading"><div class="section-heading"><div><h2 id="approval-heading">核对与审批</h2><p>审批仅适用于下方已保存版本。保存任何修改后，需重新审批。</p></div><span class="badge">{draftLabel(draft.state)}</span></div>
      {#if dirty}<div class="notice" role="status">当前更改尚未保存。下方展示已保存版本，保存后才能审批或发送。</div>{/if}
      <dl class="approval-metadata"><div><dt>发件人</dt><dd>{mailbox.address}</dd></div><div><dt>收件人</dt><dd>{draft.content.to.join('；')||'无'}</dd></div><div><dt>抄送</dt><dd>{draft.content.cc.join('；')||'无'}</dd></div><div><dt>密送</dt><dd>{draft.content.bcc.join('；')||'无'}</dd></div><div><dt>主题</dt><dd>{draft.content.subject||'（无主题）'}</dd></div><div><dt>版本</dt><dd>{draft.version}</dd></div><div><dt>内容 SHA-256</dt><dd><code>{draft.contentSha256}</code></dd></div>{#if draft.content.inReplyTo}<div><dt>回复引用</dt><dd>{draft.content.inReplyTo}</dd></div>{/if}</dl>
      <h3 class="approval-body-label">完整文本正文</h3><pre class="message-body approval-body">{draft.content.text||'（正文为空）'}</pre>
      {#if savedHasHtml}
        <h3 class="approval-body-label">已保存的完整 HTML 源码</h3><pre class="approval-body approval-html-source">{draft.content.html}</pre>
        {#if !dirty}<div class="draft-html-preview"><h3 class="approval-body-label">已保存版本的安全 HTML 预览</h3><p class="helper">预览经过安全清洗，脚本、表单和远程图片已屏蔽。发送采用上方已保存的 HTML 源码；内嵌图片需绑定当前草稿附件。</p>
          {#key `${draft.id}:${draft.version}:${draft.contentSha256}`}<iframe class="message-html-frame" title="草稿 HTML 安全预览" sandbox="" referrerpolicy="no-referrer" src={previewUrl(draft)}></iframe>{/key}
          {#if editable&&draft.state!=='approved'}<label class="html-review-confirm"><input type="checkbox" bind:checked={htmlReviewChecked} disabled={Boolean(busy)}/>已核对当前版本的文本、HTML 源码和安全预览</label>{/if}
        </div>{:else}<p class="draft-preview-hidden" role="status">有未保存的修改，HTML 预览已隐藏。保存新版本后重新核对。</p>{/if}
      {/if}
      <DraftAttachments {draft} {base} busy={Boolean(busy)} {editable} {dirty} {htmlEnabled} {inlineImages} active={mailbox.status==='active'} onUpload={uploadFiles} onRemove={removeAttachment} onInlineChange={changeInlineImage} onInsertCid={insertInlineImage}/>
      <div class="approval-actions"><button type="button" disabled={Boolean(busy)||!canApprove} onclick={approve}>{busy==='approve'?'审批中…':'审批当前版本'}</button><button type="button" class="primary" disabled={Boolean(busy)||!canSend} onclick={send}>{busy==='send'?'提交中…':'提交发送'}</button></div>
      <p class="helper">审批不会自动发送。提交后由后台处理；已接受表示发送服务已接收，尚不代表送达。</p>
    </section>{/if}
  </div>
</div>

<section class="outbound-history" aria-labelledby="outbound-heading"><div class="section-heading"><div><h2 id="outbound-heading">发送记录</h2><p>刷新查看最新状态。收件服务器已接收不代表已读；延迟、退信或投诉不会触发自动重新发送。</p></div><span class="helper">{outbound.length} 条</span></div>
  {#if outbound.length===0}<div class="table-wrap empty-state"><p>{loading?'正在读取发送记录…':'还没有发送记录。'}</p></div>
  {:else}<ul class="outbound-records">{#each outbound as item (item.id)}<li data-outbound-id={item.id}><div class="outbound-record-heading"><span class="badge" class:active={item.status==='accepted'||item.status==='delivered'} class:paused={item.status==='unknown'||item.status==='partial'||item.status==='bounced'||item.status==='failed'}>{outboundLabel(item.status)}</span><time datetime={new Date(item.createdAt).toISOString()}>{date(item.createdAt)}</time>{#if item.status==='queued'}<button type="button" class="table-action" disabled={Boolean(busy)} onclick={()=>cancel(item)}>取消发送</button>{/if}</div>
    <dl class="approval-metadata">{#if item.providerMessageId}<div><dt>服务消息 ID</dt><dd>{item.providerMessageId}</dd></div>{/if}{#if item.lastProviderEventAt!==null}<div><dt>最新服务事件</dt><dd><time datetime={new Date(item.lastProviderEventAt).toISOString()}>{providerDate(item.lastProviderEventAt)}</time></dd></div>{/if}{#if item.lastErrorCode}<div><dt>状态代码</dt><dd>{item.lastErrorCode}</dd></div>{/if}</dl>
    <ul class="outbound-recipient-statuses" aria-label="收件人投递状态">{#each item.recipients as recipient (`${recipient.kind}:${recipient.address}`)}<li data-recipient={recipient.address}>
      <div class="outbound-recipient-heading"><span class="outbound-recipient-kind">{recipient.kind==='to'?'收件人':recipient.kind==='cc'?'抄送':'密送'}</span><strong>{recipient.address}</strong><span class="badge" class:active={recipient.status==='delivered'} class:paused={['deferred','bounced','failed','unknown'].includes(recipient.status)}>{recipientStatus(recipient.status)}</span>{#if recipient.complainedAt!==null}<span class="badge paused">收到投诉</span>{/if}</div>
      {#if recipient.deliveryEventType}<p class="outbound-recipient-event">投递结果事件：{providerEvent(recipient.deliveryEventType)}</p>{/if}
      {#if recipient.lastProviderEventAt!==null}<p class="outbound-recipient-event">最新服务事件时间：<time datetime={new Date(recipient.lastProviderEventAt).toISOString()}>{providerDate(recipient.lastProviderEventAt)}</time></p>{/if}
      {#if recipient.complainedAt!==null}<p class="outbound-recipient-event">投诉时间：<time datetime={new Date(recipient.complainedAt).toISOString()}>{providerDate(recipient.complainedAt)}</time>。发送服务可能限制后续投递，请先核对接收方意愿。</p>{/if}
      {#if recipient.diagnosticCode}<p class="outbound-recipient-event">诊断代码：<code>{recipient.diagnosticCode}</code></p>{/if}
    </li>{/each}</ul>
    {#if item.status==='unknown'}<p class="outbound-unknown" role="status">发送结果未知，邮件可能已经发出。不会自动重发，请先核对发送服务的记录。</p>{:else if item.status==='submitting'}<p class="helper">正在提交，无法保证取消。请刷新查看结果。</p>{/if}
  </li>{/each}</ul>{/if}
</section>

<style>
  .outbound-recipient-statuses {list-style:none;margin:16px 0 3px;padding:0;border-top:1px solid var(--line);}
  .outbound-recipient-statuses>li {padding:13px 0;border-bottom:1px solid var(--line);min-width:0;}
  .outbound-recipient-statuses>li:last-child {border-bottom:0;}
  .outbound-recipient-heading {display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;}
  .outbound-recipient-kind {font-size:11px;color:var(--muted);min-width:36px;}
  .outbound-recipient-heading strong {font-size:13px;font-weight:600;overflow-wrap:anywhere;min-width:0;}
  .outbound-recipient-event {font-size:11px;line-height:1.8;overflow-wrap:anywhere;margin:5px 0 0;}
  .outbound-recipient-event code {font:11px/1.8 ui-monospace,monospace;}
</style>
