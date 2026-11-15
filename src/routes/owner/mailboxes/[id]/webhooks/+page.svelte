<script lang="ts">
  import WebhooksConsole from '#lib/components/owner/WebhooksConsole.svelte';
  let {data}=$props();
</script>
<svelte:head><title>{data.mailbox.name} · Webhook · Agent Mail</title></svelte:head>
{#key data.mailbox.id}<WebhooksConsole mailbox={data.mailbox}/>{/key}
