<script lang="ts">
  import {page} from '$app/state';
</script>
<svelte:head><title>无法打开控制台 · Agent Mail</title></svelte:head>
<h1>无法打开控制台</h1>
<p>{page.error?.message??'请稍后重试。'}</p>
<a class="button" href="/owner/mailboxes">返回邮箱列表</a>
