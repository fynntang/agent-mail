<script lang="ts">
  let {mailboxId,active}:{mailboxId:string;active:'mail'|'outbound'|'settings'|'webhooks'|'suppressions'}=$props();
</script>
<nav class="mailbox-tabs" aria-label="邮箱功能">
  <a href="/owner/mailboxes/{mailboxId}/messages" aria-current={active==='mail'?'page':undefined}>邮件</a>
  <a href="/owner/mailboxes/{mailboxId}/outbound" aria-current={active==='outbound'?'page':undefined}>草稿与发信</a>
  <a href="/owner/mailboxes/{mailboxId}/webhooks" aria-current={active==='webhooks'?'page':undefined}>Webhook</a>
  <a href="/owner/mailboxes/{mailboxId}/suppressions" aria-current={active==='suppressions'?'page':undefined}>抑制名单</a>
  <a href="/owner/mailboxes/{mailboxId}" aria-current={active==='settings'?'page':undefined}>邮箱设置</a>
</nav>
<style>.mailbox-tabs {flex-wrap:wrap;row-gap:10px;}</style>
