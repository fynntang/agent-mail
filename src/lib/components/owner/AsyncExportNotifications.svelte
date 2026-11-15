<script lang="ts">
  import {onMount,onDestroy,untrack,tick} from 'svelte';
  import {invalidateAll} from '$app/navigation';
  import {ownerRequest} from '#lib/owner-client.ts';
  import Dialog from './Dialog.svelte';
  import AsyncExportNotificationDeliveries from './AsyncExportNotificationDeliveries.svelte';
  import AsyncExportNotificationRetryBatches from './AsyncExportNotificationRetryBatches.svelte';
  import RetryBatchNotifications from './RetryBatchNotifications.svelte';
  import type {AsyncExportNotification as Notification,AsyncExportNotificationList as Page} from '#lib/types/async-export-notifications.ts';
  type Status='unread'|'acknowledged'|'all';
  let {mailboxId,revision=0,onViewTask}:{mailboxId:string;revision?:number;onViewTask:(id:string)=>Promise<void>}=$props();
  let result=$state<Page|null>(null),status=$state<Status>('unread'),loading=$state(true),busy=$state(false),errorMessage=$state(''),notice=$state('');
  let cursor=$state<string|null>(null),previous=$state<(string|null)[]>([]),detail=$state<Notification|null>(null),detailError=$state(''),now=$state(Date.now());
  const base=$derived(`/owner/api/mailboxes/${mailboxId}/export-notifications`),controller=new AbortController();
  let mounted=false,knownUnread:number|null=null;
  let deliveryBusy=$state(false);
  let retryBatches=$state<{viewBatch:(id:string)=>Promise<void>}|null>(null);
  onMount(()=>{mounted=true;void load(null);});
  onDestroy(()=>{mounted=false;controller.abort();});
  $effect(()=>{revision;untrack(()=>{if(mounted)void load(cursor,'same',false);});});
  function date(value:number|null):string{return value===null?'—':new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function bytes(value:number):string{return value<1024?`${value} B`:value<1024*1024?`${(value/1024).toFixed(1)} KiB`:`${(value/(1024*1024)).toFixed(1)} MiB`;}
  function title(value:Notification):string{return `${value.format.toUpperCase()} 导出${value.outcome==='succeeded'?'已完成':'失败'}`;}
  function decision(value:Notification):string{return value.notificationDecision===null?'等待评估通知策略':({allowed:'已准入 Webhook，实际结果请查看投递记录',disabled:'通知关闭，本次未发送 Webhook',quiet_hours:'静默命中，本次未发送 Webhook',repeat_limited:'重复限频，本次未发送 Webhook',no_subscribers:'无匹配订阅，本次未发送 Webhook'} as Record<string,string>)[value.notificationDecision]??'通知状态暂不可用';}
  async function fetchPage(value:string|null){
    const query=new URLSearchParams({status,limit:'10'});if(value)query.set('cursor',value);
    const next=await ownerRequest<Page>(`${base}?${query}`,{signal:controller.signal});
    if(controller.signal.aborted)return;result=next;cursor=value;now=Date.now();
    if(knownUnread!==next.summary.unread){knownUnread=next.summary.unread;await invalidateAll();}
  }
  async function load(value:string|null,direction:'reset'|'next'|'previous'|'same'='reset',clear=true):Promise<void>{
    if(busy||controller.signal.aborted)return;busy=true;if(clear)errorMessage='';const old=cursor;
    try{await fetchPage(value);if(mounted)previous=direction==='next'?[...previous,old]:direction==='previous'?previous.slice(0,-1):direction==='reset'?[]:previous;}
    catch(error){if(mounted)errorMessage=error instanceof Error?error.message:'导出通知读取失败，请刷新重试。';}
    finally{if(mounted){busy=false;loading=false;}}
  }
  async function selectStatus(value:Status){if(busy)return;status=value;notice='';await load(null);}
  async function openDetail(item:Notification){
    if(busy)return;busy=true;errorMessage='';detailError='';
    try{const value=await ownerRequest<{notification:Notification}>(`${base}/${item.jobId}`,{signal:controller.signal});if(mounted){detail=value.notification;now=Date.now();}}
    catch(error){if(mounted)errorMessage=error instanceof Error?error.message:'导出通知详情读取失败。';}
    finally{if(mounted)busy=false;}
  }
  async function acknowledge(item:Notification){
    if(busy||item.acknowledgedAt!==null)return;busy=true;errorMessage='';detailError='';notice='';
    try{
      const next=await ownerRequest<{notification:Notification}>(`${base}/${item.jobId}/acknowledge`,{method:'POST',body:{expectedVersion:item.version},signal:controller.signal});
      if(!mounted)return;if(detail?.jobId===item.jobId)detail=next.notification;notice='已确认知悉此导出通知。文件有效期与 Webhook 投递保持不变。';await fetchPage(null);previous=[];
    }catch(error){if(mounted){const message=error instanceof Error?error.message:'确认未完成，请刷新核对。';if(detail)detailError=message;else errorMessage=message;}}
    finally{if(mounted)busy=false;}
  }
  async function viewTask(item:Notification){
    if(busy)return;busy=true;errorMessage='';detailError='';
    const previousDetail=detail;if(detail){detail=null;await tick();}
    try{await onViewTask(item.jobId);}
    catch(error){if(mounted){const message=error instanceof Error?error.message:'导出任务读取失败，请刷新重试。';if(previousDetail){detail=previousDetail;detailError=message;}else errorMessage=message;}}
    finally{if(mounted)busy=false;}
  }
</script>

<section id="async-export-notifications" class="export-notifications" aria-labelledby="export-notifications-heading">
  <div class="notification-heading"><div><h4 id="export-notifications-heading">导出完成与失败通知</h4><p>任务完成或最终失败后保留提醒。确认知悉只更新控制台状态，文件在创建后24小时过期。</p></div><button type="button" disabled={busy} onclick={()=>load(null)}>刷新导出通知</button></div>
  {#if result}<p class="notification-summary" aria-label="导出通知统计">待确认 {result.summary.unread} · 完成 {result.summary.succeeded} · 失败 {result.summary.failed}</p>{/if}
  <div class="notification-filters" role="group" aria-label="导出通知筛选">{#each [{value:'unread' as const,label:'待确认'},{value:'acknowledged' as const,label:'已知悉'},{value:'all' as const,label:'全部通知'}] as option}<button type="button" disabled={busy} aria-pressed={status===option.value} onclick={()=>selectStatus(option.value)}>{option.label}</button>{/each}</div>
  {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}{#if notice}<p role="status" class="notification-notice">{notice}</p>{/if}
  {#if loading}<p role="status">正在读取导出通知…</p>{:else if !result?.notifications.length}<p>当前筛选下没有导出通知。</p>{:else}
    <ul class="notification-list">{#each result.notifications as item (item.id)}<li data-export-notification={item.jobId}>
      <div class="notification-row-heading"><strong>{title(item)}</strong><span class="badge" class:active={item.outcome==='succeeded'} class:paused={item.outcome==='failed'}>{item.acknowledgedAt===null?'待确认':'已知悉'}</span></div>
      <p>处理决策 {item.processedDecisions}/{item.totalDecisions} · 投递 {item.processedDeliveries} 条 · 明细 {bytes(item.bodyBytes)}</p>
      <p class="notification-meta">结束 {date(item.completedAt)}<br/>{decision(item)}</p>
      {#if item.outcome==='failed'}<p>任务已停止生成，不提供部分文件。{#if item.errorCode}<code>{item.errorCode}</code>{/if}</p>{:else if item.expiresAt<=now}<p>临时文件已过期，通知记录仍保留。</p>{:else}<p>文件有效期至 {date(item.expiresAt)}，请在任务中核对后下载。</p>{/if}
      <div class="notification-actions"><button type="button" disabled={busy} aria-label={`查看导出通知 ${item.jobId}`} onclick={()=>openDetail(item)}>查看通知</button><button type="button" disabled={busy} aria-label={`定位导出任务 ${item.jobId}`} onclick={()=>viewTask(item)}>查看任务</button>{#if item.acknowledgedAt===null}<button type="button" disabled={busy} aria-label={`确认导出通知 ${item.jobId}`} onclick={()=>acknowledge(item)}>确认知悉</button>{/if}</div>
    </li>{/each}</ul>
  {/if}
  <nav class="notification-pagination" aria-label="导出通知分页"><button type="button" disabled={busy||!previous.length} onclick={()=>load(previous.at(-1)??null,'previous')}>上一页</button><span>本页 {result?.notifications.length??0} 项通知</span><button type="button" disabled={busy||!result?.nextCursor} onclick={()=>load(result?.nextCursor??null,'next')}>下一页</button></nav>
</section>

<RetryBatchNotifications {mailboxId} onViewBatch={async id=>{if(!retryBatches)throw new Error('批量任务面板尚未就绪，请稍后重试。');await retryBatches.viewBatch(id);}}/>
<AsyncExportNotificationRetryBatches {mailboxId} bind:this={retryBatches}/>

{#if detail}<Dialog title="导出通知详情" busy={busy||deliveryBusy} onClose={()=>{if(!busy&&!deliveryBusy){detail=null;detailError='';}}}><div class="notification-detail">
  <h3>{title(detail)}</h3><p>{detail.acknowledgedAt===null?'待确认':`已知悉 · ${date(detail.acknowledgedAt)}`}</p>
  <dl><div><dt>任务 ID</dt><dd><code>{detail.jobId}</code></dd></div><div><dt>结束时间</dt><dd>{date(detail.completedAt)}</dd></div><div><dt>决策进度</dt><dd>{detail.processedDecisions}/{detail.totalDecisions}</dd></div><div><dt>投递结果</dt><dd>{detail.processedDeliveries} 条 · 明细 {bytes(detail.bodyBytes)}</dd></div><div><dt>诊断代码</dt><dd><code>{detail.errorCode??'—'}</code></dd></div><div><dt>通知策略</dt><dd>{decision(detail)}<br/>版本 {detail.policyVersion??'—'} · {date(detail.decidedAt)}</dd></div></dl>
  <p>控制台提醒不受 Webhook 开关或静默策略隐藏；实际 Webhook 结果请查看邮箱投递记录。</p>
  {#if detail.outcome==='succeeded'}<p>{detail.expiresAt<=now?'临时文件已过期，不能继续下载。':`文件有效期至 ${date(detail.expiresAt)}。`}</p>{:else}<p>任务最终失败，不能下载部分文件，可在原筛选下重新创建任务。</p>{/if}
  {#if detailError}<div class="notice error" role="alert">{detailError}</div>{/if}
  <div class="notification-actions"><button type="button" disabled={busy||deliveryBusy} onclick={()=>viewTask(detail!)}>查看对应任务</button>{#if detail.acknowledgedAt===null}<button type="button" disabled={busy||deliveryBusy} onclick={()=>acknowledge(detail!)}>确认知悉此通知</button>{/if}</div>
  {#key detail.jobId}<AsyncExportNotificationDeliveries {mailboxId} jobId={detail.jobId} onBusyChange={value=>deliveryBusy=value}/>{/key}
</div></Dialog>{/if}

<style>
  .export-notifications{margin:12px 0 18px;padding:13px;border:1px solid var(--line);border-radius:7px;background:var(--surface);scroll-margin-top:20px;}
  .notification-heading,.notification-row-heading,.notification-actions,.notification-pagination,.notification-filters{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:9px;}.notification-heading{align-items:flex-start;}.notification-heading h4{font-size:14px;margin:0;}
  .export-notifications p,.notification-detail p{font-size:12px;line-height:1.8;overflow-wrap:anywhere;}.export-notifications button,.notification-detail button{font-size:12px;min-height:32px;padding:5px 10px;}.notification-summary{font-weight:650;}.notification-filters,.notification-actions,.notification-row-heading{justify-content:flex-start;}.notification-filters button[aria-pressed="true"]{background:#dfe9d8;}
  .notification-list{list-style:none;padding:0;margin:12px 0;}.notification-list>li{border-top:1px solid var(--line);padding:13px 0;}.notification-list strong{font-size:13px;}.notification-meta,.notification-pagination{font-size:11px!important;color:var(--muted);}.notification-notice{color:var(--green);}.notification-list code,.notification-detail code{font-size:11px;overflow-wrap:anywhere;}
  .notification-detail h3{font-size:15px;}.notification-detail dl>div{display:grid;grid-template-columns:75px minmax(0,1fr);gap:9px;margin:10px 0;font-size:12px;}.notification-detail dt{color:var(--muted);}.notification-detail dd{margin:0;overflow-wrap:anywhere;}
  @media(max-width:800px){.export-notifications{padding:10px;}.notification-heading>button{margin-bottom:5px;}}
</style>
