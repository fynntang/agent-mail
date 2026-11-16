# Agent Mail

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Ffynntang%2Fagent-mail)
[![Deploy Worker with GitHub Actions](https://img.shields.io/badge/Deploy_Worker-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)](https://github.com/fynntang/agent-mail/actions/workflows/deploy.yml)

本仓库已公开，可通过 Cloudflare 标准按钮开始部署并配置 D1/R2，也可 Fork 后使用自己仓库的 GitHub Actions。点击前请阅读[按钮部署步骤](docs/deployment.md#部署按钮)，填写账户、邮件域名及 Owner 邮箱；Access、邮件路由和发送服务通过部署后的向导配置。

面向个人自部署的 Agent 邮箱服务：一个 Cloudflare 账户中运行一个实例，管理多个独立邮箱，为不同 Agent 签发严格绑定邮箱的 Token，逐步提供 API / MCP 收发邮件能力。

技术栈为 SvelteKit + TypeScript + Cloudflare Workers + D1（SQLite）+ 私有 R2。保持单 Worker：SvelteKit处理HTTP，自定义入口同时处理email、scheduled和可选queue。个人控制台由Cloudflare Access保护，无需中心化账号、租户、订阅计费或必需的LLM服务。

**当前状态：支持多邮箱与 Token 管理、安全 HTML 阅读、双正文/CID 图片发送、附件、回复与 Owner 审批、Cloudflare Email Sending、邮箱事件与 HMAC Webhook、带 OAuth 的 MCP，以及部署工具和 Owner 初始化向导。保持单 Worker + D1 + 私有 R2。通用附件预览尚未实现。**

部署到自己的账户：复制并填写 `deploy.config.example.json` 为 `deploy.config.json`，先运行 `pnpm deploy:plan -- --input deploy.config.json` 查看离线计划；设置终端环境变量 `CLOUDFLARE_API_TOKEN` 后，运行 `pnpm deploy:setup -- --input deploy.config.json` 自动创建 D1/R2、构建、迁移和部署。也提供手动触发的 GitHub Actions。部署后通过 `/setup` 引导配置 Access，再进入 `/owner/setup` 确认域名、路由、发送和邮箱。完整步骤与中断恢复见[部署与初始化](docs/deployment.md)。

需要 Node.js 24、pnpm 11.25.0。首次启动：

```sh
pnpm install --frozen-lockfile
pnpm build:worker
pnpm db:local
pnpm local:seed research
pnpm preview
```

访问 `http://127.0.0.1:8787/`。seed 显示本地邮箱的只读 Token；Owner 管理接口仍需要真实 Access JWT，没有开发认证旁路。根配置的云端资源 ID 仍为占位符，不要直接部署。

Owner 控制台入口为 `/owner/mailboxes`，Access 配置、管理 API 和本地浏览器测试见 [Owner 控制台说明](docs/owner-console.md)。

点击邮箱名称进入阅读界面，支持文件夹/阅读状态筛选与前后翻页。打开邮件不会自动改为已读；详细行为和只读 Agent API 见[邮件阅读与分页](docs/mail-reader.md)。附件保存到私有 R2，邮件读取权限可看元数据，内容下载另需 `attachments:read`；Owner 页面及 API/MCP 均可使用，详见[附件解析与下载](docs/attachments.md)。

Owner 阅读页可切换安全 HTML：服务端清洗后在空权限沙箱中显示，CID 图片仅从当前邮件的已校验附件读取并内嵌，远程图片默认屏蔽。明确确认后，同一 Worker 有界下载并校验远程图片，无需远端支持 CORS；切换邮件或纯文本会重置远程许可。API/MCP 保持文本输出，详见[HTML 邮件阅读](docs/html-mail.md)。

Owner、API/MCP 草稿支持 HTML/文本双正文和当前草稿附件的 CID 绑定，复用版本审批及冻结发送。Owner 可核对原始源码与安全沙箱预览，Sent 可阅读 HTML 和内嵌图片，详见[HTML 邮件发送](docs/html-sending.md)。

“草稿与发送”页面支持保存、编辑、附件上传/移除、审批、提交和取消排队发送；阅读页可创建回复。附件变更会递增版本并清除旧审批。Token 的 `mail:draft` / `mail:send` 独立授权，默认需要 Owner 审批。发送结果未知时不会自动重发。详见[邮件发送与审批](docs/mail-sending.md)及[草稿附件发送](docs/outbound-attachments.md)。

Agent 可连接 `https://<API 域名>/mcp`，使用同一邮箱级 Bearer Token 查询邮件/事件/投递、检查收件人抑制、获取附件、分块上传草稿文件、回复和请求发送。最多22个工具按权限开放，兼容已验证的现代2026与旧版2025协议，回复只创建草稿，发送沿用 Owner 审批。详见[MCP 接入与示例](docs/mcp.md)。

Owner 可按邮箱订阅邮件事件，配置签名 Webhook、轮换密钥、查看投递与失败重试。启用前应用 `0006_webhooks.sql` 并配置 Worker secret `WEBHOOK_KEYRING`，详见[Webhook 配置与验证](docs/webhooks.md)。

Cloudflare Email Sending 投递事件通过专用 Queue 接入同一 Worker，支持 delivered/deferred/bounced/failed/rejected/complained、事件去重和状态同步，并联动 Owner、API/MCP 与邮箱 Webhook。启用前应用 `0007_email_delivery_events.sql` 并配置事件来源；可选自建 HTTP 桥接支持 HMAC 验签，详见[投递事件配置](docs/email-delivery-events.md)。

永久退信（明确 hard）和投诉会自动加入邮箱级抑制名单，阻止向对应收件人发送整封邮件；Owner 可查看并解除，Agent 可通过 API/MCP 检查候选地址。应用 `0008_recipient_suppressions.sql` 后启用，详见[抑制名单](docs/recipient-suppressions.md)。

Owner 可同步 Cloudflare 服务端抑制并解除可修改记录，选择联动当前邮箱本地名单。应用 `0009_cloudflare_suppressions.sql`，使用专用 Worker Secret 保存 Cloudflare API Token；部署配置、作用域确认及未知结果处理见[Cloudflare 抑制管理](docs/cloudflare-suppressions.md)。

同步和解除支持 Owner 执行历史、失败时间线、未知结果只读核对及明确确认后的安全重试。应用 `0010_cloudflare_suppression_history.sql`，不新增凭据或 Worker，详见[执行历史与重试](docs/cloudflare-suppression-history.md)。

同步/解除失败和未知结果支持 Owner 持久告警、确认知悉及恢复通知，Webhook 沿用 HMAC、失败重试和投递记录；Agent 无法枚举运维告警。应用 `0011_cloudflare_suppression_alerts.sql`，详见[抑制操作告警](docs/cloudflare-suppression-alerts.md)。

Owner 可按邮箱配置告警 Webhook 开关、IANA 时区静默时段、重复告警限频及恢复通知，控制台历史完整保留；已排队通知响应关闭和静默设置。应用 `0012_alert_notification_policies.sql`，详见[通知策略与降噪](docs/alert-notification-policy.md)。

Owner 可查看通知决策、跳过原因、静默/限频命中和降噪统计，按原因、通知类型及时间窗口分页查询，并关联告警和实际 Webhook 投递。应用只增加索引的 `0013_alert_notification_decision_indexes.sql`，详见[决策记录与统计](docs/alert-notification-decisions.md)。

通知决策可按相同筛选同步导出 CSV/JSON，包含完整范围内的统计及订阅投递结果，支持取消和超限提示；同步接口保留既有语义，详见[导出格式与边界](docs/alert-notification-export.md)。

大批量 CSV/JSON 可创建后台导出任务，由同一 Worker 的 scheduled 分批生成并暂存私有 R2；Owner 可查看进度、取消、安全下载，文件创建后24小时过期并由后台清理。应用 `0014_async_alert_notification_exports.sql` 后共49张表，详见[异步导出](docs/async-alert-notification-export.md)。

后台导出完成或最终失败会保留 Owner 提醒，可查看详情并确认知悉；邮箱可订阅两个专属 Webhook 事件，沿用 HMAC、重试及现有开关/静默/限频策略。导出完成不属于故障恢复，通知不会混入抑制操作决策统计或改变导出格式。应用 `0015_async_export_notifications.sql` 后共51张表，详见[导出完成与失败通知](docs/async-export-notifications.md)。

Owner 可在导出通知详情追踪原通知决定、跳过原因、发布进度和 Webhook 投递/重试记录，并安全重试已准入且最终失败的投递。重试沿用原事件和签名快照，以操作 UUID 和版本防重复调度，仍受当前策略约束。应用只增加审计查询索引的 `0016_export_notification_delivery_history.sql`，仍为51张表，详见[通知投递追踪与手动重试](docs/async-export-notification-deliveries.md)。

失败导出通知可按当前邮箱、失败时间和安全原因筛选，先预览固定的最多1000条候选，再明确确认后台批量重试。预览及提交各自使用 UUID 幂等核对，后台每轮最多处理5项并保留逐项结果；未知结果只读对账，不盲目重排。应用 `0017_export_notification_retry_batches.sql` 后共53张表，详见[批量重试](docs/async-export-notification-retry-batches.md)。

批量任务可停止尚未执行的条目、手动核对未知收据并分页查看操作历史，已执行结果保留。应用0018迁移后仍为53张表，复用Owner权限与现有幂等收据，详见[取消与未知结果对账](docs/async-export-notification-retry-controls.md)。

批量任务支持完成、失败及待对账提醒，Owner 可确认、查看快照及定位原任务，邮箱级 Webhook 沿用通知策略、签名和自动重试。应用0019后共54张表，详见[批次完成与异常通知](docs/retry-batch-notifications.md)。

批次通知的失败投递可按当前邮箱、时间及安全原因冻结预览，明确确认后由后台每轮最多5项重新排队，保留幂等进度和逐条结果。独立任务表不再生成自身通知，避免递归重试；应用0020后共56张表，详见[通知失败投递批量重试](docs/retry-batch-notification-retry-batches.md)。

Owner 可停止通知重试任务尚未执行的条目，保留已执行结果；运行中或未知条目通过原幂等收据核对，支持单条/批量操作和分页历史。取消与对账不增加重试预算、不生成递归通知，本轮复用0020无需新迁移，详见[通知重试任务取消与未知结果对账](docs/retry-batch-notification-retry-controls.md)。

OAuth 客户端可通过发现、动态注册、PKCE 和 Owner 授权页连接，Owner 选择单个邮箱与权限并可撤销访问。已有实例需按序应用待迁移文件（当前最新 `0020_retry_batch_notification_retry_batches.sql`），静态 Token 保持可用且不会自动获得收件附件下载权限。详见[OAuth 接入与部署](docs/oauth.md)。

```sh
pnpm check
pnpm test
pnpm test:e2e
```

测试使用本地 workerd、真实 D1/R2 模拟绑定和最终 bundle，不触发真实发信或远程部署。详见[本地开发、事件触发与验证范围](docs/development.md)。

- [技术方案](docs/architecture.md)
- [本地开发与验证](docs/development.md)
- [Owner 控制台与 Access 配置](docs/owner-console.md)
- [邮件阅读与分页 API](docs/mail-reader.md)
- [HTML 清洗、沙箱及图片许可](docs/html-mail.md)
- [附件解析、权限与安全下载](docs/attachments.md)
- [草稿附件上传、分块与审批发送](docs/outbound-attachments.md)
- [邮件发送、回复与审批 API](docs/mail-sending.md)
- [SvelteKit项目目录与单Worker接入](docs/project-structure.md)
- [数据库字段、约束与关系](docs/database.md)
- [D1 初始迁移](migrations/0001_initial.sql) · [初始化增量迁移](migrations/0003_setup.sql) · [参考快照](docs/schema.sql)
- [API 与 MCP 契约](docs/api-mcp.md)
- [MCP 连接、工具与权限](docs/mcp.md)
- [MCP OAuth 授权与迁移](docs/oauth.md)
- [开源发布与一键部署设计](docs/deployment.md)
- [本地结构验证与限制](docs/validation.md)

验证环境需要支持 `node:sqlite` 的 Node.js 24：

```sh
node scripts/validate-schema.mjs
node scripts/validate-schema.mjs --dictionary
node scripts/validate-svelte-config.mjs
```

Email Sending 当前为 Beta，限定事务性邮件；向任意收件人发送需要 Workers Paid。应用保留可替换的发送适配器。[官方服务说明](https://developers.cloudflare.com/email-service/)、[适用范围](https://developers.cloudflare.com/email-service/reference/faq/)。

部署工具及按钮入口已通过本地模拟验证；尚未执行真实 Cloudflare 账户安装或发布公开 release。标准按钮指向本仓库，依赖仓库公开可访问；生产安装建议在克隆后固定已审阅的提交或 release。

唯一部署入口为 `worker/entry.ts`，adapter 只读取生成的 `wrangler.svelte.jsonc`。三个原生 handler 使用同一份最终 bundle。根配置含 `EMAIL` 发送绑定；本地使用模拟发送，真实发送需在自己的账户开通 Email Sending 并验证域名。

批量任务通知支持Owner查看原决定/跳过原因、投递状态、传输尝试和手动重试收据。重新排队复用原冻结身份、当前策略及UUID/版本幂等，专用和通用Webhook入口采用相同校验；无新迁移或绑定，仍54张表。详见[批次通知投递追踪](docs/retry-batch-notification-deliveries.md)。
