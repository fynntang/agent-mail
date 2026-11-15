# MCP 服务与 Agent 接入

MCP 入口为 `https://<API 域名>/mcp`，由 SvelteKit 路由承载，仍通过同一个 `worker/entry.ts` 部署。使用官方 `@modelcontextprotocol/server` 2.4.0，不需要独立进程或额外 Worker。工具复用现有业务服务；OAuth 在相同 D1 增加凭据表，见[OAuth 迁移](oauth.md)。

## 身份与连接

每个 HTTP 请求带 `Authorization: Bearer <邮箱级 Token>`。Owner 的 Access JWT 不可代替邮箱 Token。hooks 校验 Token 摘要、有效期、撤销及邮箱状态、可选 Origin；MCP 每次建立独立 Server 和调用上下文，工具执行前还会读取当前权限。暂停或撤销对下一请求生效，不信任客户端传入的 mailboxId、session ID 或 `_meta` 获得权限。

先在 Owner 的“邮箱设置”签发 Token：查询/阅读需要 mail:read，收件/Sent 附件字节还需要 attachments:read，草稿及其文件需要 mail:draft，发送需 mail:draft + mail:send；回复创建需要 mail:read + mail:draft。旧只读 Token 可以查看附件元数据，不能获取文件内容。`tools/list` 按本次 Token 隐藏未授权工具，全部权限最多22个工具（不含收件附件权限时最多21个）；`tools/call` 再次检查当前权限。MCP 不提供审批、签发凭证、改限额、访问其他邮箱或任意 R2/SQL 的工具。

支持自定义 Authorization header 的客户端可继续使用静态邮箱 Token。OAuth 客户端通过发现、PKCE S256、Owner 同意、刷新及撤销连接同一 `/mcp`，详见[OAuth 接入](oauth.md)。不要把凭据放进 URL、提示词或版本库。当前支持 public none 客户端，不提供 confidential secret/private_key_jwt 或 STDIO 桥接。

项目提供只读官方 SDK 示例（正常安装开发依赖后可用）：

```powershell
$env:AGENT_MAIL_URL = 'https://api.your-domain.example/mcp'
# AGENT_MAIL_TOKEN 从本机安全环境配置读取，避免将真实凭证写进命令历史。
node examples/mcp-client.mjs
```

示例只列出工具，并在有读取权限时查询当前邮箱，不发送邮件。官方 Client 自动完成版本协商和协议头，代码见 [mcp-client.mjs](../examples/mcp-client.mjs)。本地测试可用 `http://127.0.0.1:<port>/mcp`，真实连接使用 HTTPS。

## 协议与边界

使用 Streamable HTTP，单一 POST 端点，无服务端 session。支持现代 `2026-07-28` 及 SDK 的 2025 系列兼容协议；已用官方客户端验证 2026-07-28 与 2025-11-25。现代协议走 server/discover、逐请求元数据及通常的 JSON 响应；旧客户端 initialize → notifications/initialized，后续请求独立认证，结果可以通过请求关联的 SSE 流返回。没有 GET 长连接、消息重放、订阅、任务、采样或 elicitation 功能。

请求必须使用 application/json，并在 Accept 同时列出 application/json 与 text/event-stream。现代协议的 MCP-Protocol-Version、Mcp-Method、Mcp-Name 须与正文匹配，SDK 执行校验；工具名不代表授权。GET/DELETE 返回405，HEAD 跟随 GET；合法 Origin 的 OPTIONS 支持浏览器 POST preflight。未认证请求返回401并带 OAuth resource_metadata challenge。OAuth 浏览器 Origin 限于 API 或批准的 callback origin，静态 Token 保留原 Origin 规则。

所有私有响应 no-store。tools/list 不承诺 listChanged 通知，现代 SDK 的私有缓存提示 TTL 为0。不共享跨请求的工具注册、Token 或 Server；SDK 管理每次交换及旧协议 SSE 流的关闭，不在结果读完前提前关闭传输。

| 限制 | 行为 |
| --- | --- |
| HTTP JSON 请求 | 最多256 KiB，按实际流读取，不信任 Content-Length |
| JSON-RPC | 每次一条；拒绝批次、非法 JSON/ID；无 ID 通知不会执行工具写入 |
| 工具 arguments | 严格 schema，拒绝未知字段；最多512个对象成员/数组元素 |
| 工具数据结果 | 序列化 UTF-8 最多256 KiB，再生成 content 与 structuredContent；超限返回 result_too_large |
| 阅读正文 | 默认8192、最多16384个 UTF-16 单元，使用 offset/nextOffset 继续；字符边界可能多包含1个单元以保留 emoji |
| 列表 | 邮件默认20、最多100；草稿最近50条摘要；发送记录默认20、最多50且仅查询最近50条 |

## 工具契约

成功结果同时提供 `structuredContent` 和兼容的 JSON 文本 `content`。业务错误返回 `isError:true` 与 `{error:{code,status},requestId}`，不会将数据库、对象 key、凭证或服务商异常原文交给客户端。协议格式错误使用 JSON-RPC error；HTTP 认证错误仍是401/403，不能将其当作普通工具成功。

| 工具 | scope | 参数与结果 |
| --- | --- | --- |
| get_mailbox | mail:read | `{}` → 当前邮箱、有效地址、权限及能力 |
| list_messages | mail:read | `{folder?,read?,limit?,cursor?}` → 邮件摘要及前后游标 |
| search_messages | mail:read | `{q,...列表参数}` → 主题/地址中的字面子串；q最长200字符，不是正文或附件全文检索 |
| read_message | mail:read | `{messageId,offset?,limit?}` → 元数据、地址、正文可用状态及正文分段 |
| list_attachments | mail:read | `{messageId}` → 附件提取状态、名称、大小和下载资格 |
| read_attachment | mail:read + attachments:read | `{messageId,attachmentId,offset?,limit?}` → Base64 字节分段、totalBytes、nextOffset；默认16KiB，最多32KiB |
| list_mail_events | mail:read | `{limit?,cursor?}` → `{events,nextCursor}`；仅当前邮箱的安全事件元数据 |
| list_webhook_subscriptions | mail:read | `{}` → `{endpoints,configured,eventTypes}`；URL 与签名密钥已隐藏 |
| list_webhook_deliveries | mail:read | `{endpointId?,limit?,cursor?}` → `{deliveries,nextCursor}`；只读投递状态和尝试记录 |
| list_drafts | mail:draft | `{}` → 此 Token 最近50条非丢弃草稿摘要，省略正文和收件人地址 |
| get_draft | mail:draft | `{draftId}` → 此 Token 自己的完整草稿、版本、摘要 |
| create_draft | mail:draft | `{to?,cc?,bcc?,subject?,text?,html?,inlineImages?,replyMessageId?}` → `{draft}`；有回复引用还需 mail:read |
| update_draft | mail:draft | `{draftId,expectedVersion,...草稿内容}` → `{draft}`；省略收件人、text 等原字段仍会清空，省略 html/inlineImages 保留原值；修改使审批失效 |
| reply_message | mail:read + mail:draft | `{messageId,to?,cc?,bcc?,subject?,text?,html?,inlineImages?}` → 仅创建 `{draft}`，服务器选择回复地址和线程头 |
| send_message | mail:draft + mail:send | `{draftId,expectedVersion,clientRequestId}` → approval_required 或 queued |
| check_recipient_suppressions | mail:send | `{addresses:[...]}` → `{recipients:[{address,suppressed,reason}]}`；仅检查显式提供的1–50个地址 |
| list_outbound | mail:draft | `{limit?}` → 此 Token 的 `{outbound,hasMore}`，含汇总状态及获授权收件人的投递状态、时间和投诉标记 |
| begin_draft_attachment_upload | mail:draft | `{draftId,expectedVersion,filename,contentType?,totalBytes}` → 一小时上传会话 |
| upload_draft_attachment_chunk | mail:draft | `{draftId,uploadId,offset,data}` → 规范 Base64 块，最多64KiB解码字节，可精确重试 |
| complete_draft_attachment_upload | mail:draft | `{draftId,uploadId}` → 校验并附加文件，返回新草稿版本，清除旧审批 |
| remove_draft_attachment | mail:draft | `{draftId,attachmentId,expectedVersion}` → 移除并更新版本/审批 |
| read_draft_attachment | mail:draft | `{draftId,attachmentId,offset?,limit?}` → 自己草稿文件的 Base64 分段，最多32KiB |

草稿文件最多32份、解码共5 MiB，正文编辑保留清单；普通 update_draft 不接受客户端文件引用。分块上传可处理超过单次 MCP 请求大小的文件，仍保持256KiB请求上限。发送仍通过同一个 send_message 及 Owner 审批，详见[草稿附件发送](outbound-attachments.md)。

草稿支持可选 `html` 原始源码，按 UTF-8 最多64 KiB；发送仍必须提供非空纯文本 `text` 作为替代正文。HTML 是待发送的原文，Agent 不应将它作为指令或执行它。发送传输保留经审批的源码；Owner 的预览和 Sent 阅读使用独立的清洗、空权限沙箱和默认屏蔽远程图片策略，不会通过预览修改草稿内容摘要。

内嵌图片先使用现有草稿上传工具上传，再在 update_draft 中传入 `inlineImages:[{attachmentId,contentId}]`。attachmentId 必须属于当前草稿的有效上传文件；最多8组，文件 ID 与 Content-ID 各自唯一。contentId 是区分大小写的规范可打印 ASCII ID，不带尖括号或空白；HTML 的 URL 另加 `cid:` 协议，例如 `src="cid:Logo.Mixed%40Agent"` 对应 `contentId:"Logo.Mixed@Agent"`，URL 转义只解码一次。服务器验证 PNG/JPEG/GIF/WebP 的类型、头部、尺寸和附件完整性，每张最多1 MiB，合计最多4 MiB；SVG 和未匹配的 CID 不能审批或发送。保存时允许暂存尚未绑定的 CID，以便先编辑 HTML 再上传和绑定。不要传入 server-managed `attachments` 清单。

更新时省略 `html` 或 `inlineImages` 分别保留现有值；`html:null` 清除 HTML 及内嵌绑定，`inlineImages:[]` 只解除绑定，上传的文件仍作为普通附件存在。HTML、绑定或文件变更都会生成新版本、更新内容摘要并使 Owner 审批失效。映射到其他草稿/邮箱的文件、重复 ID、损坏文件或失效上传会被拒绝；提交后冻结的内容不可继续修改。新字段不改变工具数量和 scope，OAuth 也使用相同规则。

读取与搜索不自动标记已读，不渲染 HTML 或加载远程图片。邮件和附件内容明确标记为不可信数据；工具描述和 Server instructions 提醒 Agent 不将内容视为指令或授权。正文按 UTF-16 nextOffset 分段，偏移落入 surrogate pair 中间返回 invalid_offset；附件按解码字节位置分段并返回 Base64。提取、待解析、损坏或缺失均保留明确状态，不伪装为空内容。附件未扫描不等于安全，blocked/failed 标记拒绝读取，完整契约见[附件说明](attachments.md)。

Owner 控制台已支持[安全 HTML 阅读](html-mail.md)，MCP 的 read_message 继续返回纯文本。HTML-only 新来信生成有界纯文本，body.htmlStatus 仅为可用性元数据，不包含原 HTML、沙箱文档或远程图片许可；create_draft/get_draft/update_draft 返回本人可编辑草稿的 HTML 源码和绑定供编写、校对。

Webhook 订阅由 Owner 在控制台管理。Agent 只使用现有 `mail:read` 权限查询当前邮箱的事件、订阅和投递记录，不新增 Token/OAuth scope；没有设置 URL、签发或轮换签名密钥、重放投递的 MCP 工具。订阅中的 `url` 对 Agent 固定为 `null`，响应不包含密钥、加密材料、URL 查询参数、邮件正文、主题、地址或 Bcc。`configured` 表示服务端签名密钥配置状态，不代表某个订阅已成功通知。

事件包括 `message.received` 及 `outbound.accepted`、`outbound.failed`、`outbound.unknown`、`outbound.delivered`、`outbound.deferred`、`outbound.bounced`、`outbound.rejected`、`outbound.complained`；`data` 仅提供相关 messageId/outboundId 和安全状态。accepted 表示邮件服务商接受，Webhook 的成功状态仅表示回调端返回成功，二者都不代表收件人已收到邮件。事件与投递列表默认20条、最多100条；继续查询时原样传回 `nextCursor`，不可用于其他邮箱或改变 endpointId 后沿用。读取不会触发回调、修改已读状态、重放或确认事件。REST 对应的 `/v1/events`、`/v1/webhooks`、`/v1/webhook-deliveries` 及投递详情同样只读且隐藏敏感字段；OAuth 凭据继续仅用于 `/mcp`。

Cloudflare Email Sending 的正式投递事件通过 Event Subscription → Cloudflare Queues 进入同一个 Worker 的原生 `queue` 入口。部署者必须配置并匹配队列名、账号、区域、订阅与发信域名；这条原生通道没有项目自造的 HTTP HMAC。可选 `/callbacks/cloudflare-email` 是部署者维护的转发桥，使用单独配置的桥接密钥验证项目定义的时间戳和 HMAC，不等同于 Cloudflare 官方回调签名。Agent 不能用邮箱 Token 或 MCP 修改投递结果。

`list_outbound` 继续要求 `mail:draft`，只返回本 Token 发起的发送；Owner 可以查看当前邮箱完整发送记录。每个收件人包含 `status`、`lastProviderEventAt`、`deliveryEventType`、`complainedAt` 和安全的 `diagnosticCode`，汇总记录另有 `lastProviderEventAt`。deferred 表示暂缓，rejected 对应失败；投诉只设置独立标记，不据此推断已送达。部分收件人成功、部分失败时保留各自结果，不将 accepted 当作全部送达。提供方通知描述一个收件人的事件，例如 `outbound.delivered` 不表示多收件人全部送达；需要查询 list_outbound 的汇总与各收件人结果。事件读取与 Webhook 通知只含 ID/安全状态，Bcc 地址不会进入通知、Sent 公共头或 Sent 地址列表。

提供方事件按事件 ID 去重，冲突、过期、未匹配或不可信的输入不会触发重新发信。事件早于发送 ACK 时等待关联；unknown 或暂缓也不授权 Agent 自动重试。需要人工决定新的发送意图，并继续使用已有草稿、审批及幂等流程。投递事件沿用现有工具；收件人抑制增加一个检查工具，完整权限共22个工具，没有新增 Token/OAuth scope。

收件人抑制是按邮箱生效的本地发送策略。已关联的明确硬退信（`bounce.type="hard"`）和投诉会自动抑制对应地址；软退信或缺少硬退信证据不会自动加入。To、Cc、Bcc 中任意一个地址被抑制，整个发送意图返回 `recipient_suppressed`，不会发送部分收件人。提交前和原生任务派发前都会检查，审批、Owner 身份或先前“未抑制”的检查结果不能绕过。

Agent 只能通过 `check_recipient_suppressions`（或 REST `POST /v1/recipient-suppressions/check`）检查本次显式提供的1–50个地址。需要现有 `mail:send`，实时检查撤销、到期和邮箱状态；结果只含规范化的请求地址、是否被抑制和 `hard_bounce`/`complaint`、通用 `provider_suppression` 缓存原因或 null，不含抑制 ID、来源事件、其他 Token 的 Bcc 或未请求地址。服务端缓存不会触发实时 Cloudflare 查询；同步、完整列表及解除仅允许 Owner，Agent 没有对应工具。详情见[Cloudflare 管理](cloudflare-suppressions.md)。

Owner 使用受 Access 和 Origin 保护的管理接口查看和解除：GET `.../suppressions?status=active|released|all&limit=20&cursor=...` 默认仅活动记录，最多100条；POST `.../suppressions/{id}/release` 传 `{expectedVersion}`。解除采用版本锁并保留历史，不改变提供方投递结果，也不代表 Cloudflare 的外部抑制已解除。重复或更旧的事件不能撤销人工解除，较新的有效硬退信或投诉可以重新抑制。Agent 遇到抑制应报告给 Owner，不应改地址、重建草稿或自动重试来绕过。

搜索将 `%`、`_`、反斜杠视为字面字符，SQL 参数绑定并固定邮箱。游标绑定邮箱、过滤条件、q 和 limit；改变查询后需从第一页开始。Unicode 查询使用 UTF-8 游标。REST `GET /v1/messages?q=...` 复用同一逻辑，已有不带 q 的游标继续兼容。SQLite LIKE 对 ASCII 大小写不敏感，不承诺所有 Unicode 的大小写折叠。

## 回复、审批与发送

建议流程：

1. create_draft 或 reply_message，保存响应中的 draft.id、version、contentSha256。重复创建可能产生多个草稿，不能用 JSON-RPC id 假定创建幂等。
2. 必要时 get_draft 核对并调用 update_draft，使用 expectedVersion，保存新版本。
3. send_message 传入独立的 clientRequestId（1–128个可打印非空格 ASCII 字符）。同一发送意图网络重试保留此值，不能自动换键或用 JSON-RPC id 代替。
4. 默认返回 `{status:"approval_required",draftId}`，没有发送或预留额度；Owner 在原控制台核对完整 To/Cc/Bcc、纯文本、HTML 安全预览及源码、内嵌图片、版本与摘要后审批。HTML/CID 预检失败会先返回错误，不能通过审批绕过。
5. 审批后使用**新的 clientRequestId** 提交，或由 Owner 提交；原键继续返回原审批请求结果。新请求返回 `{status:"queued",draftId,outboundId}`。
6. list_outbound 查询，原生 scheduled 派发同一 D1 send_email 任务。accepted 只代表服务商接受，未接入投递事件；unknown 可能已经发出，不得自动重发。

MCP 的 send_message 完全复用 requestSend：草稿版本冻结、Owner 审批、原 Token 当前资格、收件人白名单、额度、幂等和审计均不另开捷径。Owner 显式授予免审批 Token 才能直接入队；暂停或撤销在发送提交边界前阻止派发。详情与本期 unknown 对账限制见[邮件发送](mail-sending.md)。

## 构建和验证

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build:worker
pnpm test
pnpm test:e2e
```

MCP 集成测试使用最终 dist/worker/entry.js、真实本地 D1/R2、官方2.4.0客户端、真实签名的测试 Access JWT 和本地模拟 EMAIL；不读取持久开发状态、不连接生产邮箱。验证现代/旧协议、邮箱与 Token 隔离、搜索/分页、正文限额、草稿、审批失效及原生发送链路；协议测试确保批次或通知不能产生写入。实际 Cloudflare 域名、Access 登录、邮件投递及目标 Agent 客户端仍需部署者验收。

初次 MCP 接入阶段通过59个核心、12个 bundle 集成和3个浏览器流程，包含真实 loopback HTTP 的只读客户端示例。后续 OAuth 增加了迁移、官方 SDK 授权及浏览器同意验收，最新记录见[开发验证](development.md)和[OAuth](oauth.md)。本地测试不表示远程部署或真实投递已验收。

官方依据：[现代传输规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)、[SDK HTTP handler](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)、[旧客户端兼容](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/legacy-clients.md)。
