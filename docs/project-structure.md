# SvelteKit 单 Worker 项目结构

当前包括多邮箱控制台、阅读、发送、MCP/OAuth 和初始化向导。完整产品的目标仍见[架构](architecture.md)与[API/MCP 契约](api-mcp.md)，本地启动步骤见[开发说明](development.md)，部署见[部署与初始化](deployment.md)。

## 实际目录

```text
src/
  app.html / app.d.ts                 HTML 模板与 App.Locals
  hooks.server.ts                    HTTP 请求认证、Origin 与错误边界
  lib/server/core/
    types.ts                         显式 RuntimeEnv、Actor、能力声明
    auth.ts                          Owner Access JWT、邮箱 Token 与独立 scopes
    crypto.ts                        SHA-256、派生对象 UUIDv8
    storage.ts                       流大小限制、envelope 地址规范化
    ingest.ts                        收信原文持久化、receipt 补账
    jobs.ts                          条件领取、租约、文本解析与幂等发布
    owner.ts                         多邮箱与 Token 生命周期、原子审计
    mail.ts                          分页、正文授权、Owner 阅读状态
    mail-html.ts                     HTML 白名单清洗、预算、纯文本投影和文档 CSP
    mail-images.ts                   Owner 显式许可后的公网图片代取、流预算及栅格格式校验
    mail-cid.ts                      CID URL 与 Content-ID 的严格规范化和一次解码
    mail-cid-images.ts               本邮件 CID 唯一匹配、复用附件授权和 R2 完整性读取
    outbound-content.ts              地址/正文校验、回复头与本地 Sent EML
    outbound-html.ts                 绑定草稿版本/hash 的 Owner 清洗预览与 CID 字节读取
    outbound.ts                      草稿、审批、冻结、幂等、额度与取消
    outbound-jobs.ts                 原生 EMAIL 调用、租约与 unknown 防重发
    delivery-events.ts               提供商事件来源校验、持久去重、关联与逐收件人状态补账
    recipient-suppressions.ts          永久退信/投诉证据、发送阻止、Owner解除与候选地址检查
    cloudflare-suppression-config.ts   Worker Secret配置验证，仅导出公开账户/域身份
    cloudflare-suppression-policy.ts   适用发信域缓存查询与原子发送SQL条件
    cloudflare-suppressions.ts          固定Cloudflare API、完整快照、共享租约、幂等解除与本地CAS
                                       同步/解除历史、只读对账、重试父子关系和追加式日志
    async-alert-notification-exports.ts  Owner后台导出幂等任务、权限、配额、进度及取消
    async-alert-notification-export-jobs.ts scheduled分批处理、租约检查点、私有R2分片和过期清理
    async-alert-notification-export-format.ts CSV/JSON分块正文及完整文件封装
    async-alert-notification-export-download.ts Owner安全流式拼接下载、状态/过期及校验和检查
    async-export-notifications.ts       终态通知快照、Owner分页/详情/确认、全局提醒和有界事件投影
    async-export-notification-admission.ts 独立通知准入收据、复用邮箱策略及重复限频
    async-export-notification-deliveries.ts Owner通知决定、发布/投递汇总、分页与尝试/手动重试历史
    async-export-notification-delivery-shared.ts 严格绑定通知快照、事件与冻结投递内容
    async-export-notification-retry.ts Owner幂等CAS重排队、实时策略及冻结凭据校验
    async-export-notification-retry-batches.ts Owner固定候选预览、双UUID幂等确认、配额和批次/结果分页
    retry-batch-notifications.ts 批次完成/异常快照、Owner确认与事件投影
    retry-batch-notification-admission.ts 精确快照验签关联、邮箱策略与独立限频指纹
    async-export-notification-retry-controls.ts Owner取消、原收据对账及幂等操作历史
    async-export-notification-retry-batch-shared.ts 原子进度汇总与取消状态保留
    async-export-notification-retry-batch-jobs.ts 每轮5项重新排队、租约围栏和未知结果只读对账
    oauth.ts                         客户端、Owner 同意、授权及撤销管理
    oauth-tokens.ts                  PKCE、受众、刷新轮换及凭据校验
    oauth-http.ts                    发现、注册、token/revoke 和 CORS
    setup.ts                         结构检查、配置指纹、Owner 确认与 R2 探针
    attachment-ingest.ts              MIME 附件预算、不可变 R2 派生对象
    attachment-metadata.ts            文件名、类型和 CID 规范化
    attachments.ts                    附件列表、归属权限和校验后二进制下载
    draft-attachments.ts              草稿文件、不可变清单及有界分块上传
  lib/server/mcp/
    server.ts                        官方 MCP handler、请求边界及独立实例
    tools.ts                         最多22个工具、实时 scope、邮件/事件/投递分页、抑制检查和文件上传
  lib/server/svelte/api.ts            业务错误到 HTTP 状态码的转换
  lib/server/svelte/owner.ts          Owner 请求上下文与有界 JSON 输入
  lib/server/svelte/mail-html-api.ts   Owner HTML 文档、只读元数据及 POST 图片许可
  lib/server/svelte/async-export-notifications-api.ts Owner终态通知查询与确认API
  lib/server/svelte/async-export-notification-deliveries-api.ts Owner投递追踪与安全重试API
  lib/components/owner/              控制台布局、表单、对话框、Token 表格
  routes/
    +layout.ts                       禁止 prerender
    +page.svelte                     公开的基础服务说明，无邮箱数据
    healthz/+server.ts               极简公开存活检查
    setup/+page.svelte               无实例详情的公开部署引导
    owner/setup/                     Owner 初始化向导
    owner/api/setup/                 初始化 GET/POST 与显式 probe
    owner/api/setup/checks/+server.ts Owner JWT 保护的只读绑定检查
    owner/mailboxes/                 邮箱列表、创建、详情与管理页面
    owner/mailboxes/[id]/messages/    邮件列表与正文阅读
    owner/api/mailboxes/[id]/messages/[messageId]/html/  默认沙箱文档及 POST 图片许可
    owner/mailboxes/[id]/outbound/    草稿、审批及发送记录
    owner/oauth/authorize/           Access 保护的邮箱与 scope 同意页面
    owner/oauth/grants/              OAuth 访问授权管理
    owner/api/mailboxes/             邮箱与邮箱级 Token 管理 API
    owner/api/mailboxes/[id]/export-notifications/ 导出完成/失败通知、详情与版本确认
    v1/mailbox/+server.ts             当前 Token 的邮箱和能力
    v1/messages/+server.ts            当前邮箱筛选与双向游标分页
    v1/messages/[messageId]/          当前邮箱的安全文本正文
    v1/drafts/ / v1/outbound/          Token 草稿、请求发送与状态
    mcp/+server.ts                    Bearer 保护的无会话 Streamable HTTP
worker/
  entry.ts                           唯一部署入口
  handlers/email.ts                  原生收信
  handlers/scheduled.ts              原生定时任务
  handlers/delivery-events.ts         原生 Queue 与可选自建 HMAC HTTP 桥接
migrations/0001_initial.sql           22 张 STRICT 表与触发器
migrations/0002_oauth.sql             7 张 OAuth 表及身份/范围约束
migrations/0003_setup.sql             实例初始化确认与配置指纹，保留 29 张表
migrations/0004_attachments.sql       区分未提取与已索引附件，保留 29 张表
migrations/0005_draft_attachments.sql  草稿附件与分块上传三表，共32张STRICT表
migrations/0006_webhooks.sql          事件发布标记、签名快照与尝试日志，共33张STRICT表
migrations/0007_email_delivery_events.sql 提供商事件收件箱与收件人排序字段，共34张STRICT表
migrations/0008_recipient_suppressions.sql 永久退信证据、邮箱级抑制与Owner解除水位，共35张STRICT表
migrations/0009_cloudflare_suppressions.sql 服务端快照、同步租约和解除操作三表，共38张STRICT表
migrations/0010_cloudflare_suppression_history.sql 执行、对账与不可修改时间线三表，共41张STRICT表
migrations/0011_cloudflare_suppression_alerts.sql 持久告警、追加变化及投影水位三表，共44张STRICT表
migrations/0012_alert_notification_policies.sql 邮箱通知策略、准入决策及限频状态三表，共47张STRICT表
migrations/0013_alert_notification_decision_indexes.sql 决策原因分页与事件投递查询索引，仍为47张表
migrations/0014_async_alert_notification_exports.sql 异步导出任务及不可变分片清单，完成后共49张STRICT表
migrations/0015_async_export_notifications.sql 导出终态快照、确认与准入收据、独立限频状态，完成后共51张STRICT表
migrations/0016_export_notification_delivery_history.sql 既有审计的资源/动作/时间查询索引，保持51张STRICT表
migrations/0017_export_notification_retry_batches.sql 批量重试固定预览与逐项执行结果
migrations/0018_export_notification_retry_controls.sql 不可撤销取消标记
migrations/0019_retry_batch_notifications.sql 批次完成与异常通知快照，当前54张STRICT表
scripts/
  deploy.mjs / deploy/                本地/CI 资源预配、迁移和单 Worker 发布
  sync-svelte-config.mjs              从根配置派生 adapter 配置
  seed-local.mjs                     本地邮箱与只读 Token fixture
  validate-schema.mjs                结构检查、字段字典生成
  validate-svelte-config.mjs          配置和输出路径防护
tests/
  deploy/                            控制面 HTTP 和中断恢复测试，无真实云调用
  unit/core.test.ts                  认证和输入边界
  unit/persistence.test.ts           真实 D1/R2、失败路径和旧租约
  unit/owner.test.ts                 角色、并发修改与退役交错
  unit/mail.test.ts                  分页位置、正文对象、幂等阅读状态
  unit/setup.test.ts                 初始化与配置变更、并发、探针失败
  integration/worker.test.mjs        最终 bundle 原生事件与 HTTP
  integration/owner.test.mjs         真实 JWT、Origin 与管理 API
  integration/mail.test.mjs          最终 bundle 阅读/分页权限边界
  integration/setup.test.mjs         真实 JWT/Origin、资源探针、配置漂移和诊断
  helpers/owner-runtime.mjs          仅测试用签名密钥与固定 JWKS 网络适配器
  e2e/owner.test.mjs                 桌面/手机浏览器完整管理流程
  e2e/mail.test.mjs                  桌面/手机阅读、筛选、分页、安全文本
  e2e/setup.test.mjs                 桌面/手机初始化完整流程
  fixtures/inbound.eml               包含文本和附件的邮件 fixture
vite.config.ts                       SvelteKit 3 + adapter-cloudflare
vitest.config.ts                     核心服务测试
wrangler.jsonc                       唯一部署配置，main 为 wrapper
deploy.config.example.json           个人部署输入模板，真实输入被 Git 忽略
.github/workflows/deploy.yml          手动点击运行的个人部署
wrangler.svelte.jsonc                 自动生成，不提交、不单独部署
pnpm-lock.yaml / pnpm-workspace.yaml  锁定依赖与允许的构建脚本
.svelte-kit/cloudflare/_worker.js     adapter 生成的 HTTP 模块
.svelte-kit/cloudflare/               公共静态资源；.assetsignore 排除服务端入口
dist/worker/entry.js                  Wrangler dry-run 的最终 bundle
```

生成目录、依赖、Token 输出和本地状态不提交。`#lib/*` 使用 package imports；TypeScript 路径包含文件扩展名。Kit 3 的 tsconfig 继承 `$app/tsconfig`，adapter 配置位于 Vite 插件，绑定通过 `cloudflare:workers` 读取。

## 一个部署对象，三类原生入口

`worker/entry.ts` 默认导出一个 `ExportedHandler<RuntimeEnv>`：

| 入口 | 当前行为 | 身份与持久化 |
| --- | --- | --- |
| fetch | 公开 OAuth 协议局部分流，其余委托 SvelteKit | hooks 验证 Owner/邮箱及 OAuth；Owner CSRF 保持启用 |
| email | 调用 handleEmail → ingestEmail | 从可信 envelope 收件地址映射邮箱；await D1/R2 关键写入 |
| scheduled | handleScheduled → 解析、发送、事件/Webhook、异步导出及终态通知投影 | 内部有界批处理；先处理既有Webhook，再生成导出及每轮至多20条终态事件，新事件下轮投递 |

native email/scheduled 不经过 hooks，也不通过 HTTP 回调自己。core 只接受显式 env/job/actor，不依赖 SvelteKit RequestEvent、模块别名或请求全局状态。wrapper 与 core 之间使用可由 Wrangler 解析的相对路径。

最终入口导出 fetch/email/scheduled/queue；发送使用 EMAIL binding，由同一 scheduled handler 派发。可选 Email Sending 专用 Queue 将投递事件交给同一 Worker；来源校验、去重和逐收件人状态同步见[投递事件配置](email-delivery-events.md)。accepted 不等于 delivered；格式错误的发送任务标记 dead，不假装完成。

Owner 后台导出通过 `/owner/api/mailboxes/{id}/alert-notification-exports` 创建/分页查询任务，单任务 GET、`cancel` 和 `download` 复用同一 HTTP 入口。scheduled 分批写入私有 R2，下载经 Owner 鉴权后流式拼接；任务和分片由0014迁移管理，仍只部署一个 Worker。详见[异步导出](async-alert-notification-export.md)。

0015迁移通过 D1 触发器随任务终态原子保存完成/失败通知，不回填历史终态。Owner 从全局提醒或邮箱列表进入通知详情，以独立版本确认知悉；后台把不可变通知投影为两个 Owner 专属 Webhook 类型，沿用邮箱策略、HMAC和投递重试。准入记录独立保存，不混入原抑制决策统计。详见[导出终态通知](async-export-notifications.md)。

Owner `.../export-notifications/{jobId}/delivery-results` 查询绑定当前通知事件的决定、发布进度、完整汇总及投递分页，`.../deliveries/{deliveryId}` 查看最多80次尝试与10条手动重试审计。重试 POST 使用操作UUID和 expectedUpdatedAt，只重排队已准入的 dead 投递，不重评原跳过决定。通用 Webhook 重试入口对导出事件也调用同一内核，继续使用单 Worker。详见[投递追踪](async-export-notification-deliveries.md)。

## 认证边界

公开首页和 healthz 不返回任何邮件、Token 或绑定详情。`/owner/*` 验证 Access JWT 的签名、issuer、audience、exp 和 Owner email；未配置默认拒绝，不接受身份提示头或首访者认领，也没有可部署的开发旁路。

`/v1/*` 与 `/mcp` 验证 Bearer Token 摘要、有效期、撤销状态和邮箱 active 状态。只读 API 再检查 can_read，并固定使用认证结果中的 mailbox_id，忽略调用方传来的其他邮箱 ID。敏感响应使用 no-store；Owner 写入还必须来自 console Origin。

Owner 管理界面、邮箱与 Token 生命周期已实现，详见[控制台说明](owner-console.md)。本地 fixture 由 CLI/测试生成，不暴露无认证初始化路由。Token 明文仅在签发时返回，页面加载和列表中不含明文或摘要。

## 存储与任务边界

收信先有界读取实际流，再创建 pending 对象与 receipt，随后写私有 R2，最后以 D1 batch 标记 ready/stored 并创建唯一解析任务。应用上限 10 MiB，邮箱可设置更低限额；不会信任单独的 rawSize 声明。

scheduled 先恢复 R2 成功/D1 最终提交失败的 receipt，再用单条 UPDATE RETURNING 条件领取任务。发布邮件、地址、对象、事件及 ACK 的所有 D1 语句都在同一 batch 内验证当前 lease，旧 Worker 不能发布部分记录。失败路径也使用 lease CAS。派生文本正文使用版本化 key、条件写入和冲突校验。

当前每封独立投递创建独立 receipt，不使用 Message-ID 冒充投递 ID。重复解析同一 receipt 不会增加第二封邮件或附件。正文 v3 将 HTML 保存在私有 R2，由 Owner 专用服务在校验后清洗展示；普通 API/MCP 仍只返回文本。附件另存 R2，D1 保存关联与未扫描状态，下载检查归属和校验和；Owner HTML 可将本邮件唯一 CID 对应的安全栅格图片内嵌到空沙箱。线程当前一封邮件一条，完整会话归并留待后续。

## 构建与部署契约

1. 从根 `wrangler.jsonc` 同步生成 adapter 专用配置。
2. Vite 构建 SvelteKit；adapter 的 main 只指向 `.svelte-kit/cloudflare/_worker.js`。
3. Wrangler 使用**根配置**打包 `worker/entry.ts`，将生成 HTTP 模块和原生 handlers 合为一个 bundle。
4. 本地 dry-run 与集成测试通过后，才由部署者配置真实资源、域名和 Access 并执行远程验收。

不能让 adapter 直接读取根配置：它会将配置中的 main 当成输出文件。当前连续两次构建已检查 wrapper 与根配置内容未变。ASSETS 保持 `run_worker_first: true`；R2 不作为公共资产发布。

## 后续目录与能力

发送、审批、幂等、额度、MCP、OAuth、附件、HTML 阅读/发送、Webhook 通知、服务商投递事件、退信/投诉抑制及初始化向导已实现。后续通用附件预览、线程归并、STDIO 桥接及公开 release Deploy 按钮继续遵守[架构](architecture.md)和[部署发布门槛](deployment.md)。
