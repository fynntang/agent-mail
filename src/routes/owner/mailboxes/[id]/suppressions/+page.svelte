<script lang="ts">
  import SuppressionsConsole from '#lib/components/owner/SuppressionsConsole.svelte';
  let {data}=$props();
</script>
<svelte:head><title>{data.mailbox.name} · 抑制名单 · Agent Mail</title></svelte:head>
{#key data.mailbox.id}<SuppressionsConsole mailbox={data.mailbox}/>{/key}
