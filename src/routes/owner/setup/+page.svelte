<script lang="ts">
  import SetupWizard from '#lib/components/owner/SetupWizard.svelte';
  let {data}=$props();
</script>
<svelte:head><title>初始化向导 · Agent Mail</title></svelte:head>
{#key JSON.stringify([data.setup.instance.updatedAt,data.setup.configFingerprint])}<SetupWizard initialSetup={data.setup}/>{/key}
