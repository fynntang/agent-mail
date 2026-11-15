<script lang="ts">
  import {invalidateAll} from '$app/navigation';
  import {onDestroy} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {MessageDetail,HtmlBodyStatus,OwnerMessageHtml} from '#lib/types/mail.ts';

  type HtmlInfo=Omit<OwnerMessageHtml,'html'>;
  let {mailboxId,messageId,body}:{mailboxId:string;messageId:string;body:MessageDetail['body']}=$props();
  let mode=$state<'text'|'html'>('text'),busy=$state(false),errorMessage=$state('');
  let info=$state<HtmlInfo|null>(null),document=$state<string|null>(null),imagesAllowed=$state(false),frameVersion=$state(0);
  let sequence=0;
  const controller=new AbortController();
  const htmlEndpoint=$derived(`/owner/api/mailboxes/${mailboxId}/messages/${messageId}/html`);
  const canShowHtml=$derived(body.htmlStatus==='available');
  const links=$derived((info?.links??[]).filter(link=>{
    try{const url=new URL(link.url);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}
  }).slice(0,50));
  onDestroy(()=>{sequence++;controller.abort();});

  const statusText=(status:HtmlBodyStatus):string=>({
    available:'',not_present:'此邮件没有 HTML 正文。',not_extracted:'此邮件尚未提取 HTML 正文，原始邮件已保留。',
    pending:'HTML 正文正在解析，请稍后刷新。',failed:'邮件解析失败，HTML 正文暂不可用。',
    unavailable:'HTML 正文暂不可用，请稍后重试。',too_large:'HTML 正文超过安全展示上限，请使用纯文本或原始邮件。'
  })[status];
  function showText() {sequence++;mode='text';busy=false;info=null;document=null;imagesAllowed=false;errorMessage='';frameVersion++;}
  async function showBlockedHtml() {
    if(!canShowHtml)return;
    const request=++sequence;mode='html';busy=true;errorMessage='';document=null;imagesAllowed=false;info=null;frameVersion++;
    try{
      const value=await ownerRequest<HtmlInfo>(`${htmlEndpoint}-info`,{signal:controller.signal});
      if(request===sequence&&!controller.signal.aborted)info=value;
    }catch(error){if(request===sequence&&!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'HTML 正文加载失败，请重试。';}
    finally{if(request===sequence&&!controller.signal.aborted)busy=false;}
  }
  async function allowImages() {
    if(busy||mode!=='html'||!info?.remoteImages)return;
    if(!window.confirm('邮件服务将代为获取图片，浏览器不会直接访问外站。对方仍可能据此获知阅读时间。是否仅为这封邮件加载？'))return;
    const request=++sequence;busy=true;errorMessage='';
    try{
      const value=await ownerRequest<HtmlInfo&{document:string|null}>(htmlEndpoint,{method:'POST',body:{allowRemoteImages:true},signal:controller.signal});
      if(request===sequence&&!controller.signal.aborted){
        info=value;
        if(value.status==='available'&&typeof value.document==='string'){document=value.document;imagesAllowed=true;frameVersion++;}
      }
    }catch(error){if(request===sequence&&!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'图片许可未完成，请重试。';}
    finally{if(request===sequence&&!controller.signal.aborted)busy=false;}
  }
</script>

<div class="message-body-toolbar"><div class="message-body-switch" role="group" aria-label="正文格式">
  <button type="button" class:chosen={mode==='text'} aria-pressed={mode==='text'} onclick={showText}>纯文本</button>
  <button type="button" class:chosen={mode==='html'} aria-pressed={mode==='html'} disabled={!canShowHtml||busy} onclick={showBlockedHtml}>HTML 正文</button>
</div><span class="message-body-hint">{canShowHtml?'HTML 在独立沙箱中展示':'纯文本模式'}</span></div>

{#if mode==='text'}
  {#if body.status==='ready'}<pre class="message-body">{body.text}</pre>
  {:else}<div class="message-body-status" role={body.status==='unavailable'?'alert':'status'}>
    {#if body.status==='pending'}正文正在解析，请稍后刷新。
    {:else if body.status==='failed'}邮件解析失败，原始邮件已保留。
    {:else if body.status==='unavailable'}正文暂不可用，请稍后刷新重试。
    {:else if body.status==='not_extracted'}尚未提取可显示的文本正文，原始邮件已保留。
    {:else}提取的文本正文为空。{/if}
    {#if body.status==='unavailable'||body.status==='pending'}<button type="button" onclick={()=>invalidateAll()}>重新加载正文</button>{/if}
  </div>{/if}
  {#if !canShowHtml}<p class="html-availability">{statusText(body.htmlStatus)}</p>{/if}
{:else}
  <div class="html-content-notice"><strong>来自邮件的不可信内容</strong><p>HTML 已清洗并在无脚本、表单或页面访问权限的沙箱中展示。邮件中的链接不会在正文内跳转。</p></div>
  {#if errorMessage}<div class="notice error" role="alert">{errorMessage}<button type="button" onclick={showBlockedHtml}>重新加载 HTML</button></div>{/if}
  {#if busy}<p class="html-loading" role="status">正在准备安全正文…</p>{/if}
  {#if info?.status==='available'}
    <div class="html-image-controls">
      <p>{#if info.inlineImages>0}内嵌图片已显示 {info.loadedInlineImages} / {info.inlineImages} 处，无需访问外站。 {/if}{#if imagesAllowed}已仅为此邮件加载 {info.loadedImages} 处远程图片，浏览器不会直接访问来源。{:else}远程图片默认屏蔽{info.remoteImages?`（${info.remoteImages} 处）`:''}。{/if}{#if imagesAllowed?info.blockedImages>0:info.blockedImages>info.remoteImages} 不可用或超过限制的图片资源仍被屏蔽。{/if}</p>
      {#if imagesAllowed}<button type="button" disabled={busy} onclick={showBlockedHtml}>恢复屏蔽图片</button>
      {:else if info.remoteImages>0}<button type="button" disabled={busy} onclick={allowImages}>加载远程图片</button>{/if}
    </div>
    {#key `${imagesAllowed}:${frameVersion}`}<iframe class="message-html-frame" title="HTML 邮件正文" sandbox="" referrerpolicy="no-referrer" src={document?undefined:htmlEndpoint} srcdoc={document??undefined}></iframe>{/key}
    {#if links.length}<div class="html-mail-links"><h3>邮件中的外部链接</h3><p>打开前核对实际地址；邮件中的文字不代表站点可信。</p><ul>{#each links as link,index (`${link.url}:${index}`)}<li><span>{link.label||'外部链接'}</span><a href={link.url} target="_blank" rel="noopener noreferrer">{link.url}</a></li>{/each}</ul></div>{/if}
  {:else if info}<p class="html-availability">{statusText(info.status)}</p>{/if}
{/if}
