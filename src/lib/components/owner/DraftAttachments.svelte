<script lang="ts">
  import type {DraftDTO} from '#lib/types/outbound.ts';
  type Attachment=NonNullable<DraftDTO['content']['attachments']>[number];
  type InlineImage={attachmentId:string;contentId:string};
  let {draft,base,busy,editable,dirty,active,htmlEnabled,inlineImages,onUpload,onRemove,onInlineChange,onInsertCid}:{
    draft:DraftDTO;base:string;busy:boolean;editable:boolean;dirty:boolean;active:boolean;
    htmlEnabled:boolean;inlineImages:InlineImage[];
    onUpload:(files:File[])=>Promise<void>;onRemove:(attachment:Attachment)=>Promise<void>;
    onInlineChange:(attachmentId:string,contentId:string|null)=>void;onInsertCid:(attachmentId:string,contentId:string)=>void;
  }=$props();
  let fileInput:HTMLInputElement|undefined=$state();
  const attachments=$derived(draft.content.attachments??[]);
  const canMutate=$derived(editable&&active&&!dirty&&!busy);
  const canBind=$derived(editable&&active&&htmlEnabled&&!busy);
  function canInline(file:Attachment):boolean {return /^(?:image\/png|image\/jpeg|image\/gif|image\/webp)$/.test(file.contentType)&&file.sizeBytes<=1024*1024;}
  function size(bytes:number):string {
    if(bytes<1024)return `${bytes} B`;
    if(bytes<1024*1024)return `${(bytes/1024).toFixed(bytes<10*1024?1:0)} KiB`;
    return `${(bytes/(1024*1024)).toFixed(1)} MiB`;
  }
  function selected(event:Event) {
    const input=event.currentTarget as HTMLInputElement,files=Array.from(input.files??[]);
    input.value='';
    if(files.length)void onUpload(files);
  }
</script>

<section class="draft-attachments" aria-label="草稿附件">
  <div class="draft-attachment-heading"><h3>草稿附件 <span>{attachments.length} / 32</span></h3>
    {#if editable}<button type="button" disabled={!canMutate||attachments.length>=32} onclick={()=>fileInput?.click()}>{busy?'处理中…':'添加附件'}</button>{/if}
  </div>
  <input class="draft-file-input" type="file" multiple bind:this={fileInput} onchange={selected} disabled={!canMutate} aria-label="选择草稿附件"/>
  {#if attachments.length===0}<p class="helper">此版本没有附件。</p>
  {:else}<ul class="draft-attachment-list">{#each attachments as attachment (attachment.id)}{@const inline=inlineImages.find(image=>image.attachmentId===attachment.id)}<li>
    <div class="draft-attachment-info"><strong>{attachment.filename}</strong><div class="draft-attachment-meta"><span>{size(attachment.sizeBytes)}</span><span>{attachment.contentType}</span></div>
      <span class="draft-attachment-hash-label">SHA-256</span><code>{attachment.sha256}</code>
      {#if htmlEnabled}
        {#if canInline(attachment)||inline}<div class="draft-inline-binding">
          <label class="draft-inline-toggle"><input type="checkbox" checked={Boolean(inline)} disabled={!canBind||!inline&&inlineImages.length>=8} onchange={event=>onInlineChange(attachment.id,event.currentTarget.checked?`image-${attachment.id}@agent-mail`:null)}/>将 {attachment.filename} 用作内嵌图片</label>
          {#if inline}<label for={`inline-cid-${attachment.id}`}>Content-ID</label><input id={`inline-cid-${attachment.id}`} aria-label={`Content-ID：${attachment.filename}`} value={inline.contentId} maxlength="200" disabled={!canBind} spellcheck={false} oninput={event=>onInlineChange(attachment.id,event.currentTarget.value)}/>
            <div class="draft-inline-reference"><code>cid:{inline.contentId}</code>{#if editable}<button type="button" disabled={!canBind||!inline.contentId} onclick={()=>onInsertCid(attachment.id,inline.contentId)} aria-label={`插入内嵌图片 ${attachment.filename}`}>插入正文引用</button>{/if}</div>
          {/if}
        </div>{:else}<p class="draft-attachment-note">此附件不适合作为内嵌图片；支持单张不超过 1 MiB 的 PNG、JPEG、GIF、WebP。</p>{/if}
      {/if}
    </div>
    <div class="draft-attachment-actions"><a class="button" href={`${base}/drafts/${draft.id}/attachments/${attachment.id}/download`} data-sveltekit-reload aria-label={`下载草稿附件 ${attachment.filename}`}>下载核对</a>
      {#if editable}<button type="button" class="table-action" disabled={!canMutate} onclick={()=>onRemove(attachment)} aria-label={`移除附件 ${attachment.filename}`}>移除</button>{/if}
    </div>
  </li>{/each}</ul>{/if}
  {#if dirty}<p class="draft-attachment-note">请先保存文本更改，再上传或移除附件。</p>
  {:else if editable}<p class="draft-attachment-note">上传或移除附件会保存新版本并使已有审批失效。最多 32 个文件，单个及合计大小不超过 5 MiB。</p>{/if}
  {#if attachments.length}<p class="helper">审批会同时确认这些文件的名称、类型、大小和内容摘要。附件未经病毒扫描，请在审批前核对来源与内容。</p>{/if}
  {#if htmlEnabled}<p class="draft-attachment-note">内嵌图片 {inlineImages.length} / 8。绑定后点击“插入正文引用”，或在 HTML 源码中使用对应的 cid: 地址。绑定与源码修改一起保存并使审批失效；合计上限 4 MiB，审批和发送前会验证图片内容。</p>{/if}
</section>
