<script lang="ts">
  import './oauth.css';
  interface Grant {id:string;clientId:string;clientName:string;mailboxId:string;mailboxName:string;mailboxAddress:string;scopes:string[];requiresApproval:boolean;createdAt:number;expiresAt:number;revokedAt:number|null;state:'active'|'expired'|'revoked'}
  let {grants,errorMessage=null,notice=null}:{grants:Grant[];errorMessage?:string|null;notice?:string|null}=$props();
  const labels:Record<string,string>={'mail:read':'查询和阅读','attachments:read':'附件下载','mail:draft':'草稿编辑','mail:send':'提交发送'};
  const date=(value:number)=>new Date(value).toISOString().replace('T',' ').slice(0,16)+' UTC';
  function confirmRevoke(event:SubmitEvent) {if(!window.confirm('撤销此客户端的邮箱访问？新的请求和刷新将被拒绝；已经开始的发送不能保证撤回。'))event.preventDefault();}
</script>

<div class="breadcrumb"><a href="/owner/mailboxes">邮箱</a><span>/</span><span>MCP 授权</span></div>
<div class="page-heading"><div><h1>MCP 授权</h1><p>查看客户端已获准访问的邮箱、权限和审批策略。</p></div></div>
{#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
{#if notice}<div class="notice" role="status">{notice}</div>{/if}
<p class="oauth-intro">每个授权只绑定一个邮箱。撤销会阻止此授权的新请求和凭证刷新，尚未派发的发送也会重新检查资格。</p>
{#if grants.length===0}<div class="table-wrap empty-state"><h2>还没有 MCP 授权</h2><p>在支持 OAuth 的 MCP 客户端中添加此服务，登录后即可选择邮箱和允许的权限。</p><a class="button" href="/owner/mailboxes">返回邮箱列表</a></div>
{:else}<ul class="oauth-grants">{#each grants as grant (grant.id)}<li><section aria-labelledby={`grant-${grant.id}`}><div class="section-heading"><div><h2 id={`grant-${grant.id}`}>{grant.clientName}</h2><p><a href={`/owner/mailboxes/${grant.mailboxId}/messages`}>{grant.mailboxName} · {grant.mailboxAddress}</a></p></div><span class="badge" class:active={grant.state==='active'}>{grant.state==='active'?'有效':grant.state==='expired'?'已过期':'已撤销'}</span></div><dl class="oauth-metadata"><div><dt>客户端标识</dt><dd><code>{grant.clientId}</code></dd></div><div><dt>允许的操作</dt><dd>{grant.scopes.map(scope=>labels[scope]??scope).join('、')}</dd></div><div><dt>发送审批</dt><dd>{grant.scopes.includes('mail:send')?(grant.requiresApproval?'每封发送需 Owner 审批':'允许免审批提交发送'):'未授权发送'}</dd></div><div><dt>授权时间</dt><dd>{date(grant.createdAt)}</dd></div><div><dt>到期时间</dt><dd>{date(grant.expiresAt)}</dd></div>{#if grant.revokedAt!==null}<div><dt>撤销时间</dt><dd>{date(grant.revokedAt)}</dd></div>{/if}</dl>{#if grant.state==='active'}<form method="POST" action="?/revoke" onsubmit={confirmRevoke}><input type="hidden" name="grantId" value={grant.id}/><button class="danger" type="submit">撤销访问</button></form>{/if}</section></li>{/each}</ul>{/if}
