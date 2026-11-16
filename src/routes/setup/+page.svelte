<svelte:head><title>开始部署与初始化 · Agent Mail</title><meta name="description" content="Agent Mail 个人自部署初始化说明"/></svelte:head>
<main class="bootstrap"><a class="bootstrap-brand" href="/">Agent Mail</a><p class="bootstrap-tag">个人自部署</p><h1>开始部署与初始化</h1><p class="bootstrap-lead">把邮箱放在自己的 Cloudflare 账户中，再为每个 Agent 分配独立访问权限。</p>
  <p>本页提供通用接入说明，不保存部署配置，也不创建 Cloudflare Access 应用。已经通过部署按钮完成发布时，请从<a href="#bootstrap-access">配置 Owner 与 Access</a>继续，复用已有 D1、R2 和 Worker。</p>
  <section aria-labelledby="bootstrap-deploy"><span class="bootstrap-step">1</span><div><h2 id="bootstrap-deploy">创建资源并部署应用</h2><p>尚未部署时，可使用仓库中的 Cloudflare 部署按钮，或在本机将 deploy.config.example.json 复制为私有的 deploy.config.json，填写自己的部署参数。先检查离线计划，再登录 Wrangler，显式授权部署器使用本机登录：</p><pre><code>pnpm deploy:plan -- --input deploy.config.json
pnpm exec wrangler login
pnpm deploy:setup -- --input deploy.config.json --use-wrangler-login</code></pre><p>--use-wrangler-login 仅用于本机交互登录。CI 和 Workers Builds 必须通过秘密注入提供 CLOUDFLARE_API_TOKEN，并省略此参数；管理凭据不填写在本页，也不交给 Worker。已有资源需按工具说明明确选择复用。</p><p>未配置 Access 时管理入口会保持拒绝访问。配置完成后更新同一实例的部署，不重新创建资源；根配置使用自己的资源和域名，不能直接发布示例中的占位 ID。</p></div></section>
  <section aria-labelledby="bootstrap-access"><span class="bootstrap-step">2</span><div><h2 id="bootstrap-access">配置 Owner 与 Access</h2><p>在 Cloudflare Zero Trust 中创建 Self-hosted Access 应用，Allow 策略只允许自己的 Owner 邮箱。Wrangler 登录不包含 Access 管理权限；可在 Zero Trust 控制台操作，或使用另行授权的 Access API Token。</p><p>默认控制台与 Agent API 共用 workers.dev 地址时，将应用域名设为 <code>&lt;Worker主机名&gt;/owner</code>，覆盖 /owner 及其子路径。不要选择保护整个 Worker 的 Protect this Worker，否则 MCP、API 和 OAuth 也会被交互式登录拦截。</p><p>使用独立控制台和 API 域名时，将两者绑定到同一个 Worker，只对控制台域名配置 Access。Agent API、MCP 和 OAuth 公开协议端点由应用验证各自凭据。</p><p>将团队域名 ACCESS_TEAM_DOMAIN、应用 ACCESS_AUD、OWNER_EMAIL 及入口 CONSOLE_ORIGIN / API_ORIGIN 写入实际部署配置，再重新发布同一实例。本页不会接收或保存这些参数；部署后进入 Owner 向导确认当前值。</p><p><a href="https://developers.cloudflare.com/workers/configuration/cloudflare-access/" target="_blank" rel="noopener noreferrer">Cloudflare Access 覆盖范围 ↗</a> · <a href="https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/" target="_blank" rel="noopener noreferrer">应用路径与子路径规则 ↗</a></p></div></section>
  <section aria-labelledby="bootstrap-finish"><span class="bootstrap-step">3</span><div><h2 id="bootstrap-finish">登录后完成初始化</h2><p>Owner 登录后检查资源、邮件域名、Email Routing 和 Email Sending，创建第一个邮箱，再连接 Agent。向导不会自动修改 DNS 或发送测试邮件。</p><a class="bootstrap-primary" href="/owner/setup">打开 Owner 初始化向导 ↗</a><p class="bootstrap-note">尚未配置 Access 或 Owner 时，管理页面会拒绝访问。请先完成部署配置；本页不提供匿名认领或权限旁路。</p></div></section>
  <footer>此公开说明不展示实例域名、Owner 身份、应用 AUD、资源标识或访问凭据。</footer>
</main>
<style>
  :global(body){margin:0;background:#f5f4ef;color:#1c302a;font-family:system-ui,sans-serif;}
  .bootstrap{max-width:850px;padding:48px 24px 64px;margin:auto;}
  .bootstrap-brand{font-size:24px;font-weight:750;letter-spacing:-.6px;text-decoration:none;}
  .bootstrap-tag{font-size:12px;letter-spacing:.13em;font-weight:700;color:#50665a;margin-top:38px;}
  h1{font-size:clamp(34px,6vw,50px);line-height:1.25;letter-spacing:-1px;margin:12px 0 18px;}
  .bootstrap-lead{font-size:17px;line-height:1.8;max-width:680px;color:#526259;margin-bottom:32px;}
  section{display:flex;align-items:flex-start;gap:18px;padding:26px;background:#fffefa;border:1px solid #d6ddd3;border-radius:10px;margin-bottom:18px;}
  section>div{min-width:0;}
  .bootstrap-step{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;background:#edf1e8;color:#255c44;font-size:13px;font-weight:700;}
  h2{font-size:21px;margin:0 0 12px;line-height:1.5;}
  p{font-size:14px;line-height:1.9;margin:10px 0;color:#526259;}
  a{color:#255c44;text-underline-offset:4px;font-size:14px;font-weight:600;}
  a:focus-visible{outline:2px solid #255c44;outline-offset:5px;}
  pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f4ef;border:1px solid #d6ddd3;border-radius:6px;padding:13px;font:12px/1.8 ui-monospace,monospace;}
  .bootstrap-primary{display:inline-block;margin:12px 0;padding:10px 16px;background:#255c44;color:white;border-radius:6px;text-decoration:none;}
  p.bootstrap-note,footer{font-size:12px;color:#607267;line-height:1.8;}
  footer{margin-top:28px;}
  @media(max-width:600px){.bootstrap{padding:28px 20px 44px;}section{padding:21px 16px;gap:12px;}h2{font-size:19px;}.bootstrap-lead{font-size:15px;}}
</style>
