<script lang="ts">
  import {onMount,onDestroy} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {MailboxSummary} from '#lib/types/owner.ts';
  import Dialog from './Dialog.svelte';
  import MailboxTabs from './MailboxTabs.svelte';
  import './mail.css';
  import './webhooks.css';

  interface Endpoint {id:string;mailboxId:string;url:string|null;eventTypes:string[];status:'active'|'paused'|'disabled';secretVersion:number;createdAt:number;updatedAt:number}
  interface Delivery {id:string;mailboxId:string;endpointId:string;eventId:string;eventType:string;state:'pending'|'running'|'succeeded'|'dead'|'cancelled';attempts:number;attemptBudget:number;availableAt:number;lastHttpStatus:number|null;lastErrorCode:string|null;createdAt:number;updatedAt:number;completedAt:number|null;secretVersion:number}
  interface Attempt {id:string;attemptNo:number;outcome:string;httpStatus:number|null;errorCode:string|null;startedAt:number;finishedAt:number|null}
  interface DeliveryPage {deliveries:Delivery[];nextCursor:string|null}
  let {mailbox}:{mailbox:MailboxSummary}=$props();
  let endpoints=$state<Endpoint[]>([]),eventTypes=$state<string[]>([]),configured=$state(false),loading=$state(true),busy=$state('');
  let url=$state(''),selectedEvents=$state<string[]>([]),editingId=$state<string|null>(null),editingEvents=$state<string[]>([]);
  let deliveries=$state<Delivery[]>([]),nextCursor=$state<string|null>(null),cursor=$state<string|null>(null),endpointFilter=$state('');
  let detail=$state<{delivery:Delivery;attempts:Attempt[]}|null>(null),secret=$state(''),secretVersion=$state(0),copied=$state(false),dialogError=$state('');
  let errorMessage=$state(''),notice=$state('');
  let exportRetryIntent=$state<{deliveryId:string;clientRequestId:string;expectedUpdatedAt:number}|null>(null);
  const controller=new AbortController();
  const base=$derived(`/owner/api/mailboxes/${mailbox.id}`);
  const canActivate=$derived(configured&&mailbox.status==='active');
  const liveEndpoints=$derived(endpoints.filter(endpoint=>endpoint.status!=='disabled').length);
  onMount(()=>{void refresh();});
  onDestroy(()=>{controller.abort();secret='';});
  const eventNames:Record<string,string>={'message.received':'收到邮件','outbound.accepted':'发送已接受','outbound.failed':'发送失败','outbound.unknown':'发送结果未知',
    'outbound.delivered':'收件服务器已接收','outbound.deferred':'投递暂时延迟','outbound.bounced':'邮件退信','outbound.rejected':'发送被拒绝','outbound.complained':'收到投诉',
    'cloudflare.suppression.alert.created':'Cloudflare 抑制运行提醒','cloudflare.suppression.alert.resolved':'Cloudflare 抑制提醒恢复',
    'alert_notification.export.succeeded':'异步导出已完成','alert_notification.export.failed':'异步导出失败',
    'alert_notification.retry_batch.completed':'批量任务处理完成','alert_notification.retry_batch.failed':'批量任务执行异常','alert_notification.retry_batch.needs_reconciliation':'批量任务结果待对账'};
  const stateNames:Record<Delivery['state'],string>={pending:'等待投递',running:'投递中',succeeded:'投递成功',dead:'已停止重试',cancelled:'已取消'};
  function endpointLabel(status:Endpoint['status']):string {return {active:'启用中',paused:'已暂停',disabled:'已停用'}[status];}
  function batchNoticeDelivery(delivery:Delivery):boolean{return delivery.eventType.startsWith('alert_notification.retry_batch.');}
  function canRetry(delivery:Delivery):boolean {return !exportRetryIntent&&canActivate&&delivery.state==='dead'&&delivery.attemptBudget<80&&endpoints.some(endpoint=>endpoint.id===delivery.endpointId&&endpoint.status==='active');}
  function exportDelivery(delivery:Delivery):boolean{return delivery.eventType==='alert_notification.export.succeeded'||delivery.eventType==='alert_notification.export.failed';}
  function date(value:number|null):string {return value===null?'—':new Date(value).toISOString().replace('T',' ').slice(0,19)+' UTC';}
  function showError(error:unknown) {if(!controller.signal.aborted)errorMessage=error instanceof Error?error.message:'操作未完成，请刷新核对。';}
  function select(events:string[],value:string,checked:boolean):string[] {return checked?[...new Set([...events,value])]:events.filter(item=>item!==value);}
  async function endpointList() {
    const value=await ownerRequest<{endpoints:Endpoint[];configured:boolean;eventTypes:string[]}>(`${base}/webhooks`,{signal:controller.signal});
    if(controller.signal.aborted)return;
    endpoints=value.endpoints;configured=value.configured;eventTypes=value.eventTypes;
    if(!selectedEvents.length)selectedEvents=value.eventTypes.filter(type=>type==='message.received');
  }
  async function deliveryList(value:string|null=null) {
    const params=new URLSearchParams({limit:'50'});if(endpointFilter)params.set('endpointId',endpointFilter);if(value)params.set('cursor',value);
    const result=await ownerRequest<DeliveryPage>(`${base}/webhook-deliveries?${params}`,{signal:controller.signal});
    if(!controller.signal.aborted){deliveries=result.deliveries;nextCursor=result.nextCursor;cursor=value;}
  }
  async function refresh() {
    if(busy)return;
    if(editingId&&!window.confirm('事件订阅有尚未保存的编辑。是否放弃这些编辑并刷新？'))return;
    editingId=null;busy='refresh';errorMessage='';
    try {await Promise.all([endpointList(),deliveryList(cursor)]);}
    catch(error){showError(error);}finally{if(!controller.signal.aborted){busy='';loading=false;}}
  }
  async function paginate(value:string|null) {
    if(busy)return;busy='deliveries';errorMessage='';
    try {await deliveryList(value);}catch(error){showError(error);}finally{if(!controller.signal.aborted)busy='';}
  }
  async function create(event:SubmitEvent) {
    event.preventDefault();if(busy||!canActivate)return;
    if(!selectedEvents.length){errorMessage='请至少订阅一种事件。';return;}
    busy='create';errorMessage='';notice='';
    try {
      const value=await ownerRequest<{endpoint:Endpoint;secret:string}>(`${base}/webhooks`,{method:'POST',body:{url,eventTypes:selectedEvents},signal:controller.signal});
      if(controller.signal.aborted)return;
      secret=value.secret;secretVersion=value.endpoint.secretVersion;copied=false;dialogError='';url='';
      await endpointList();notice='Webhook 已创建。签名密钥只显示这一次。';
    }catch(error){showError(error);}finally{if(!controller.signal.aborted)busy='';}
  }
  async function update(endpoint:Endpoint,changes:{status?:Endpoint['status'];eventTypes?:string[]}) {
    if(busy)return;
    if(changes.eventTypes&&!changes.eventTypes.length){errorMessage='请至少订阅一种事件。';return;}
    if(changes.status==='disabled'&&!window.confirm('停用后无法恢复此 Webhook，尚未完成的投递会取消。已发出的请求无法撤回。是否继续？'))return;
    busy=endpoint.id;errorMessage='';notice='';
    try {
      await ownerRequest(`${base}/webhooks/${endpoint.id}`,{method:'PATCH',body:{expectedUpdatedAt:endpoint.updatedAt,...changes},signal:controller.signal});
      if(!controller.signal.aborted){editingId=null;await Promise.all([endpointList(),deliveryList(cursor)]);notice=changes.status==='paused'?'已暂停，尚未完成的投递已取消。已发出的请求无法撤回。':changes.status==='active'?'已恢复，仅投递之后产生的新事件；已取消的投递不会重放。':changes.status==='disabled'?'Webhook 已停用。':'事件订阅已保存，仅影响之后的新事件。';}
    }catch(error){showError(error);}finally{if(!controller.signal.aborted)busy='';}
  }
  async function rotate(endpoint:Endpoint) {
    if(busy||!canActivate)return;
    if(!window.confirm('新事件将使用新签名密钥。此前排队的投递仍使用原密钥；接收端请保留旧密钥以完成校验。是否轮换？'))return;
    busy=endpoint.id;errorMessage='';notice='';
    try {
      const value=await ownerRequest<{endpoint:Endpoint;secret:string}>(`${base}/webhooks/${endpoint.id}/rotate`,{method:'POST',body:{expectedUpdatedAt:endpoint.updatedAt},signal:controller.signal});
      if(!controller.signal.aborted){secret=value.secret;secretVersion=value.endpoint.secretVersion;copied=false;dialogError='';await endpointList();notice='签名密钥已轮换，请更新接收端；此前投递仍使用原密钥。';}
    }catch(error){showError(error);}finally{if(!controller.signal.aborted)busy='';}
  }
  async function copySecret() {try{await navigator.clipboard.writeText(secret);copied=true;dialogError='';}catch{dialogError='复制未完成，请手动选择并保存签名密钥。';}}
  function closeSecret() {secret='';copied=false;dialogError='';}
  async function openDelivery(id:string) {
    if(busy)return;busy=id;errorMessage='';
    try {const value=await ownerRequest<{delivery:Delivery;attempts:Attempt[]}>(`${base}/webhook-deliveries/${id}`,{signal:controller.signal});if(!controller.signal.aborted)detail=value;}
    catch(error){showError(error);}finally{if(!controller.signal.aborted)busy='';}
  }
  async function retry(delivery:Delivery) {
    if(busy||!canRetry(delivery)||exportRetryIntent)return;
    if(exportDelivery(delivery)||batchNoticeDelivery(delivery)){
      if(!window.confirm('确认重新排队这条通知？将保留原事件、投递 ID、载荷和签名版本；当前通知策略仍会再次检查。'))return;
      exportRetryIntent={deliveryId:delivery.id,clientRequestId:crypto.randomUUID(),expectedUpdatedAt:delivery.updatedAt};await submitExportRetry();return;
    }
    busy=delivery.id;errorMessage='';notice='';
    try {
      await ownerRequest(`${base}/webhook-deliveries/${delivery.id}/retry`,{method:'POST',body:{},signal:controller.signal});
      if(!controller.signal.aborted){await deliveryList(cursor);if(detail?.delivery.id===delivery.id)detail=await ownerRequest(`${base}/webhook-deliveries/${delivery.id}`,{signal:controller.signal});notice='已重新排队，沿用原投递 ID、事件内容和签名密钥。接收端应按投递 ID 去重。';}
    }catch(error){showError(error);}finally{if(!controller.signal.aborted)busy='';}
  }
  async function submitExportRetry(){
    if(busy||!exportRetryIntent)return;const intent={...exportRetryIntent};busy=intent.deliveryId;errorMessage='';notice='';
    try{
      const response=await ownerRequest<{replayed:boolean}>(`${base}/webhook-deliveries/${intent.deliveryId}/retry`,{method:'POST',body:{clientRequestId:intent.clientRequestId,expectedUpdatedAt:intent.expectedUpdatedAt},signal:controller.signal});
      if(!controller.signal.aborted){exportRetryIntent=null;await deliveryList(cursor);if(detail?.delivery.id===intent.deliveryId)detail=await ownerRequest(`${base}/webhook-deliveries/${intent.deliveryId}`,{signal:controller.signal});notice=response.replayed?'已核对原通知重试收据，本次未增加预算或再次排队。请查看投递当前状态。':'通知已重新排队，尚未代表接收端收到；沿用原事件、投递 ID、载荷和签名版本。';}
    }catch(error){showError(error);}finally{if(!controller.signal.aborted)busy='';}
  }
  function abandonExportRetry(){if(busy)return;exportRetryIntent=null;errorMessage='';notice='已放弃本次核对标识，不会撤销可能已排队的投递，请刷新核对当前状态。';}
</script>

<div class="breadcrumb"><a href="/owner/mailboxes">邮箱</a><span>/</span><span>{mailbox.name}</span></div>
<div class="page-heading reader-heading"><div><h1>{mailbox.name}</h1><div class="address-line"><span>{mailbox.address}</span><span class="badge" class:active={mailbox.status==='active'} class:paused={mailbox.status==='paused'}>{mailbox.status==='active'?'启用中':'已暂停'}</span></div></div><button type="button" disabled={Boolean(busy)||loading} onclick={refresh}>刷新 Webhook</button></div>
<MailboxTabs mailboxId={mailbox.id} active="webhooks"/>
{#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
{#if notice}<div class="notice" role="status">{notice}</div>{/if}
{#if exportRetryIntent&&!detail}<div class="notice" role="group" aria-label="通知重试核对"><p>已保留本次通知重试的操作标识和原投递版本。沿用标识核对不会重复增加预算，刷新页面内记录不会自动提交。</p><code>{exportRetryIntent.deliveryId}</code><div class="webhook-actions"><button type="button" disabled={Boolean(busy)} onclick={submitExportRetry}>沿用标识核对重试</button><button type="button" disabled={Boolean(busy)} onclick={abandonExportRetry}>放弃本次核对</button></div></div>{/if}
{#if loading}<p role="status">正在读取 Webhook…</p>{/if}
{#if !loading&&!configured}<div class="webhook-setup" role="status"><h2>先配置 Webhook 加密密钥</h2><p>部署者需通过 Wrangler Secret 配置 <code>WEBHOOK_KEYRING</code>，再刷新此页。密钥环包含当前密钥标识和 32 字节加密密钥；配置说明见项目部署文档。</p><p>密钥环用于加密保存签名密钥，请保留仍有投递引用的旧密钥。此页面不接收或显示部署密钥。</p></div>{/if}
{#if mailbox.status!=='active'}<p class="webhook-warning">邮箱已暂停：可查看、暂停或停用现有 Webhook；恢复邮箱后才可创建、启用、轮换或重试。</p>{/if}

<section class="webhook-create" aria-labelledby="webhook-create-heading"><div class="section-heading"><div><h2 id="webhook-create-heading">新增 Webhook</h2><p>将此邮箱的事件发送到你控制的 HTTPS 接收地址。</p></div><span class="helper">可用地址 {liveEndpoints} / 10 · 历史总计 {endpoints.length} / 100</span></div>
  <form onsubmit={create}><fieldset disabled={Boolean(busy)||loading||!canActivate||liveEndpoints>=10||endpoints.length>=100}>
    <div class="field"><label for="webhook-url">接收地址</label><input id="webhook-url" type="url" bind:value={url} required maxlength="2048" placeholder="https://hooks.example.com/agent-mail" spellcheck={false} autocomplete="off"/><small>仅支持公网 HTTPS 地址，不跟随重定向。保存后地址不可修改，需要更换时请创建新 Webhook。</small></div>
    <fieldset class="webhook-events"><legend>订阅事件</legend>{#each eventTypes as type}<label><input type="checkbox" checked={selectedEvents.includes(type)} onchange={event=>selectedEvents=select(selectedEvents,type,event.currentTarget.checked)}/><span>{eventNames[type]??type}<code>{type}</code></span></label>{/each}</fieldset>
    <button class="primary" type="submit">{busy==='create'?'创建中…':'创建 Webhook'}</button>
  </fieldset></form>
</section>

<section class="webhook-endpoints" aria-labelledby="webhook-endpoints-heading"><div class="section-heading"><div><h2 id="webhook-endpoints-heading">接收地址与订阅</h2><p>暂停会取消未完成的投递。恢复仅影响新事件，已取消的记录不会自动重放。</p></div></div>
  {#if !loading&&!endpoints.length}<div class="webhook-empty">还没有 Webhook。创建后，请保存签名密钥并在接收端验证每次请求。</div>
  {:else}<ul class="webhook-endpoint-list">{#each endpoints as endpoint (endpoint.id)}<li data-endpoint-id={endpoint.id}>
    <div class="webhook-endpoint-heading"><strong>{endpoint.url??'接收地址暂不可用，请检查部署密钥配置'}</strong><span class="badge" class:active={endpoint.status==='active'} class:paused={endpoint.status==='paused'}>{endpointLabel(endpoint.status)}</span></div>
    <p class="webhook-endpoint-meta">签名密钥版本 {endpoint.secretVersion} · 更新于 {date(endpoint.updatedAt)}</p>
    {#if editingId===endpoint.id}<form onsubmit={event=>{event.preventDefault();void update(endpoint,{eventTypes:editingEvents});}}><fieldset class="webhook-events" disabled={Boolean(busy)}><legend>修改订阅事件</legend>{#each eventTypes as type}<label><input type="checkbox" checked={editingEvents.includes(type)} onchange={event=>editingEvents=select(editingEvents,type,event.currentTarget.checked)}/><span>{eventNames[type]??type}<code>{type}</code></span></label>{/each}</fieldset><div class="webhook-actions"><button type="submit" disabled={Boolean(busy)}>保存订阅</button><button type="button" disabled={Boolean(busy)} onclick={()=>editingId=null}>取消编辑</button></div></form>
    {:else}<ul class="webhook-subscriptions">{#each endpoint.eventTypes as type}<li><span>{eventNames[type]??type}</span><code>{type}</code></li>{/each}</ul>{/if}
    <div class="webhook-actions">
      {#if endpoint.status!=='disabled'}<button type="button" disabled={Boolean(busy)||!canActivate} onclick={()=>{editingId=endpoint.id;editingEvents=[...endpoint.eventTypes];}}>编辑事件</button>
        <button type="button" disabled={Boolean(busy)||!canActivate} onclick={()=>rotate(endpoint)}>轮换签名密钥</button>
        {#if endpoint.status==='active'}<button type="button" disabled={Boolean(busy)} onclick={()=>update(endpoint,{status:'paused'})}>暂停 Webhook</button>{:else}<button type="button" disabled={Boolean(busy)||!canActivate} onclick={()=>update(endpoint,{status:'active'})}>恢复 Webhook</button>{/if}
        <button class="danger" type="button" disabled={Boolean(busy)} onclick={()=>update(endpoint,{status:'disabled'})}>停用 Webhook</button>
      {/if}
    </div>
  </li>{/each}</ul>{/if}
  <p class="helper">签名密钥明文仅在创建或轮换时显示一次。轮换后，新事件使用新密钥，原有投递继续使用原密钥；接收端应保留旧版本用于校验。</p>
</section>

<section class="webhook-history" aria-labelledby="webhook-history-heading"><div class="section-heading"><div><h2 id="webhook-history-heading">投递记录</h2><p>暂时性失败会按退避策略重试。已停止重试的投递可手动重新排队。</p></div><label class="webhook-filter">接收地址<select aria-label="筛选投递接收地址" value={endpointFilter} disabled={Boolean(busy)} onchange={event=>{endpointFilter=event.currentTarget.value;void paginate(null);}}><option value="">全部地址</option>{#each endpoints as endpoint}<option value={endpoint.id}>{endpoint.url??endpoint.id}</option>{/each}</select></label></div>
  {#if !loading&&!deliveries.length}<div class="webhook-empty">暂无投递记录。订阅事件发生后会在这里显示。</div>
  {:else}<ul class="webhook-deliveries">{#each deliveries as delivery (delivery.id)}<li data-delivery-id={delivery.id}><div class="webhook-delivery-heading"><strong>{eventNames[delivery.eventType]??delivery.eventType}</strong><span class="badge" class:active={delivery.state==='succeeded'} class:paused={delivery.state==='dead'}>{stateNames[delivery.state]}</span><time>{date(delivery.createdAt)}</time></div><code class="webhook-delivery-id">{delivery.id}</code><p>{delivery.attempts} 次尝试{delivery.lastHttpStatus?` · HTTP ${delivery.lastHttpStatus}`:''}{delivery.lastErrorCode?` · ${delivery.lastErrorCode}`:''}</p><div class="webhook-actions"><button type="button" disabled={Boolean(busy)} aria-label={`查看投递 ${delivery.id}`} onclick={()=>openDelivery(delivery.id)}>详情与日志</button>{#if delivery.state==='dead'}<button type="button" disabled={Boolean(busy)||!canRetry(delivery)} aria-label={`重试投递 ${delivery.id}`} onclick={()=>retry(delivery)}>重新排队</button>{/if}</div></li>{/each}</ul>{/if}
  <nav class="webhook-pagination" aria-label="Webhook 投递分页"><button type="button" disabled={Boolean(busy)||!cursor} onclick={()=>paginate(null)}>返回第一页</button><button type="button" disabled={Boolean(busy)||!nextCursor} onclick={()=>paginate(nextCursor)}>下一页</button></nav>
</section>

{#if secret}<Dialog title="Webhook 签名密钥" onClose={closeSecret}><p class="secret-warning">版本 {secretVersion}。请立即保存签名密钥，关闭后无法再次查看。接收端必须验证签名，并按投递 ID 去重。</p><div class="field"><label for="webhook-secret">完整签名密钥</label><textarea id="webhook-secret" class="secret-value" readonly value={secret} spellcheck={false} autocomplete="off"></textarea></div>{#if dialogError}<p role="alert">{dialogError}</p>{/if}<div class="dialog-actions"><button type="button" onclick={copySecret}>{copied?'已复制':'复制签名密钥'}</button><button class="primary" type="button" onclick={closeSecret}>我已保存</button></div></Dialog>{/if}
{#if detail}<Dialog title="Webhook 投递详情" busy={Boolean(busy)} onClose={()=>detail=null}><div class="webhook-delivery-detail"><span class="badge" class:active={detail.delivery.state==='succeeded'} class:paused={detail.delivery.state==='dead'}>{stateNames[detail.delivery.state]}</span><dl><div><dt>投递 ID</dt><dd><code>{detail.delivery.id}</code></dd></div><div><dt>事件 ID</dt><dd><code>{detail.delivery.eventId}</code></dd></div><div><dt>事件</dt><dd>{detail.delivery.eventType}</dd></div><div><dt>接收地址 ID</dt><dd><code>{detail.delivery.endpointId}</code></dd></div><div><dt>签名密钥版本</dt><dd>{detail.delivery.secretVersion}</dd></div><div><dt>尝试次数</dt><dd>{detail.delivery.attempts} / {detail.delivery.attemptBudget}</dd></div><div><dt>下次可投递</dt><dd>{date(detail.delivery.availableAt)}</dd></div><div><dt>完成时间</dt><dd>{date(detail.delivery.completedAt)}</dd></div></dl><h3>尝试日志</h3>{#if !detail.attempts.length}<p>尚未开始投递。</p>{:else}<ol class="webhook-attempts">{#each detail.attempts as attempt (attempt.id)}<li><strong>第 {attempt.attemptNo} 次 · {attempt.outcome}</strong><span>{attempt.httpStatus?`HTTP ${attempt.httpStatus}`:'无 HTTP 响应'}{attempt.errorCode?` · ${attempt.errorCode}`:''}</span><small>{date(attempt.startedAt)} → {date(attempt.finishedAt)}</small></li>{/each}</ol>{/if}<p class="helper">{#if batchNoticeDelivery(detail.delivery)}批量任务通知手动重试需要核对原准入、当前策略及原投递版本。{/if}日志只展示状态和诊断代码，不包含签名密钥、邮件正文或接收端响应内容。</p>{#if detail.delivery.state==='dead'}<button type="button" disabled={Boolean(busy)||!canRetry(detail.delivery)} onclick={()=>retry(detail!.delivery)}>重新排队此投递</button>{/if}{#if exportRetryIntent}<div class="notice" role="group" aria-label="通知重试核对"><p>已保留原操作标识和版本，可沿用标识核对排队结果；本次核对不会重复增加预算。</p>{#if errorMessage}<p role="alert">{errorMessage}</p>{/if}<div class="webhook-actions"><button type="button" disabled={Boolean(busy)} onclick={submitExportRetry}>沿用标识核对重试</button><button type="button" disabled={Boolean(busy)} onclick={abandonExportRetry}>放弃本次核对</button></div></div>{/if}</div></Dialog>{/if}
