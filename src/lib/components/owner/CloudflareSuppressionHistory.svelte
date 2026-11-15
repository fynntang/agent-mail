<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import Dialog from './Dialog.svelte';

  type Kind='sync'|'release';
  type Scope={type:'account'}|{type:'sending_domain';value:string};
  interface Common {id:string;kind:Kind;state:string;startedAt:number;completedAt:number|null;errorCode:string|null;retryOf:string|null;canRetry:boolean;canReconcile:boolean}
  interface SyncItem extends Common {kind:'sync';source:'owner'|'scheduled';count:number|null}
  interface ReleaseItem extends Common {kind:'release';remoteId:string;address:string;scope:Scope;version:string;remoteStatus:string;localStatus:string;current:{version:string;readOnly:boolean;localSuppression:{id:string;version:number;status:'active'|'released';reason:string}|null}|null}
  type HistoryItem=SyncItem|ReleaseItem;
  interface Timeline {id:string;action:string;state:string;remoteStatus:string|null;localStatus:string|null;errorCode:string|null;count:number|null;occurredAt:number}
  interface Detail {item:HistoryItem;timeline:Timeline[];timelineTruncated?:boolean}
  interface Page {history:HistoryItem[];nextCursor:string|null;configured?:boolean}
  interface Operation {operationId:string;remoteStatus:string;localStatus:string;errorCode?:string}
  let {mailboxId,onChanged}:{mailboxId:string;onChanged?:()=>Promise<void>}=$props();
  let kind=$state<Kind>('sync'),limit=$state(20),page=$state<Page>({history:[],nextCursor:null}),loading=$state(true),busy=$state(false);
  let cursor=$state<string|null>(null),previous=$state<(string|null)[]>([]),detail=$state<Detail|null>(null),errorMessage=$state(''),notice=$state('');
  let retryTarget=$state<ReleaseItem|null>(null),requestId=$state(''),confirmationAddress=$state(''),scopeConfirmed=$state(false),releaseLocal=$state(false),attempted=$state(false),retryError=$state(''),retryResult=$state<Operation|null>(null);
  const base=$derived(`/owner/api/mailboxes/${mailboxId}/cloudflare-suppressions/history`),controller=new AbortController();
  let listSequence=0;
  const canConfirm=$derived(Boolean(retryTarget?.canRetry&&retryTarget.current&&!retryTarget.current.readOnly&&confirmationAddress.trim()===retryTarget.address&&(retryTarget.scope.type!=='account'||scopeConfirmed)&&!retryResult));
  onMount(()=>{void load(null);});onDestroy(()=>controller.abort());
  function date(value:number|null):string {return value===null?'—':new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function stateLabel(value:string):string {return ({running:'执行中',preparing:'准备中',deleting:'正在解除',succeeded:'已完成',failed:'失败',unknown:'结果未知',confirmed_absent:'已确认远端不存在',abandoned:'执行已中断'} as Record<string,string>)[value]??value;}
  function scopeLabel(value:Scope):string {return value.type==='account'?'账户范围 · 所有发信域':`发信域 · ${value.value}`;}
  function remoteLabel(value:string):string {return ({deleted:'远端已解除',already_absent:'远端已不存在',unknown:'远端结果未知',failed:'远端操作未完成',in_progress:'远端操作处理中'} as Record<string,string>)[value]??value;}
  function localLabel(value:string):string {return ({released:'已解除当前邮箱本地抑制',changed:'本地记录已变化，保持抑制',not_requested:'未请求解除本地抑制',pending:'本地抑制保持保留'} as Record<string,string>)[value]??value;}
  function diagnostic(code:string):string {
    return ({cloudflare_api_timeout:'Cloudflare 响应超时，请先核对现状。',cloudflare_api_unavailable:'Cloudflare 暂时不可用，已有本地状态保持保留。',cloudflare_delete_unknown:'解除请求的结果尚未确认，请先核对远端结果。',cloudflare_api_rejected:'Cloudflare 拒绝了此次请求，请核对配置和记录。',cloudflare_suppression_read_only:'当前服务端记录是只读状态。',cloudflare_suppression_changed:'服务端快照已变化，需要重新核对。',suppression_changed:'本地记录出现了新的变化，需要重新核对。',operation_lease_expired:'上一次执行未能完成确认，请核对远端结果。'} as Record<string,string>)[code]??'操作未完成，请根据诊断代码核对后继续。';
  }
  async function fetchPage(value:string|null) {
    const sequence=++listSequence,query=new URLSearchParams({kind,limit:String(limit)});if(value)query.set('cursor',value);
    const result=await ownerRequest<Page>(`${base}?${query}`,{signal:controller.signal});if(sequence===listSequence&&!controller.signal.aborted){page=result;cursor=value;}
  }
  async function load(value:string|null,direction:'reset'|'next'|'previous'='reset') {
    if(busy)return;busy=true;errorMessage='';const old=cursor;
    try{await fetchPage(value);if(!controller.signal.aborted)previous=direction==='next'?[...previous,old]:direction==='previous'?previous.slice(0,-1):[];}
    catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'历史记录读取失败。';}
    finally{if(!controller.signal.aborted){busy=false;loading=false;}}
  }
  async function switchKind(value:Kind) {if(busy)return;kind=value;notice='';await load(null);}
  async function readDetail(id:string,itemKind:Kind):Promise<Detail> {return ownerRequest(`${base}/${encodeURIComponent(id)}?${new URLSearchParams({kind:itemKind})}`,{signal:controller.signal});}
  export async function openSource(itemKind:Kind,id:string) {
    busy=true;errorMessage='';
    try{if(kind!==itemKind){kind=itemKind;previous=[];await fetchPage(null);}const value=await readDetail(id,itemKind);if(!controller.signal.aborted)detail=value;}
    catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'关联历史读取失败。';}
    finally{if(!controller.signal.aborted)busy=false;}
  }
  async function openDetail(item:HistoryItem) {
    if(busy)return;busy=true;errorMessage='';
    try{const value=await readDetail(item.id,item.kind);if(!controller.signal.aborted)detail=value;}
    catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'详情读取失败。';}
    finally{if(!controller.signal.aborted)busy=false;}
  }
  async function refreshAfterAction() {
    if(controller.signal.aborted)return;previous=[];
    const results=await Promise.allSettled([fetchPage(null),onChanged?.()??Promise.resolve()]);
    for(const result of results)if(result.status==='rejected'&&!controller.signal.aborted)errorMessage=result.reason instanceof Error?result.reason.message:'记录已变更，请刷新核对。';
  }
  async function reconcile(item:ReleaseItem) {
    if(busy||!item.canReconcile)return;busy=true;errorMessage='';notice='';
    try{
      const result=await ownerRequest<{operation:ReleaseItem;reconciliationId:string}>(`${base}/${item.id}/reconcile`,{method:'POST',body:{clientRequestId:crypto.randomUUID()},signal:controller.signal});
      if(controller.signal.aborted)return;
      notice=`已只读核对远端结果：${remoteLabel(result.operation.remoteStatus)}。核对不会删除远端记录或解除本地抑制。`;
      if(detail?.item.id===item.id)detail=await readDetail(item.id,'release');
      await refreshAfterAction();
    }catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'结果核对未完成，请刷新后重试。';}
    finally{if(!controller.signal.aborted)busy=false;}
  }
  async function retrySync(item:SyncItem) {
    if(busy||!item.canRetry)return;busy=true;errorMessage='';notice='';
    try{
      const result=await ownerRequest<{synced:boolean;count:number;runId:string;state:string}>(`${base}/${item.id}/retry`,{method:'POST',body:{kind:'sync',clientRequestId:crypto.randomUUID()},signal:controller.signal});
      if(controller.signal.aborted)return;
      notice=result.synced?`重新同步已完成，共 ${result.count} 条。新记录已关联原同步记录。`:'新的同步请求已记录，请核对最新状态。';
      detail=null;await refreshAfterAction();
    }catch(error){if(!controller.signal.aborted){errorMessage=error instanceof Error?error.message:'重新同步未完成，请刷新历史核对。';await refreshAfterAction();}}
    finally{if(!controller.signal.aborted)busy=false;}
  }
  async function prepareRetry(item:ReleaseItem) {
    if(busy||!item.canRetry)return;busy=true;errorMessage='';
    try{
      const fresh=(await readDetail(item.id,'release')).item;
      if(controller.signal.aborted)return;
      if(fresh.kind!=='release'||!fresh.canRetry||!fresh.current||fresh.current.readOnly){errorMessage='当前记录不能重新解除，请先刷新或核对远端结果。';return;}
      retryTarget=fresh;requestId=crypto.randomUUID();confirmationAddress='';scopeConfirmed=false;releaseLocal=false;attempted=false;retryError='';retryResult=null;detail=null;
    }catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'重新确认所需的快照读取失败。';}
    finally{if(!controller.signal.aborted)busy=false;}
  }
  function closeRetry() {retryTarget=null;requestId='';confirmationAddress='';scopeConfirmed=false;releaseLocal=false;attempted=false;retryError='';retryResult=null;}
  async function submitRetry() {
    if(busy||!retryTarget?.current||!canConfirm)return;const target=retryTarget,current=target.current;if(!current)return;busy=true;attempted=true;retryError='';
    try{
      const result=await ownerRequest<Operation>(`${base}/${target.id}/retry`,{method:'POST',body:{kind:'release',clientRequestId:requestId,expectedVersion:current.version,
        confirmationAddress:confirmationAddress.trim(),confirmationScope:target.scope.type==='account'?'account':target.scope.value,
        ...(releaseLocal&&current.localSuppression?.status==='active'?{releaseLocal:true,expectedLocalVersion:current.localSuppression.version}:{})},signal:controller.signal});
      if(controller.signal.aborted)return;
      retryResult=result;notice=`新的解除操作：${remoteLabel(result.remoteStatus)}；${localLabel(result.localStatus)}。`;
      if(result.remoteStatus==='deleted'||result.remoteStatus==='already_absent')closeRetry();
      await refreshAfterAction();
    }catch(error){if(!controller.signal.aborted)retryError=error instanceof Error?error.message:'重新确认的操作未完成，请先刷新历史核对。';}
    finally{if(!controller.signal.aborted)busy=false;}
  }
</script>

<section class="cf-history" aria-labelledby="cf-history-heading"><div class="cf-history-heading"><div><h2 id="cf-history-heading">Cloudflare 操作历史</h2><p>查看同步与解除记录。核对未知结果只读取远端现状；重新解除需要新的明确确认。</p></div><button type="button" disabled={busy||loading} onclick={()=>load(null)}>刷新历史</button></div>
  {#if notice}<div class="notice" role="status">{notice}</div>{/if}{#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
  <div class="cf-history-toolbar"><div role="group" aria-label="Cloudflare 历史类型" class="read-filter"><button type="button" class:chosen={kind==='sync'} aria-pressed={kind==='sync'} disabled={busy} onclick={()=>switchKind('sync')}>同步记录</button><button type="button" class:chosen={kind==='release'} aria-pressed={kind==='release'} disabled={busy} onclick={()=>switchKind('release')}>解除记录</button></div><label>每页<select aria-label="Cloudflare 历史每页条数" value={String(limit)} disabled={busy} onchange={event=>{limit=Number(event.currentTarget.value);void load(null);}}><option value="10">10 条</option><option value="20">20 条</option><option value="50">50 条</option></select></label></div>
  {#if page.configured===false}<p class="cf-history-help">当前配置未启用变更操作，已有历史仍可查看。</p>{/if}
  {#if loading}<p role="status">正在读取操作历史…</p>{:else if !page.history.length}<div class="cf-history-empty">暂无{kind==='sync'?'同步':'解除'}历史记录。</div>
  {:else}<ul class="cf-history-list">{#each page.history as item (item.id)}<li data-history-id={item.id}><div class="cf-history-row-heading"><strong>{item.kind==='sync'?(item.source==='scheduled'?'定时同步':'Owner 手动同步'):item.address}</strong><span class="badge" class:active={item.state==='succeeded'||item.state==='confirmed_absent'} class:paused={item.state==='failed'||item.state==='unknown'}>{stateLabel(item.state)}</span></div>
    <p class="cf-history-meta">开始于 {date(item.startedAt)}{#if item.completedAt!==null} · 完成于 {date(item.completedAt)}{/if}</p>
    {#if item.kind==='sync'}<p class="cf-history-help">同步记录数：{item.count===null?'—':item.count}</p>{:else}<p class="cf-history-help">{scopeLabel(item.scope)} · {remoteLabel(item.remoteStatus)} · {localLabel(item.localStatus)}</p>{/if}
    {#if item.errorCode}<p class="cf-history-help">{diagnostic(item.errorCode)} <code>{item.errorCode}</code></p>{/if}{#if item.retryOf}<p class="cf-history-help">由前一次记录重新发起。</p>{/if}
    <div class="cf-history-actions"><button type="button" disabled={busy} aria-label={`查看${item.kind==='sync'?'同步':'解除'}记录 ${item.id}`} onclick={()=>openDetail(item)}>详情</button>{#if item.kind==='sync'&&item.canRetry}<button type="button" disabled={busy} aria-label={`重新同步 ${item.id}`} onclick={()=>retrySync(item)}>重新同步</button>{:else if item.kind==='release'}{#if item.canReconcile}<button type="button" disabled={busy} aria-label={`核对远端结果 ${item.id}`} onclick={()=>reconcile(item)}>核对远端结果</button>{/if}{#if item.canRetry&&item.current&&!item.current.readOnly}<button type="button" disabled={busy} aria-label={`重新确认解除 ${item.id}`} onclick={()=>prepareRetry(item)}>重新确认解除</button>{/if}{/if}</div>
  </li>{/each}</ul>{/if}
  <nav class="cf-history-pagination" aria-label="Cloudflare 操作历史分页"><button type="button" disabled={busy||!previous.length} onclick={()=>load(previous.at(-1)??null,'previous')}>上一页</button><span>本页 {page.history.length} 条</span><button type="button" disabled={busy||!page.nextCursor} onclick={()=>load(page.nextCursor,'next')}>下一页</button></nav>
</section>

{#if detail}<Dialog title="Cloudflare 操作详情" {busy} onClose={()=>detail=null}><div class="cf-history-detail"><span class="badge">{stateLabel(detail.item.state)}</span>{#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}<dl><div><dt>记录 ID</dt><dd><code>{detail.item.id}</code></dd></div><div><dt>开始时间</dt><dd>{date(detail.item.startedAt)}</dd></div><div><dt>完成时间</dt><dd>{date(detail.item.completedAt)}</dd></div>{#if detail.item.retryOf}<div><dt>前一次记录</dt><dd><code>{detail.item.retryOf}</code></dd></div>{/if}{#if detail.item.kind==='sync'}<div><dt>来源</dt><dd>{detail.item.source==='scheduled'?'定时同步':'Owner 手动同步'}</dd></div><div><dt>同步记录数</dt><dd>{detail.item.count??'—'}</dd></div>{:else}<div><dt>收件地址</dt><dd>{detail.item.address}</dd></div><div><dt>范围</dt><dd>{scopeLabel(detail.item.scope)}</dd></div><div><dt>远端结果</dt><dd>{remoteLabel(detail.item.remoteStatus)}</dd></div><div><dt>本地结果</dt><dd>{localLabel(detail.item.localStatus)}</dd></div>{#if detail.item.current?.readOnly}<div><dt>当前权限</dt><dd>Cloudflare 记录只读，不能重新解除。</dd></div>{/if}{/if}</dl>
    {#if detail.item.errorCode}<p class="cf-history-help">{diagnostic(detail.item.errorCode)} <code>{detail.item.errorCode}</code></p>{/if}
    {#if detail.item.kind==='release'&&detail.item.canReconcile}<p class="cf-history-help">核对只读取 Cloudflare 记录，不删除远端记录，也不解除本地抑制。</p>{/if}
    <div class="cf-history-actions">{#if detail.item.kind==='sync'&&detail.item.canRetry}<button type="button" disabled={busy} onclick={()=>retrySync(detail!.item as SyncItem)}>重新同步此记录</button>{:else if detail.item.kind==='release'}{#if detail.item.canReconcile}<button type="button" disabled={busy} onclick={()=>reconcile(detail!.item as ReleaseItem)}>核对远端结果</button>{/if}{#if detail.item.canRetry&&detail.item.current&&!detail.item.current.readOnly}<button type="button" disabled={busy} onclick={()=>prepareRetry(detail!.item as ReleaseItem)}>重新确认解除</button>{/if}{/if}</div>
    <h3>执行时间线</h3>{#if !detail.timeline.length}<p class="cf-history-help">没有更多执行记录。</p>{:else}<ol class="cf-history-timeline">{#each detail.timeline as entry (entry.id)}<li><strong>{entry.action} · {stateLabel(entry.state)}</strong><time>{date(entry.occurredAt)}</time>{#if entry.remoteStatus}<span>{remoteLabel(entry.remoteStatus)}{entry.localStatus?` · ${localLabel(entry.localStatus)}`:''}</span>{/if}{#if entry.count!==null}<span>记录数：{entry.count}</span>{/if}{#if entry.errorCode}<code>{entry.errorCode}</code>{/if}</li>{/each}</ol>{/if}{#if detail.timelineTruncated}<p class="cf-history-help">仅显示最近的执行时间线。</p>{/if}
  </div></Dialog>{/if}

{#if retryTarget?.current}<Dialog title="重新确认 Cloudflare 解除操作" {busy} onClose={closeRetry}><p><strong class="cf-history-address">{retryTarget.address}</strong><br/>{scopeLabel(retryTarget.scope)}</p><p>将创建关联原记录的新操作，按当前服务端快照重新校验。</p>{#if retryTarget.scope.type==='account'}<div class="cf-history-warning">账户范围的解除会影响所有发信域，包括当前邮箱之外的发信域。</div>{/if}
  {#if retryResult}<div class="cf-history-warning" role="status">{remoteLabel(retryResult.remoteStatus)}；{localLabel(retryResult.localStatus)}。请关闭后先在历史中核对结果。</div><button type="button" disabled={busy} onclick={closeRetry}>关闭</button>
  {:else}<div class="field"><label for="cf-history-confirm-address">输入完整收件地址以重新确认</label><input id="cf-history-confirm-address" bind:value={confirmationAddress} disabled={busy||attempted} spellcheck={false} autocomplete="off"/></div>{#if retryTarget.scope.type==='account'}<label class="cf-history-confirm"><input type="checkbox" bind:checked={scopeConfirmed} disabled={busy||attempted}/>我确认此次新操作影响 Cloudflare 账户的所有发信域。</label>{/if}{#if retryTarget.current.localSuppression?.status==='active'}<label class="cf-history-confirm"><input type="checkbox" bind:checked={releaseLocal} disabled={busy||attempted}/>同时解除当前邮箱匹配的本地抑制</label><p class="cf-history-help">仅按当前版本解除；新的本地事件会保留。其他邮箱的本地名单不受影响。</p>{/if}{#if retryError}<div class="notice error" role="alert">{retryError}</div><p class="cf-history-help">再次确认会沿用本次新操作标识；也可关闭并刷新历史后核对。</p>{/if}<div class="dialog-actions"><button type="button" disabled={busy} onclick={closeRetry}>取消</button><button class="primary" type="button" disabled={busy||!canConfirm} onclick={submitRetry}>确认新的解除操作</button></div>{/if}
</Dialog>{/if}

<style>
  .cf-history {margin-top:36px;padding-top:28px;border-top:1px solid var(--line);}
  .cf-history-heading,.cf-history-toolbar,.cf-history-row-heading,.cf-history-actions,.cf-history-pagination {display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
  .cf-history-heading,.cf-history-toolbar {justify-content:space-between;margin-bottom:20px;}
  .cf-history-heading p,.cf-history-help {font-size:12px;line-height:1.8;overflow-wrap:anywhere;}
  .cf-history-toolbar label {display:flex;align-items:center;gap:9px;font-size:12px;}
  .cf-history-toolbar select {padding:8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink);font-size:12px;}
  .cf-history-list {list-style:none;padding:0;margin:0;}
  .cf-history-list>li {padding:18px 20px;margin-bottom:12px;border:1px solid var(--line);border-radius:8px;min-width:0;}
  .cf-history-row-heading strong {font-size:14px;overflow-wrap:anywhere;}
  .cf-history-meta {font-size:11px;overflow-wrap:anywhere;}
  .cf-history-actions {margin:13px 0 4px;}
  .cf-history-actions button,.cf-history-heading>button,.cf-history-pagination button {font-size:12px;min-height:34px;padding:6px 11px;}
  .cf-history-pagination {justify-content:space-between;margin-top:18px;}
  .cf-history-pagination span {font-size:12px;color:var(--muted);}
  .cf-history-empty,.cf-history-warning {padding:16px 18px;border:1px solid var(--line);border-radius:7px;background:var(--paper);font-size:13px;margin:15px 0;overflow-wrap:anywhere;}
  .cf-history-detail dl {font-size:12px;margin:17px 0;}
  .cf-history-detail dl>div {display:grid;grid-template-columns:85px minmax(0,1fr);gap:10px;margin:9px 0;}
  .cf-history-detail dt {color:var(--muted);}.cf-history-detail dd {margin:0;overflow-wrap:anywhere;}
  .cf-history-detail code,.cf-history-help code {font:11px/1.8 ui-monospace,monospace;overflow-wrap:anywhere;}
  .cf-history-detail h3 {font-size:15px;margin:22px 0 12px;}
  .cf-history-timeline {list-style:none;margin:0;padding:0;max-height:300px;overflow:auto;}
  .cf-history-timeline li {padding:10px 0;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:5px;font-size:12px;overflow-wrap:anywhere;}
  .cf-history-timeline time {font-size:11px;color:var(--muted);}
  .cf-history-confirm {display:flex;align-items:flex-start;gap:9px;font-size:13px;line-height:1.8;margin:13px 0;}
  .cf-history-confirm input {width:16px;height:16px;flex:0 0 auto;margin:4px 0 0;}
  .cf-history-address {overflow-wrap:anywhere;}
  @media(max-width:800px) {.cf-history-list>li {padding:15px;}.cf-history-heading {align-items:flex-start;}}
</style>
