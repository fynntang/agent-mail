<script lang="ts">
  import {onMount,untrack} from 'svelte';
  import type {MailboxSummary} from '#lib/types/owner.ts';
  import './oauth.css';

  interface Authorization {
    id:string;csrfToken:string;client:{id:string;name:string;kind:'dynamic'|'cimd';metadataHost:string|null};
    redirectUri:string;redirectHost:string;loopback:boolean;requestedScopes:string[];expiresAt:number;mailboxes:MailboxSummary[];
  }
  let {authorization,errorMessage=null}:{authorization:Authorization;errorMessage?:string|null}=$props();
  let selectedScopes=$state<string[]>(untrack(()=>[...authorization.requestedScopes]));
  let mailboxId=$state(''),directSending=$state(false),ready=$state(false);
  onMount(()=>{ready=true;});
  const activeMailboxes=$derived(authorization.mailboxes.filter(mailbox=>mailbox.status==='active'));
  const selectedMailbox=$derived(activeMailboxes.find(mailbox=>mailbox.id===mailboxId));
  const sends=$derived(selectedScopes.includes('mail:send'));
  const complete=$derived(Boolean(selectedMailbox)&&selectedScopes.length>0&&(!sends||selectedScopes.includes('mail:draft'))&&(!selectedScopes.includes('attachments:read')||selectedScopes.includes('mail:read')));
  const labels:Record<string,string>={'mail:read':'查询和阅读邮件','attachments:read':'下载邮件附件','mail:draft':'创建和修改草稿','mail:send':'提交邮件发送'};
  const descriptions:Record<string,string>={
    'mail:read':'读取所选邮箱中的邮件列表、地址、文本正文和附件信息；下载附件内容需另行授权。',
    'attachments:read':'下载所选邮箱的附件内容，同时需要邮件读取权限；附件可能尚未进行病毒扫描。',
    'mail:draft':'管理此客户端创建的草稿；创建回复还需邮件读取权限。',
    'mail:send':'请求发送此客户端的草稿，仍遵守发送限额和审批策略。'
  };
  function changeScope(scope:string,checked:boolean) {
    const next=new Set(selectedScopes);
    if(checked)next.add(scope);else next.delete(scope);
    if(scope==='mail:send'&&checked)next.add('mail:draft');
    if(scope==='mail:draft'&&!checked)next.delete('mail:send');
    if(scope==='attachments:read'&&checked)next.add('mail:read');
    if(scope==='mail:read'&&!checked)next.delete('attachments:read');
    selectedScopes=authorization.requestedScopes.filter(value=>next.has(value));
    if(!selectedScopes.includes('mail:send'))directSending=false;
  }
</script>

<div class="breadcrumb"><a href="/owner/mailboxes">邮箱</a><span>/</span><span>MCP 授权</span></div>
<div class="page-heading"><div><h1>授权 MCP 客户端</h1><p>选择一个邮箱，并核对允许客户端执行的操作。</p></div></div>
{#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}

<div class="oauth-content">
  <section class="oauth-client" aria-labelledby="oauth-client-heading">
    <div class="section-heading"><div><h2 id="oauth-client-heading">{authorization.client.name}</h2><p>客户端提供的名称，请核对标识与回调地址。</p></div><span class="badge">{authorization.client.kind==='cimd'?'客户端元数据':'注册客户端'}</span></div>
    <dl class="oauth-metadata"><div><dt>客户端标识</dt><dd><code>{authorization.client.id}</code></dd></div>{#if authorization.client.metadataHost}<div><dt>元数据域名</dt><dd>{authorization.client.metadataHost}</dd></div>{/if}<div><dt>回调主机</dt><dd><strong>{authorization.redirectHost}</strong></dd></div><div><dt>完整回调地址</dt><dd><code>{authorization.redirectUri}</code></dd></div><div><dt>本次请求有效期</dt><dd>{new Date(authorization.expiresAt).toISOString().replace('T',' ').slice(0,19)} UTC</dd></div></dl>
    {#if authorization.loopback}<div class="oauth-warning" role="note">此客户端使用本机回调地址。请确认连接由你正在使用的本机应用发起，并核对回调端口和路径。</div>{/if}
  </section>

  <form method="POST" class="oauth-consent" aria-labelledby="oauth-consent-heading">
    <input type="hidden" name="requestId" value={authorization.id}/><input type="hidden" name="csrfToken" value={authorization.csrfToken}/>
    <h2 id="oauth-consent-heading">允许访问的邮箱和权限</h2>
    <div class="field"><label for="oauth-mailbox">授权邮箱</label><select id="oauth-mailbox" name="mailboxId" bind:value={mailboxId} required disabled={!ready}><option value="" disabled>请选择一个启用中的邮箱</option>{#each activeMailboxes as mailbox (mailbox.id)}<option value={mailbox.id}>{mailbox.name} · {mailbox.address}</option>{/each}</select><small>此授权只适用于所选邮箱，客户端不能自行切换邮箱。</small></div>
    {#if activeMailboxes.length===0}<div class="notice" role="status">没有启用中的邮箱。请先<a href="/owner/mailboxes?create=1">创建邮箱</a>或恢复一个邮箱，再从客户端重新发起授权。</div>{/if}
    {#if selectedMailbox}<div class="oauth-mailbox-preview"><strong>{selectedMailbox.name}</strong><span>{selectedMailbox.address}</span><small>每日收件人数上限：{selectedMailbox.dailyRecipientLimit}；{selectedMailbox.allowedRecipients.length?'已设置收件人白名单':'未额外限制收件人地址'}。</small></div>{/if}
    <fieldset class="scope-options oauth-scope-options" disabled={!ready}><legend>允许的操作</legend>{#each authorization.requestedScopes as scope (scope)}<label><input type="checkbox" name="scope" value={scope} checked={selectedScopes.includes(scope)} onchange={event=>changeScope(scope,event.currentTarget.checked)}/><span><strong>{labels[scope]??scope}</strong><small>{descriptions[scope]??scope}</small></span></label>{/each}</fieldset>
    <div class="oauth-approval"><strong>邮件发送审批</strong><p>授权客户端访问邮箱，不会批准任何一封邮件。默认仍需你在控制台核对草稿后逐封审批。</p>{#if sends}<label class="oauth-direct"><input type="checkbox" name="directSending" value="1" bind:checked={directSending} disabled={!ready}/><span>允许此客户端无需逐封审批，直接提交发送</span></label>{#if directSending}<p class="oauth-warning">你正在授予免审批发送权限。邮箱的收件人规则和发送额度仍然有效。</p>{/if}{/if}</div>
    <div class="oauth-consent-actions"><button type="submit" name="decision" value="deny" formnovalidate>拒绝授权</button><button type="submit" name="decision" value="allow" class="primary" disabled={!ready||!complete}>授权此客户端</button></div>
    <p class="helper">访问授权最长30天，可随时撤销；刷新不会自动延长期限。</p>
    <p class="helper">同意后将返回上述回调地址。你可以随时在“<a href="/owner/oauth/grants" data-sveltekit-reload>MCP 授权</a>”中撤销此访问。</p>
  </form>
</div>
