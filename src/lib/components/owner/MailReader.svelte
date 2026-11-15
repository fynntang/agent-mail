<script lang="ts">
  import {goto,invalidateAll} from '$app/navigation';
  import {page} from '$app/state';
  import {onDestroy} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {MailboxSummary} from '#lib/types/owner.ts';
  import type {MessagePage,MessageDetail,MessageSummary} from '#lib/types/mail.ts';
  import MailboxTabs from './MailboxTabs.svelte';
  import MessageAttachments from './MessageAttachments.svelte';
  import MessageBody from './MessageBody.svelte';
  import Icon from './Icon.svelte';
  import './mail.css';
  let {mailbox,list,detail,detailError}:{mailbox:MailboxSummary;list:MessagePage;detail:MessageDetail|null;detailError:string|null}=$props();
  let busy=$state(false),errorMessage=$state(''),notice=$state('');
  const controller=new AbortController();
  onDestroy(()=>controller.abort());
  const base=$derived(`/owner/mailboxes/${mailbox.id}/messages`);
  const selectedOutsidePage=$derived(detail&&!list.messages.some(message=>message.id===detail!.message.id));
  function href(values:{cursor?:string|null;message?:string;folder?:string;read?:string;limit?:number}={}):string {
    const params=new URLSearchParams({folder:values.folder??list.filters.folder,read:values.read??list.filters.read,limit:String(values.limit??list.limit)});
    if(values.cursor)params.set('cursor',values.cursor);
    if(values.message)params.set('message',values.message);
    return `${base}?${params}`;
  }
  function subject(message:MessageSummary):string {return message.subject?.trim()||'（无主题）';}
  function openMessage(event:MouseEvent,messageId:string) {
    if(!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&window.matchMedia('(max-width:800px)').matches) {
      event.preventDefault();goto(`${href({cursor:page.url.searchParams.get('cursor'),message:messageId})}#message-body`);
    }
  }
  function received(value:number):string {return new Date(value).toISOString().replace('T',' ').slice(0,16);}
  function address(kind:string):string {
    return detail?.addresses.filter(value=>value.kind===kind).map(value=>value.name?`${value.name} <${value.address}>`:value.address).join('；')||'未提供';
  }
  async function mark(message:MessageSummary,isRead:boolean) {
    if(busy)return;busy=true;errorMessage='';notice='';
    try {
      await ownerRequest(`/owner/api/mailboxes/${mailbox.id}/messages/${message.id}`,{method:'PATCH',body:{isRead},signal:controller.signal});
      if(!controller.signal.aborted){
        if(detail?.message.id===message.id&&!page.url.searchParams.has('message')) {
          await goto(href({cursor:page.url.searchParams.get('cursor'),message:message.id}),{replace:true,reset:false});
        }else await invalidateAll();
        if(!controller.signal.aborted)notice=isRead?'已标记为已读。':'已标记为未读。';
      }
    }catch(e){if(!controller.signal.aborted)errorMessage=e instanceof Error?e.message:'修改状态失败，请重试。';}
    finally{if(!controller.signal.aborted)busy=false;}
  }
</script>

<div class="breadcrumb"><a href="/owner/mailboxes">邮箱</a><span>/</span><span>{mailbox.name}</span></div>
<div class="page-heading reader-heading"><div><h1>{mailbox.name}</h1><div class="address-line"><span>{mailbox.address}</span><span class="badge" class:active={mailbox.status==='active'} class:paused={mailbox.status==='paused'}>{mailbox.status==='active'?'启用中':'已暂停'}</span></div></div></div>
<MailboxTabs mailboxId={mailbox.id} active="mail"/>
{#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
{#if notice}<div class="notice" role="status">{notice}</div>{/if}
<div class="mail-toolbar">
  <div class="read-filter" role="group" aria-label="阅读状态筛选">
    {#each [{value:'all',label:'全部'},{value:'unread',label:'未读'},{value:'read',label:'已读'}] as filter}
      <button type="button" class:chosen={list.filters.read===filter.value} aria-pressed={list.filters.read===filter.value} onclick={()=>goto(href({read:filter.value}))}>{filter.label}</button>
    {/each}
  </div>
  <div class="mail-controls">
    <label>文件夹<select aria-label="文件夹" value={list.filters.folder} onchange={e=>goto(href({folder:e.currentTarget.value}))}><option value="inbox">收件箱</option><option value="all">全部邮件</option><option value="archive">归档</option><option value="spam">垃圾邮件</option><option value="trash">垃圾箱</option><option value="sent">已发送</option></select></label>
    <label>每页<select aria-label="每页封数" value={String(list.limit)} onchange={e=>goto(href({limit:Number(e.currentTarget.value)}))}>{#if ![10,20,50,100].includes(list.limit)}<option value={String(list.limit)}>{list.limit} 封</option>{/if}<option value="10">10 封</option><option value="20">20 封</option><option value="50">50 封</option><option value="100">100 封</option></select></label>
    <a class="button" href={href()}>刷新</a>
  </div>
</div>

<div class="mail-reader-grid">
  <section class="mail-list-panel" aria-label="邮件列表">
    <div class="mail-list-top"><h2>{list.filters.folder==='inbox'?'收件箱':'邮件列表'}</h2><span>本页 {list.messages.length} 封</span></div>
    {#if list.messages.length===0}
      <div class="mail-list-empty"><Icon name="mail" size={28}/><h3>没有符合条件的邮件</h3><p>来信会在解析后显示。筛选或分页结果变化时，可刷新查看。</p><a class="button" href={href()}>返回第一页</a></div>
    {:else}
      <ul class="mail-items">{#each list.messages as message (message.id)}
        <li class:current={detail?.message.id===message.id} class:unread={message.is_read===0}>
          <a class="mail-summary" href={href({cursor:page.url.searchParams.get('cursor'),message:message.id})} onclick={event=>openMessage(event,message.id)} aria-current={detail?.message.id===message.id?'true':undefined}>
            <div class="mail-sender"><span>{message.from?.name||message.from?.address||'未知发件人'}</span><time datetime={new Date(message.received_at).toISOString()} title="{received(message.received_at)} UTC">{received(message.received_at).slice(5,16)}</time></div>
            <div class="mail-subject">{#if !message.is_read}<span class="unread-dot" aria-label="未读"></span>{/if}<span>{subject(message)}</span></div>
            <p class="mail-preview">{message.preview||'暂无文本预览'}</p>
          </a>
          <button type="button" class="mail-state-button" disabled={busy} title={message.is_read?'标记为未读':'标记为已读'} aria-label="{message.is_read?'标记为未读':'标记为已读'}：{subject(message)}" onclick={()=>mark(message,!message.is_read)}>{message.is_read?'已读':'未读'}</button>
        </li>
      {/each}</ul>
    {/if}
    <nav class="mail-pagination" aria-label="邮件分页">
      {#if list.previousCursor}<a class="button" href={href({cursor:list.previousCursor})}>上一页</a>{:else}<span aria-disabled="true">上一页</span>{/if}
      {#if list.nextCursor}<a class="button" href={href({cursor:list.nextCursor})}>下一页</a>{:else}<span aria-disabled="true">下一页</span>{/if}
    </nav>
  </section>

  <section id="message-body" class="mail-detail-panel" aria-label="邮件正文">
    {#if detailError}<div class="mail-detail-empty"><h2>无法打开邮件</h2><p role="alert">{detailError}</p><a class="button" href={href()}>返回当前列表</a></div>
    {:else if !detail}<div class="mail-detail-empty"><Icon name="mail" size={34}/><h2>在这里阅读邮件</h2><p>选择左侧邮件，查看正文与收发信息。</p></div>
    {:else}
      <div class="message-header"><div class="message-title"><h2>{subject(detail.message)}</h2><div class="message-actions"><a class="button" href="/owner/mailboxes/{mailbox.id}/outbound?reply={detail.message.id}">回复</a><button type="button" disabled={busy} onclick={()=>mark(detail!.message,!detail!.message.is_read)}>{detail.message.is_read?'标记为未读':'标记为已读'}</button></div></div>
        <dl><div><dt>发件人</dt><dd>{address('from')}</dd></div><div><dt>收件人</dt><dd>{address('to')}</dd></div>{#if detail.addresses.some(value=>value.kind==='cc')}<div><dt>抄送</dt><dd>{address('cc')}</dd></div>{/if}<div><dt>接收时间</dt><dd><time datetime={new Date(detail.message.received_at).toISOString()}>{received(detail.message.received_at)} UTC</time></dd></div><div><dt>阅读状态</dt><dd>{detail.message.is_read?'已读':'未读'}</dd></div></dl>
        {#if selectedOutsidePage}<p class="message-filter-note">此邮件已不在当前页或筛选结果中，正文仍保留在阅读区。</p>{/if}
      </div>
      {#key detail.message.id}<MessageBody mailboxId={mailbox.id} messageId={detail.message.id} body={detail.body}/>{/key}
      <MessageAttachments mailboxId={mailbox.id} messageId={detail.message.id} attachments={detail.attachments}/>
      <p class="message-format-note">HTML 仅在独立沙箱中展示，远程图片需逐封明确许可。原始邮件已保留。</p>
    {/if}
  </section>
</div>
