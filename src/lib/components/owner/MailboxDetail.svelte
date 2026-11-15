<script lang="ts">
  import {goto,invalidateAll} from '$app/navigation';
  import type {MailboxSummary,MailboxToken} from '#lib/types/owner.ts';
  import {dateLabel,ownerRequest} from '#lib/owner-client.ts';
  import Dialog from './Dialog.svelte';
  import Icon from './Icon.svelte';
  import MailboxTabs from './MailboxTabs.svelte';
  import './mail.css';
  let {mailbox,tokens}:{mailbox:MailboxSummary;tokens:MailboxToken[]}=$props();
  let name=$state(''),sizeMiB=$state(10),busy=$state(false),notice=$state(''),error=$state('');
  let dailyLimit=$state(20),allowedRecipients=$state('');
  let issueOpen=$state(false),tokenName=$state(''),expiryDays=$state('30'),dialogError=$state('');
  let scopeRead=$state(true),scopeAttachments=$state(false),scopeDraft=$state(false),scopeSend=$state(false),requiresApproval=$state(true);
  let issuedSecret=$state(''),copied=$state(false),revokeTarget=$state<MailboxToken|null>(null),retireOpen=$state(false),confirmAddress=$state('');
  $effect(()=>{name=mailbox.name;sizeMiB=mailbox.maxMessageBytes/(1024*1024);dailyLimit=mailbox.dailyRecipientLimit;allowedRecipients=mailbox.allowedRecipients.join('\n');});
  const base=$derived(`/owner/api/mailboxes/${mailbox.id}`);
  function permissionLabel(scope:string):string {return ({'mail:read':'邮件读取','attachments:read':'附件下载','mail:draft':'草稿编辑','mail:send':'请求发信'} as Record<string,string>)[scope]??scope;}
  async function update(changes:Record<string,unknown>) {
    if(busy)return;busy=true;error='';notice='';
    try {await ownerRequest(base,{method:'PATCH',body:{...changes,expectedUpdatedAt:mailbox.updatedAt}});await invalidateAll();notice='邮箱设置已保存。';}
    catch(e){error=e instanceof Error?e.message:'保存失败，请重试。';}finally{busy=false;}
  }
  async function issue(event:SubmitEvent) {
    event.preventDefault();if(busy)return;dialogError='';
    const scopes=[...(scopeRead?['mail:read']:[]),...(scopeRead&&scopeAttachments?['attachments:read']:[]),...(scopeDraft||scopeSend?['mail:draft']:[]),...(scopeSend?['mail:send']:[])];
    if(scopes.length===0){dialogError='请至少选择一项权限。';return;}
    busy=true;
    try {
      const expiresAt=expiryDays==='never'?null:Date.now()+Number(expiryDays)*86_400_000;
      const result=await ownerRequest<{token:MailboxToken;secret:string}>(`${base}/tokens`,{method:'POST',body:{name:tokenName,scopes,requiresApproval:scopeSend?requiresApproval:true,expiresAt}});
      issuedSecret=result.secret;issueOpen=false;copied=false;tokenName='';
      // Keep the one-time result visible even when refreshing metadata fails.
      try {await invalidateAll();}catch {error='Token 已签发，但列表刷新失败，请稍后刷新。';}
    }catch(e){dialogError=e instanceof Error?e.message:'签发失败，请重试。';}finally{busy=false;}
  }
  async function revoke() {
    if(!revokeTarget||busy)return;busy=true;dialogError='';
    try {await ownerRequest(`${base}/tokens/${revokeTarget.id}`,{method:'DELETE'});revokeTarget=null;await invalidateAll();notice='Token 已撤销，新的请求将被拒绝。';}
    catch(e){dialogError=e instanceof Error?e.message:'撤销失败，请重试。';}finally{busy=false;}
  }
  async function retire(event:SubmitEvent) {
    event.preventDefault();if(busy)return;busy=true;dialogError='';
    try {await ownerRequest(base,{method:'DELETE',body:{confirmAddress,expectedUpdatedAt:mailbox.updatedAt}});retireOpen=false;await invalidateAll();await goto('/owner/mailboxes');}
    catch(e){dialogError=e instanceof Error?e.message:'退役失败，请重试。';}finally{busy=false;}
  }
  async function copySecret() {
    try {await navigator.clipboard.writeText(issuedSecret);copied=true;}catch {copied=false;dialogError='无法自动复制，请手动选择并保存 Token。';}
  }
</script>

<div class="breadcrumb"><a href="/owner/mailboxes">邮箱</a><span>/</span><span>{mailbox.name}</span></div>
<MailboxTabs mailboxId={mailbox.id} active="settings"/>
<div class="detail-grid"><div>
  <div class="page-heading"><div><h1>{mailbox.name}</h1><div class="address-line"><span>{mailbox.address}</span><span class="badge" class:active={mailbox.status==='active'} class:paused={mailbox.status==='paused'}>{mailbox.status==='active'?'启用中':'已暂停'}</span></div></div><button disabled={busy} onclick={()=>update({status:mailbox.status==='active'?'paused':'active'})}>{mailbox.status==='active'?'暂停邮箱':'恢复邮箱'}</button></div>
  {#if notice}<div class="notice" role="status">{notice}</div>{/if}
  {#if error}<div class="notice error" role="alert">{error}</div>{/if}
  {#if mailbox.status==='paused'}<div class="token-note">邮箱已暂停：新的收信和 Token 请求会被拒绝。恢复后，未撤销的有效 Token 可以继续使用。</div>{/if}
  <section aria-labelledby="settings-heading"><h2 id="settings-heading">邮箱设置</h2>
    <form class="settings-form" onsubmit={(event)=>{event.preventDefault();update({name,maxMessageBytes:Math.round(sizeMiB*1024*1024),dailyRecipientLimit:dailyLimit,allowedRecipients:allowedRecipients.split(/[\n,;，；]+/).map(value=>value.trim()).filter(Boolean)});}}>
      <div class="field setting-row"><label for="edit-mailbox-name">邮箱名称</label><input id="edit-mailbox-name" bind:value={name} required maxlength="80" autocomplete="off"/></div>
      <div class="field setting-row"><label for="edit-message-size">邮件大小上限</label><div class="input-unit"><input id="edit-message-size" type="number" min="0.0009765625" max="10" step="any" bind:value={sizeMiB} required/><span>MiB</span></div></div>
      <div class="field setting-row"><label for="daily-recipient-limit">每日收件人数上限</label><div><input id="daily-recipient-limit" type="number" min="0" max="1000" step="1" bind:value={dailyLimit} required/><small>按 UTC 日期统计所有收件人（含抄送、密送），设为 0 禁止发信。</small></div></div>
      <div class="field setting-row"><label for="allowed-recipients">允许的收件人</label><div><textarea id="allowed-recipients" bind:value={allowedRecipients} rows="4" spellcheck={false} placeholder="每行一个完整邮箱地址" aria-describedby="allowed-recipients-note"></textarea><small id="allowed-recipients-note">最多 100 个完整地址；留空表示不额外限制收件人。此限制也适用于抄送和密送。</small></div></div>
      <button class="primary" type="submit" disabled={busy}>保存更改</button>
    </form>
  </section>
  <section class="token-section" aria-labelledby="tokens-heading">
    <div class="section-heading"><div><h2 id="tokens-heading">访问凭证</h2><p>每个 Token 仅能访问此邮箱，按需授予读取、附件下载、草稿和发信权限。</p></div><button class="primary" disabled={busy||mailbox.status!=='active'} onclick={()=>{issueOpen=true;dialogError='';scopeRead=true;scopeAttachments=false;scopeDraft=false;scopeSend=false;requiresApproval=true;}}><Icon name="plus" size={18}/>签发 Token</button></div>
    {#if tokens.length===0}<div class="table-wrap empty-state"><p>还没有 Token。签发后即可供 Agent 使用此邮箱。</p></div>
    {:else}<div class="table-wrap"><table class="tokens-table" aria-label="邮箱 Token"><thead><tr><th>名称</th><th class="token-permission">权限</th><th class="token-expiry">有效期</th><th>状态</th><th>操作</th></tr></thead><tbody>
      {#each tokens as token (token.id)}<tr><td>{token.name}<small class="mobile-token-meta">{token.scopes.map(permissionLabel).join('、')}{#if token.scopes.includes('mail:send')} · {token.requiresApproval?'需 Owner 审批':'可直接发送'}{/if}<br/>{dateLabel(token.expiresAt)}</small></td><td class="token-permission">{token.scopes.map(permissionLabel).join('、')}{#if token.scopes.includes('mail:send')}<small class="helper"> · {token.requiresApproval?'需 Owner 审批':'可直接发送'}</small>{/if}</td><td class="token-expiry">{dateLabel(token.expiresAt)}</td><td><span class="badge" class:active={token.state==='active'} class:revoked={token.state==='revoked'} class:expired={token.state==='expired'}>{token.state==='revoked'?'已撤销':token.state==='expired'?'已过期':'有效'}</span></td><td>{#if token.state!=='revoked'}<button class="table-action" disabled={busy} onclick={()=>{revokeTarget=token;dialogError='';}} aria-label="撤销 {token.name}">撤销</button>{:else}<span aria-label="无可用操作">—</span>{/if}</td></tr>{/each}
    </tbody></table></div>{/if}
    <div class="token-note">Token 明文仅在签发时显示一次，请妥善保存。</div>
  </section>
  <section class="retire-section"><div><h2>退役邮箱</h2><p>保留已有邮件和地址记录，撤销所有 Token。</p></div><button class="danger" disabled={busy} onclick={()=>{retireOpen=true;dialogError='';confirmAddress='';}}>退役邮箱</button></section>
</div></div>

{#if issueOpen}
  <Dialog title="签发 Token" {busy} onClose={()=>{issueOpen=false;dialogError='';}}><form onsubmit={issue}>
    {#if dialogError}<div class="notice error" role="alert">{dialogError}</div>{/if}
    <div class="field"><label for="token-name">名称</label><input id="token-name" bind:value={tokenName} required maxlength="80" placeholder="例如 Research Agent" autocomplete="off"/></div>
    <fieldset class="scope-options"><legend>权限</legend><label><input type="checkbox" checked={scopeRead} onchange={event=>{scopeRead=event.currentTarget.checked;if(!scopeRead)scopeAttachments=false;}}/>邮件读取 <small>mail:read</small></label><label><input type="checkbox" bind:checked={scopeAttachments} disabled={!scopeRead}/>附件下载 <small>attachments:read（同时需要邮件读取权限）</small></label><label><input type="checkbox" bind:checked={scopeDraft} disabled={scopeSend}/>草稿编辑 <small>mail:draft</small></label><label><input type="checkbox" checked={scopeSend} onchange={event=>{scopeSend=event.currentTarget.checked;if(scopeSend)scopeDraft=true;}}/>请求发信 <small>mail:send（同时需要草稿权限）</small></label></fieldset>
    {#if scopeSend}<div class="field"><label class="approval-checkbox"><input type="checkbox" bind:checked={requiresApproval}/>发信需要 Owner 逐封审批</label><small>{requiresApproval?'Agent 提交后，由 Owner 核对当前版本再允许发送。':'此 Token 可在邮箱的收件人和每日限额策略内直接发送，请仅授予可信 Agent。'}</small></div>{/if}
    <div class="field"><label for="token-expiry">有效期</label><select id="token-expiry" bind:value={expiryDays}><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option><option value="never">永不过期</option></select></div>
    <div class="dialog-actions"><button type="button" disabled={busy} onclick={()=>issueOpen=false}>取消</button><button type="submit" class="primary" disabled={busy}>{busy?'签发中…':'签发 Token'}</button></div>
  </form></Dialog>
{/if}
{#if issuedSecret}
  <Dialog title="Token 已签发" onClose={()=>{issuedSecret='';dialogError='';}}>
    <p class="secret-warning">请立即复制保存。关闭后无法再次查看；如有遗失，请撤销后重新签发。</p>
    <div class="field"><label for="issued-token">完整 Token</label><textarea id="issued-token" class="secret-value" readonly value={issuedSecret} spellcheck={false} autocomplete="off"></textarea></div>
    {#if dialogError}<div class="notice error" role="alert">{dialogError}</div>{/if}
    <div class="dialog-actions"><button type="button" onclick={copySecret}><Icon name="copy" size={16}/>{copied?'已复制':'复制 Token'}</button><button class="primary" type="button" onclick={()=>{issuedSecret='';dialogError='';}}>我已保存</button></div>
  </Dialog>
{/if}
{#if revokeTarget}
  <Dialog title="撤销 Token" {busy} onClose={()=>{revokeTarget=null;dialogError='';}}>
    <p>撤销“{revokeTarget.name}”后，使用此 Token 的新请求将立即失效。此操作无法撤回。</p>
    {#if dialogError}<div class="notice error" role="alert">{dialogError}</div>{/if}
    <div class="dialog-actions"><button type="button" disabled={busy} onclick={()=>revokeTarget=null}>取消</button><button class="danger primary" disabled={busy} onclick={revoke}>{busy?'撤销中…':'确认撤销'}</button></div>
  </Dialog>
{/if}
{#if retireOpen}
  <Dialog title="退役邮箱" {busy} onClose={()=>{retireOpen=false;dialogError='';}}><form onsubmit={retire}>
    <p>退役后地址将永久保留，不能重新分配；已有邮件不会删除，所有 Token 将撤销。</p>
    <div class="field"><label for="confirm-address">输入完整邮箱地址以确认</label><input id="confirm-address" bind:value={confirmAddress} placeholder={mailbox.address} required autocomplete="off" spellcheck={false}/></div>
    {#if dialogError}<div class="notice error" role="alert">{dialogError}</div>{/if}
    <div class="dialog-actions"><button type="button" disabled={busy} onclick={()=>retireOpen=false}>取消</button><button type="submit" class="danger primary" disabled={busy||confirmAddress!==mailbox.address}>{busy?'退役中…':'确认退役'}</button></div>
  </form></Dialog>
{/if}
