<script lang="ts">
  import OAuthGrants from '#lib/components/owner/OAuthGrants.svelte';
  let {data,form}=$props();
</script>
<svelte:head><title>MCP 授权 · Agent Mail</title></svelte:head>
<OAuthGrants grants={data.grants} errorMessage={form?.error??null} notice={form?.success??null}/>
