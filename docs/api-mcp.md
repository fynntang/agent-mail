# 个人版 API 与 MCP 契约

本文件包含当前实现及标注的目标契约。当前实现邮箱/正文/搜索/分页、附件解析与下载、Owner 管理、草稿/回复/审批/发送、事件轮询、Webhook、收件人抑制及 MCP/OAuth。附件字段与安全下载见[附件说明](attachments.md)，发送见[邮件发送 API](mail-sending.md)，MCP 接入见[MCP 服务](mcp.md)。实例有一个 Owner，多个邮箱；Agent Token 严格绑定一个邮箱，所有资源使用不透明 UUID。

## 1 身份与路由

控制台与管理接口规划位于 console origin，受 Access 和 Worker 内 Owner JWT 校验保护；Agent API/MCP 位于 api origin，使用 `Authorization: Bearer am_<UUID>_<base64url-secret>`。secret 为 32 个随机字节，D1 存储完整 Token 的 SHA-256 摘要。两个入口绑定同一 Worker，不将交互式 Access 登录强加给 Agent。

HTTP 全部由同一 Worker 中的 SvelteKit 路由承载。hooks.server.ts 按路径验证请求、Origin 并建立 locals 身份；core 校验 scope 与邮箱归属，HTTP 适配层将业务错误转换为正确状态码。当前公开首页仅展示开发状态；所有私有页面必须动态处理，ASSETS 保持 Worker 优先执行。真实域名入口配置在远程发布前单独验收。[项目目录与原生事件接入](project-structure.md)

| 主体 | 入口 | 权限 |
| --- | --- | --- |
| Owner | /owner/*、/setup/* | 管理全部邮箱、地址、Token、审批、Webhook、导出 |
| 邮箱 Token | /v1/*、/mcp | 仅绑定邮箱及明确scope |
| 未认证 | /healthz | 极简运行状态，无邮箱/配置/密钥信息 |

Owner 修改请求严格校验 Origin/CSRF；邮箱 Token 不接受在URL传递。Worker无论从哪个域名访问都重新认证。GET /v1/mailbox 仅返回 Token 自己的邮箱，不提供全实例列表。

## 2 Token 数据映射

mail:read → can_read；attachments:read → can_read_attachments；mail:draft → can_draft；mail:send → can_send。附件权限要求同时可读邮件。requires_approval 默认开启。can_send 不意味着可以审批或修改要求。撤销后所有新请求失效；已经被服务商接受的邮件不能通过撤销撤回。

Owner 创建Token时只返回一次完整secret，其后仅返回ID、名称、权限、到期/撤销时间。不返回secret_sha256。外部Agent持有Token就代表相应能力，应使用本机密钥环境配置，不写进提示词、仓库、日志或命令历史。

## 3 HTTP 接口

Agent API 中没有由调用者选择的 mailbox_id 路由。若请求包含其他邮箱ID，拒绝或忽略选择并始终以Token邮箱为准；不能作为额外授权。查不到与无权访问均返回404，避免枚举。

| 方法与路径 | scope | 行为 |
| --- | --- | --- |
| GET /v1/mailbox | mail:read | 当前邮箱元数据 |
| GET /v1/messages | mail:read | 已实现 folder/read/limit 筛选与双向游标分页；默认 20、最多 100 |
| GET /v1/messages/{id} | mail:read | 已实现本邮箱文本正文和地址，不渲染 HTML、不修改已读状态 |
| GET /v1/messages/{id}/raw | mail:read | 目标，尚未实现 |
| GET /v1/messages/{id}/attachments | mail:read | 当前邮件的附件元数据及提取状态 |
| GET /v1/messages/{id}/attachments/{attachmentId}/download | mail:read + attachments:read | 有界校验后的二进制下载，强制下载，无公开 R2 URL |
| POST /v1/drafts | mail:draft | 创建草稿版本与内容对象 |
| GET /v1/drafts、GET /v1/drafts/{id} | mail:draft | 当前 Token 自己的草稿 |
| GET/POST /v1/drafts/{id}/attachments | mail:draft | 当前文件清单 / 原始二进制上传，变更版本并使审批失效 |
| DELETE /v1/drafts/{id}/attachments/{attachmentId} | mail:draft | expectedVersion 移除当前文件 |
| GET /v1/drafts/{id}/attachments/{attachmentId}/download | mail:draft | 仅当前主体草稿内文件的鉴权下载 |
| POST /v1/drafts/{id}/attachment-uploads；PATCH /.../{uploadId}；POST /.../{uploadId}/complete | mail:draft | 分块上传，完整契约见[草稿附件](outbound-attachments.md) |
| PATCH /v1/drafts/{id} | mail:draft | expectedVersion 乐观锁；收件人/文本完整替换，HTML/CID 省略保留，编辑使审批失效 |
| DELETE /v1/drafts/{id} | mail:draft | 丢弃未提交草稿 |
| POST /v1/drafts/{id}/send | mail:draft + mail:send | 冻结、请求审批或异步提交，必须有幂等键 |
| GET /v1/outbound | mail:draft | 本 Token 的发送状态，最近50条 |
| GET /v1/events | mail:read | 当前邮箱安全事件，limit/cursor 分页，不含正文、地址或 Bcc |
| GET /v1/webhooks、GET /v1/webhook-deliveries、GET /v1/webhook-deliveries/{id} | mail:read | 只读脱敏订阅和投递记录，隐藏订阅 URL 与密钥 |
| POST /v1/recipient-suppressions/check | mail:send | `{addresses:[...]}` 检查显式提供的1–50个地址，不列举抑制列表 |

Owner JSON 接口统一在 /owner/api/*。已实现 mailboxes、邮箱级 tokens/drafts/outbound/webhooks/webhook-deliveries/events/suppressions 和 setup/checks；地址管理与导出接口仍是目标。页面与 JSON 路径分离，不依赖 Accept 猜测；审批、Webhook 管理和解除抑制不接受邮箱 Token，有副作用操作记录审计。

Owner GET `/owner/api/mailboxes/{id}/suppressions` 返回 `{suppressions,nextCursor}`；status 为 active（默认）、released 或 all，limit 默认20、最多100，cursor 绑定邮箱与过滤条件。每条包含 id、mailboxId、address、status、reason、version、lastEventAt、lastEventId、createdAt、updatedAt、releasedAt。POST `/owner/api/mailboxes/{id}/suppressions/{suppressionId}/release` 接受 `{expectedVersion}`，返回 `{suppression}`；需要 Owner、正确 Origin 和当前活动版本，冲突返回409。

Agent 检查响应仅为 `{recipients:[{address,suppressed,reason}]}`，规范化并去重请求地址，reason 为 null、hard_bounce 或 complaint。没有全量列举、来源事件或解除接口，不返回其他地址、抑制 ID 或其他 Token 的 Bcc。OAuth 凭据继续仅用于 MCP，相同 mail:send 权限可调用检查工具。明确硬退信和投诉会按邮箱自动抑制；软退信或缺少明确硬退信证据不自动抑制。提交及实际派发均检查全部 To/Cc/Bcc，任一抑制返回 recipient_suppressed 并阻止整封发送；人工解除保留历史，较新的有效事件可以再次抑制。

Owner 另有邮件 `.../messages/{messageId}/html-info` 与 `/html` 安全阅读接口，图片许可仅接受受 Origin 保护的 POST。普通 Owner/Agent JSON 与 MCP 只增加 body.htmlStatus 元数据，不返回原 HTML；Owner HTML 展示不增加 Agent scope，见[HTML 阅读](html-mail.md)。

草稿 DTO 另行支持 html 与 inlineImages，供本主体编辑和发送；这不改变 read_message 的文本输出。Owner 另有绑定 expectedVersion/contentSha256 的草稿沙箱预览，完整字段、保留/清除规则与 MIME 见[HTML 发送](html-sending.md)。

发送请求示意（先创建草稿；回复时创建请求增加 replyMessageId）：

```http
POST /v1/drafts/{draftId}/send
Authorization: Bearer <MAILBOX_TOKEN>
Idempotency-Key: <CLIENT_GENERATED_KEY>
Content-Type: application/json

{
  "expectedVersion": 1
}
```

后端固定 mailbox 和 From。外部收件地址保留 local-part 语义。Token 要求审批时返回202与 status=approval_required；批准后使用新幂等键提交，返回 status=queued 和 outboundId，不表示已送达。审批路径为 `/owner/api/mailboxes/{id}/drafts/{draftId}/approve`，只允许 Owner。

幂等键按mailbox、可信principal、操作隔离；相同键不同摘要409；返回旧结果前重新鉴权。scope不足403，撤销/到期401，版本、额度冲突409，输入/大小限制400/413。跨邮箱资源统一404。

## 4 MCP

已实现 Streamable HTTP `/mcp`，使用官方 server SDK 2.4.0，兼容现代2026-07-28与2025协议。工具复用同一业务服务；每次 HTTP 请求验证邮箱 Token，工具再检查当前权限。无跨请求 session，JSON-RPC request ID 不代表发送幂等键。Origin、协议头、Content-Type/Accept、请求及结果大小均受限；批次和工具通知不能产生写入。

MCP POST 由 SvelteKit 返回标准 Response/Web Streams。GET/DELETE 返回405，OAuth 浏览器 OPTIONS 支持 POST preflight。现代调用通常为 JSON，旧协议可用请求关联 SSE，不提供 GET 长连接。真正发送仍由持久 job 与 EMAIL binding 完成。公开 OAuth 端点由同一 wrapper 局部分流，Owner 页面保留 SvelteKit 与 CSRF，见[OAuth 文档](oauth.md)。

| 工具 | scope | 行为 |
| --- | --- | --- |
| get_mailbox | mail:read | 当前邮箱 |
| list_messages / search_messages | mail:read | 摘要、主题/地址字面搜索、双向分页 |
| read_message | mail:read | 分段纯文本，不执行 HTML 或修改已读 |
| list_attachments | mail:read | 当前邮件附件元数据 |
| read_attachment | mail:read + attachments:read | Base64 字节分段，最大32KiB，不执行附件 |
| list_drafts / get_draft | mail:draft | 此 Token 自己的草稿 |
| create_draft / update_draft | mail:draft | 版本化草稿 |
| reply_message | mail:read + mail:draft | 只创建回复草稿，不自动发送 |
| send_message | mail:draft + mail:send | 显式 clientRequestId，复用审批、额度和队列 |
| check_recipient_suppressions | mail:send | 仅检查显式提供的1–50个地址，返回规范化地址、suppressed 与安全原因；不列举或解除 |
| list_outbound | mail:draft | 此 Token 发送记录、逐收件人投递状态和独立投诉标记 |
| begin_draft_attachment_upload / upload_draft_attachment_chunk / complete_draft_attachment_upload | mail:draft | 分块上传、校验并生成新草稿版本 |
| read_draft_attachment / remove_draft_attachment | mail:draft | 自己草稿文件的分段读取 / 移除 |

不提供签发Token、列举所有邮箱、执行任意SQL、读任意R2 key或绕过审批的工具。提示注入不能修改这些规则。

远程 MCP 支持静态 Authorization header 和标准 OAuth public PKCE 客户端。OAuth 发现、Owner 同意、刷新及撤销已实现，见[OAuth 接入](oauth.md)。静态 SDK 示例仍从环境读取 AGENT_MAIL_URL 与 AGENT_MAIL_TOKEN，只执行读取。STDIO 桥接器和 confidential client 认证尚未实现，不保证兼容所有具体客户端产品。

## 5 客户事件

Webhook由Owner按邮箱配置，不向Token开放管理。发送事件只输出稳定event ID、mailbox ID、resource ID、type、时间和脱敏状态；不包含正文、Bcc或secret。签名覆盖时间戳、delivery ID和原始body。重试沿用event/delivery ID，接收端去重。

/v1/events轮询是基础安装能力；Webhook/可选Queues是低延迟通知，不能替代持久事件记录。Provider事件不开启时，发送状态保留accepted和remote unknown，不宣称投递成功。

当前 `/v1/events`、`/v1/webhooks`、`/v1/webhook-deliveries` 及投递详情支持 mail:read 只读访问；MCP 提供 list_mail_events、list_webhook_subscriptions、list_webhook_deliveries。Agent 的订阅 URL 隐藏，管理、轮换和人工重试仅允许 Owner。客户通知使用现有 scheduled，最多每分钟分批发布和投递。Cloudflare Email Sending 状态通过可选专用 Queue 进入同一 Worker，或使用自建 HMAC 桥接；配置和状态含义见[投递事件](email-delivery-events.md)。事件类型、签名、分页、重试及密钥配置见[Webhook](webhooks.md)。

Owner 的 Cloudflare 名单 API 提供缓存列表、显式同步和按版本解除；管理凭据只用 Worker Secret，静态 Token/MCP/OAuth Agent 均无管理入口。Agent 的 check_recipient_suppressions 继续只检查本次提供的地址，缓存命中返回通用 provider_suppression；不访问实时上游或泄露远端记录。完整端点和远端/本地分别结果见[Cloudflare抑制协议](cloudflare-suppressions.md)。

Owner 另可读取 `/cloudflare-suppressions/history` 列表及详情，并显式执行只读对账或带新请求ID的关联重试；这些能力不向 Agent 开放。历史在 API Token 暂缺时仍可读取，原失败保留在不可修改时间线中，见[历史与安全重试](cloudflare-suppression-history.md)。

Owner 的异步导出通知批次提供 `.../export-notification-retry-batches/{batchId}/cancel`、`/reconcile` 和 `/operations`。取消停止未执行条目并保留已执行结果；对账验证原幂等收据，不重新排队或增加预算。操作使用 UUID 与批次版本，历史支持分页；静态 Token、OAuth 和 MCP 不开放这些运维端点，详见[取消与未知结果对账](async-export-notification-retry-controls.md)。

Owner可读取及确认 `.../retry-batch-notifications` 的批次完成、失败和待对账提醒，支持状态/类型筛选、分页和版本确认。三个 `alert_notification.retry_batch.*` topic及相关事件/投递只对Owner开放，静态Token、OAuth和MCP保持邮箱邮件权限，详见[批次通知](retry-batch-notifications.md)。

批量任务通知支持Owner查看原决定/跳过原因、投递状态、传输尝试和手动重试收据。重新排队复用原冻结身份、当前策略及UUID/版本幂等，专用和通用Webhook入口采用相同校验；无新迁移或绑定，仍54张表。详见[批次通知投递追踪](retry-batch-notification-deliveries.md)。

Owner可对批次通知失败投递保存固定预览并幂等确认，后台每轮最多5项处理；0020增加独立两表，当前56表，新任务不生成自身通知或events，避免递归重试。静态Token/OAuth/MCP权限不扩大，详见[通知失败投递批量重试](retry-batch-notification-retry-batches.md)。
