<script lang="ts">
  import {onMount,onDestroy,tick} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {AlertNotificationDecisionReason} from '#lib/types/alert-notification-decisions.ts';
  import type {AsyncAlertNotificationExport as ExportJob} from '#lib/types/async-alert-notification-exports.ts';
  import AsyncExportNotifications from './AsyncExportNotifications.svelte';
  type AppliedFilters={decision:'all'|AlertNotificationDecisionReason;eventType:'all'|'created'|'resolved';from:number;to:number};
  type CreateInput=AppliedFilters&{format:'csv'|'json';clientRequestId:string};
  let {mailboxId,filters,disabled=false}:{mailboxId:string;filters:AppliedFilters;disabled?:boolean}=$props();
  let jobs=$state<ExportJob[]>([]),loading=$state(true),reading=$state(false),busy=$state(false),errorMessage=$state(''),notice=$state('');
  let cursor=$state<string|null>(null),nextCursor=$state<string|null>(null),previous=$state<(string|null)[]>([]),limit=$state(10);
  let pendingIntent=$state<CreateInput|null>(null),now=$state(Date.now());
  let notificationRevision=$state(0);
  const base=$derived(`/owner/api/mailboxes/${mailboxId}/alert-notification-exports`),lifetime=new AbortController();
  let listRequest:AbortController|null=null,listWasPoll=false,pollTimer:ReturnType<typeof setTimeout>|undefined,expiryTimer:ReturnType<typeof setTimeout>|undefined;
  let mounted=false;
  const labels:Record<ExportJob['state'],string>={queued:'等待处理',running:'正在生成',succeeded:'可下载',failed:'生成失败',cancelled:'已取消',expired:'已过期'};
  const reasonLabels:Record<AppliedFilters['decision'],string>={all:'全部决策',allowed:'已准入',disabled:'通知关闭',quiet_hours:'静默命中',repeat_limited:'限频命中',recovery_disabled:'恢复通知关闭',no_subscribers:'无匹配订阅'};
  onMount(()=>{mounted=true;document.addEventListener('visibilitychange',visibilityChanged);void load(null);});
  onDestroy(()=>{mounted=false;clearTimers();listRequest?.abort();lifetime.abort();document.removeEventListener('visibilitychange',visibilityChanged);});
  function date(value:number|null):string{return value===null?'—':new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function bytes(value:number):string{return value<1024?`${value} B`:value<1024*1024?`${(value/1024).toFixed(1)} KiB`:`${(value/(1024*1024)).toFixed(1)} MiB`;}
  function jobState(job:ExportJob):ExportJob['state']{return job.expiresAt<=now&&['queued','running','succeeded'].includes(job.state)?'expired':job.state;}
  function active(job:ExportJob):boolean{return ['queued','running'].includes(jobState(job));}
  function clearTimers(){if(pollTimer)clearTimeout(pollTimer);if(expiryTimer)clearTimeout(expiryTimer);pollTimer=undefined;expiryTimer=undefined;}
  function schedule(){
    clearTimers();if(!mounted||lifetime.signal.aborted||document.visibilityState!=='visible'||busy||reading)return;now=Date.now();
    if(jobs.some(active))pollTimer=setTimeout(()=>{void load(cursor,'same',true);},5000);
    const expires=jobs.filter(job=>job.expiresAt>now&&['queued','running','succeeded'].includes(job.state)).map(job=>job.expiresAt);
    if(expires.length)expiryTimer=setTimeout(()=>{now=Date.now();schedule();},Math.max(1,Math.min(...expires)-now+1));
  }
  function visibilityChanged(){
    clearTimers();now=Date.now();
    if(document.visibilityState!=='visible'){if(listWasPoll)listRequest?.abort();return;}
    if(jobs.some(active)&&!busy&&!reading)void load(cursor,'same',true);else schedule();
  }
  async function load(value:string|null,direction:'reset'|'next'|'previous'|'same'='reset',poll=false):Promise<void>{
    if(busy||reading||lifetime.signal.aborted)return;clearTimers();reading=true;listWasPoll=poll;if(!poll)errorMessage='';
    const request=new AbortController(),old=cursor;listRequest=request;
    try{
      const query=new URLSearchParams({limit:String(limit)});if(value)query.set('cursor',value);
      const result=await ownerRequest<{jobs:ExportJob[];nextCursor:string|null}>(`${base}?${query}`,{signal:request.signal});
      if(!request.signal.aborted&&mounted){jobs=result.jobs;nextCursor=result.nextCursor;cursor=value;now=Date.now();previous=direction==='next'?[...previous,old]:direction==='previous'?previous.slice(0,-1):direction==='reset'?[]:previous;notificationRevision++;}
    }catch(error){if(!request.signal.aborted&&mounted)errorMessage=error instanceof Error?error.message:'后台导出任务读取失败，请刷新重试。';}
    finally{if(listRequest===request){listRequest=null;listWasPoll=false;reading=false;loading=false;schedule();}}
  }
  async function submitIntent(){
    if(!pendingIntent||busy||reading||lifetime.signal.aborted)return;clearTimers();busy=true;errorMessage='';notice='';
    const intent={...pendingIntent};let created=false;
    try{
      await ownerRequest<{job:ExportJob}>(base,{method:'POST',body:intent,signal:lifetime.signal});
      if(mounted){pendingIntent=null;notice='后台导出任务已创建。可离开此页，稍后回来查看进度。';created=true;}
    }catch(error){if(mounted)errorMessage=error instanceof Error?error.message:'无法确定任务是否已创建，请沿用本次标识重试并核对列表。';}
    finally{if(mounted){busy=false;if(created)await load(null);else schedule();}}
  }
  async function create(format:'csv'|'json'){
    if(disabled||busy||reading||pendingIntent)return;pendingIntent={...filters,format,clientRequestId:crypto.randomUUID()};await submitIntent();
  }
  async function cancel(job:ExportJob){
    if(busy||reading||!job.canCancel||!active(job))return;clearTimers();busy=true;errorMessage='';notice='';
    try{await ownerRequest(`${base}/${job.id}/cancel`,{method:'POST',body:{expectedVersion:job.version},signal:lifetime.signal});if(mounted)notice='任务已取消，未完成文件不可下载，临时数据会由后台清理。';}
    catch(error){if(mounted)errorMessage=error instanceof Error?error.message:'取消未完成，请刷新任务状态。';}
    finally{if(mounted){busy=false;await load(cursor,'same',true);}}
  }
  async function download(job:ExportJob){
    if(busy||reading||jobState(job)!=='succeeded'||!job.downloadAvailable)return;clearTimers();busy=true;errorMessage='';notice='';
    try{
      const latest=(await ownerRequest<{job:ExportJob}>(`${base}/${job.id}`,{signal:lifetime.signal})).job;now=Date.now();
      if(!mounted)return;
      if(!latest.downloadAvailable||jobState(latest)!=='succeeded'){jobs=jobs.map(item=>item.id===latest.id?latest:item);errorMessage='文件尚不可下载或已过期，请刷新任务状态。';return;}
      // Use the browser's streaming download, so a large file never becomes a page-sized Blob.
      const link=document.createElement('a');link.href=`${base}/${latest.id}/download`;link.rel='noopener';link.setAttribute('data-sveltekit-reload','');document.body.appendChild(link);link.click();link.remove();notice='已开始下载。文件通过当前 Owner 登录校验后传输。';
    }catch(error){if(mounted)errorMessage=error instanceof Error?error.message:'下载未开始，请刷新或重新登录。';}
    finally{if(mounted){busy=false;schedule();}}
  }
  function abandonIntent(){if(busy)return;pendingIntent=null;errorMessage='';notice='已放弃本次重试标识。此操作不会取消可能已创建的任务，请先刷新列表核对。';}
  async function viewTask(id:string):Promise<void>{
    if(busy||reading)throw new Error('后台任务正在读取，请稍后再试。');clearTimers();busy=true;errorMessage='';
    try{
      const value=await ownerRequest<{job:ExportJob}>(`${base}/${id}`,{signal:lifetime.signal});
      if(!mounted)return;jobs=[value.job];cursor=null;nextCursor=null;previous=[];now=Date.now();notice='已定位对应任务；点击“刷新后台任务”可返回最新任务列表。';
      await tick();document.getElementById(`async-export-job-${id}`)?.scrollIntoView({block:'center',behavior:'instant'});
    }finally{if(mounted){busy=false;schedule();}}
  }
</script>

<section class="async-exports" aria-labelledby="async-exports-heading">
  <AsyncExportNotifications {mailboxId} revision={notificationRevision} onViewTask={viewTask}/>
  <div class="async-heading"><div><h4 id="async-exports-heading">后台大批量导出</h4><p>使用当前已应用的时间范围和筛选。任务分批生成，完成后可下载，文件在创建后24小时过期。</p></div><button type="button" disabled={busy||reading} onclick={()=>load(null)}>刷新后台任务</button></div>
  <div class="async-actions"><button type="button" disabled={disabled||busy||reading||loading||Boolean(pendingIntent)} onclick={()=>create('csv')}>创建后台 CSV</button><button type="button" disabled={disabled||busy||reading||loading||Boolean(pendingIntent)} onclick={()=>create('json')}>创建后台 JSON</button></div>
  <p class="async-helper">每个邮箱最多2个进行中任务，本实例最多4个。支持最多10万条决策、100万条投递及256 MiB；超限会明确失败，不提供截断文件。</p>
  <p class="async-helper">决策范围在创建时固定；Webhook 结果按各批次读取时记录，文件统计与导出的明细一致。</p>
  {#if disabled}<p class="async-helper">请先完成当前查询并应用时间范围，再创建后台任务。</p>{/if}
  {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}{#if notice}<p role="status" class="async-notice">{notice}</p>{/if}
  {#if pendingIntent}<div class="async-retry"><p>已保留本次 {pendingIntent.format.toUpperCase()} 创建条件。重试会沿用同一操作标识，避免重复创建任务；也可刷新列表核对后放弃重试并调整条件。</p><div class="async-actions"><button type="button" disabled={busy||reading} onclick={submitIntent}>重试创建并核对</button><button type="button" disabled={busy||reading} onclick={abandonIntent}>放弃本次重试</button></div></div>{/if}
  {#if loading}<p role="status">正在读取后台导出任务…</p>{:else if !jobs.length}<p class="async-empty">尚无后台导出任务。</p>{:else}
    <ul class="async-job-list">{#each jobs as job (job.id)}<li id={`async-export-job-${job.id}`} data-export-job={job.id}>
      <div class="async-job-heading"><strong>{job.format.toUpperCase()} 导出</strong><span class="badge" class:active={jobState(job)==='succeeded'} class:paused={active(job)}>{jobState(job)==='queued'&&job.processedDecisions>0?'等待继续':labels[jobState(job)]}</span></div>
      <p>{reasonLabels[job.filters.decision]} · {job.filters.eventType==='all'?'全部通知':job.filters.eventType==='created'?'故障通知':'恢复通知'}<br/>{date(job.window.from)} 至 {date(job.window.to)}（不含结束）</p>
      <label class="async-progress">决策进度 <strong>{job.processedDecisions}/{job.totalDecisions}</strong><progress max={Math.max(1,job.totalDecisions)} value={jobState(job)==='succeeded'&&job.totalDecisions===0?1:job.processedDecisions}></progress></label>
      <p>已记录投递 {job.processedDeliveries} 条 · 已生成 {bytes(job.bodyBytes)}{#if job.summary} · 已准入 {job.summary.allowed} · 已跳过 {job.summary.skipped}{/if}</p>
      <p class="async-meta">创建 {date(job.createdAt)}<br/>过期 {date(job.expiresAt)}{#if job.observedFrom!==null}<br/>投递结果读取时段 {date(job.observedFrom)} 至 {date(job.observedTo)}{/if}</p>
      {#if jobState(job)==='expired'}<p>临时文件已过期，不能继续下载。</p>{:else if job.errorCode}<p class="async-error">{active(job)?'本次处理暂未完成，任务会在后台继续尝试。':jobState(job)==='cancelled'?'任务已停止，临时数据将由后台清理。':'任务已停止生成，请核对提示后重新创建。'} <code>{job.errorCode}</code></p>{/if}
      <div class="async-actions">{#if job.canCancel&&active(job)}<button type="button" disabled={busy||reading} aria-label={`取消后台任务 ${job.id}`} onclick={()=>cancel(job)}>取消任务</button>{/if}{#if jobState(job)==='succeeded'&&job.downloadAvailable}<button type="button" disabled={busy||reading} aria-label={`下载后台任务 ${job.id}`} onclick={()=>download(job)}>下载 {job.format.toUpperCase()}</button>{/if}</div>
    </li>{/each}</ul>
  {/if}
  <nav class="async-pagination" aria-label="后台导出任务分页"><button type="button" disabled={busy||reading||!previous.length} onclick={()=>load(previous.at(-1)??null,'previous')}>上一页</button><span>本页 {jobs.length} 个任务</span><button type="button" disabled={busy||reading||!nextCursor} onclick={()=>load(nextCursor,'next')}>下一页</button></nav>
</section>

<style>
  .async-exports{margin-top:13px;padding-top:16px;border-top:1px solid var(--line);}
  .async-heading,.async-actions,.async-job-heading,.async-pagination{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:9px;}
  .async-heading{align-items:flex-start;}.async-heading h4{font-size:14px;margin:0;}.async-heading p,.async-exports p{font-size:12px;line-height:1.8;overflow-wrap:anywhere;}
  .async-actions{justify-content:flex-start;}.async-exports button{font-size:12px;min-height:32px;padding:5px 10px;}
  .async-helper,.async-meta,.async-pagination{font-size:11px!important;color:var(--muted);}.async-notice{color:var(--green);}
  .async-retry{padding:10px 12px;border:1px solid var(--line);border-radius:6px;margin:10px 0;background:var(--surface);}
  .async-job-list{list-style:none;padding:0;margin:13px 0;}.async-job-list>li{padding:13px;background:var(--surface);border:1px solid var(--line);border-radius:7px;margin:9px 0;}
  .async-job-heading{justify-content:flex-start;}.async-job-heading strong{font-size:13px;}.async-progress{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:12px;}
  .async-progress progress{width:100%;height:10px;accent-color:var(--green);}.async-error code{font-size:11px;overflow-wrap:anywhere;}.async-pagination{margin-top:12px;}
  @media(max-width:800px){.async-heading>button{margin-bottom:5px;}.async-job-list>li{padding:11px;}}
</style>
