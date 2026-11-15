<script lang="ts">
  import MailboxDetail from '#lib/components/owner/MailboxDetail.svelte';
  let {data}=$props();
</script>

<svelte:head><title>{data.mailbox.name} · Agent Mail</title></svelte:head>
{#key data.mailbox.id}<MailboxDetail mailbox={data.mailbox} tokens={data.tokens}/>{/key}
