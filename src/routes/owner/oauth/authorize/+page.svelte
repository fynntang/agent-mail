<script lang="ts">
  import OAuthConsent from '#lib/components/owner/OAuthConsent.svelte';
  let {data,form}=$props();
</script>
<svelte:head><title>授权 MCP 客户端 · Agent Mail</title></svelte:head>
{#key data.authorization.id}<OAuthConsent authorization={data.authorization} errorMessage={form?.error??null}/>{/key}
