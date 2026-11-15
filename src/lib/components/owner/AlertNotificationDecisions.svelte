<script lang="ts">
  import {onMount,onDestroy,tick} from 'svelte';
  import {ownerRequest,ownerDownload} from '#lib/owner-client.ts';
  import type {AlertNotificationDecision,AlertNotificationDecisionList,AlertNotificationDecisionDetail,AlertNotificationDeliverySummary} from '#lib/types/alert-notification-decisions.ts';
  import type {WebhookDelivery,WebhookAttempt} from '#lib/types/webhooks.ts';
  import Dialog from './Dialog.svelte';
  import AsyncAlertNotificationExports from './AsyncAlertNotificationExports.svelte';
  type Decision=AlertNotificationDecision['decision'];type EventType='all'|'created'|'resolved';type Period='24h'|'7d'|'30d'|'custom';
  let {mailboxId,onViewAlert}:{mailboxId:string;onViewAlert?:(id:string)=>Promise<void>}=$props();
  let result=$state<AlertNotificationDecisionList|null>(null),expanded=$state(false),busy=$state(false),loading=$state(true),errorMessage=$state('');
  let decision=$state<Decision|'all'>('all'),eventType=$state<EventType>('all'),limit=$state(20),period=$state<Period>('7d');
  let range=$state<{from:number;to:number}|null>(null),rangeStart=$state(''),rangeEnd=$state(''),cursor=$state<string|null>(null),previous=$state<(string|null)[]>([]);
  let detail=$state<AlertNotificationDecisionDetail|null>(null),deliveryDetail=$state<{delivery:WebhookDelivery;attempts:WebhookAttempt[]}|null>(null),dialogError=$state('');
  let exporting=$state<'csv'|'json'|null>(null),exportNotice=$state(''),exportError=$state(''),exportController:AbortController|null=null;
  const downloadUrls=new Set<string>();
  let linkedNotificationPending=false;
  const base=$derived(`/owner/api/mailboxes/${mailboxId}/alert-notification-decisions`),controller=new AbortController();
  const reasons:Record<Decision,string>={allowed:'已准入',disabled:'通知关闭',quiet_hours:'静默命中',repeat_limited:'限频命中',recovery_disabled:'恢复通知关闭',no_subscribers:'无匹配订阅'};
  const descriptions:Record<Decision,string>={allowed:'已通过通知策略，是否发送成功请查看投递结果。',disabled:'发布时告警通知已关闭，本次跳过。',quiet_hours:'发布时处于静默时段，本次跳过，不会自动补发。',repeat_limited:'相同告警信号命中重复间隔，本次跳过，不会自动补发。',recovery_disabled:'发布时恢复通知已关闭，本次跳过。',no_subscribers:'发布时没有符合条件的活动订阅，本次跳过，不会自动补发。'};
  const deliveryStates:Record<WebhookDelivery['state'],string>={pending:'等待投递',running:'投递中',succeeded:'投递成功',dead:'已停止重试',cancelled:'已取消'};
  const unappliedRange=$derived(Boolean(range)&&(rangeStart!==localDate(range!.from)||rangeEnd!==localDate(range!.to)));
  onMount(()=>{void load(null);void openLinkedNotifications();window.addEventListener('hashchange',openLinkedNotifications);});onDestroy(()=>{controller.abort();exportController?.abort();for(const url of downloadUrls)URL.revokeObjectURL(url);downloadUrls.clear();if(typeof window!=='undefined')window.removeEventListener('hashchange',openLinkedNotifications);});
  async function openLinkedNotifications(){const id=window.location.hash.slice(1);if(['async-export-notifications','retry-batch-notifications'].includes(id)){linkedNotificationPending=true;expanded=true;await tick();const target=document.getElementById(id);if(target){linkedNotificationPending=false;target.scrollIntoView({block:'start',behavior:'instant'});}}}
  function date(value:number|null):string{return value===null?'—':new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function localDate(value:number):string{const instant=new Date(value);return new Date(value-instant.getTimezoneOffset()*60_000).toISOString().slice(0,16);}
  function setInputs(){if(range){rangeStart=localDate(range.from);rangeEnd=localDate(range.to);}}
  function title(item:AlertNotificationDecision):string{return `${item.kind==='sync'?'同步':item.kind==='release'?'解除':'关联事件不可用'} · ${item.eventType==='created'?'故障通知':item.eventType==='resolved'?'恢复通知':'类型不可用'}`;}
  function outcome(item:AlertNotificationDecision):string{return item.outcome==='unknown'?'结果未知':item.outcome==='failed'?'失败':item.outcome==='resolved'?'实际恢复':'状态不可用';}
  function deliveryText(value:AlertNotificationDeliverySummary):string{return value.total?`投递成功 ${value.succeeded}/${value.total} · 等待 ${value.pending} · 投递中 ${value.running} · 已停止 ${value.dead} · 已取消 ${value.cancelled}`:'未创建投递';}
  async function fetchPage(value:string|null){
    const query=new URLSearchParams({decision,eventType,limit:String(limit)});if(range){query.set('from',String(range.from));query.set('to',String(range.to));}if(value)query.set('cursor',value);
    const page=await ownerRequest<AlertNotificationDecisionList>(`${base}?${query}`,{signal:controller.signal});
    if(!controller.signal.aborted){result=page;range=page.window;setInputs();cursor=value;}
  }
  async function load(value:string|null,direction:'reset'|'next'|'previous'='reset'):Promise<boolean>{
    if(busy)return false;busy=true;errorMessage='';exportNotice='';exportError='';const old=cursor;
    try{await fetchPage(value);if(!controller.signal.aborted)previous=direction==='next'?[...previous,old]:direction==='previous'?previous.slice(0,-1):[];return true;}
    catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'通知决策读取失败，请刷新重试。';return false;}
    finally{if(!controller.signal.aborted){busy=false;loading=false;if(linkedNotificationPending)void openLinkedNotifications();}}
  }
  async function refresh(){if(busy)return;const oldRange=range,oldPeriod=period;const to=Date.now()+1;if(period!=='custom')range={from:to-(period==='24h'?1:period==='30d'?30:7)*86_400_000,to};if(!await load(null)){range=oldRange;period=oldPeriod;setInputs();}}
  async function choosePeriod(value:Exclude<Period,'custom'>){if(busy)return;const oldRange=range,oldPeriod=period,to=Date.now()+1;period=value;range={from:to-(value==='24h'?1:value==='30d'?30:7)*86_400_000,to};if(!await load(null)){range=oldRange;period=oldPeriod;setInputs();}}
  async function chooseDecision(value:Decision|'all'){if(busy)return;const old=decision;decision=value;if(!await load(null))decision=old;}
  async function chooseEventType(value:EventType){if(busy)return;const old=eventType;eventType=value;if(!await load(null))eventType=old;}
  async function chooseLimit(value:number){if(busy)return;const old=limit;limit=value;if(!await load(null))limit=old;}
  async function applyRange(event:SubmitEvent){
    event.preventDefault();if(busy)return;const from=new Date(rangeStart).getTime(),to=new Date(rangeEnd).getTime();
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>=to||to-from>31*86_400_000||to>Date.now()+60_000){errorMessage='请选择有效的时间范围，最多31天，结束时间不能在未来。';return;}
    const oldRange=range,oldPeriod=period;range={from,to};period='custom';if(!await load(null)){range=oldRange;period=oldPeriod;setInputs();}
  }
  async function openDetail(item:AlertNotificationDecision){if(busy)return;busy=true;errorMessage='';dialogError='';deliveryDetail=null;try{const value=await ownerRequest<AlertNotificationDecisionDetail>(`${base}/${item.eventId}`,{signal:controller.signal});if(!controller.signal.aborted)detail=value;}catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'通知决策详情读取失败。';}finally{if(!controller.signal.aborted)busy=false;}}
  async function openDelivery(id:string){if(busy)return;busy=true;dialogError='';try{const value=await ownerRequest<{delivery:WebhookDelivery;attempts:WebhookAttempt[]}>(`/owner/api/mailboxes/${mailboxId}/webhook-deliveries/${id}`,{signal:controller.signal});if(!controller.signal.aborted)deliveryDetail=value;}catch(error){if(!controller.signal.aborted)dialogError=error instanceof Error?error.message:'投递尝试读取失败。';}finally{if(!controller.signal.aborted)busy=false;}}
  async function viewAlert(id:string){if(busy)return;busy=true;dialogError='';const previousDetail=detail;detail=null;deliveryDetail=null;try{await onViewAlert?.(id);}catch(error){if(!controller.signal.aborted){detail=previousDetail;dialogError=error instanceof Error?error.message:'关联告警读取失败。';}}finally{if(!controller.signal.aborted)busy=false;}}
  function closeDetail(){detail=null;deliveryDetail=null;dialogError='';}
  async function exportRecords(format:'csv'|'json'){
    if(busy||loading||!result||unappliedRange)return;busy=true;exporting=format;errorMessage='';exportNotice='';exportError='';
    const current=result.window,query=new URLSearchParams({format,decision,eventType,from:String(current.from),to:String(current.to)}),request=new AbortController();exportController=request;
    try{
      const blob=await ownerDownload(`${base}/export?${query}`,format,request.signal);if(request.signal.aborted||controller.signal.aborted)return;
      const url=URL.createObjectURL(blob);downloadUrls.add(url);const link=document.createElement('a');link.href=url;link.download=`alert-notification-decisions-${mailboxId}-${current.from}-${current.to}.${format}`;link.rel='noopener';document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>{URL.revokeObjectURL(url);downloadUrls.delete(url);},1000);exportNotice=`${format.toUpperCase()} 导出已生成，包含当前筛选的全部记录。`;
    }catch(error){if(!controller.signal.aborted){if(request.signal.aborted)exportNotice='导出已取消。';else exportError=error instanceof Error?error.message:'导出未完成，请重试。';}}
    finally{if(!controller.signal.aborted){busy=false;exporting=null;exportController=null;}}
  }
</script>

<section class="notification-decisions" aria-labelledby="notification-decisions-heading">
  <div class="decision-heading"><div><h3 id="notification-decisions-heading">通知决策与降噪</h3><p>准入不等于发送成功；统计按邮箱事件计数，投递结果按订阅分别统计。</p></div><button type="button" disabled={busy||loading} aria-expanded={expanded} aria-controls="notification-decision-records" onclick={()=>expanded=!expanded}>{expanded?'收起通知决策':'查看通知决策'}</button></div>
  {#if result&&!expanded}<p aria-label="通知决策统计范围">{date(result.window.from)} 至 {date(result.window.to)}（不含结束） · {decision==='all'?'全部决策':reasons[decision]} · {eventType==='all'?'全部通知':eventType==='created'?'故障通知':'恢复通知'}</p>{/if}
  {#if loading}<p role="status">正在读取通知决策…</p>{:else if result}<dl class="decision-summary" aria-label="通知决策统计"><div><dt>决策事件</dt><dd data-stat="total">{result.summary.total}</dd></div><div><dt>已准入</dt><dd data-stat="allowed">{result.summary.allowed}</dd></div><div><dt>已跳过</dt><dd data-stat="skipped">{result.summary.skipped}</dd></div><div><dt>静默命中</dt><dd data-stat="quiet">{result.summary.byDecision.quiet_hours}</dd></div><div><dt>限频命中</dt><dd data-stat="repeat">{result.summary.byDecision.repeat_limited}</dd></div></dl>{/if}
  {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
  {#if expanded}
    <div id="notification-decision-records">
      <div class="decision-toolbar"><div role="group" aria-label="通知决策时间范围" class="decision-periods">{#each [{value:'24h' as const,label:'24小时'},{value:'7d' as const,label:'7天'},{value:'30d' as const,label:'30天'}] as option}<button type="button" aria-pressed={period===option.value} disabled={busy} onclick={()=>choosePeriod(option.value)}>{option.label}</button>{/each}</div><button type="button" disabled={busy} onclick={refresh}>刷新通知决策</button></div>
      <form class="decision-custom-range" aria-label="自定义通知决策时间范围" onsubmit={applyRange}><label>开始时间<input type="datetime-local" aria-label="通知决策开始时间" required bind:value={rangeStart} disabled={busy}/></label><label>结束时间<input type="datetime-local" aria-label="通知决策结束时间" required bind:value={rangeEnd} disabled={busy}/></label><button type="submit" disabled={busy}>查询时间范围</button><small>浏览器本地时间；最多31天，结束时间不包含。可查询更早的历史窗口。</small></form>
      <div class="decision-filters"><label>决策<select aria-label="通知决策筛选" value={decision} disabled={busy} onchange={event=>chooseDecision(event.currentTarget.value as Decision|'all')}><option value="all">全部决策</option>{#each Object.entries(reasons) as [value,label]}<option value={value}>{label}</option>{/each}</select></label><label>通知类型<select aria-label="通知类型筛选" value={eventType} disabled={busy} onchange={event=>chooseEventType(event.currentTarget.value as EventType)}><option value="all">全部通知</option><option value="created">故障通知</option><option value="resolved">恢复通知</option></select></label><label>每页<select aria-label="通知决策每页条数" value={String(limit)} disabled={busy} onchange={event=>chooseLimit(Number(event.currentTarget.value))}><option value="10">10 条</option><option value="20">20 条</option><option value="50">50 条</option></select></label></div>
      <div class="decision-export" aria-label="通知决策导出"><div class="decision-export-actions"><button type="button" disabled={busy||loading||!result||unappliedRange} onclick={()=>exportRecords('csv')}>导出 CSV</button><button type="button" disabled={busy||loading||!result||unappliedRange} onclick={()=>exportRecords('json')}>导出 JSON</button>{#if exporting}<button type="button" onclick={()=>exportController?.abort()}>取消导出</button>{/if}</div><p>导出当前已查询时间范围及筛选的全部记录，不受当前页影响。每次最多1000条决策、5000条订阅投递及8 MiB；超限请缩小范围。{#if unappliedRange}时间范围尚未查询，请先点击“查询时间范围”。{/if}</p>{#if exporting}<p role="status">正在生成 {exporting.toUpperCase()} 导出…</p>{/if}{#if exportNotice}<p role="status">{exportNotice}</p>{/if}{#if exportError}<div class="notice error" role="alert">{exportError}</div>{/if}</div>
      {#if result}<AsyncAlertNotificationExports {mailboxId} filters={{...result.window,decision,eventType}} disabled={busy||loading||unappliedRange}/>{/if}
      {#if result}<p class="decision-scope">统计范围：{date(result.window.from)} 至 {date(result.window.to)}（不含结束）；覆盖当前筛选的全部事件。列表翻页保留同一决策快照，投递状态为当前值。</p><p class="decision-delivery-summary" aria-label="通知投递统计">订阅投递：{deliveryText(result.summary.delivery)} · 尝试 {result.summary.delivery.attempts} 次 · 当前静默暂缓 {result.summary.delivery.quietDeferred} 条</p>
        <div class="decision-reason-counts" aria-label="跳过原因统计">{#each Object.entries(reasons).filter(([key])=>key!=='allowed') as [value,label]}<span>{label} <strong>{result.summary.byDecision[value as Decision]}</strong></span>{/each}</div>
        {#if !result.decisions.length}<p class="decision-empty">此时间范围和筛选下没有通知决策。</p>{:else}<ul class="decision-list">{#each result.decisions as item (item.eventId)}<li data-decision-event={item.eventId}><div class="decision-row-heading"><strong>{title(item)}</strong><span class="badge" class:active={item.decision==='allowed'}>{reasons[item.decision]}</span><span class="badge">{outcome(item)}</span></div><p>{descriptions[item.decision]}</p>{#if !item.eventAvailable}<p>关联事件不可用，保留决策记录，不推断历史正文。</p>{/if}<p>{deliveryText(item.delivery)} · 尝试 {item.delivery.attempts} 次{#if item.delivery.quietDeferred} · 当前静默暂缓 {item.delivery.quietDeferred} 条{/if}</p><p class="decision-meta">决策时间 {date(item.decidedAt)} · 策略版本 {item.policyVersion}{#if item.errorCode}<br/><code>{item.errorCode}</code>{/if}</p><button type="button" disabled={busy} aria-label={`查看通知决策 ${item.eventId}`} onclick={()=>openDetail(item)}>查看决策详情</button></li>{/each}</ul>{/if}
        <nav class="decision-pagination" aria-label="通知决策分页"><button type="button" disabled={busy||!previous.length} onclick={()=>load(previous.at(-1)??null,'previous')}>上一页</button><span>本页 {result.decisions.length} 条</span><button type="button" disabled={busy||!result.nextCursor} onclick={()=>load(result!.nextCursor,'next')}>下一页</button></nav>
      {/if}
    </div>
  {/if}
</section>

{#if detail}<Dialog title={deliveryDetail?'通知投递尝试':'通知决策详情'} {busy} onClose={closeDetail}><div class="decision-detail">{#if dialogError}<div class="notice error" role="alert">{dialogError}</div>{/if}
  {#if deliveryDetail}<button type="button" class="table-action" disabled={busy} onclick={()=>{deliveryDetail=null;dialogError='';}}>返回决策详情</button><p><strong>{deliveryStates[deliveryDetail.delivery.state]}</strong> · 尝试 {deliveryDetail.delivery.attempts} 次</p><p>投递 ID <code>{deliveryDetail.delivery.id}</code></p><ol>{#each deliveryDetail.attempts as attempt (attempt.id)}<li><strong>第 {attempt.attemptNo} 次 · {attempt.outcome}</strong><time>{date(attempt.startedAt)}</time><span>HTTP {attempt.httpStatus??'—'} · <code>{attempt.errorCode??'—'}</code></span></li>{/each}</ol>{:else}
    <p><strong>{title(detail.decision)}</strong> · {reasons[detail.decision.decision]} · {outcome(detail.decision)}</p><p>{descriptions[detail.decision.decision]}</p><dl><div><dt>决策时间</dt><dd>{date(detail.decision.decidedAt)}</dd></div><div><dt>事件时间</dt><dd>{date(detail.decision.occurredAt)}</dd></div><div><dt>策略版本</dt><dd>{detail.decision.policyVersion}（记录当时版本，不重建历史配置）</dd></div><div><dt>诊断代码</dt><dd><code>{detail.decision.errorCode??'—'}</code></dd></div><div><dt>事件 ID</dt><dd><code>{detail.decision.eventId}</code></dd></div></dl>
    <p>{deliveryText(detail.decision.delivery)} · 尝试 {detail.decision.delivery.attempts} 次 · 当前静默暂缓 {detail.decision.delivery.quietDeferred} 条</p>
    {#if onViewAlert}<button type="button" disabled={busy} onclick={()=>viewAlert(detail!.decision.alertId)}>查看关联告警</button>{/if}
    <h3>订阅投递</h3>{#if !detail.deliveries.length}<p>没有创建订阅投递。准入决策与实际 HTTP 发送分别记录。</p>{:else}<ul class="decision-deliveries">{#each detail.deliveries as delivery (delivery.id)}<li><strong>{deliveryStates[delivery.state]}</strong><p>端点 <code>{delivery.endpointId}</code></p><p>尝试 {delivery.attempts} 次 · HTTP {delivery.lastHttpStatus??'—'}{#if delivery.lastErrorCode}<br/><code>{delivery.lastErrorCode}</code>{/if}</p><button type="button" disabled={busy} aria-label={`查看通知投递 ${delivery.id}`} onclick={()=>openDelivery(delivery.id)}>查看投递尝试</button></li>{/each}</ul>{/if}{#if detail.deliveriesTruncated}<p>仅显示最近100条投递；总数以完整统计为准。</p>{/if}
  {/if}
</div></Dialog>{/if}

<style>
  .notification-decisions{border-top:1px solid var(--line);margin:18px 0 14px;padding-top:15px;}
  .decision-heading,.decision-toolbar,.decision-filters,.decision-pagination,.decision-row-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}
  .decision-heading h3{font-size:14px;margin:0;}.decision-heading p,.notification-decisions p{font-size:12px;line-height:1.8;overflow-wrap:anywhere;}
  .notification-decisions button,.decision-detail button{font-size:12px;min-height:32px;padding:5px 10px;}
  .decision-summary{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:13px 0;}.decision-summary>div{padding:9px 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface);}.decision-summary dt{font-size:11px;color:var(--muted);}.decision-summary dd{font-size:20px;font-weight:650;margin:0;}
  .decision-toolbar{margin:17px 0 12px;}.decision-periods{display:flex;gap:6px;}.decision-periods button[aria-pressed="true"]{background:#dfe9d8;}
  .decision-export{margin:12px 0;padding:12px;border:1px solid var(--line);border-radius:7px;background:var(--surface);}.decision-export-actions{display:flex;gap:8px;flex-wrap:wrap;}.decision-export p{margin:6px 0 0;}
  .decision-custom-range{display:grid;grid-template-columns:repeat(2,minmax(0,1fr)) auto;gap:10px;align-items:end;padding:12px;border:1px solid var(--line);border-radius:7px;background:var(--surface);}.decision-custom-range label,.decision-filters label{display:flex;gap:7px;align-items:center;font-size:12px;}.decision-custom-range label{display:block;}.decision-custom-range input{width:100%;min-width:0;display:block;margin-top:5px;padding:7px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--ink);font-size:12px;}.decision-custom-range small{grid-column:1/-1;font-size:11px;color:var(--muted);}
  .decision-filters{justify-content:flex-start;margin:14px 0;}.decision-filters select{padding:7px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--ink);font-size:12px;}
  .decision-reason-counts{display:flex;gap:8px 14px;flex-wrap:wrap;font-size:11px;margin:12px 0 16px;color:var(--muted);}.decision-reason-counts strong{color:var(--ink);}.decision-scope{font-size:11px!important;}.decision-delivery-summary{padding:10px;background:var(--surface);border:1px solid var(--line);border-radius:6px;}
  .decision-list,.decision-deliveries{list-style:none;padding:0;margin:0;}.decision-list>li{padding:14px;margin:10px 0;background:var(--surface);border:1px solid var(--line);border-radius:7px;}.decision-row-heading{justify-content:flex-start;}.decision-row-heading strong{font-size:13px;}.decision-meta{font-size:11px!important;}.decision-list code,.decision-detail code{font:11px/1.8 ui-monospace,monospace;overflow-wrap:anywhere;}.decision-pagination{margin:15px 0 8px;font-size:12px;}
  .decision-detail p{font-size:12px;overflow-wrap:anywhere;}.decision-detail dl{font-size:12px;margin:15px 0;}.decision-detail dl>div{display:grid;grid-template-columns:75px minmax(0,1fr);gap:9px;margin:9px 0;}.decision-detail dt{color:var(--muted);}.decision-detail dd{margin:0;overflow-wrap:anywhere;}.decision-detail h3{font-size:14px;margin:20px 0 10px;}.decision-detail ol{list-style:none;padding:0;max-height:280px;overflow:auto;}.decision-detail ol>li,.decision-deliveries>li{padding:11px 0;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:5px;font-size:12px;}.decision-detail time{font-size:11px;color:var(--muted);}
  @media(max-width:800px){.decision-summary{grid-template-columns:repeat(3,minmax(0,1fr));}.decision-summary>div{padding:8px;}.decision-custom-range{grid-template-columns:minmax(0,1fr);}.decision-custom-range button{justify-self:start;}.decision-filters{align-items:flex-start;}.decision-heading{align-items:flex-start;}}
</style>
