<script lang="ts">
  import {goto,invalidateAll} from '$app/navigation';
  import {page} from '$app/state';
  import Dialog from '#lib/components/owner/Dialog.svelte';
  import Icon from '#lib/components/owner/Icon.svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {MailboxSummary} from '#lib/types/owner.ts';
  let {data}=$props();
  let creating=$state(false),busy=$state(false),name=$state(''),localPart=$state(''),error=$state('');
  $effect(()=>{if(page.url.searchParams.get('create')==='1')creating=true;});
  async function close() {creating=false;error='';if(page.url.searchParams.has('create'))await goto('/owner/mailboxes',{replaceState:true});}
  async function create(event:SubmitEvent) {
    event.preventDefault();if(busy)return;busy=true;error='';
    try {
      const result=await ownerRequest<{mailbox:MailboxSummary}>('/owner/api/mailboxes',{method:'POST',body:{name,localPart}});
      creating=false;await invalidateAll();await goto(`/owner/mailboxes/${result.mailbox.id}`);
    } catch(e){error=e instanceof Error?e.message:'创建失败，请重试。';}finally{busy=false;}
  }
</script>

<svelte:head><title>Agent 邮箱 · Agent Mail</title></svelte:head>
<div class="breadcrumb">邮箱</div>
<div class="page-heading"><div><h1>Agent 邮箱</h1><p>独立地址，按邮箱授权。</p></div><button class="primary" onclick={()=>creating=true}><Icon name="plus" size={18}/>新建邮箱</button></div>
{#if data.mailboxes.length===0}
  <div class="table-wrap empty-state"><h2>创建你的第一个 Agent 邮箱</h2><p>给 Agent 一个独立地址，再签发专属的访问凭证。</p><button class="primary" onclick={()=>creating=true}>新建邮箱</button></div>
{:else}
  <div class="table-wrap"><table><thead><tr><th>邮箱</th><th>状态</th><th>有效 Token</th><th>操作</th></tr></thead><tbody>
    {#each data.mailboxes as mailbox (mailbox.id)}<tr><td><a href="/owner/mailboxes/{mailbox.id}/messages"><strong>{mailbox.name}</strong><div class="mailbox-address">{mailbox.address}</div></a></td><td><span class:active={mailbox.status==='active'} class:paused={mailbox.status==='paused'} class="badge">{mailbox.status==='active'?'启用中':'已暂停'}</span></td><td>{mailbox.activeTokenCount}</td><td><a class="button table-action" href="/owner/mailboxes/{mailbox.id}">管理<Icon name="chevron" size={14}/></a></td></tr>{/each}
  </tbody></table></div>
{/if}
{#if creating}
  <Dialog title="新建邮箱" onClose={close} {busy}>
    <form onsubmit={create}>
      {#if error}<div class="notice error" role="alert">{error}</div>{/if}
      <div class="field"><label for="mailbox-name">邮箱名称</label><input id="mailbox-name" bind:value={name} maxlength="80" required placeholder="例如 Research" autocomplete="off"/></div>
      <div class="field"><label for="mailbox-local-part">邮箱前缀</label><input id="mailbox-local-part" bind:value={localPart} maxlength="64" required placeholder="research" autocomplete="off" autocapitalize="none" spellcheck={false}/><small>{localPart.trim()||'research'}@{data.mailDomain} · 创建后地址不能更改</small></div>
      <div class="dialog-actions"><button type="button" onclick={close} disabled={busy}>取消</button><button type="submit" class="primary" disabled={busy}>{busy?'创建中…':'创建邮箱'}</button></div>
    </form>
  </Dialog>
{/if}
