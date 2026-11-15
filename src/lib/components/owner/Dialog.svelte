<script lang="ts">
  import {onMount,type Snippet} from 'svelte';
  import Icon from './Icon.svelte';
  let {title,onClose,busy=false,children}:{title:string;onClose:()=>void;busy?:boolean;children:Snippet}=$props();
  let element:HTMLDialogElement;
  onMount(()=>{element.showModal();});
</script>

<dialog bind:this={element} aria-label={title} class="owner-dialog" oncancel={(e)=>{e.preventDefault();if(!busy)onClose();}}>
  <div class="dialog-heading"><h2>{title}</h2><button class="icon-button" type="button" aria-label="关闭对话框" onclick={onClose} disabled={busy}><Icon name="close"/></button></div>
  {@render children()}
</dialog>
