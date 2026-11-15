<script lang="ts">
  import OutboundConsole from '#lib/components/owner/OutboundConsole.svelte';
  let {data}=$props();
</script>
<svelte:head><title>{data.mailbox.name} · 草稿与发信 · Agent Mail</title></svelte:head>
{#key data.mailbox.id}<OutboundConsole mailbox={data.mailbox} replyMessageId={data.replyMessageId}/>{/key}
