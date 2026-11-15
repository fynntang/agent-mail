<script lang="ts">
  import MailReader from '#lib/components/owner/MailReader.svelte';
  let {data}=$props();
</script>
<svelte:head><title>{data.mailbox.name} · 邮件 · Agent Mail</title></svelte:head>
{#key data.mailbox.id}<MailReader mailbox={data.mailbox} list={data.list} detail={data.detail} detailError={data.detailError}/>{/key}
