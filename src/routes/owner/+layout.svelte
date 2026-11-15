<script lang="ts">
  import {page} from '$app/state';
  import Icon from '#lib/components/owner/Icon.svelte';
  import '#lib/components/owner/owner.css';
  let {data,children}=$props();
</script>

<div class="owner-shell">
  <aside class="owner-sidebar" aria-label="Owner 导航">
    <a class="brand" href="/owner/mailboxes"><Icon name="mail" size={27}/>Agent Mail</a>
    <div class="sidebar-mailboxes">
      <div class="sidebar-title"><a href="/owner/mailboxes">邮箱</a></div>
      <nav class="mailbox-nav" aria-label="邮箱列表">
        {#each data.mailboxes as mailbox (mailbox.id)}
          <a href="/owner/mailboxes/{mailbox.id}/messages" class:current={page.params.id===mailbox.id} aria-current={page.params.id===mailbox.id?'page':undefined}>
            <span><strong>{mailbox.name}</strong><small>{mailbox.address}</small></span><Icon name="chevron" size={15}/>
          </a>
        {/each}
      </nav>
      <a class="button sidebar-new" href="/owner/mailboxes?create=1"><Icon name="plus" size={18}/>新建邮箱</a>
      <a class="button sidebar-new" href="/owner/oauth/grants" data-sveltekit-reload aria-current={page.url.pathname.startsWith('/owner/oauth/')?'page':undefined}>MCP 授权</a>
      <a class="button sidebar-new" href="/owner/setup" aria-current={page.url.pathname==='/owner/setup'?'page':undefined}>初始化</a>
    </div>
    <div class="sidebar-owner"><span>{data.ownerEmail}</span><small>Cloudflare Access</small></div>
  </aside>
  <main class="owner-main">
    {#if data.retryBatchNotificationNotice}
      <div class="notice suppression-alert-notice retry-batch-notification-notice" class:error={data.retryBatchNotificationNotice.attentionCount>0} role="status">
        <span>有 {data.retryBatchNotificationNotice.count} 项批量任务通知未确认，其中 {data.retryBatchNotificationNotice.attentionCount} 项仍有异常。</span>
        <a href="/owner/mailboxes/{data.retryBatchNotificationNotice.mailboxId}/suppressions#retry-batch-notifications">查看批量任务通知 →</a>
      </div>
    {/if}
    {#if data.exportNotificationNotice}
      <div class="notice suppression-alert-notice export-notification-notice" role="status">
        <span>有 {data.exportNotificationNotice.count} 项导出通知未确认。</span>
        <a href="/owner/mailboxes/{data.exportNotificationNotice.mailboxId}/suppressions#async-export-notifications">查看导出通知 →</a>
      </div>
    {/if}
    {#if data.suppressionAlertNotice}
      <div class="notice error suppression-alert-notice" role="status">
        <span>Cloudflare 抑制操作有 {data.suppressionAlertNotice.count} 项告警待确认。</span>
        <a href="/owner/mailboxes/{data.suppressionAlertNotice.mailboxId}/suppressions#cloudflare-suppression-alerts">查看告警 →</a>
      </div>
    {/if}
    {@render children()}
  </main>
</div>

<style>
  .suppression-alert-notice{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;}
  .suppression-alert-notice a{font-weight:650;text-decoration:underline;}
</style>
