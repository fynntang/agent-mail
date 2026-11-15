<script lang="ts">
  import type {MessageDetail} from '#lib/types/mail.ts';
  let {mailboxId,messageId,attachments}:{mailboxId:string;messageId:string;attachments:MessageDetail['attachments']}=$props();
  function size(bytes:number):string {
    if(bytes<1024)return `${bytes} B`;
    if(bytes<1024*1024)return `${(bytes/1024).toFixed(bytes<10*1024?1:0)} KiB`;
    return `${(bytes/(1024*1024)).toFixed(1)} MiB`;
  }
  const scanLabel=(status:string)=>({unscanned:'未扫描',clean:'扫描通过',blocked:'已阻止',failed:'扫描失败'} as Record<string,string>)[status]??'状态未知';
</script>

<section class="message-attachments" aria-label="邮件附件">
  <div class="attachment-heading"><h3>附件</h3>{#if attachments.status==='ready'}<span>{attachments.attachments.length} 个</span>{/if}</div>
  {#if attachments.status==='pending'}<p class="attachment-status">附件正在解析，请稍后刷新。</p>
  {:else if attachments.status==='failed'}<p class="attachment-status">邮件解析失败，附件暂不可用；原始邮件已保留。</p>
  {:else if attachments.status==='not_extracted'}<p class="attachment-status">此邮件尚未提取附件，原始邮件已保留。</p>
  {:else if attachments.attachments.length===0}<p class="attachment-status">此邮件没有附件。</p>
  {:else}
    <ul class="attachment-list">{#each attachments.attachments as attachment (attachment.id)}<li>
      <div class="attachment-details"><strong class="attachment-filename">{attachment.filename}</strong><div class="attachment-metadata"><span>{size(attachment.sizeBytes)}</span><span>{attachment.contentType}</span>{#if attachment.disposition==='inline'}<span class="badge">内嵌资源</span>{/if}<span class:attachment-blocked={attachment.scanStatus==='blocked'||attachment.scanStatus==='failed'}>{scanLabel(attachment.scanStatus)}</span></div></div>
      {#if attachment.downloadable&&attachments.canDownload}<a class="button attachment-download" href={`/owner/api/mailboxes/${mailboxId}/messages/${messageId}/attachments/${attachment.id}/download`} data-sveltekit-reload aria-label={`下载 ${attachment.filename}`}>下载</a>
      {:else}<span class="attachment-unavailable">{attachment.scanStatus==='blocked'||attachment.scanStatus==='failed'?'禁止下载':attachments.canDownload?'暂不可下载':'未授权下载'}</span>{/if}
    </li>{/each}</ul>
    {#if attachments.attachments.some(attachment=>attachment.scanStatus==='unscanned')}<p class="attachment-warning">附件未进行病毒扫描。下载前请核对来源，使用可信工具检查文件；不要直接执行未知附件。</p>{/if}
    <p class="attachment-status">附件可显式下载；通过校验的内嵌图片可在 HTML 正文的安全沙箱中显示。</p>
  {/if}
</section>
