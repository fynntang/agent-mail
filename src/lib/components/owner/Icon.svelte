<script lang="ts">
  let {name,size=20}:{name:'mail'|'plus'|'chevron'|'close'|'copy'|'arrow';size?:number}=$props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if name==='mail'}<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m4 6 8 6 8-6"/>
  {:else if name==='plus'}<path d="M12 4v16M4 12h16"/>
  {:else if name==='chevron'}<path d="m9 5 7 7-7 7"/>
  {:else if name==='close'}<path d="m5 5 14 14M19 5 5 19"/>
  {:else if name==='copy'}<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>
  {:else}<path d="m9 5-7 7 7 7M3 12h18"/>{/if}
</svg>
