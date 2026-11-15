<script lang="ts">
  import {onMount,onDestroy,tick} from 'svelte';
  import {invalidateAll} from '$app/navigation';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {RetryBatchNotification as Notification,RetryBatchNotificationList as Page,RetryBatchNotificationKind as Kind} from '#lib/types/retry-batch-notifications.ts';
  import Dialog from './Dialog.svelte';
  import RetryBatchNotificationDeliveries from './RetryBatchNotificationDeliveries.svelte';
  import RetryBatchNotificationRetryBatches from './RetryBatchNotificationRetryBatches.svelte';
  type Status='unread'|'acknowledged'|'all';
  let {mailboxId,onViewBatch}:{mailboxId:string;onViewBatch:(id:string)=>Promise<void>}=$props();
  let result=$state<Page|null>(null),status=$state<Status>('unread'),kind=$state<Kind|'all'>('all'),loading=$state(true),busy=$state(false);
  let cursor=$state<string|null>(null),previous=$state<(string|null)[]>([]),detail=$state<Notification|null>(null),errorMessage=$state(''),detailError=$state(''),notice=$state('');
  const base=$derived(`/owner/api/mailboxes/${mailboxId}/retry-batch-notifications`),controller=new AbortController();
  const titles:Record<Kind,string>={completed:'批量任务处理完成',failed:'批量任务执行异常',needs_reconciliation:'批量任务结果待对账'};
  const states:Record<string,string>={preview:'待确认预览',queued:'等待执行',running:'正在执行',completed:'处理完成',expired:'已过期',cancelled:'已停止未执行条目'};
  let deliveryBusy=$state(false);
  let mounted=false,knownSummary='',timer:ReturnType<typeof setTimeout>|undefined;
  onMount(()=>{mounted=true;document.addEventListener('visibilitychange',visibilityChanged);void load(null);});
  onDestroy(()=>{mounted=false;clearTimeout(timer);controller.abort();document.removeEventListener('visibilitychange',visibilityChanged);});
  function date(value:number|null):string{return value===null?'—':new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function decision(value:Notification):string{return value.notificationDecision===null?'等待评估通知策略':({allowed:'已准入 Webhook，实际结果请查看邮箱投递记录',disabled:'通知关闭，本次未发送 Webhook',quiet_hours:'静默命中，本次未发送 Webhook',repeat_limited:'重复限频，本次未发送 Webhook',no_subscribers:'无匹配订阅，本次未发送 Webhook'} as Record<string,string>)[value.notificationDecision]??'通知状态暂不可用';}
  function reason(value:Notification):string{return value.reason==='expired'?'批次已过执行期限，未完成条目不再创建新排队。':value.kind==='failed'?'本批次出现执行失败，请核对逐项原因。':value.kind==='needs_reconciliation'?'有结果尚未确认，请核对原操作收据。':'本批次已完成逐项处理，可能包含跳过或失败。';}
  function current(value:Notification):string{return value.kind==='needs_reconciliation'?(value.currentAttention?'当前仍有待对账结果。':'当前已无待对账结果，原提醒作为历史保留。'):value.kind==='failed'?(value.currentAttention?'当前仍有异常结果，请在批次中核对。':'当前异常状态已变化，原提醒作为历史保留。'):'请在批次及原投递记录中核对实际结果。';}
  function schedule(){clearTimeout(timer);if(mounted&&!controller.signal.aborted&&!busy&&!deliveryBusy&&document.visibilityState==='visible')timer=setTimeout(()=>{void load(cursor,'same',false);},15_000);}
  function visibilityChanged(){clearTimeout(timer);if(document.visibilityState==='visible'&&!busy)void load(cursor,'same',false);}
  async function fetchPage(value:string|null){
    const query=new URLSearchParams({status,kind,limit:'5'});if(value)query.set('cursor',value);
    const next=await ownerRequest<Page>(`${base}?${query}`,{signal:controller.signal});if(controller.signal.aborted)return;
    result=next;cursor=value;const summary=JSON.stringify([next.summary.unread,next.summary.attention]);
    if(knownSummary!==summary){knownSummary=summary;await invalidateAll();}
  }
  async function load(value:string|null,direction:'reset'|'next'|'previous'|'same'='reset',clear=true){
    if(busy||controller.signal.aborted)return;clearTimeout(timer);busy=true;if(clear)errorMessage='';const old=cursor;
    try{await fetchPage(value);if(detail){const next=await ownerRequest<{notification:Notification}>(`${base}/${detail.id}`,{signal:controller.signal});if(mounted)detail=next.notification;}
      if(mounted)previous=direction==='next'?[...previous,old]:direction==='previous'?previous.slice(0,-1):direction==='reset'?[]:previous;}
    catch(error){if(mounted)errorMessage=error instanceof Error?error.message:'批量任务通知读取失败，请刷新重试。';}
    finally{if(mounted){busy=false;loading=false;schedule();}}
  }
  async function selectStatus(value:Status){if(busy)return;status=value;notice='';await load(null);}
  async function selectKind(value:string){if(busy||!['all','completed','failed','needs_reconciliation'].includes(value))return;kind=value as Kind|'all';notice='';await load(null);}
  async function openDetail(item:Notification){
    if(busy)return;clearTimeout(timer);busy=true;errorMessage='';detailError='';
    try{const next=await ownerRequest<{notification:Notification}>(`${base}/${item.id}`,{signal:controller.signal});if(mounted)detail=next.notification;}
    catch(error){if(mounted)errorMessage=error instanceof Error?error.message:'批量通知详情读取失败。';}
    finally{if(mounted){busy=false;schedule();}}
  }
  async function acknowledge(item:Notification){
    if(busy||deliveryBusy||item.acknowledgedAt!==null)return;clearTimeout(timer);busy=true;errorMessage='';detailError='';notice='';
    try{const next=await ownerRequest<{notification:Notification}>(`${base}/${item.id}/acknowledge`,{method:'POST',body:{expectedVersion:item.version},signal:controller.signal});
      if(!mounted)return;if(detail?.id===item.id)detail=next.notification;notice='已确认知悉此批量任务通知。任务处理、待对账结果和 Webhook 投递保持保留。';await fetchPage(null);previous=[];}
    catch(error){if(mounted){const message=error instanceof Error?error.message:'确认未完成，请刷新核对。';if(detail)detailError=message;else errorMessage=message;}}
    finally{if(mounted){busy=false;schedule();}}
  }
  async function viewBatch(item:Notification){
    if(busy||deliveryBusy)return;clearTimeout(timer);busy=true;errorMessage='';detailError='';const before=detail;if(detail){detail=null;await tick();}
    try{await onViewBatch(item.batchId);}
    catch(error){if(mounted){const message=error instanceof Error?error.message:'批次读取失败，请刷新后核对。';if(before){detail=before;detailError=message;}else errorMessage=message;}}
    finally{if(mounted){busy=false;schedule();}}
  }
</script>

<section id="retry-batch-notifications" class="batch-notifications" aria-labelledby="retry-batch-notifications-heading">
  <div class="notification-heading"><div><h4 id="retry-batch-notifications-heading">批量任务完成与异常通知</h4><p>保留处理完成、执行失败及待对账提醒。控制台提醒不受 Webhook 开关或静默策略隐藏。</p></div><button type="button" disabled={busy} onclick={()=>load(null)}>刷新批量任务通知</button></div>
  {#if result}<p class="notification-summary" aria-label="批量任务通知统计">待确认 {result.summary.unread} · 待确认异常 {result.summary.attention} · 完成 {result.summary.completed} · 失败提醒 {result.summary.failed} · 待对账提醒 {result.summary.needsReconciliation}</p>{/if}
  <div class="notification-filters" role="group" aria-label="批量任务通知筛选">{#each [{value:'unread' as const,label:'待确认'},{value:'acknowledged' as const,label:'已知悉'},{value:'all' as const,label:'全部通知'}] as option}<button type="button" disabled={busy} aria-pressed={status===option.value} onclick={()=>selectStatus(option.value)}>{option.label}</button>{/each}<label>通知类型<select aria-label="批量任务通知类型" value={kind} disabled={busy} onchange={event=>selectKind(event.currentTarget.value)}><option value="all">全部类型</option><option value="completed">处理完成</option><option value="failed">执行异常</option><option value="needs_reconciliation">结果待对账</option></select></label></div>
  {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}{#if notice}<p role="status" class="notification-notice">{notice}</p>{/if}
  {#if loading}<p role="status">正在读取批量任务通知…</p>{:else if !result?.notifications.length}<p>当前筛选下没有批量任务通知。</p>{:else}
    <ul class="notification-list">{#each result.notifications as item (item.id)}<li data-retry-batch-notification={item.id}>
      <div class="notification-row-heading"><strong>{titles[item.kind]}</strong><span class="badge" class:active={item.kind==='completed'} class:paused={item.currentAttention}>{item.acknowledgedAt===null?'待确认':'已知悉'}</span></div>
      <p>快照已处理 {item.processedItems}/{item.totalItems} · 已重新排队 {item.requeuedItems} · 跳过 {item.skippedItems} · 失败 {item.failedItems} · 待对账 {item.unknownItems}</p>
      <p>{reason(item)} {current(item)}</p><p class="notification-meta">记录 {date(item.occurredAt)} · 批次版本 {item.sourceVersion}<br/>{decision(item)}</p>
      <div class="notification-actions"><button type="button" disabled={busy} aria-label={`查看批量任务通知 ${item.id}`} onclick={()=>openDetail(item)}>查看通知</button><button type="button" disabled={busy} aria-label={`定位批量任务 ${item.batchId}`} onclick={()=>viewBatch(item)}>查看批次</button>{#if item.acknowledgedAt===null}<button type="button" disabled={busy} aria-label={`确认批量任务通知 ${item.id}`} onclick={()=>acknowledge(item)}>确认知悉</button>{/if}</div>
    </li>{/each}</ul>
  {/if}
  <p class="notification-meta">“处理完成”包含跳过或失败；“已重新排队”不代表接收端已收到 Webhook。确认知悉不会解决待对账结果。</p>
  <nav class="notification-pagination" aria-label="批量任务通知分页"><button type="button" disabled={busy||!previous.length} onclick={()=>load(previous.at(-1)??null,'previous')}>上一页</button><span>本页 {result?.notifications.length??0} 项通知</span><button type="button" disabled={busy||!result?.nextCursor} onclick={()=>load(result?.nextCursor??null,'next')}>下一页</button></nav>
</section>

{#key mailboxId}<RetryBatchNotificationRetryBatches {mailboxId}/>{/key}

{#if detail}<Dialog title="批量任务通知详情" busy={busy||deliveryBusy} onClose={()=>{if(!busy&&!deliveryBusy){detail=null;detailError='';}}}><div class="notification-detail">
  <h3>{titles[detail.kind]}</h3><p>{detail.acknowledgedAt===null?'待确认':`已知悉 · ${date(detail.acknowledgedAt)}`}</p>
  <dl><div><dt>通知 ID</dt><dd><code>{detail.id}</code></dd></div><div><dt>批次 ID</dt><dd><code>{detail.batchId}</code></dd></div><div><dt>记录时间</dt><dd>{date(detail.occurredAt)} · 版本 {detail.sourceVersion}</dd></div><div><dt>原状态</dt><dd>{states[detail.batchState]??detail.batchState}</dd></div><div><dt>原结果快照</dt><dd>已处理 {detail.processedItems}/{detail.totalItems} · 已重新排队 {detail.requeuedItems} · 跳过 {detail.skippedItems} · 失败 {detail.failedItems} · 待对账 {detail.unknownItems}</dd></div><div><dt>当前状态</dt><dd>{states[detail.currentBatch.state]??detail.currentBatch.state} · 版本 {detail.currentBatch.version}<br/>已处理 {detail.currentBatch.processedItems}/{detail.currentBatch.totalItems} · 失败 {detail.currentBatch.failedItems} · 待对账 {detail.currentBatch.unknownItems}</dd></div><div><dt>通知策略</dt><dd>{decision(detail)}<br/>版本 {detail.policyVersion??'—'} · {date(detail.decidedAt)}</dd></div></dl>
  <p>{reason(detail)} {current(detail)}</p><p>此提醒记录当时事实，原快照不会随之后对账改写。确认知悉只更新控制台状态，不停止任务、不解决异常，也不重发 Webhook。</p>
  {#if detailError}<div class="notice error" role="alert">{detailError}</div>{/if}
  <div class="notification-actions"><button type="button" disabled={busy||deliveryBusy} onclick={()=>viewBatch(detail!)}>查看对应批次</button>{#if detail.acknowledgedAt===null}<button type="button" disabled={busy||deliveryBusy} onclick={()=>acknowledge(detail!)}>确认知悉此批量通知</button>{/if}</div>
  {#key detail.id}<RetryBatchNotificationDeliveries {mailboxId} notificationId={detail.id} onBusyChange={value=>{deliveryBusy=value;if(value)clearTimeout(timer);else schedule();}}/>{/key}
</div></Dialog>{/if}

<style>
  .batch-notifications{margin:12px 0 18px;padding:13px;border:1px solid var(--line);border-radius:7px;background:var(--surface);scroll-margin-top:20px;}
  .notification-heading,.notification-row-heading,.notification-actions,.notification-pagination,.notification-filters{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:9px;}.notification-heading{align-items:flex-start;}.notification-heading h4{font-size:14px;margin:0;}
  .batch-notifications p,.notification-detail p{font-size:12px;line-height:1.8;overflow-wrap:anywhere;}.batch-notifications button,.batch-notifications select,.notification-detail button{font-size:12px;min-height:32px;padding:5px 10px;}.notification-summary{font-weight:650;}.notification-filters,.notification-actions,.notification-row-heading{justify-content:flex-start;}.notification-filters button[aria-pressed="true"]{background:#dfe9d8;}.notification-filters label{font-size:12px;display:flex;align-items:center;gap:8px;}
  .notification-list{list-style:none;padding:0;margin:12px 0;}.notification-list>li{border-top:1px solid var(--line);padding:13px 0;}.notification-list strong{font-size:13px;}.notification-meta,.notification-pagination{font-size:11px!important;color:var(--muted);}.notification-notice{color:var(--green);}.notification-detail code{font-size:11px;overflow-wrap:anywhere;}
  .notification-detail h3{font-size:15px;}.notification-detail dl>div{display:grid;grid-template-columns:75px minmax(0,1fr);gap:9px;margin:10px 0;font-size:12px;}.notification-detail dt{color:var(--muted);}.notification-detail dd{margin:0;overflow-wrap:anywhere;}
  @media(max-width:800px){.batch-notifications{padding:10px;}.notification-heading>button{margin-bottom:5px;}.notification-filters label{width:100%;}}
</style>
