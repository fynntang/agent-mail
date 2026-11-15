<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {invalidateAll} from '$app/navigation';
  import {ownerRequest} from '#lib/owner-client.ts';
  import Dialog from './Dialog.svelte';
  import AlertNotificationPolicy from './AlertNotificationPolicy.svelte';
  import AlertNotificationDecisions from './AlertNotificationDecisions.svelte';
  type Kind='sync'|'release';type Status='open'|'acknowledged'|'resolved';
  interface Source {kind:Kind;sourceId:string;mailboxId?:string}
  interface Alert {id:string;kind:Kind;status:Status;outcome:'failed'|'unknown'|'resolved';version:number;generation:number;occurrences:number;errorCode:string|null;firstOccurredAt:number;lastOccurredAt:number;acknowledgedAt:number|null;resolvedAt:number|null;source:Source;global:boolean}
  interface Page {configured:boolean;alerts:Alert[];nextCursor:string|null;summary:{open:number;acknowledged:number;resolved:number}}
  interface Timeline {id:string;action:'failed'|'resolved';version:number;errorCode:string|null;occurredAt:number;source:Source}
  interface Detail {alert:Alert;timeline:Timeline[];timelineTruncated?:boolean}
  let {mailboxId,onViewSource}:{mailboxId:string;onViewSource?:(kind:Kind,id:string)=>Promise<void>}=$props();
  let page=$state<Page>({configured:false,alerts:[],nextCursor:null,summary:{open:0,acknowledged:0,resolved:0}}),status=$state<Status>('open'),kind=$state<Kind|''>(''),limit=$state(20);
  let loading=$state(true),busy=$state(false),expanded=$state(false),cursor=$state<string|null>(null),previous=$state<(string|null)[]>([]);
  let errorMessage=$state(''),notice=$state(''),detail=$state<Detail|null>(null),ackTarget=$state<Alert|null>(null),ackError=$state('');
  const base=$derived(`/owner/api/mailboxes/${mailboxId}/cloudflare-suppression-alerts`),controller=new AbortController();
  onMount(()=>{void load(null);});onDestroy(()=>controller.abort());
  function date(value:number):string {return new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function statusLabel(value:Status):string {return {open:'待处理',acknowledged:'已知悉',resolved:'已解决'}[value];}
  function outcomeLabel(value:Alert['outcome']):string {return {failed:'失败',unknown:'结果未知',resolved:'实际恢复'}[value];}
  function title(value:Kind):string {return value==='sync'?'Cloudflare 同步异常':'Cloudflare 解除异常';}
  function explain(code:string|null,outcome:Alert['outcome']):string {
    if(outcome==='resolved')return '实际同步成功或远端核对结果已使此问题恢复。';
    if(outcome==='unknown')return '远端结果尚未确认。请查看关联历史并只读核对，不会自动重复删除。';
    return code?({cloudflare_api_unavailable:'Cloudflare 暂时不可用，已有缓存和本地抑制保持保留。',cloudflare_api_timeout:'Cloudflare 响应超时，请先核对当前状态。',cloudflare_api_rejected:'Cloudflare 拒绝了请求，请检查配置及对应记录。',cloudflare_suppression_read_only:'服务端记录已标记为只读，不能通过本实例解除。',cloudflare_suppression_changed:'服务端快照已变化，请先核对新快照。',operation_lease_expired:'此前执行中断，请查看关联历史并核对远端结果。'} as Record<string,string>)[code]??'操作未能完成，请查看关联历史和安全诊断代码。':'操作未能完成，请查看关联历史。';
  }
  async function fetchPage(value:string|null) {
    const query=new URLSearchParams({status,limit:String(limit)});if(kind)query.set('kind',kind);if(value)query.set('cursor',value);
    const result=await ownerRequest<Page>(`${base}?${query}`,{signal:controller.signal});
    if(!controller.signal.aborted){page=result;cursor=value;}
  }
  async function load(value:string|null,direction:'reset'|'next'|'previous'='reset') {
    if(busy)return;busy=true;errorMessage='';const old=cursor;
    try{await fetchPage(value);if(!controller.signal.aborted){previous=direction==='next'?[...previous,old]:direction==='previous'?previous.slice(0,-1):[];await invalidateAll();}}
    catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'运行提醒读取失败，请重试。';}
    finally{if(!controller.signal.aborted){busy=false;loading=false;}}
  }
  async function selectStatus(value:Status) {if(busy)return;status=value;expanded=true;notice='';await load(null);expanded=true;}
  async function openDetail(item:Alert) {
    if(busy)return;busy=true;errorMessage='';
    try{const result=await ownerRequest<Detail>(`${base}/${item.id}`,{signal:controller.signal});if(!controller.signal.aborted)detail=result;}
    catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'提醒详情读取失败。';}
    finally{if(!controller.signal.aborted)busy=false;}
  }
  async function viewNotificationAlert(id:string) {
    if(busy)throw new Error('提醒正在读取，请稍后再试。');busy=true;errorMessage='';
    try{const result=await ownerRequest<Detail>(`${base}/${id}`,{signal:controller.signal});if(!controller.signal.aborted)detail=result;}
    finally{if(!controller.signal.aborted)busy=false;}
  }
  function openAcknowledge(item:Alert) {if(busy||item.status!=='open')return;ackTarget={...item,source:{...item.source}};ackError='';detail=null;}
  async function acknowledge() {
    if(busy||!ackTarget)return;busy=true;ackError='';notice='';
    try{
      await ownerRequest(`${base}/${ackTarget.id}/acknowledge`,{method:'POST',body:{expectedVersion:ackTarget.version},signal:controller.signal});
      if(controller.signal.aborted)return;
      ackTarget=null;previous=[];notice='已确认知悉此提醒。故障是否恢复，仍由实际执行或远端核对结果决定。';
      const results=await Promise.allSettled([fetchPage(null),invalidateAll()]);for(const result of results)if(result.status==='rejected')throw result.reason;
    }catch(error){if(!controller.signal.aborted){const message=error instanceof Error?error.message:'确认未完成，请刷新核对。';if(ackTarget)ackError=message;else errorMessage=message;}}
    finally{if(!controller.signal.aborted)busy=false;}
  }
  async function closeAndRefresh() {if(busy)return;ackTarget=null;ackError='';await load(null);}
  async function viewSource(source:Source) {
    if(busy)return;busy=true;errorMessage='';detail=null;
    try{await onViewSource?.(source.kind,source.sourceId);}
    catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'关联历史读取失败。';}
    finally{if(!controller.signal.aborted)busy=false;}
  }
  function sourceLink(source:Source):string {return `/owner/mailboxes/${encodeURIComponent(source.mailboxId??mailboxId)}/suppressions?${new URLSearchParams({historyKind:source.kind,historyId:source.sourceId})}`;}
  function followSource(event:MouseEvent,source:Source) {if(busy){event.preventDefault();return;}if(source.mailboxId&&source.mailboxId!==mailboxId||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey)return;event.preventDefault();void viewSource(source);}
</script>

<section id="cloudflare-suppression-alerts" class="cf-alerts" class:attention={page.summary.open>0} aria-labelledby="cf-alerts-heading"><div class="cf-alerts-heading"><div><h2 id="cf-alerts-heading">Cloudflare 运行提醒</h2><p>{page.summary.open>0?'有待处理的失败或未知结果，请先核对关联历史。':'提醒状态与本地、服务端抑制名单分别管理。'}</p></div><button type="button" disabled={busy||loading} onclick={()=>load(null)}>刷新提醒</button></div>
  {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}{#if notice}<div class="notice" role="status">{notice}</div>{/if}
  <AlertNotificationPolicy {mailboxId}/>
  <AlertNotificationDecisions {mailboxId} onViewAlert={viewNotificationAlert}/>
  {#if loading}<p role="status">正在读取运行提醒…</p>{:else}<div class="cf-alert-summary" aria-label="提醒统计">{#each [{value:'open' as const,label:'待处理'},{value:'acknowledged' as const,label:'已知悉'},{value:'resolved' as const,label:'已解决'}] as item}<button type="button" disabled={busy} aria-label={`筛选${item.label}提醒`} onclick={()=>selectStatus(item.value)}><strong>{page.summary[item.value]}</strong><span>{item.label}</span></button>{/each}</div><button class="table-action" type="button" disabled={busy} onclick={()=>expanded=!expanded}>{expanded?'收起提醒列表':'查看提醒记录'}</button>{/if}
  {#if expanded&&!loading}<div class="cf-alert-toolbar"><div class="read-filter" role="group" aria-label="提醒状态筛选">{#each [{value:'open' as const,label:'待处理'},{value:'acknowledged' as const,label:'已知悉'},{value:'resolved' as const,label:'已解决'}] as item}<button type="button" class:chosen={status===item.value} aria-pressed={status===item.value} disabled={busy} onclick={()=>selectStatus(item.value)}>{item.label}</button>{/each}</div><div class="cf-alert-filters"><label>类型<select aria-label="提醒类型" value={kind} disabled={busy} onchange={event=>{kind=event.currentTarget.value as Kind|'';void load(null);}}><option value="">全部</option><option value="sync">同步</option><option value="release">解除</option></select></label><label>每页<select aria-label="提醒每页条数" value={String(limit)} disabled={busy} onchange={event=>{limit=Number(event.currentTarget.value);void load(null);}}><option value="10">10 条</option><option value="20">20 条</option><option value="50">50 条</option></select></label></div></div>
    {#if !page.alerts.length}<p class="cf-alert-empty">没有{statusLabel(status)}的提醒。</p>{:else}<ul class="cf-alert-list">{#each page.alerts as item (item.id)}<li data-alert-id={item.id}><div class="cf-alert-row-heading"><strong>{title(item.kind)}</strong><span class="badge" class:active={item.status==='resolved'} class:paused={item.status==='open'}>{statusLabel(item.status)}</span><span class="badge">{outcomeLabel(item.outcome)}</span>{#if item.global}<span class="badge">共享提醒</span>{/if}</div><p>{explain(item.errorCode,item.outcome)}{#if item.errorCode} <code>{item.errorCode}</code>{/if}</p><p class="cf-alert-meta">首次 {date(item.firstOccurredAt)} · 最近 {date(item.lastOccurredAt)}<br/>已触发 {item.occurrences} 次 · 第 {item.generation} 个提醒周期</p><div class="cf-alert-actions"><button type="button" disabled={busy} aria-label={`查看提醒 ${item.id}`} onclick={()=>openDetail(item)}>详情</button><a class="button" href={sourceLink(item.source)} aria-disabled={busy} aria-label={`查看关联历史 ${item.id}`} onclick={event=>followSource(event,item.source)}>查看关联历史</a>{#if item.status==='open'}<button type="button" disabled={busy} aria-label={`确认已知悉 ${item.id}`} onclick={()=>openAcknowledge(item)}>确认已知悉</button>{/if}</div></li>{/each}</ul>{/if}
    <nav class="cf-alert-pagination" aria-label="运行提醒分页"><button type="button" disabled={busy||!previous.length} onclick={()=>load(previous.at(-1)??null,'previous')}>上一页</button><span>本页 {page.alerts.length} 条</span><button type="button" disabled={busy||!page.nextCursor} onclick={()=>load(page.nextCursor,'next')}>下一页</button></nav>
  {/if}
</section>

{#if detail}<Dialog title="Cloudflare 提醒详情" {busy} onClose={()=>detail=null}><div class="cf-alert-detail"><p><strong>{title(detail.alert.kind)}</strong> · {statusLabel(detail.alert.status)} · {outcomeLabel(detail.alert.outcome)}</p><p>{explain(detail.alert.errorCode,detail.alert.outcome)}</p><dl><div><dt>首次发生</dt><dd>{date(detail.alert.firstOccurredAt)}</dd></div><div><dt>最近发生</dt><dd>{date(detail.alert.lastOccurredAt)}</dd></div>{#if detail.alert.acknowledgedAt!==null}<div><dt>确认知悉</dt><dd>{date(detail.alert.acknowledgedAt)}</dd></div>{/if}{#if detail.alert.resolvedAt!==null}<div><dt>实际恢复</dt><dd>{date(detail.alert.resolvedAt)}</dd></div>{/if}<div><dt>诊断代码</dt><dd><code>{detail.alert.errorCode??'—'}</code></dd></div></dl><div class="cf-alert-actions"><a class="button" href={sourceLink(detail.alert.source)} aria-disabled={busy} onclick={event=>followSource(event,detail!.alert.source)}>查看关联历史</a>{#if detail.alert.status==='open'}<button type="button" disabled={busy} onclick={()=>openAcknowledge(detail!.alert)}>确认已知悉</button>{/if}</div><h3>提醒变化</h3><ol>{#each detail.timeline as entry (entry.id)}<li><strong>{entry.action==='failed'?'出现异常':'实际恢复'}</strong><time>{date(entry.occurredAt)}</time>{#if entry.errorCode}<code>{entry.errorCode}</code>{/if}<a class="table-action" href={sourceLink(entry.source)} aria-disabled={busy} onclick={event=>followSource(event,entry.source)}>查看此次关联历史</a></li>{/each}</ol>{#if detail.timelineTruncated}<p>仅显示最近的提醒变化。</p>{/if}</div></Dialog>{/if}
{#if ackTarget}<Dialog title="确认已知悉提醒" {busy} onClose={()=>{ackTarget=null;ackError='';}}><p><strong>{title(ackTarget.kind)}</strong> · {outcomeLabel(ackTarget.outcome)}</p><p>此操作仅确认你已知悉提醒，不代表故障已解决；不会重试、核对远端、删除记录或解除抑制。</p>{#if ackTarget.global}<p>这是一条共享提醒，确认状态会同步到可查看它的邮箱。</p>{/if}{#if ackError}<div class="notice error" role="alert">{ackError}</div><button type="button" disabled={busy} onclick={closeAndRefresh}>关闭并刷新提醒</button>{/if}<div class="dialog-actions"><button type="button" disabled={busy} onclick={()=>{ackTarget=null;ackError='';}}>取消</button><button type="button" class="primary" disabled={busy||Boolean(ackError)} onclick={acknowledge}>确认已知悉</button></div></Dialog>{/if}

<style>
  .cf-alerts {padding:17px 19px;margin:0 0 27px;border:1px solid var(--line);border-radius:8px;background:var(--paper);}
  .cf-alerts.attention {border-color:#d8c8a5;background:#fcf7ed;}
  .cf-alerts-heading,.cf-alert-row-heading,.cf-alert-toolbar,.cf-alert-filters,.cf-alert-actions,.cf-alert-pagination {display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
  .cf-alerts-heading,.cf-alert-toolbar {justify-content:space-between;}
  .cf-alerts-heading h2 {font-size:18px;}.cf-alerts-heading p {font-size:12px;}
  .cf-alerts-heading>button,.cf-alert-actions button,.cf-alert-actions .button,.cf-alert-pagination button {font-size:12px;min-height:32px;padding:5px 10px;}
  .cf-alert-summary {display:flex;gap:12px;margin:13px 0 7px;}
  .cf-alert-summary button {padding:7px 12px;min-height:38px;gap:9px;background:var(--surface);font-size:12px;}
  .cf-alert-summary strong {font-size:18px;line-height:1.1;}
  .cf-alert-toolbar {margin:16px 0;}.cf-alert-filters label {display:flex;gap:6px;align-items:center;font-size:12px;}
  .cf-alert-filters select {background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:7px;color:var(--ink);font-size:12px;}
  .cf-alert-list {list-style:none;padding:0;margin:0;}.cf-alert-list>li {padding:15px;background:var(--surface);border:1px solid var(--line);border-radius:7px;margin-bottom:12px;}
  .cf-alert-row-heading strong {font-size:14px;}.cf-alert-list p {font-size:12px;line-height:1.8;overflow-wrap:anywhere;}
  .cf-alert-list code,.cf-alert-detail code {font:11px/1.8 ui-monospace,monospace;overflow-wrap:anywhere;}
  .cf-alert-list .cf-alert-meta {font-size:11px;}.cf-alert-actions {margin-top:11px;}
  .cf-alert-pagination {justify-content:space-between;margin-top:16px;}.cf-alert-pagination span,.cf-alert-empty {font-size:12px;color:var(--muted);}
  .cf-alert-detail p {font-size:13px;overflow-wrap:anywhere;}.cf-alert-detail dl {font-size:12px;margin:17px 0;}
  .cf-alert-detail dl>div {display:grid;grid-template-columns:80px minmax(0,1fr);gap:10px;margin:9px 0;}.cf-alert-detail dt {color:var(--muted);}.cf-alert-detail dd {margin:0;overflow-wrap:anywhere;}
  .cf-alert-detail h3 {font-size:15px;margin:22px 0 10px;}.cf-alert-detail ol {list-style:none;padding:0;max-height:280px;overflow:auto;}.cf-alert-detail li {padding:10px 0;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:5px;font-size:12px;}.cf-alert-detail time {font-size:11px;color:var(--muted);}
  @media(max-width:800px){.cf-alerts {padding:15px 13px;}.cf-alert-summary {gap:7px;}.cf-alert-summary button {padding:7px 9px;}.cf-alert-toolbar {align-items:flex-start;}}
</style>
