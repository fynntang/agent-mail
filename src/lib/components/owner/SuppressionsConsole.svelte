<script lang="ts">
  import {onMount,onDestroy,tick} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {MailboxSummary} from '#lib/types/owner.ts';
  import MailboxTabs from './MailboxTabs.svelte';
  import Dialog from './Dialog.svelte';
  import CloudflareSuppressionHistory from './CloudflareSuppressionHistory.svelte';
  import CloudflareSuppressionAlerts from './CloudflareSuppressionAlerts.svelte';
  import './mail.css';

  interface Suppression {id:string;address:string;reason:'hard_bounce'|'complaint';status:'active'|'released';version:number;createdAt:number;lastEventAt:number;releasedAt:number|null;updatedAt:number}
  interface SuppressionPage {suppressions:Suppression[];nextCursor:string|null}
  interface ProviderSuppression {id:string;address:string;reason:string;scope:{type:'account'}|{type:'sending_domain';value:string};readOnly:boolean;status:'active'|'absent';version:string;expiresAt:number|null;providerCreatedAt:number|null;seenAt:number;localSuppression:{id:string;version:number;status:'active'|'released';reason:string}|null}
  interface ProviderPage {configured:boolean;suppressions:ProviderSuppression[];nextCursor:string|null;sync:{lastSuccessAt:number|null;lastAttemptAt:number|null;lastErrorCode:string|null}|null}
  interface ProviderOperation {operationId:string;remoteStatus:'deleted'|'unknown'|'already_absent'|'failed'|'in_progress';localStatus:'released'|'changed'|'not_requested'|'pending';errorCode?:string}
  type Status='active'|'released'|'all';
  let {mailbox}:{mailbox:MailboxSummary}=$props();
  let rows=$state<Suppression[]>([]),filter=$state<Status>('active'),limit=$state(25),loading=$state(true),busy=$state(false);
  let cursor=$state<string|null>(null),nextCursor=$state<string|null>(null),previousCursors=$state<(string|null)[]>([]);
  let releaseTarget=$state<Suppression|null>(null),errorMessage=$state(''),dialogError=$state(''),notice=$state('');
  let provider=$state<ProviderPage|null>(null),providerLoading=$state(true),providerBusy=$state(false),providerError=$state(''),providerNotice=$state('');
  let providerCursor=$state<string|null>(null),providerPrevious=$state<(string|null)[]>([]);
  let providerTarget=$state<ProviderSuppression|null>(null),providerRequestId=$state(''),providerAddress=$state(''),providerScopeConfirmed=$state(false),providerReleaseLocal=$state(false),providerAttempted=$state(false),providerDialogError=$state(''),providerResult=$state<ProviderOperation|null>(null);
  let historyVersion=$state(0),alertsVersion=$state(0),historyView=$state<{openSource:(kind:'sync'|'release',id:string)=>Promise<void>}|undefined>();
  const base=$derived(`/owner/api/mailboxes/${mailbox.id}/suppressions`),controller=new AbortController();
  const providerBase=$derived(`/owner/api/mailboxes/${mailbox.id}/cloudflare-suppressions`);
  const providerCanConfirm=$derived(Boolean(providerTarget&&providerAddress.trim()===providerTarget.address&&(providerTarget.scope.type!=='account'||providerScopeConfirmed)&&!providerResult));
  onMount(()=>{void load(null);void loadProvider(null);void openLinkedHistory();});
  onDestroy(()=>controller.abort());
  function date(value:number):string {return new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function reason(value:Suppression['reason']):string {return value==='hard_bounce'?'永久退信':'收件人投诉';}
  async function fetchPage(value:string|null):Promise<void> {
    const query=new URLSearchParams({status:filter,limit:String(limit)});if(value)query.set('cursor',value);
    const result=await ownerRequest<SuppressionPage>(`${base}?${query}`,{signal:controller.signal});
    if(!controller.signal.aborted){rows=result.suppressions;nextCursor=result.nextCursor;cursor=value;}
  }
  async function load(value:string|null,history:'reset'|'next'|'previous'='reset') {
    if(busy)return;busy=true;errorMessage='';
    const oldCursor=cursor;
    try {
      await fetchPage(value);
      if(!controller.signal.aborted)previousCursors=history==='next'?[...previousCursors,oldCursor]:history==='previous'?previousCursors.slice(0,-1):[];
    }catch(error){if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'名单读取失败，请重试。';}
    finally{if(!controller.signal.aborted){busy=false;loading=false;}}
  }
  async function changeFilter(value:Status) {if(busy)return;filter=value;notice='';await load(null);}
  function closeRelease() {releaseTarget=null;dialogError='';}
  async function release() {
    if(busy||!releaseTarget)return;const target=releaseTarget;busy=true;dialogError='';errorMessage='';notice='';
    try {
      await ownerRequest(`${base}/${target.id}/release`,{method:'POST',body:{expectedVersion:target.version},signal:controller.signal});
      if(controller.signal.aborted)return;
      closeRelease();previousCursors=[];notice=`已解除对 ${target.address} 的本地抑制。新的永久退信或投诉可能再次触发抑制。`;
      await fetchPage(null);
    }catch(error){if(!controller.signal.aborted){const message=error instanceof Error?error.message:'解除未完成，请刷新核对。';if(releaseTarget)dialogError=message;else errorMessage=message;}}
    finally{if(!controller.signal.aborted)busy=false;}
  }
  async function refreshAfterConflict() {if(busy)return;closeRelease();await load(null);}
  function providerScope(row:ProviderSuppression):string {return row.scope.type==='account'?'账户范围 · 所有发信域':`发信域 · ${row.scope.value}`;}
  async function fetchProvider(value:string|null) {
    const query=new URLSearchParams({limit:'25'});if(value)query.set('cursor',value);
    const result=await ownerRequest<ProviderPage>(`${providerBase}?${query}`,{signal:controller.signal});
    if(!controller.signal.aborted){provider=result;providerCursor=value;}
  }
  async function loadProvider(value:string|null,history:'reset'|'next'|'previous'='reset') {
    if(providerBusy)return;providerBusy=true;providerError='';const previous=providerCursor;
    try {await fetchProvider(value);if(!controller.signal.aborted)providerPrevious=history==='next'?[...providerPrevious,previous]:history==='previous'?providerPrevious.slice(0,-1):[];}
    catch(error){if(!controller.signal.aborted)providerError=error instanceof Error?error.message:'Cloudflare 缓存记录读取失败，请重试。';}
    finally{if(!controller.signal.aborted){providerBusy=false;providerLoading=false;}}
  }
  async function syncProvider() {
    if(providerBusy||!provider?.configured)return;providerBusy=true;providerError='';providerNotice='';
    try {
      await ownerRequest(`${providerBase}/sync`,{method:'POST',body:{},signal:controller.signal});
      if(!controller.signal.aborted){providerPrevious=[];await fetchProvider(null);providerNotice='Cloudflare 记录已同步。本地抑制名单保持独立。';}
    }catch(error){if(!controller.signal.aborted){providerError=error instanceof Error?error.message:'同步未完成，请稍后重试。';await fetchProvider(providerCursor).catch(()=>{});}}
    finally{if(!controller.signal.aborted){providerBusy=false;historyVersion++;alertsVersion++;}}
  }
  function openProvider(row:ProviderSuppression) {
    if(providerBusy||busy||row.readOnly||row.status!=='active')return;
    providerTarget={...row,scope:{...row.scope},localSuppression:row.localSuppression?{...row.localSuppression}:null};
    providerRequestId=crypto.randomUUID();providerAddress='';providerScopeConfirmed=false;providerReleaseLocal=false;providerAttempted=false;providerDialogError='';providerResult=null;
  }
  function closeProvider() {providerTarget=null;providerRequestId='';providerAddress='';providerScopeConfirmed=false;providerReleaseLocal=false;providerAttempted=false;providerDialogError='';providerResult=null;}
  function operationMessage(result:ProviderOperation):string {
    if(result.remoteStatus==='unknown')return 'Cloudflare 删除结果暂未确认。本地抑制没有自动解除。请先同步记录核对，再决定后续操作。';
    if(result.remoteStatus==='in_progress')return '此次 Cloudflare 操作仍在处理中。请稍后刷新或同步记录，本地抑制不会自动解除。';
    if(result.remoteStatus==='failed')return 'Cloudflare 记录未能解除，本地抑制保持不变。请核对状态后再操作。';
    const remote=result.remoteStatus==='already_absent'?'Cloudflare 记录已不存在。':'Cloudflare 记录已解除。';
    return remote+(result.localStatus==='released'?'已同时解除当前邮箱匹配的本地抑制。':result.localStatus==='changed'?'当前邮箱的本地记录已变化，仍保留抑制；请在上方刷新并核对后单独处理。':'当前邮箱的本地抑制没有随此操作解除。');
  }
  async function releaseProvider() {
    if(providerBusy||!providerTarget||!providerCanConfirm)return;
    const target=providerTarget,refreshLocal=providerReleaseLocal;providerBusy=true;providerAttempted=true;providerDialogError='';providerError='';
    try {
      const result=await ownerRequest<ProviderOperation>(`${providerBase}/${encodeURIComponent(target.id)}/release`,{method:'POST',body:{clientRequestId:providerRequestId,expectedVersion:target.version,
        confirmationAddress:providerAddress.trim(),confirmationScope:target.scope.type==='account'?'account':target.scope.value,
        ...(providerReleaseLocal&&target.localSuppression?.status==='active'?{releaseLocal:true,expectedLocalVersion:target.localSuppression.version}:{})},signal:controller.signal});
      if(controller.signal.aborted)return;
      providerResult=result;providerNotice=operationMessage(result);
      if(result.remoteStatus==='deleted'||result.remoteStatus==='already_absent') {
        closeProvider();providerPrevious=[];await fetchProvider(null);
        if(refreshLocal||result.localStatus==='released'||result.localStatus==='changed') {busy=true;try{previousCursors=[];await fetchPage(null);}finally{busy=false;}}
      }
    }catch(error){if(!controller.signal.aborted){const message=error instanceof Error?error.message:'解除结果尚未确认，请先同步记录核对。';if(providerTarget)providerDialogError=message;else providerError=message;}}
    finally{if(!controller.signal.aborted){providerBusy=false;historyVersion++;alertsVersion++;}}
  }
  async function closeAndSyncProvider() {if(providerBusy)return;closeProvider();await syncProvider();}
  async function refreshAfterHistory() {await Promise.allSettled([load(null),loadProvider(null)]);alertsVersion++;}
  async function viewAlertSource(kind:'sync'|'release',id:string) {document.getElementById('cf-history-heading')?.scrollIntoView({block:'start',behavior:'instant'});await historyView?.openSource(kind,id);}
  async function openLinkedHistory() {const query=new URLSearchParams(window.location.search),kind=query.get('historyKind'),id=query.get('historyId');if(query.getAll('historyKind').length===1&&query.getAll('historyId').length===1&&(kind==='sync'||kind==='release')&&id&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)){await tick();await viewAlertSource(kind,id);}}
</script>

<div class="breadcrumb"><a href="/owner/mailboxes">邮箱</a><span>/</span><span>{mailbox.name}</span></div>
<div class="page-heading reader-heading"><div><h1>{mailbox.name}</h1><div class="address-line"><span>{mailbox.address}</span><span class="badge" class:active={mailbox.status==='active'} class:paused={mailbox.status==='paused'}>{mailbox.status==='active'?'启用中':'已暂停'}</span></div></div><button type="button" disabled={busy||loading} onclick={()=>load(null)}>刷新名单</button></div>
<MailboxTabs mailboxId={mailbox.id} active="suppressions"/>
{#key alertsVersion}<CloudflareSuppressionAlerts mailboxId={mailbox.id} onViewSource={viewAlertSource}/>{/key}
<section aria-labelledby="suppressions-heading"><div class="section-heading suppression-heading"><div><h2 id="suppressions-heading">收件人抑制名单</h2><p>此邮箱收到永久退信或投诉后，会阻止向相关地址提交新的发送。</p></div><a class="button" href={`/owner/mailboxes/${mailbox.id}/outbound`}>查看发送记录</a></div>
  {#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
  {#if notice}<div class="notice" role="status">{notice}</div>{/if}
  <div class="suppression-note"><p>只有 Owner 可以解除本地抑制。解除后若再次收到新的永久退信或投诉，该地址仍可能重新进入名单。</p><p>Cloudflare 发送服务的抑制名单独立管理；解除本地记录不会同步解除服务端限制。</p></div>
  <div class="suppression-toolbar"><div class="read-filter" role="group" aria-label="抑制状态筛选">{#each [{value:'active' as const,label:'抑制中'},{value:'released' as const,label:'已解除'},{value:'all' as const,label:'全部'}] as item}<button type="button" disabled={busy} class:chosen={filter===item.value} aria-pressed={filter===item.value} onclick={()=>changeFilter(item.value)}>{item.label}</button>{/each}</div>
    <label class="suppression-limit">每页<select aria-label="抑制名单每页条数" value={String(limit)} disabled={busy} onchange={event=>{limit=Number(event.currentTarget.value);void load(null);}}><option value="10">10 条</option><option value="25">25 条</option><option value="50">50 条</option></select></label>
  </div>
  {#if loading}<p role="status">正在读取抑制名单…</p>
  {:else if errorMessage}<div class="suppression-empty"><p>名单尚未刷新，请重新读取后再操作。</p><button type="button" disabled={busy} onclick={()=>load(null)}>重新读取名单</button></div>
  {:else if !rows.length}<div class="suppression-empty"><h3>{filter==='active'?'没有正在抑制的收件人':filter==='released'?'没有已解除的记录':'暂无抑制记录'}</h3><p>{filter==='active'?'永久退信或投诉触发的记录会显示在这里。':'可以切换状态筛选，查看此邮箱的其他记录。'}</p></div>
  {:else}<ul class="suppression-list">{#each rows as row (row.id)}<li data-suppression-id={row.id} data-address={row.address}><div class="suppression-row-heading"><strong>{row.address}</strong><span class="badge" class:paused={row.status==='active'}>{row.status==='active'?'抑制中':'已解除'}</span></div><dl><div><dt>原因</dt><dd>{reason(row.reason)}</dd></div><div><dt>首次抑制</dt><dd><time datetime={new Date(row.createdAt).toISOString()}>{date(row.createdAt)}</time></dd></div><div><dt>最新触发事件</dt><dd><time datetime={new Date(row.lastEventAt).toISOString()}>{date(row.lastEventAt)}</time></dd></div>{#if row.releasedAt!==null}<div><dt>解除时间</dt><dd><time datetime={new Date(row.releasedAt).toISOString()}>{date(row.releasedAt)}</time></dd></div>{/if}</dl>{#if row.status==='active'}<button type="button" disabled={busy} aria-label={`解除 ${row.address} 的抑制`} onclick={()=>{releaseTarget={...row};dialogError='';}}>解除抑制</button>{/if}</li>{/each}</ul>{/if}
  <nav class="suppression-pagination" aria-label="抑制名单分页"><button type="button" disabled={busy||Boolean(errorMessage)||!previousCursors.length} onclick={()=>load(previousCursors.at(-1)??null,'previous')}>上一页</button><span>{errorMessage?'名单待刷新':`本页 ${rows.length} 条`}</span><button type="button" disabled={busy||Boolean(errorMessage)||!nextCursor} onclick={()=>load(nextCursor,'next')}>下一页</button></nav>
</section>

<section class="provider-suppressions" aria-labelledby="provider-suppressions-heading"><div class="section-heading suppression-heading"><div><h2 id="provider-suppressions-heading">Cloudflare 服务端抑制</h2><p>展示配置账户范围及指定发信域的缓存记录，与上方当前邮箱的本地名单分别管理。</p></div><div class="provider-controls"><button type="button" disabled={providerBusy||providerLoading} onclick={()=>loadProvider(null)}>刷新缓存记录</button><button type="button" disabled={providerBusy||!provider?.configured} onclick={syncProvider}>{providerBusy?'处理中…':'同步 Cloudflare 记录'}</button></div></div>
  {#if providerNotice}<div class="notice" role="status">{providerNotice}</div>{/if}
  {#if providerError}<div class="notice error" role="alert">{providerError}</div>{/if}
  {#if providerLoading}<p role="status">正在读取 Cloudflare 配置和缓存…</p>
  {:else if provider?.configured===false}<div class="suppression-note"><h3>尚未配置 Cloudflare 名单管理</h3><p>部署者需配置账户与发信域，并将 <code>EMAIL_SUPPRESSIONS_API_TOKEN</code> 保存为 Worker Secret。此页面不输入或显示 API 凭证。</p><p>本地抑制名单可继续独立使用。</p></div>
  {:else if provider}
    <dl class="provider-sync-status"><div><dt>服务配置</dt><dd>已配置</dd></div><div><dt>最近成功同步</dt><dd>{provider.sync?.lastSuccessAt?date(provider.sync.lastSuccessAt):'尚未成功同步'}</dd></div><div><dt>最近同步尝试</dt><dd>{provider.sync?.lastAttemptAt?date(provider.sync.lastAttemptAt):'尚未尝试'}</dd></div>{#if provider.sync?.lastErrorCode}<div><dt>同步诊断代码</dt><dd><code>{provider.sync.lastErrorCode}</code>。缓存可能较旧，请核对同步状态。</dd></div>{/if}</dl>
    {#if !provider.suppressions.length}<div class="suppression-empty"><h3>缓存中没有 Cloudflare 抑制记录</h3><p>点击同步，从 Cloudflare 读取账户范围和指定发信域的记录。同步不会自动解除本地名单。</p></div>
    {:else}<ul class="suppression-list provider-suppression-list">{#each provider.suppressions as row (row.id)}<li data-provider-id={row.id}><div class="suppression-row-heading"><strong>{row.address}</strong><span class="badge" class:paused={row.readOnly}>{row.readOnly?'只读':'可解除'}</span>{#if row.status==='absent'}<span class="badge">已不在缓存来源中</span>{/if}</div><p class="provider-scope">{providerScope(row)}</p><dl><div><dt>原因</dt><dd>{row.reason||'未提供'}</dd></div><div><dt>到期时间</dt><dd>{row.expiresAt===null?'未提供到期时间':date(row.expiresAt)}</dd></div><div><dt>服务端创建</dt><dd>{row.providerCreatedAt===null?'未提供':date(row.providerCreatedAt)}</dd></div><div><dt>缓存读取于</dt><dd>{date(row.seenAt)}</dd></div></dl>{#if row.localSuppression?.status==='active'}<p class="provider-local-match">当前邮箱也有此地址的本地抑制，默认保持不变。</p>{/if}{#if row.readOnly}<p class="provider-local-match">此服务端记录标记为只读，不能在这里解除。</p>{:else if row.status==='active'}<button type="button" disabled={providerBusy||busy} aria-label={`解除 Cloudflare 记录 ${row.address}`} onclick={()=>openProvider(row)}>解除 Cloudflare 记录</button>{/if}</li>{/each}</ul>{/if}
    <nav class="suppression-pagination" aria-label="Cloudflare 抑制记录分页"><button type="button" disabled={providerBusy||!providerPrevious.length} onclick={()=>loadProvider(providerPrevious.at(-1)??null,'previous')}>上一页</button><span>本页 {provider.suppressions.length} 条</span><button type="button" disabled={providerBusy||!provider.nextCursor} onclick={()=>loadProvider(provider?.nextCursor??null,'next')}>下一页</button></nav>
  {/if}
</section>

{#key historyVersion}<CloudflareSuppressionHistory bind:this={historyView} mailboxId={mailbox.id} onChanged={refreshAfterHistory}/>{/key}

{#if releaseTarget}<Dialog title="解除收件人抑制" {busy} onClose={closeRelease}><p>确认解除 <strong class="suppression-dialog-address">{releaseTarget.address}</strong> 的本地抑制？原因：{reason(releaseTarget.reason)}。</p><p>解除本地限制后，发送仍会检查 Cloudflare 缓存及服务端限制。新的永久退信或投诉可能重新将其加入名单。</p><p>Cloudflare 发送服务的抑制名单独立管理，此操作不会同步解除服务端限制。请先确认接收方意愿及地址有效性。</p>{#if dialogError}<div class="notice error" role="alert">{dialogError}</div><button type="button" disabled={busy} onclick={refreshAfterConflict}>关闭并刷新名单</button>{/if}<div class="dialog-actions"><button type="button" disabled={busy} onclick={closeRelease}>取消</button><button type="button" class="primary" disabled={busy||Boolean(dialogError)} onclick={release}>{busy?'解除中…':'确认解除'}</button></div></Dialog>{/if}
{#if providerTarget}<Dialog title="解除 Cloudflare 服务端抑制" busy={providerBusy} onClose={closeProvider}><p><strong class="suppression-dialog-address">{providerTarget.address}</strong><br/>{providerScope(providerTarget)}</p>{#if providerTarget.scope.type==='account'}<div class="suppression-note provider-account-warning"><strong>账户范围操作</strong><p>解除会影响此 Cloudflare 账户的所有发信域，包括当前邮箱之外的发信域。</p></div>{:else}<p>解除仅针对上面显示的发信域记录。</p>{/if}<p>新的服务端事件可能重新创建抑制记录。请先确认接收方意愿及地址有效性。</p>
  {#if providerResult}<div class="suppression-note" role="status">{operationMessage(providerResult)}{#if providerResult.errorCode}<p>诊断代码：<code>{providerResult.errorCode}</code></p>{/if}</div><div class="dialog-actions"><button type="button" disabled={providerBusy} onclick={closeProvider}>关闭</button><button type="button" disabled={providerBusy} onclick={closeAndSyncProvider}>关闭并同步记录</button></div>
  {:else}<div class="field"><label for="provider-confirm-address">输入完整收件地址以确认</label><input id="provider-confirm-address" bind:value={providerAddress} disabled={providerBusy||providerAttempted} autocomplete="off" spellcheck={false}/></div>{#if providerTarget.scope.type==='account'}<label class="provider-confirm-option"><input type="checkbox" bind:checked={providerScopeConfirmed} disabled={providerBusy||providerAttempted}/>我确认解除账户范围记录，会影响此账户的所有发信域。</label>{/if}
    {#if providerTarget.localSuppression?.status==='active'}<label class="provider-confirm-option"><input type="checkbox" bind:checked={providerReleaseLocal} disabled={providerBusy||providerAttempted}/>同时解除当前邮箱 {mailbox.address} 中匹配的本地抑制</label><p class="provider-local-match">仅处理当前邮箱的本地记录；若确认期间出现新事件，新的本地抑制会保留。</p>{:else}<p class="provider-local-match">当前邮箱没有匹配的活跃本地抑制。</p>{/if}
    {#if providerDialogError}<div class="notice error" role="alert">{providerDialogError}</div><p class="provider-local-match">再次确认会沿用本次操作标识；也可关闭后同步核对，避免重复操作。</p><button type="button" disabled={providerBusy} onclick={closeAndSyncProvider}>关闭并同步记录</button>{/if}<div class="dialog-actions"><button type="button" disabled={providerBusy} onclick={closeProvider}>取消</button><button type="button" class="primary" disabled={providerBusy||!providerCanConfirm} onclick={releaseProvider}>{providerBusy?'处理中…':'确认解除 Cloudflare 记录'}</button></div>
  {/if}
</Dialog>{/if}

<style>
  .suppression-heading {flex-wrap:wrap;}
  .suppression-heading p {font-size:13px;}
  .suppression-note {padding:13px 17px;border:1px solid var(--line);border-radius:7px;background:var(--paper);font-size:12px;margin:0 0 22px;}
  .suppression-toolbar {display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px;}
  .suppression-limit {display:flex;align-items:center;gap:9px;font-size:12px;color:var(--muted);}
  .suppression-limit select {border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:12px;color:var(--ink);padding:8px;}
  .suppression-list {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;list-style:none;padding:0;margin:0;}
  .suppression-list>li {padding:20px;border:1px solid var(--line);border-radius:8px;min-width:0;}
  .suppression-row-heading {display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}
  .suppression-row-heading strong {font-size:14px;overflow-wrap:anywhere;min-width:0;}
  .suppression-list dl {font-size:12px;margin:15px 0;}
  .suppression-list dl>div {display:grid;grid-template-columns:90px minmax(0,1fr);gap:10px;margin:8px 0;}
  .suppression-list dt {color:var(--muted);}
  .suppression-list dd {margin:0;overflow-wrap:anywhere;}
  .suppression-list button {font-size:12px;min-height:34px;padding:6px 11px;}
  .suppression-empty {padding:35px 22px;text-align:center;border:1px solid var(--line);border-radius:8px;background:var(--paper);}
  .suppression-empty h3 {font-size:17px;margin:0 0 9px;}
  .suppression-empty p {font-size:13px;}
  .suppression-pagination {display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px;}
  .suppression-pagination button {font-size:12px;min-height:34px;}
  .suppression-pagination span {font-size:12px;color:var(--muted);}
  .suppression-dialog-address {overflow-wrap:anywhere;}
  .provider-suppressions {margin-top:38px;padding-top:30px;border-top:1px solid var(--line);}
  .provider-controls {display:flex;gap:10px;flex-wrap:wrap;}
  .provider-controls button {font-size:12px;min-height:36px;padding:7px 11px;}
  .provider-sync-status {font-size:12px;margin:20px 0;}
  .provider-sync-status>div {display:grid;grid-template-columns:100px minmax(0,1fr);gap:12px;margin:9px 0;}
  .provider-sync-status dt {color:var(--muted);}
  .provider-sync-status dd {margin:0;overflow-wrap:anywhere;}
  .provider-scope,.provider-local-match {font-size:12px;line-height:1.8;overflow-wrap:anywhere;}
  .provider-scope {margin:8px 0 10px;}
  .provider-confirm-option {display:flex;align-items:flex-start;gap:9px;font-size:13px;line-height:1.8;margin:14px 0;}
  .provider-confirm-option input {width:16px;height:16px;flex:0 0 auto;margin:4px 0 0;}
  .provider-account-warning {background:#faf2e0;}
  @media(max-width:1100px) {.suppression-list {grid-template-columns:1fr;}}
  @media(max-width:800px) {.suppression-list>li {padding:16px;}.suppression-list dl>div {grid-template-columns:80px minmax(0,1fr);gap:8px;}}
</style>
