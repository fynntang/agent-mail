<svelte:head><title>开始部署与初始化 · Agent Mail</title><meta name="description" content="Agent Mail 个人自部署初始化说明"/></svelte:head>
<main class="bootstrap"><a class="bootstrap-brand" href="/">Agent Mail</a><p class="bootstrap-tag">个人自部署</p><h1>开始部署与初始化</h1><p class="bootstrap-lead">把邮箱放在自己的 Cloudflare 账户中，再为每个 Agent 分配独立访问权限。</p>
  <section aria-labelledby="bootstrap-deploy"><span class="bootstrap-step">1</span><div><h2 id="bootstrap-deploy">创建资源并部署应用</h2><p>在本机或受信的构建环境，将 deploy.config.example.json 复制为私有的 deploy.config.json，填写自己的部署参数。先检查离线计划，再创建 D1、私有 R2，执行迁移并发布同一个 Worker。</p><pre><code>pnpm deploy:plan -- --input deploy.config.json
pnpm deploy:setup -- --input deploy.config.json</code></pre><p>账号管理凭据通过本机 CLOUDFLARE_API_TOKEN 环境变量提供，不填写在此页面，也不交给 Worker。先检查部署计划；已有资源需要按工具说明明确选择复用。</p><p>未配置 Access 时管理入口会保持拒绝访问；配置后重新运行部署。根配置使用你自己的资源和域名，不把示例中的占位资源 ID 直接发布。</p></div></section>
  <section aria-labelledby="bootstrap-access"><span class="bootstrap-step">2</span><div><h2 id="bootstrap-access">配置 Owner 与 Access</h2><p>为控制台域名配置 Cloudflare Access，只允许部署者的 Owner 邮箱。将团队域名、应用 AUD、Owner 邮箱及两个入口地址写入部署配置，再发布。</p><p>Agent API 域名与控制台分开，仍绑定同一个 Worker。OAuth 的公开发现与 token 端点使用自身授权流程。</p><a href="https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/" target="_blank" rel="noopener noreferrer">Cloudflare Access 配置说明 ↗</a></div></section>
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
