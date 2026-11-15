<svelte:head>
  <title>Agent Mail · 个人邮箱</title>
  <meta name="description" content="个人自部署的 Agent 邮箱基础服务" />
</svelte:head>

<main>
  <span class="tag">AGENT MAIL / SELF-HOSTED</span>
  <h1>每个 Agent，<br />一个独立邮箱。</h1>
  <p>你的 Cloudflare 账户，你的邮件数据。为不同 Agent 分配邮箱和访问凭证。</p>
  <section aria-label="当前实现状态">
    <h2>基础服务已就绪</h2>
    <ul>
      <li>SvelteKit HTTP 与原生邮件事件运行在同一个 Worker。</li>
      <li>D1 保存邮件索引，私有 R2 保存原文和正文。</li>
      <li>定时任务负责解析来信，并恢复未完成的持久化任务。</li>
    </ul>
    <p class="note">Owner 控制台支持邮件阅读、草稿、回复、发送审批，以及邮箱和凭据管理。Agent 可通过邮箱级 Token 或 OAuth 授权使用 MCP 工具。</p>
    <a href="/owner/mailboxes">打开 Owner 控制台 <span aria-hidden="true">↗</span></a>
    <span aria-hidden="true"> · </span><a href="/healthz">检查 HTTP 服务</a>
  </section>
  <footer>Owner 接口需要 Cloudflare Access；邮箱 API 需要独立 Token。</footer>
</main>

<style>
  :global(body) { margin: 0; background: #f5f4ef; color: #1c302a; font-family: system-ui, sans-serif; }
  main { max-width: 760px; padding: 70px 24px; margin: auto; }
  .tag { font-size: 12px; letter-spacing: .13em; font-weight: 700; color: #50665a; }
  h1 { font-size: clamp(38px, 7vw, 64px); line-height: 1.16; letter-spacing: -.04em; margin: 30px 0 20px; }
  p, li { line-height: 1.8; }
  section { margin-top: 45px; padding: 28px; background: #fffefa; border: 1px solid #d6ddd3; border-radius: 12px; }
  h2 { margin-top: 0; font-size: 20px; }
  ul { padding-left: 20px; }
  .note, footer { color: #526259; font-size: 14px; }
  a { display: inline-block; color: #255c44; padding: 10px 0; text-underline-offset: 5px; font-weight: 650; }
  a:focus-visible { outline: 2px solid #255c44; outline-offset: 5px; }
  footer { margin-top: 24px; }
</style>
