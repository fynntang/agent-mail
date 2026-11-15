<script lang="ts">
  import {onMount,onDestroy,tick} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {AsyncExportRetryBatch as Batch,AsyncExportRetryBatchItem as Item,AsyncExportRetryBatchDetail as Detail,
    AsyncExportRetryBatchPreview as Preview,AsyncExportBatchFailureReason,AsyncExportRetryBatchControlOperation as ControlOperation,
    AsyncExportRetryBatchControlResult as ControlResult,AsyncExportRetryBatchOperationList as OperationList} from '#lib/types/async-export-notification-retry-batches.ts';
  type BatchState=Batch['state'];
  type Period='24h'|'7d'|'30d'|'custom';
  type PreviewIntent={clientRequestId:string;from:number;to:number;reason:AsyncExportBatchFailureReason};
  type CommitIntent={batchId:string;clientRequestId:string;expectedVersion:number};
  type ControlIntent=CommitIntent&{kind:'cancel'|'reconcile';deliveryId?:string};
  let {mailboxId}:{mailboxId:string}=$props();
  let period=$state<Period>('7d'),fromText=$state(''),toText=$state(''),reason=$state<AsyncExportBatchFailureReason>('all');
  let batches=$state<Batch[]>([]),cursor=$state<string|null>(null),nextCursor=$state<string|null>(null),previous=$state<(string|null)[]>([]);
  let detail=$state<Detail|null>(null),itemCursor=$state<string|null>(null),itemPrevious=$state<(string|null)[]>([]);
  let loading=$state(true),reading=$state(false),operation=$state<'preview'|'commit'|'cancel'|'reconcile'|null>(null),errorMessage=$state(''),notice=$state(''),now=$state(Date.now());
  let previewIntent=$state<PreviewIntent|null>(null),commitIntent=$state<CommitIntent|null>(null),appliedSignature=$state('');
  let controlIntent=$state<ControlIntent|null>(null),confirmCancel=$state(false),history=$state<OperationList>({operations:[],nextCursor:null}),historyCursor=$state<string|null>(null),historyPrevious=$state<(string|null)[]>([]);
  const busy=$derived(reading||operation!==null),base=$derived(`/owner/api/mailboxes/${mailboxId}/export-notification-retry-batches`),lifetime=new AbortController();
  const pendingIntent=$derived(Boolean(previewIntent||commitIntent||controlIntent));
  const signature=$derived(JSON.stringify([period,fromText,toText,reason]));
  const dirty=$derived(Boolean(detail)&&detail?.batch.state==='preview'&&signature!==appliedSignature);
  const stateLabels:Record<BatchState,string>={preview:'待确认预览',queued:'等待执行',running:'正在执行',completed:'处理完成',expired:'已过期',cancelled:'已停止未执行条目'};
  const operationLabels:Record<ControlOperation['action'],string>={preview:'创建固定预览',commit:'确认提交',cancel:'停止未执行条目',reconcile:'核对未知结果'};
  const itemLabels:Record<Item['state'],string>={pending:'尚未处理',running:'正在核对',requeued:'已重新排队',skipped:'已跳过',failed:'执行失败',unknown:'结果待核对'};
  const reasons:Record<string,string>={all:'全部失败原因',http_rejected:'接收端拒绝',http_retry:'HTTP 重试耗尽',network_error:'网络错误',delivery_timeout:'接收端超时',
    lease_expired:'投递租约失效',lease_lost:'投递租约已更换',invalid_target:'接收地址不可用',payload_unavailable:'冻结内容不可用',signing_key_unavailable:'历史签名密钥不可用',
    mailbox_inactive:'邮箱未启用',endpoint_inactive:'订阅未启用',alert_notifications_disabled:'通知已关闭',alert_recovery_disabled:'恢复通知已关闭',alert_quiet_hours:'通知静默',
    legacy_snapshot_unavailable:'旧冻结快照不可用',other:'其他或无安全诊断'};
  const blockReasons:Record<string,string>={not_dead:'投递已不处于最终失败状态',not_admitted:'原通知未准入',mailbox_inactive:'邮箱未启用',endpoint_inactive:'订阅未启用',budget_exhausted:'尝试预算已达80次',
    notifications_disabled:'当前通知已关闭',quiet_hours:'当前处于静默时段',not_configured:'签名配置缺失',payload_unavailable:'冻结内容不可用',signing_key_unavailable:'历史签名密钥不可用',invalid_target:'冻结接收地址不可用',
    changed:'投递版本已变化',export_notification_retry_changed:'投递版本已变化',export_notification_retry_unavailable:'当前条件不允许重试',export_notification_retry_conflict:'原重试收据条件不一致',
    expired:'批次已过执行期限',batch_expired:'批次已过执行期限',batch_cancelled:'Owner 已停止此条目，未提交重试',not_submitted:'已核对原操作收据，确认未提交重试',preview_blocked:'预览时不可重试',not_found:'原投递已不可访问',unknown:'结果尚未确认',result_unknown:'结果尚未确认',retry_failed:'本次执行未能完成',receipt_conflict:'原操作收据条件不一致'};
  let mounted=false,readController:AbortController|null=null,readWasPoll=false,pollTimer:ReturnType<typeof setTimeout>|undefined,expiryTimer:ReturnType<typeof setTimeout>|undefined;
  onMount(()=>{mounted=true;document.addEventListener('visibilitychange',visibilityChanged);void load(null);});
  onDestroy(()=>{mounted=false;clearTimers();lifetime.abort();readController?.abort();document.removeEventListener('visibilitychange',visibilityChanged);});
  function date(value:number|null):string{return value===null?'—':new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function localDate(value:number):string{return new Date(value-new Date(value).getTimezoneOffset()*60_000).toISOString().slice(0,23);}
  function reasonText(value:string|null):string{return value===null?'—':blockReasons[value]??reasons[value]??'请核对安全诊断代码';}
  function previewExpired(batch:Batch):boolean{return batch.cancelledAt===null&&batch.committedAt===null&&(batch.previewExpiresAt<=now||batch.expiresAt<=now);}
  function active(batch:Batch):boolean{return ['queued','running'].includes(batch.state)||batch.unknownItems>0;}
  function clearTimers(){if(pollTimer)clearTimeout(pollTimer);if(expiryTimer)clearTimeout(expiryTimer);pollTimer=undefined;expiryTimer=undefined;}
  function schedule(){
    clearTimers();if(!mounted||lifetime.signal.aborted||document.visibilityState!=='visible'||busy)return;now=Date.now();
    if(batches.some(active)||detail&&active(detail.batch))pollTimer=setTimeout(()=>{void load(cursor,'same',true);},5000);
    const deadlines=[...batches,...(detail?[detail.batch]:[])].filter(batch=>batch.state==='preview'&&batch.previewExpiresAt>now).map(batch=>batch.previewExpiresAt);
    if(deadlines.length)expiryTimer=setTimeout(()=>{now=Date.now();schedule();},Math.max(1,Math.min(...deadlines)-now+1));
  }
  function visibilityChanged(){clearTimers();now=Date.now();if(document.visibilityState!=='visible'){if(readWasPoll)readController?.abort();return;}if(!busy)void load(cursor,'same',true);}
  async function fetchDetail(id:string,value:string|null,signal:AbortSignal):Promise<Detail>{const query=new URLSearchParams({limit:'10'});if(value)query.set('cursor',value);return ownerRequest<Detail>(`${base}/${id}?${query}`,{signal});}
  async function fetchHistory(id:string,value:string|null,signal:AbortSignal):Promise<OperationList>{const query=new URLSearchParams({limit:'3'});if(value)query.set('cursor',value);return ownerRequest<OperationList>(`${base}/${id}/operations?${query}`,{signal});}
  async function load(value:string|null,direction:'reset'|'next'|'previous'|'same'='reset',poll=false,preserveError=false){
    if(busy||lifetime.signal.aborted)return;clearTimers();reading=true;readWasPoll=poll;if(!poll&&!preserveError)errorMessage='';const request=new AbortController(),old=cursor;readController=request;
    try{
      const query=new URLSearchParams({limit:'5'});if(value)query.set('cursor',value);
      const result=await ownerRequest<{batches:Batch[];nextCursor:string|null}>(`${base}?${query}`,{signal:request.signal});
      if(!request.signal.aborted&&mounted){batches=result.batches;nextCursor=result.nextCursor;cursor=value;previous=direction==='next'?[...previous,old]:direction==='previous'?previous.slice(0,-1):direction==='reset'?[]:previous;now=Date.now();
        if(detail){const [nextDetail,nextHistory]=await Promise.all([fetchDetail(detail.batch.id,itemCursor,request.signal),fetchHistory(detail.batch.id,historyCursor,request.signal)]);if(!request.signal.aborted&&mounted){detail=nextDetail;history=nextHistory;}}}
    }catch(error){if(!request.signal.aborted&&mounted)errorMessage=error instanceof Error?error.message:'批量重试记录读取失败，请刷新重试。';}
    finally{if(readController===request){reading=false;readController=null;readWasPoll=false;loading=false;schedule();}}
  }
  export async function viewBatch(id:string):Promise<void>{
    if(busy||pendingIntent)throw new Error('批次面板正在处理操作，请先完成或核对原操作。');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw new Error('批次标识无效。');
    await openBatch({id});if(detail?.batch.id!==id)throw new Error(errorMessage||'批次读取未完成，请刷新重试。');
    await tick();document.querySelector(`[data-retry-batch="${id}"]`)?.scrollIntoView({block:'start',behavior:'instant'});notice='已定位对应批次，请核对当前结果及操作历史。';
  }
  async function openBatch(batch:Pick<Batch,'id'>,value:string|null=null,direction:'reset'|'next'|'previous'='reset'){
    if(busy||lifetime.signal.aborted||pendingIntent)return;clearTimers();reading=true;errorMessage='';notice='';const request=new AbortController(),old=itemCursor;readController=request;
    try{const [result,nextHistory]=await Promise.all([fetchDetail(batch.id,value,request.signal),fetchHistory(batch.id,direction==='reset'?null:historyCursor,request.signal)]);if(!request.signal.aborted&&mounted){detail=result;history=nextHistory;confirmCancel=false;if(direction==='reset'){historyCursor=null;historyPrevious=[];}itemCursor=value;itemPrevious=direction==='next'?[...itemPrevious,old]:direction==='previous'?itemPrevious.slice(0,-1):[];now=Date.now();
      if(direction==='reset'&&result.batch.state==='preview'){period='custom';fromText=localDate(result.batch.window.from);toText=localDate(result.batch.window.to);reason=result.batch.filters.reason;appliedSignature=JSON.stringify(['custom',fromText,toText,reason]);}}}
    catch(error){if(!request.signal.aborted&&mounted)errorMessage=error instanceof Error?error.message:'批次详情读取失败。';}
    finally{if(readController===request){reading=false;readController=null;schedule();}}
  }
  function buildPreview():PreviewIntent|null{
    const to=period==='custom'?Date.parse(toText):Date.now()+1,from=period==='custom'?Date.parse(fromText):to-(period==='24h'?1:period==='7d'?7:30)*86_400_000;
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<0||from>=to||to-from>31*86_400_000||to>Date.now()+60_000){errorMessage='请选择有效时间范围，起点须早于终点，最多31天。';return null;}
    return {clientRequestId:crypto.randomUUID(),from,to,reason};
  }
  async function preview(){
    if(busy||commitIntent||controlIntent||lifetime.signal.aborted)return;
    if(!previewIntent){const intent=buildPreview();if(!intent)return;previewIntent=intent;appliedSignature=signature;}
    clearTimers();operation='preview';errorMessage='';notice='';const intent={...previewIntent};
    try{const result=await ownerRequest<Preview>(`${base}/preview`,{method:'POST',body:intent,signal:lifetime.signal});if(mounted){detail=result;previewIntent=null;itemCursor=null;itemPrevious=[];historyCursor=null;historyPrevious=[];confirmCancel=false;now=Date.now();notice=result.replayed?'已核对原预览，候选集合保持不变。':'预览已保存。请核对固定范围、候选数和阻止原因后明确确认。';}}
    catch(error){if(mounted)errorMessage=error instanceof Error?error.message:'无法确定预览是否已创建，请沿用本次标识核对。';}
    finally{if(mounted){operation=null;await load(null,'reset',false,true);}}
  }
  async function commit(){
    if(busy||previewIntent||controlIntent||!detail||lifetime.signal.aborted)return;
    if(!commitIntent){if(detail.batch.state!=='preview'||!detail.batch.canCommit||dirty||previewExpired(detail.batch))return;commitIntent={batchId:detail.batch.id,clientRequestId:crypto.randomUUID(),expectedVersion:detail.batch.version};}
    const intent={...commitIntent};clearTimers();operation='commit';errorMessage='';notice='';
    try{const result=await ownerRequest<{batch:Batch;replayed:boolean}>(`${base}/${intent.batchId}/commit`,{method:'POST',body:{clientRequestId:intent.clientRequestId,expectedVersion:intent.expectedVersion},signal:lifetime.signal});
      if(mounted){commitIntent=null;if(detail?.batch.id===intent.batchId)detail={...detail,batch:result.batch};notice=result.replayed?'已核对原提交。本次没有创建第二个批次或重复增加重试预算。':'批次已提交，后台将逐条校验并重新排队。此结果不代表接收端已收到通知。';}}
    catch(error){if(mounted)errorMessage=error instanceof Error?error.message:'无法确定批次是否已提交，请沿用本次标识核对。';}
    finally{if(mounted){operation=null;await load(null,'reset',false,true);}}
  }
  async function control(kind:'cancel'|'reconcile',deliveryId?:string){
    if(busy||previewIntent||commitIntent||!detail||lifetime.signal.aborted)return;
    if(!controlIntent){
      if(kind==='cancel'&&!detail.batch.canCancel||kind==='reconcile'&&detail.batch.unknownItems===0)return;
      controlIntent={kind,batchId:detail.batch.id,clientRequestId:crypto.randomUUID(),expectedVersion:detail.batch.version,...(deliveryId?{deliveryId}:{})};
    }
    const intent={...controlIntent};clearTimers();operation=intent.kind;errorMessage='';notice='';
    try{const {kind:action,batchId,...body}=intent,result=await ownerRequest<ControlResult>(`${base}/${batchId}/${action}`,{method:'POST',body,signal:lifetime.signal});
      if(mounted){controlIntent=null;confirmCancel=false;if(detail.batch.id===batchId)detail={...detail,batch:result.batch};historyCursor=null;historyPrevious=[];
        const summary=result.operation.summary;notice=intent.kind==='cancel'?`${result.replayed?'已核对原停止操作':'已停止尚未执行的条目'}：停止 ${summary.stopped??0} 条，待核对 ${summary.unknown??0} 条，保留结果 ${summary.retained??0} 条。已重新排队的 Webhook 继续按原记录投递。`:
          `${result.replayed?'已核对原对账操作':'原操作收据核对完成'}：已有收据 ${summary.requeued??0} 条，确认未提交 ${summary.notSubmitted??0} 条，仍待核对 ${summary.unresolved??0} 条。本次核对没有重新排队或增加尝试预算。`;}}
    catch(error){if(mounted)errorMessage=error instanceof Error?error.message:'无法确定操作结果，请沿用本次标识核对。';}
    finally{if(mounted){operation=null;await load(null,'reset',false,true);}}
  }
  async function loadHistory(value:string|null,direction:'reset'|'next'|'previous'='reset'){
    if(busy||pendingIntent||!detail||lifetime.signal.aborted)return;clearTimers();reading=true;errorMessage='';const request=new AbortController(),old=historyCursor;readController=request;
    try{const result=await fetchHistory(detail.batch.id,value,request.signal);if(!request.signal.aborted&&mounted){history=result;historyCursor=value;historyPrevious=direction==='next'?[...historyPrevious,old]:direction==='previous'?historyPrevious.slice(0,-1):[];}}
    catch(error){if(!request.signal.aborted&&mounted)errorMessage=error instanceof Error?error.message:'操作历史读取失败。';}
    finally{if(readController===request){reading=false;readController=null;schedule();}}
  }
  function operationSummary(entry:ControlOperation):string{
    const labels:Record<string,string>={stopped:'停止',unknown:'待核对',retained:'保留结果',requeued:'已有收据',notSubmitted:'确认未提交',unresolved:'仍待核对'};
    return Object.entries(entry.summary).filter(([,value])=>value!==undefined).map(([key,value])=>`${labels[key]??key} ${value} 条`).join(' · ');
  }
  function abandon(){if(busy)return;previewIntent=null;commitIntent=null;controlIntent=null;errorMessage='';notice='已放弃本次核对标识。已保存的操作及执行结果仍然保留，请刷新记录并查看操作历史后再决定。';schedule();}
</script>

<section class="retry-batches" aria-labelledby="retry-batches-heading" id="async-export-retry-batches">
  <div class="batch-heading"><div><h4 id="retry-batches-heading">失败投递批量重试</h4><p>仅处理当前邮箱的异步导出通知失败投递。先预览固定候选，再明确提交；预览之后新增的失败不会加入。</p></div><button type="button" disabled={busy} onclick={()=>load(null)}>刷新批量重试记录</button></div>
  <form class="batch-filters" aria-label="批量重试筛选" onsubmit={event=>{event.preventDefault();void preview();}}>
    <fieldset disabled={busy||pendingIntent}><legend class="sr-only">按失败终态时间及原因筛选</legend>
      <div class="batch-filter-row"><label>失败时间范围<select aria-label="失败时间范围" bind:value={period}><option value="24h">最近24小时</option><option value="7d">最近7天</option><option value="30d">最近30天</option><option value="custom">自定义范围</option></select></label><label>失败原因<select aria-label="失败原因" bind:value={reason}>{#each Object.entries(reasons) as [value,label]}<option {value}>{label}</option>{/each}</select></label></div>
      {#if period==='custom'}<div class="batch-filter-row"><label>失败开始时间<input aria-label="失败开始时间" type="datetime-local" step="0.001" bind:value={fromText}/></label><label>失败结束时间<input aria-label="失败结束时间" type="datetime-local" step="0.001" bind:value={toText}/></label></div>{/if}
      <button type="submit">生成批量重试预览</button>
    </fieldset>
  </form>
  <p class="batch-help">按失败投递终态时间筛选，起点包含、终点不包含，最多31天和1000条候选。预览10分钟内可确认，批次在创建后24小时停止新排队。</p>
  {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}{#if notice}<p role="status" class="batch-notice">{notice}</p>{/if}
  {#if pendingIntent}<div class="batch-intent" role="group" aria-label="核对批量操作"><p>已保留本次 {previewIntent?'预览条件':commitIntent?'批次提交条件':controlIntent?.kind==='cancel'?'停止条件':'未知结果核对条件'}和操作标识。沿用原标识核对不会新建第二个操作。</p><div class="batch-actions"><button type="button" disabled={busy} onclick={()=>previewIntent?preview():commitIntent?commit():control(controlIntent!.kind,controlIntent!.deliveryId)}>{previewIntent?'沿用标识核对预览':commitIntent?'沿用标识核对提交':controlIntent?.kind==='cancel'?'沿用标识核对停止操作':'沿用标识核对未知结果'}</button><button type="button" disabled={busy} onclick={abandon}>放弃本次核对</button></div></div>{/if}
  {#if detail}<section class="batch-detail" aria-label="批量重试详情" data-retry-batch={detail.batch.id}>
    <div class="batch-heading"><h5>批次预览与执行结果</h5><span class="badge" class:active={detail.batch.state==='completed'} class:paused={active(detail.batch)}>{previewExpired(detail.batch)?'预览已过期':stateLabels[detail.batch.state]}</span></div>
    <p>固定范围 {date(detail.batch.window.from)} 至 {date(detail.batch.window.to)}（不含结束）<br/>{reasons[detail.batch.filters.reason]??'已保存的失败原因'}</p>
    <p class="batch-counts" aria-label="批量重试统计">候选 {detail.batch.totalItems} · 预览可重试 {detail.batch.eligibleItems} · 预览阻止 {detail.batch.totalItems-detail.batch.eligibleItems}<br/>已处理 {detail.batch.processedItems}/{detail.batch.totalItems} · 已排队 {detail.batch.requeuedItems} · 跳过 {detail.batch.skippedItems} · 失败 {detail.batch.failedItems} · 待核对 {detail.batch.unknownItems}</p>
    <progress aria-label="批量重试进度" max={Math.max(1,detail.batch.totalItems)} value={detail.batch.state==='completed'&&detail.batch.totalItems===0?1:detail.batch.processedItems}></progress>
    <p class="batch-help">创建 {date(detail.batch.createdAt)} · 确认截止 {date(detail.batch.previewExpiresAt)}<br/>执行截止 {date(detail.batch.expiresAt)} · 完成 {date(detail.batch.completedAt)}{#if detail.batch.cancelledAt!==null}<br/>停止未执行条目 {date(detail.batch.cancelledAt)}{/if}</p>
    {#if detail.batch.state==='expired'&&detail.batch.committedAt===null}<p>预览已过期，不能提交，请重新生成并核对。</p>{/if}
    {#if detail.batch.state==='preview'}<div class="batch-confirm" role="group" aria-label="确认批量重试"><p>仅批准预览时可重试的 {detail.batch.eligibleItems} 条投递。执行时再次校验状态、版本、通知策略与冻结签名；不可用项会记录为跳过或失败。</p>{#if dirty}<p>筛选条件已修改，请重新生成预览后再确认。</p>{/if}{#if previewExpired(detail.batch)}<p>预览已过期，不能提交，请重新生成并核对。</p>{:else if !detail.batch.canCommit}<p>此邮箱或批次当前不能提交新的排队，请刷新核对。</p>{/if}<button type="button" disabled={busy||dirty||!detail.batch.canCommit||previewExpired(detail.batch)||pendingIntent} onclick={commit}>确认提交批量重试</button></div>{/if}
    {#if detail.batch.canCancel}<div class="batch-control" role="group" aria-label="停止批量任务"><p>停止此批次尚未执行的条目。已重新排队、跳过和失败的结果会保留；已入队的 Webhook 会继续投递。正在执行但结果不明的条目会转为待核对。</p>
      {#if confirmCancel}<div class="batch-confirm" role="group" aria-label="确认停止批量任务"><p>确认停止当前批次的未执行条目？停止后不能恢复此批次的排队。</p><div class="batch-actions"><button type="button" disabled={busy||pendingIntent} onclick={()=>control('cancel')}>确认停止未执行条目</button><button type="button" disabled={busy||pendingIntent} onclick={()=>confirmCancel=false}>继续执行此批次</button></div></div>
      {:else}<button type="button" disabled={busy||pendingIntent} onclick={()=>confirmCancel=true}>停止未执行条目</button>{/if}</div>{/if}
    {#if detail.batch.state==='cancelled'}<p>停止操作已保存。已执行结果保持保留；待核对条目可继续核对原操作收据。</p>{/if}
    {#if detail.batch.unknownItems>0}<div class="batch-control" role="group" aria-label="核对批量未知结果"><p>沿原操作标识核对不可变收据：有收据则保留已重新排队结果，无收据则确认未提交，条件冲突则保留待核对。每次最多20条，不会重新排队或增加尝试预算。</p><button type="button" disabled={busy||pendingIntent} onclick={()=>control('reconcile')}>核对本批未知结果</button></div>{/if}
    {#if detail.batch.state==='completed'}<p>批次已完成逐条处理。“已排队”不等于投递成功，请在原通知中查看实际 Webhook 状态。</p>{/if}
    <ul class="batch-items">{#each detail.items as item (item.deliveryId)}<li data-batch-delivery={item.deliveryId}><div class="batch-heading"><strong>{itemLabels[item.state]}</strong><span>{item.previewEligible?'预览可重试':'预览阻止'}</span></div><p>投递 <code>{item.deliveryId}</code><br/>导出任务 <code>{item.jobId}</code></p><p>原失败 {reasons[item.failureReason]??'其他或无安全诊断'} · {date(item.failedAt)}</p><p>{reasonText(item.reason??item.previewReason)}{#if item.reason||item.previewReason} · <code>{item.reason??item.previewReason}</code>{/if}</p><p class="batch-help">更新 {date(item.updatedAt)}{#if item.manualRetryId}<br/>手动重试收据 <code>{item.manualRetryId}</code>{/if}</p>{#if item.state==='unknown'}<button type="button" disabled={busy||pendingIntent} aria-label={`核对原操作收据 ${item.deliveryId}`} onclick={()=>control('reconcile',item.deliveryId)}>核对此条原操作收据</button>{/if}</li>{/each}</ul>
    <nav class="batch-pagination" aria-label="批量重试明细分页"><button type="button" disabled={busy||pendingIntent||!itemPrevious.length} onclick={()=>openBatch(detail!.batch,itemPrevious.at(-1)??null,'previous')}>上一页</button><span>本页 {detail.items.length} 条候选</span><button type="button" disabled={busy||pendingIntent||!detail.nextCursor} onclick={()=>openBatch(detail!.batch,detail!.nextCursor,'next')}>下一页</button></nav>
    <section class="batch-history" aria-label="批量任务操作历史"><div class="batch-heading"><h6>操作历史</h6><button type="button" disabled={busy||pendingIntent} onclick={()=>loadHistory(null)}>刷新操作历史</button></div><p class="batch-help">记录预览、提交、停止与手动对账。重放同一操作标识只读取原收据。</p>
      {#if !history.operations.length}<p>此批次尚无可查看的操作记录。</p>{:else}<ol class="batch-operations">{#each history.operations as entry (entry.id)}<li data-batch-operation={entry.id}><strong>{operationLabels[entry.action]}</strong><p>{date(entry.occurredAt)}{#if entry.expectedVersion!==null} · 请求版本 {entry.expectedVersion}{/if}</p>{#if operationSummary(entry)}<p>{operationSummary(entry)}</p>{/if}<p class="batch-help">操作收据 <code>{entry.id}</code>{#if entry.clientRequestId}<br/>操作标识 <code>{entry.clientRequestId}</code>{/if}</p>{#if entry.items?.length}<ul>{#each entry.items as result}<li><code>{result.deliveryId}</code>：{result.outcome==='receipt_found'?'已有重试收据':result.outcome==='not_submitted'?'确认未提交':'原收据条件冲突'} · {itemLabels[result.beforeState]} → {itemLabels[result.afterState]}</li>{/each}</ul>{/if}</li>{/each}</ol>{/if}
      <nav class="batch-pagination" aria-label="批量任务操作历史分页"><button type="button" disabled={busy||pendingIntent||!historyPrevious.length} onclick={()=>loadHistory(historyPrevious.at(-1)??null,'previous')}>上一页</button><span>本页 {history.operations.length} 条操作</span><button type="button" disabled={busy||pendingIntent||!history.nextCursor} onclick={()=>loadHistory(history.nextCursor,'next')}>下一页</button></nav>
    </section>
  </section>{/if}
  {#if loading}<p role="status">正在读取批量重试记录…</p>{:else if !batches.length}<p>当前邮箱尚无批量重试预览。</p>{:else}<ul class="batch-list">{#each batches as batch (batch.id)}<li data-retry-batch-record={batch.id}><div><strong>{previewExpired(batch)?'预览已过期':stateLabels[batch.state]}</strong><p>{date(batch.createdAt)} · 候选 {batch.totalItems} · 已处理 {batch.processedItems} · 待核对 {batch.unknownItems}</p></div><button type="button" disabled={busy||pendingIntent} aria-label={`查看批量重试 ${batch.id}`} onclick={()=>openBatch(batch)}>查看批次</button></li>{/each}</ul>{/if}
  <nav class="batch-pagination" aria-label="批量重试记录分页"><button type="button" disabled={busy||pendingIntent||!previous.length} onclick={()=>load(previous.at(-1)??null,'previous')}>上一页</button><span>本页 {batches.length} 个批次</span><button type="button" disabled={busy||pendingIntent||!nextCursor} onclick={()=>load(nextCursor,'next')}>下一页</button></nav>
</section>

<style>
  .retry-batches{margin:12px 0 18px;padding:13px;border:1px solid var(--line);border-radius:7px;background:var(--surface);scroll-margin-top:20px;}
  .batch-heading,.batch-actions,.batch-pagination,.batch-filter-row,.batch-list>li{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:9px;}.batch-heading{align-items:flex-start;}.batch-heading h4{margin:0;font-size:14px;}.retry-batches p{font-size:12px;line-height:1.8;overflow-wrap:anywhere;}.retry-batches button,.retry-batches input,.retry-batches select{font-size:12px;min-height:32px;padding:5px 10px;max-width:100%;}
  .batch-filters fieldset{padding:0;border:0;min-width:0;}.batch-filter-row{justify-content:flex-start;margin:9px 0;align-items:flex-end;}.batch-filter-row label{display:grid;gap:5px;font-size:12px;min-width:0;}.batch-filter-row input{width:240px;}.batch-help,.batch-pagination{font-size:11px!important;color:var(--muted);}.batch-actions{justify-content:flex-start;}.batch-notice{color:var(--green);}
  .batch-intent,.batch-confirm,.batch-control{padding:10px;border:1px solid var(--line);border-radius:6px;margin:10px 0;}.batch-detail{padding-top:14px;margin:14px 0;border-top:1px solid var(--line);}.batch-detail h5{margin:0;font-size:13px;}.batch-counts{font-weight:650;}.batch-detail progress{width:100%;height:10px;accent-color:var(--green);}.batch-items,.batch-list,.batch-operations{list-style:none;padding:0;margin:12px 0;}.batch-items>li,.batch-operations>li{border-top:1px solid var(--line);padding:10px 0;}.batch-items strong,.batch-list strong,.batch-operations strong{font-size:12px;}.retry-batches code{font-size:11px;overflow-wrap:anywhere;}.batch-list>li{padding:10px 0;border-top:1px solid var(--line);}.batch-list p{margin:3px 0;}.batch-history{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);}.batch-history h6{font-size:13px;margin:0;}.batch-operations ul{padding-left:18px;font-size:11px;line-height:1.8;overflow-wrap:anywhere;}
  @media(max-width:800px){.retry-batches{padding:10px;}.batch-heading>button{margin-bottom:5px;}.batch-filter-row{display:block;}.batch-filter-row label{margin:9px 0;}.batch-filter-row input,.batch-filter-row select{width:100%;}.batch-list>li{align-items:flex-start;}}
</style>
