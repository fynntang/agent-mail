<script lang="ts">
  import {onDestroy,onMount,untrack} from 'svelte';
  import {ownerRequest} from '#lib/owner-client.ts';
  import type {SetupAttestations,SetupDTO} from '#lib/types/setup.ts';
  import './setup.css';

  let {initialSetup}:{initialSetup:SetupDTO}=$props();
  let setup=$state<SetupDTO>(untrack(()=>initialSetup));
  let displayName=$state(untrack(()=>initialSetup.instance.displayName));
  let attestations=$state<SetupAttestations>(untrack(()=>({...initialSetup.attestations})));
  let mounted=$state(false),busy=$state<'refresh'|'save'|'complete'|'probe'|null>(null),errorMessage=$state(''),notice=$state('');
  let probeState=$state<'idle'|'verified'|'probe_failed'|'cleanup_failed'>('idle');
  const controller=new AbortController();
  const dirty=$derived(displayName!==setup.instance.displayName||Object.keys(attestations).some(key=>attestations[key as keyof SetupAttestations]!==setup.attestations[key as keyof SetupAttestations]));
  const resourcesReady=$derived(setup.resources.d1==='migrated'&&setup.resources.r2==='connected');
  const checkedCount=$derived(Number(attestations.mailDomain)+Number(attestations.access)+Number(attestations.emailRouting)+(setup.config.sendingEnabled?Number(attestations.emailSending):0));
  const requiredCount=$derived(setup.config.sendingEnabled?4:3);
  const finishReady=$derived(resourcesReady&&setup.configValid&&setup.evidence.activeMailboxCount>0
    &&attestations.mailDomain&&attestations.access&&attestations.emailRouting&&(!setup.config.sendingEnabled||attestations.emailSending)&&Boolean(displayName.trim()));
  const stateLabel=$derived(setup.instance.state==='ready'?'向导已完成':setup.instance.state==='maintenance'?'维护中':'待初始化');
  onMount(()=>{mounted=true;});
  onDestroy(()=>controller.abort());

  function adopt(value:SetupDTO) {setup=value;displayName=value.instance.displayName;attestations={...value.attestations};}
  function failed(cause:unknown) {if(!controller.signal.aborted)errorMessage=cause instanceof Error?cause.message:'操作未完成，请重试。';}
  async function refresh() {
    if(busy||!mounted||dirty&&!window.confirm('还有尚未保存的确认记录，是否刷新并放弃这些更改？'))return;
    busy='refresh';errorMessage='';notice='';
    try {const result=await ownerRequest<{setup:SetupDTO}>('/owner/api/setup',{signal:controller.signal});if(!controller.signal.aborted)adopt(result.setup);}
    catch(cause){failed(cause);}finally{if(!controller.signal.aborted)busy=null;}
  }
  async function save(complete=false) {
    if(busy||!mounted||complete&&!finishReady)return;
    busy=complete?'complete':'save';errorMessage='';notice='';
    try {
      const result=await ownerRequest<{setup:SetupDTO}>('/owner/api/setup',{method:'POST',body:{expectedUpdatedAt:setup.instance.updatedAt,
        expectedConfigFingerprint:setup.configFingerprint,displayName,attestations:{...attestations},complete},signal:controller.signal});
      if(!controller.signal.aborted){adopt(result.setup);notice=complete?'初始化记录已完成。请继续从独立邮箱进行真实收发验收。':'确认记录已保存。';}
    }catch(cause){failed(cause);}finally{if(!controller.signal.aborted)busy=null;}
  }
  async function probe() {
    if(busy||!mounted)return;busy='probe';errorMessage='';notice='';
    try {
      const result=await ownerRequest<{probe:{success:boolean;code:'verified'|'probe_failed'|'cleanup_failed'}}>('/owner/api/setup/probe',{method:'POST',body:{},signal:controller.signal});
      if(!controller.signal.aborted){probeState=result.probe.code;
        if(result.probe.success)notice='存储读写检查通过，临时探针已清理。';
        else errorMessage=result.probe.code==='cleanup_failed'?'临时存储探针清理未完成，请检查 R2 权限后重试。':'存储读写检查失败，请检查绑定及权限后重试。';}
    }catch(cause){failed(cause);}finally{if(!controller.signal.aborted)busy=null;}
  }
  function leaving(event:MouseEvent) {if(dirty&&!window.confirm('还有尚未保存的确认记录，是否离开向导？'))event.preventDefault();}
</script>

<div class="breadcrumb"><a href="/owner/mailboxes">邮箱</a><span>/</span><span>初始化</span></div>
<div class="page-heading"><div><h1>初始化向导</h1><p>检查资源，并逐项确认邮件域名、访问保护和邮件服务。</p></div><button type="button" disabled={!mounted||Boolean(busy)} onclick={refresh}>{busy==='refresh'?'刷新中…':'刷新检查'}</button></div>
{#if errorMessage}<div class="notice error" role="alert">{errorMessage}</div>{/if}
{#if notice}<div class="notice" role="status">{notice}</div>{/if}
{#if setup.configChanged}<div class="notice setup-warning" role="status">部署配置已变化，旧的人工确认不再适用。请按当前配置重新核对并保存。</div>{/if}
{#if !setup.configValid}<div class="notice error" role="alert">实例配置尚不完整或包含无效值。请在部署配置中检查邮件域名、Owner、Access 和两个入口地址，重新部署后刷新。</div>{/if}

<div class="setup-summary"><span class="badge" class:active={setup.instance.state==='ready'}>{stateLabel}</span><span>人工确认 {checkedCount} / {requiredCount}</span><span>{setup.evidence.activeMailboxCount} 个启用邮箱</span></div>
<p class="setup-intro">资源检查由本实例执行；DNS、Cloudflare Access 策略及邮件域名状态需要你在 Cloudflare 确认。勾选仅记录你的确认，不代表应用已替你验证或修改云端配置。</p>

<div class="setup-content">
  <section class="setup-card" aria-labelledby="setup-resources"><div class="setup-heading"><span class="setup-step" aria-hidden="true">1</span><div><h2 id="setup-resources">资源与数据库迁移</h2><p>应用使用一个 Worker、一份 D1 与私有 R2。</p></div><span class="badge" class:active={resourcesReady}>{resourcesReady?'绑定可访问':'需要处理'}</span></div>
    <dl class="setup-metadata"><div><dt>D1 数据库</dt><dd>{setup.resources.d1==='migrated'?'结构检查通过':setup.resources.d1==='migration_required'?'需要执行数据库迁移':'暂不可访问'}</dd></div><div><dt>R2 存储</dt><dd>{setup.resources.r2==='connected'?'绑定可访问（只读检查）':'暂不可访问'}</dd></div><div><dt>结构版本</dt><dd>{setup.resources.schemaVersion??'未确认'}</dd></div></dl>
    {#if setup.resources.missingTables.length}<div class="notice error">缺少或不完整的结构：<code>{setup.resources.missingTables.join('、')}</code></div>{/if}
    {#if setup.resources.missingIndexes.length}<div class="notice error">缺少或不完整的索引：<code>{setup.resources.missingIndexes.join('、')}</code></div>{/if}
    <p class="helper">需要的迁移：{setup.resources.expectedMigrations.join('、')}。请使用部署工具执行迁移；本页不持有 Cloudflare 账号管理凭据。</p>
    <div class="setup-actions"><button type="button" disabled={!mounted||Boolean(busy)||setup.resources.r2!=='connected'} onclick={probe}>{busy==='probe'?'检查中…':'检查存储读写'}</button>{#if probeState==='verified'}<span class="setup-result">读写通过，探针已清理</span>{/if}</div>
    <p class="helper">此按钮只写入、读取并清理随机临时探针，不发送邮件。完成向导时会再次检查存储读写。</p>
  </section>

  <section class="setup-card" aria-labelledby="setup-domain"><div class="setup-heading"><span class="setup-step" aria-hidden="true">2</span><div><h2 id="setup-domain">邮件域名</h2><p>确认此域名专用于 Agent 邮箱，避免影响已有个人邮箱。</p></div></div>
    <dl class="setup-metadata"><div><dt>MAIL_DOMAIN</dt><dd><code>{setup.config.mailDomain}</code></dd></div></dl>
    <ol class="setup-instructions"><li>在 Cloudflare 添加并验证邮件域名，核对 DNS 托管状态。</li><li>先检查现有 MX 记录及邮件用途，再按 Cloudflare 给出的记录配置；不要直接覆盖个人邮箱域的 MX。</li><li>使用子域时按该子域实际提供的说明设置，不把父域 Catch-all 当作子域规则。</li></ol>
    <p><a href="https://developers.cloudflare.com/email-service/configuration/domains/" target="_blank" rel="noopener noreferrer">查看邮件域名与 DNS 文档 ↗</a></p>
    <label class="setup-confirm"><input type="checkbox" bind:checked={attestations.mailDomain} disabled={!mounted||Boolean(busy)}/><span>我已在 Cloudflare 确认邮件域名和 DNS，不会覆盖现有个人邮箱配置。</span></label>
  </section>

  <section class="setup-card" aria-labelledby="setup-access"><div class="setup-heading"><span class="setup-step" aria-hidden="true">3</span><div><h2 id="setup-access">Cloudflare Access</h2><p>Owner 页面使用 Access 登录；Agent API 与 OAuth 协议使用各自凭据。</p></div></div>
    <dl class="setup-metadata"><div><dt>Owner 邮箱</dt><dd>{setup.config.ownerEmail}</dd></div><div><dt>Access 团队</dt><dd><code>{setup.config.accessTeamDomain}</code></dd></div><div><dt>应用 AUD</dt><dd><code>{setup.config.accessAud}</code></dd></div><div><dt>控制台入口</dt><dd><code>{setup.config.consoleOrigin}</code></dd></div><div><dt>Agent API 入口</dt><dd><code>{setup.config.apiOrigin}</code></dd></div></dl>
    <ol class="setup-instructions"><li>在 Zero Trust 的 Access Applications 创建 Self-hosted 应用，覆盖控制台域名。</li><li>Allow 策略只允许上述 Owner 邮箱；将团队域名和应用 AUD 填入部署配置。</li><li>两个域名指向同一个 Worker。API 域名的 MCP、OAuth 发现和 token 端点不能被交互式 Access 登录拦住。</li></ol>
    <p class="helper">当前页面已通过服务端 Owner JWT 检查；这不等于检查了所有 Cloudflare 边缘策略或备用域名。</p>
    <p><a href="https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/" target="_blank" rel="noopener noreferrer">查看 Access 配置文档 ↗</a></p>
    <label class="setup-confirm"><input type="checkbox" bind:checked={attestations.access} disabled={!mounted||Boolean(busy)}/><span>我已在 Cloudflare 确认控制台 Access 覆盖范围、Owner 策略和 API 域名分离。</span></label>
  </section>

  <section class="setup-card" aria-labelledby="setup-routing"><div class="setup-heading"><span class="setup-step" aria-hidden="true">4</span><div><h2 id="setup-routing">Email Routing 收信</h2><p>将邮件投递到部署输出的同一个 Worker。</p></div></div>
    <ol class="setup-instructions"><li>在 Cloudflare Email Service 开通 Email Routing，并按控制台要求验证域名和 DNS。</li><li>将需要的地址规则指向本实例 Worker；目标是 Worker 名称，不是一个 HTTP 收信网址。</li><li>Catch-all 影响整个匹配域；子域需要对应的地址规则。只把你准备交给 Agent 的邮件路由到这里。</li></ol>
    <p class="setup-evidence">本实例已记录 {setup.evidence.inboundCount} 封来信。此记录用于观察应用接收情况，不证明当前 DNS 或路由仍然正确。</p>
    <p><a href="https://developers.cloudflare.com/email-service/get-started/route-emails/" target="_blank" rel="noopener noreferrer">查看收信配置文档 ↗</a></p>
    <label class="setup-confirm"><input type="checkbox" bind:checked={attestations.emailRouting} disabled={!mounted||Boolean(busy)}/><span>我已在 Cloudflare 确认 Email Routing 的 DNS、地址规则和目标 Worker。</span></label>
  </section>

  <section class="setup-card" aria-labelledby="setup-sending"><div class="setup-heading"><span class="setup-step" aria-hidden="true">5</span><div><h2 id="setup-sending">Email Sending 发信</h2><p>发信与收信需要分别开通和验收。</p></div><span class="badge" class:active={setup.config.sendingEnabled}>{setup.config.sendingEnabled?'存在 EMAIL 绑定':'未启用发送绑定'}</span></div>
    {#if setup.config.sendingEnabled}<ol class="setup-instructions"><li>在 Cloudflare Email Sending 完成发送域名接入及其要求的 DNS 验证。</li><li>按控制台提供的记录检查 SPF、DKIM 等；结合域名用途配置 DMARC，避免自行猜测验证值。</li><li>核对账户套餐、收件人限制及事务邮件适用范围。只存在 EMAIL 绑定不代表已获准向任意收件人发送。</li></ol>
      <p class="setup-evidence">发送服务已接受 {setup.evidence.acceptedSendCount} 次提交。已接受不表示已送达；本地模拟记录也不能替代云端投递验收。</p>
      <p><a href="https://developers.cloudflare.com/email-service/get-started/send-emails/" target="_blank" rel="noopener noreferrer">查看发送域名接入文档 ↗</a></p>
      <label class="setup-confirm"><input type="checkbox" bind:checked={attestations.emailSending} disabled={!mounted||Boolean(busy)}/><span>我已在 Cloudflare 确认 Email Sending、发送域名、DNS 和账户发送限制。</span></label>
    {:else}<p>当前构建未绑定 EMAIL，可以先完成收信初始化。需要发送时，在部署配置启用绑定并完成域名接入后重新部署，再回到向导确认。</p>{/if}
    <p class="helper">向导不会发送测试邮件。真实发送请在“草稿与发送”中核对收件人、审批和发送额度后显式提交。</p>
  </section>

  <section class="setup-card" aria-labelledby="setup-mailbox"><div class="setup-heading"><span class="setup-step" aria-hidden="true">6</span><div><h2 id="setup-mailbox">邮箱和 Agent 连接</h2><p>先创建一个邮箱，再签发最小权限凭据。</p></div><span class="badge" class:active={setup.evidence.activeMailboxCount>0}>{setup.evidence.activeMailboxCount>0?'已有启用邮箱':'需要创建邮箱'}</span></div>
    <p>已启用 {setup.evidence.activeMailboxCount} 个邮箱。先保存本页的确认记录，再创建邮箱；返回向导后点击“刷新检查”。</p>
    <div class="setup-actions"><a class="button" href="/owner/mailboxes?create=1" onclick={leaving}>创建或管理邮箱</a><a class="button" href="/owner/oauth/grants" data-sveltekit-reload onclick={leaving}>管理 MCP 授权</a></div>
    <dl class="setup-metadata"><div><dt>Agent API</dt><dd><code>{setup.config.apiOrigin}/v1/mailbox</code></dd></div><div><dt>MCP / OAuth</dt><dd><code>{setup.config.apiOrigin}/mcp</code></dd></div></dl>
    <p class="helper">静态 Token 从邮箱设置签发；OAuth 客户端通过发现和 Owner 同意获得该邮箱权限。默认先授予 mail:read，发送需额外 scope 和原有审批。</p>
  </section>

  <section class="setup-card setup-finish" aria-labelledby="setup-finish"><div class="setup-heading"><span class="setup-step" aria-hidden="true">7</span><div><h2 id="setup-finish">保存初始化记录</h2><p>完成向导记录后，继续进行真实收发与目标客户端验收。</p></div></div>
    <div class="field"><label for="setup-display-name">实例名称</label><input id="setup-display-name" bind:value={displayName} maxlength="80" autocomplete="off" disabled={!mounted||Boolean(busy)}/></div>
    {#if !finishReady}<p class="helper">完成前需要：有效部署配置、可访问的完整数据库/R2、至少一个启用邮箱，以及所有适用的人工确认。</p>{/if}
    <div class="setup-actions"><button type="button" disabled={!mounted||Boolean(busy)||!displayName.trim()} onclick={()=>save(false)}>{busy==='save'?'保存中…':'保存确认记录'}</button><button type="button" class="primary" disabled={!mounted||Boolean(busy)||!finishReady} onclick={()=>save(true)}>{busy==='complete'?'完成检查中…':'完成初始化'}</button>{#if dirty}<span class="helper">有未保存的更改</span>{/if}</div>
    {#if setup.instance.state==='ready'}<p class="setup-result">向导完成状态已保存。此状态记录资源检查和 Owner 确认，不表示所有外部邮件服务已通过投递验收。</p>{/if}
  </section>
</div>
