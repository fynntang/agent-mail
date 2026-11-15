<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {AsyncExportNotificationDeliveryResults as Results,AsyncExportNotificationDeliveryDetail as Detail,AsyncExportTrackedDelivery as Delivery,
    AsyncExportNotificationDeliveryRetryResult as RetryResult,AsyncExportDeliveryRetryBlockReason as BlockReason} from '#lib/types/async-export-notification-deliveries.ts';
  let {mailboxId,jobId,onBusyChange}:{mailboxId:string;jobId:string;onBusyChange?:(busy:boolean)=>void}=$props();
  let result=$state<Results|null>(null),detail=$state<Detail|null>(null),loading=$state(true),busy=$state(false),errorMessage=$state(''),notice=$state('');
  let cursor=$state<string|null>(null),previous=$state<(string|null)[]>([]);
  let retryTarget=$state<Delivery|null>(null),retryIntent=$state<{deliveryId:string;clientRequestId:string;expectedUpdatedAt:number}|null>(null);
  const base=$derived(`/owner/api/mailboxes/${mailboxId}/export-notifications/${jobId}`),controller=new AbortController();
  const stateLabels:Record<Delivery['state'],string>={pending:'等待投递',running:'投递中',succeeded:'投递成功',dead:'已停止重试',cancelled:'已取消'};
  const blocks:Record<BlockReason,string>={not_dead:'只有最终失败的投递可以重新排队。',not_admitted:'此通知未准入，不能重新发送。',mailbox_inactive:'邮箱当前未启用，恢复后再核对。',endpoint_inactive:'接收端已暂停或停用。',budget_exhausted:'已达到累计80次尝试预算。',notifications_disabled:'此邮箱的通知开关已关闭。',quiet_hours:'当前处于通知静默时段。',not_configured:'Webhook 加密密钥尚未配置。',payload_unavailable:'冻结的事件内容不可用，请核对记录。',signing_key_unavailable:'历史签名密钥不可用，请恢复对应部署密钥。',invalid_target:'冻结接收地址当前不可用。'};
  const attemptLabels:Record<string,string>={started:'已开始',succeeded:'成功',retry:'等待重试',dead:'停止重试',expired:'租约失效',cancelled:'已取消'};
  onMount(()=>{void load(null);});onDestroy(()=>{controller.abort();onBusyChange?.(false);});
  function setBusy(value:boolean){busy=value;onBusyChange?.(value);}
  function date(value:number|null):string{return value===null?'—':new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function block(delivery:Delivery):string{return delivery.retry.reason?blocks[delivery.retry.reason]:'可由 Owner 核对后重新排队。';}
  function publication():string{return result?.publication==='pending_projection'?'等待生成通知事件':result?.publication==='pending_publication'?'事件已生成，等待发布和通知策略评估':'事件已发布，通知决策已记录';}
  function decision():string{const value=result?.notification.notificationDecision;return value===null?'等待评估通知策略':({allowed:'已准入',disabled:'通知关闭，已跳过',quiet_hours:'静默命中，已跳过',repeat_limited:'重复限频，已跳过',no_subscribers:'无匹配订阅，已跳过'} as Record<string,string>)[value??'']??'通知决策暂不可用';}
  async function page(value:string|null){
    const query=new URLSearchParams({limit:'5'});if(value)query.set('cursor',value);
    const next=await ownerRequest<Results>(`${base}/delivery-results?${query}`,{signal:controller.signal});if(!controller.signal.aborted){result=next;cursor=value;}
  }
  async function load(value:string|null,direction:'reset'|'next'|'previous'|'same'='reset'){
    if(busy||controller.signal.aborted)return;setBusy(true);errorMessage='';const old=cursor;
    try{await page(value);if(!controller.signal.aborted){previous=direction==='next'?[...previous,old]:direction==='previous'?previous.slice(0,-1):direction==='reset'?[]:previous;if(detail)detail=await ownerRequest<Detail>(`${base}/deliveries/${detail.delivery.id}`,{signal:controller.signal});}}
    catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'通知投递结果读取失败，请刷新核对。';}
    finally{if(!controller.signal.aborted){loading=false;setBusy(false);}}
  }
  async function openDelivery(delivery:Delivery){
    if(busy||retryIntent)return;setBusy(true);errorMessage='';notice='';retryTarget=null;
    try{const next=await ownerRequest<Detail>(`${base}/deliveries/${delivery.id}`,{signal:controller.signal});if(!controller.signal.aborted)detail=next;}
    catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'投递详情读取失败。';}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  function prepareRetry(delivery:Delivery){if(busy||retryIntent||!delivery.retry.available)return;retryTarget={...delivery,retry:{...delivery.retry}};errorMessage='';notice='';}
  async function retry(){
    if(busy||controller.signal.aborted||!retryTarget&&!retryIntent)return;
    if(!retryIntent&&retryTarget)retryIntent={deliveryId:retryTarget.id,clientRequestId:crypto.randomUUID(),expectedUpdatedAt:retryTarget.updatedAt};
    const intent=retryIntent!;setBusy(true);errorMessage='';notice='';
    try{
      const response=await ownerRequest<RetryResult>(`${base}/deliveries/${intent.deliveryId}/retry`,{method:'POST',body:{clientRequestId:intent.clientRequestId,expectedUpdatedAt:intent.expectedUpdatedAt},signal:controller.signal});
      if(controller.signal.aborted)return;retryIntent=null;retryTarget=null;
      notice=response.replayed?'已核对原重试收据，本次没有增加预算或再次排队。请查看投递当前状态。':'已重新排队，尚未代表接收端收到通知。事件、投递 ID、载荷和签名版本保持不变。';
      await page(cursor);detail=await ownerRequest<Detail>(`${base}/deliveries/${intent.deliveryId}`,{signal:controller.signal});
    }catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'无法确定是否已排队，请沿用本次标识核对。';}
    finally{if(!controller.signal.aborted)setBusy(false);}
  }
  function abandon(){if(busy)return;retryIntent=null;retryTarget=null;errorMessage='';notice='已放弃本次核对标识。此操作不会撤销可能已排队的投递，请刷新查看当前状态。';}
</script>

<section class="export-delivery-results" aria-label="导出通知投递追踪">
  <div class="tracking-heading"><h3>通知决策与 Webhook 投递</h3><button type="button" disabled={busy} onclick={()=>load(cursor,'same')}>刷新投递结果</button></div>
  {#if loading}<p role="status">正在读取通知投递结果…</p>{/if}
  {#if result}
    <p class="tracking-decision" aria-label="导出通知决策">{decision()} · 策略版本 {result.notification.policyVersion??'—'}<br/>{publication()}<br/>决策时间 {date(result.notification.decidedAt)}</p>
    <p class="tracking-summary" aria-label="通知投递统计">订阅投递 {result.deliverySummary.total} · 成功 {result.deliverySummary.succeeded} · 等待 {result.deliverySummary.pending} · 投递中 {result.deliverySummary.running} · 停止 {result.deliverySummary.dead} · 取消 {result.deliverySummary.cancelled}<br/>累计尝试 {result.deliverySummary.attempts} · 当前静默暂缓 {result.deliverySummary.quietDeferred}</p>
    {#if result.notification.notificationDecision&&result.notification.notificationDecision!=='allowed'}<p>本次通知已按策略跳过，不会补发，也不能手动生成投递。</p>{/if}
    {#if !result.deliveries.length}<p>{result.publication!=='published'?'发布完成后会在此显示相应投递；刷新不会推进发送。':result.notification.notificationDecision==='allowed'?'已准入，但当前没有关联投递，请刷新核对发布状态。':'当前没有 Webhook 投递记录。'}</p>{:else}
      <ul class="tracked-deliveries">{#each result.deliveries as delivery (delivery.id)}<li data-notification-delivery={delivery.id}>
        <div class="tracking-heading"><strong>{stateLabels[delivery.state]}</strong><span>尝试 {delivery.attempts}/{delivery.attemptBudget}</span></div>
        <p>投递 ID <code>{delivery.id}</code><br/>接收端 ID <code>{delivery.endpointId}</code></p>
        <p>{delivery.lastHttpStatus===null?'尚无 HTTP 状态':`HTTP ${delivery.lastHttpStatus}`}{#if delivery.lastErrorCode} · <code>{delivery.lastErrorCode}</code>{/if}<br/>下次可投递 {date(delivery.availableAt)} · 签名版本 {delivery.secretVersion}</p>
        <p class="tracking-helper">{block(delivery)}</p>
        <div class="tracking-actions"><button type="button" disabled={busy||Boolean(retryIntent)} aria-label={`查看通知投递 ${delivery.id}`} onclick={()=>openDelivery(delivery)}>尝试与重试记录</button>{#if delivery.state==='dead'}<button type="button" disabled={busy||Boolean(retryIntent)||!delivery.retry.available} aria-label={`准备重试通知投递 ${delivery.id}`} onclick={()=>prepareRetry(delivery)}>重新排队</button>{/if}</div>
      </li>{/each}</ul>
    {/if}
    <nav class="tracking-pagination" aria-label="通知投递分页"><button type="button" disabled={busy||Boolean(retryIntent)||!previous.length} onclick={()=>load(previous.at(-1)??null,'previous')}>上一页</button><span>本页 {result.deliveries.length} 条投递</span><button type="button" disabled={busy||Boolean(retryIntent)||!result.nextCursor} onclick={()=>load(result?.nextCursor??null,'next')}>下一页</button></nav>
  {/if}
  {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}{#if notice}<p role="status">{notice}</p>{/if}
  {#if retryTarget||retryIntent}<div class="tracking-retry" role="group" aria-label="确认通知投递重试"><h4>{retryIntent?'核对本次重新排队':'确认重新排队'}</h4><p>仅重试这条已准入的失败投递，保留原事件与签名版本，增加有限尝试预算。当前通知策略仍会在发送前再次检查。</p><code>{retryIntent?.deliveryId??retryTarget?.id}</code>{#if retryIntent}<p>已保留本次操作标识及原版本。沿用标识核对不会重复增加预算；刷新结果不会自动提交。</p>{/if}<div class="tracking-actions"><button type="button" disabled={busy} onclick={retry}>{retryIntent?'沿用标识核对重试':'确认重新排队'}</button><button type="button" disabled={busy} onclick={abandon}>{retryIntent?'放弃本次核对':'取消重新排队'}</button></div></div>{/if}
  {#if detail}<section class="tracking-detail" aria-label="通知投递详情"><div class="tracking-heading"><h4>投递尝试与手动重试记录</h4><button type="button" disabled={busy||Boolean(retryIntent)} onclick={()=>{detail=null;retryTarget=null;}}>收起投递详情</button></div><code>{detail.delivery.id}</code><p>{stateLabels[detail.delivery.state]} · 当前通知{detail.currentPolicy.enabled?'开启':'关闭'} · {detail.currentPolicy.quiet?'处于静默':'当前非静默'} · 策略版本 {detail.currentPolicy.version}</p><p>{block(detail.delivery)}</p>
    <h5>传输尝试</h5>{#if !detail.attempts.length}<p>尚无传输尝试。</p>{:else}<ol class="tracking-log">{#each detail.attempts as attempt (attempt.id)}<li><strong>第 {attempt.attemptNo} 次 · {attemptLabels[attempt.outcome]??attempt.outcome}</strong><span>{attempt.httpStatus===null?'无 HTTP 响应':`HTTP ${attempt.httpStatus}`}{#if attempt.errorCode} · <code>{attempt.errorCode}</code>{/if}</span><small>{date(attempt.startedAt)} → {date(attempt.finishedAt)}</small></li>{/each}</ol>{/if}
    <h5>Owner 手动重试</h5>{#if !detail.manualRetries.length}<p>尚无手动重试记录。</p>{:else}<ol class="tracking-log">{#each detail.manualRetries as manual (manual.id)}<li><strong>已请求重新排队 · {date(manual.requestedAt)}</strong><span>尝试预算 {manual.previousAttemptBudget??'—'} → {manual.attemptBudget??'—'}</span><small>操作标识 <code>{manual.clientRequestId??'旧版记录未保存标识'}</code></small></li>{/each}</ol>{/if}
    <p class="tracking-helper">记录只展示安全状态与诊断代码；手动排队记录不代表实际 HTTP 发送或接收成功。</p>
    {#if detail.delivery.state==='dead'}<button type="button" disabled={busy||Boolean(retryIntent)||!detail.delivery.retry.available} onclick={()=>prepareRetry(detail!.delivery)}>重试此通知投递</button>{/if}
  </section>{/if}
</section>

<style>
  .export-delivery-results{border-top:1px solid var(--line);margin-top:16px;padding-top:13px;min-width:0;}.tracking-heading,.tracking-actions,.tracking-pagination{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}.tracking-actions{justify-content:flex-start;}.tracking-heading h3,.tracking-heading h4{margin:0;font-size:13px;}.export-delivery-results p,.export-delivery-results li{font-size:12px;line-height:1.8;overflow-wrap:anywhere;}.export-delivery-results code{font-size:10px;overflow-wrap:anywhere;word-break:break-word;}.export-delivery-results button{font-size:11px;min-height:32px;padding:5px 9px;}.tracking-helper,.tracking-pagination{font-size:11px!important;color:var(--muted);}.tracking-summary,.tracking-decision{background:var(--surface);padding:8px;border-radius:5px;}.tracked-deliveries{list-style:none;padding:0;}.tracked-deliveries>li{border:1px solid var(--line);padding:10px;margin:9px 0;border-radius:6px;}.tracking-pagination{margin:10px 0;}.tracking-retry,.tracking-detail{border:1px solid var(--line);padding:10px;margin-top:12px;border-radius:6px;}.tracking-retry h4,.tracking-detail h5{font-size:12px;margin:4px 0 8px;}.tracking-log{padding-left:18px;}.tracking-log li{margin:8px 0;}.tracking-log span,.tracking-log small{display:block;}.tracking-log small{font-size:10px;color:var(--muted);}
</style>
