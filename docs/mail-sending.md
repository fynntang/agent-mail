# 草稿、回复与邮件发送

已实现文本、HTML 双正文、CID 图片及附件邮件发送，入口为 `/owner/mailboxes/{id}/outbound`。SvelteKit 的 HTTP 路由、原生收信 `email` 与定时 `scheduled` 仍在 `worker/entry.ts` 同一个 Worker 中。复用 drafts、objects、outbound_messages、send_attempts、jobs、idempotency_keys 和额度表；附件使用已有 `0005_draft_attachments.sql`，HTML/CID 不增加迁移。上传、删除、分块见[草稿附件](outbound-attachments.md)，正文、CID 绑定、沙箱预览和 API/MCP 见[HTML 发送](html-sending.md)。

## 权限与 Owner 操作

Owner 继续使用 Cloudflare Access JWT，写请求必须有匹配的 Origin。Token 只能管理由自己创建的草稿和发送记录，不能查看同邮箱其他 Token 的草稿。旧的 `mail:read` 凭证保持只读。

| scope | 能力 |
| --- | --- |
| mail:read | 阅读本邮箱邮件；创建回复还需要此权限 |
| mail:draft | 创建、列出、读取、编辑和丢弃自己的草稿，上传、移除与核对草稿文件 |
| mail:send | 请求发送自己的草稿，必须同时授予 mail:draft |

Token 的 `requiresApproval` 默认 true，仅 Owner 签发时可明确设为 false。审批接口只接受 Owner。Owner 不能通过代为提交，使原 Token 已撤销、过期或没有发送权限的草稿获得发送资格；需要另建 Owner 自己的草稿。

邮箱设置可配置 `dailyRecipientLimit`（0–1000，默认20）及 `allowedRecipients`（最多100个精确地址）。空白名单表示不额外限制收件人，仍受审批、额度及 Cloudflare 账户限制。外部地址只小写域名、保留 local-part 的大小写；白名单和去重使用相同规则。不支持通配域名。

Owner 可以保存空草稿。发送要求至少一名收件人、非空主题与文本备用正文，To/Cc/Bcc 合计最多50个去重地址，主题最多512字符，文本与可选 HTML 各最多64 KiB UTF-8。附件最多32份、解码后共5 MiB；CID 图片另受8张、单图1 MiB、共4 MiB限制，完整 MIME 仍受邮箱大小上限约束。拒绝头注入、任意 From 和自定义 headers。From 固定为当前邮箱的有效主地址。

## 草稿及审批

草稿内容是 R2 中不可覆盖的 JSON，每次修改创建新对象，D1 使用 `expectedVersion` 做乐观锁。修改后版本增加，状态回到 editing，旧审批清除。附件清单及每个文件的大小、名称、类型和 SHA-256 纳入完整内容摘要；修改文本保留现有文件，上传或移除也使旧审批失效。Owner 预览包含全部 To/Cc/Bcc、完整文本、文件清单、版本与 SHA-256，可下载文件核对。审批不会自动发送；Owner 需另外点击“提交发送”。

`replyMessageId` 只能引用同邮箱未删除邮件。服务器默认选择 Reply-To 或 From、生成 Re: 主题，并从原记录校验 RFC Message-ID，构造 In-Reply-To / References。回复已发送邮件默认选择 To。无有效 RFC ID 时省略线程头；不会用服务商的不透明 ID 冒充 RFC Message-ID。本期未生成会话索引。

| 方法与 Agent 路径 | 请求 / 响应 |
| --- | --- |
| GET /v1/drafts | `{drafts:[...]}`，最近50条本 Token 的非丢弃草稿，包含内容 |
| POST /v1/drafts | `{to?,cc?,bcc?,subject?,text?,replyMessageId?}` → 201 `{draft}` |
| GET /v1/drafts/{draftId} | `{draft}` |
| PATCH /v1/drafts/{draftId} | 完整替换内容，加 `expectedVersion` → `{draft}` |
| DELETE /v1/drafts/{draftId} | 丢弃未提交草稿 → 204 |
| POST /v1/drafts/{draftId}/send | `{expectedVersion}`，需 Idempotency-Key → 202 |
| GET /v1/outbound | `{outbound:[...]}`，最近50条本 Token 发起的发送记录 |

Owner 对应路径为 `/owner/api/mailboxes/{id}/drafts...` 与 `/owner/api/mailboxes/{id}/outbound`，可管理此邮箱全部记录。额外提供：

- POST `.../drafts/{draftId}/approve`，请求 `{expectedVersion,contentSha256}`，返回 `{draft}`。
- POST `.../outbound/{outboundId}/cancel`，请求 `{}`，只取消 queued 状态并释放预留，返回204。

需要审批的 Agent 首次 send 返回 `{status:"approval_required",draftId}`，不占额度、不调用服务商。Owner 审批后，Agent 使用**新的幂等键**再次提交，或由 Owner 提交。原键始终重放原审批请求结果。已批准或免审批的提交返回 `{status:"queued",draftId,outboundId}`。

幂等键为1–128个可打印非空格 ASCII 字符，按邮箱、主体和 send 操作隔离；绑定草稿 ID、版本、内容摘要。同键同请求返回原结果，不同内容返回409。submitted 草稿不再可修改，换键也不能重复消费。当前保留幂等记录，不根据 expires_at 自动删除。需要发送另一封邮件时创建新草稿。

```http
POST /v1/drafts
Authorization: Bearer <MAILBOX_TOKEN>
Content-Type: application/json

{"to":["recipient@example.net"],"subject":"任务完成","text":"构建已经通过。"}
```

保存响应中的 draft.id 和 version 后，再向 `/v1/drafts/{draftId}/send` 提交版本与客户端生成的 Idempotency-Key。API 错误使用 `{error:{code},requestId}`。权限不足403、跨邮箱资源404、审批/版本/幂等/额度冲突409，输入400、过大413；发送提交返回202不表示已送达。

## 冻结、额度与派发

入队前冻结 From、全部收件人、主题、文本、HTML、CID 绑定、回复头和有序附件清单，在 R2 保存 purpose=outbound 对象及摘要，同时准备带实际文件的本地 Sent copy。D1 一个原子 batch 认领幂等请求、消费草稿、预留当天收件人数、创建发送记录与 send_email job，并记录审计。并发请求不能重复消费草稿或突破额度。

scheduled 先处理来信，再最多处理2个发送任务；120秒租约、单次提供商调用超时20秒。派发前校验 R2 内容摘要、原始 Token 当前权限、撤销/过期、邮箱与地址状态、审批版本、白名单和额度。队列跨 UTC 日期时失败并释放旧预留，不借用昨天额度发送；需要创建新草稿重新提交。降低额度或暂停邮箱可能使尚未派发的任务失败。

发送边界是持久化的 submitting 状态与 send_attempts：只有赢得该原子状态转换的 Worker 才能调用 `env.EMAIL.send(structuredMessage)`。边界之后网络超时、无法识别的异常或过期租约转为 unknown，额度保持 reconciling，不自动重发。边界之前可以安全回收过期领取；已开始的外部调用不能靠暂停、撤销或取消保证拦截。

Cloudflare 返回 messageId 只记为 accepted，提交预留并创建 Sent 邮件索引；没有接入投递事件，不把 accepted 显示为 delivered。只有明确的服务端校验/配额拒绝代码会释放预留；不保存服务商异常原文，以免泄露正文或地址。取消仅作用于 queued。unknown 需要核对 Cloudflare 发送记录，本期没有自动对账或人工结算接口，额度和历史保留；存在 queued/submitting/unknown 时禁止退役邮箱。

Sent copy 是应用生成的本地 EML 与文本/HTML 正文，不是服务商签名后的线上 MIME。HTML 与 CID 使用 alternative/related/mixed MIME 结构，内嵌附件索引取自冻结绑定。其 Message-ID 使用 `.local@agent-mail.invalid`；索引不伪造服务商 RFC Message-ID。Bcc 仅在授权的草稿/发送记录与服务商 envelope 中，不进入本地 EML 公开头或 Sent 地址列表。

R2 与 D1 不能跨服务原子提交。额度耗尽先拒绝上传；失败或并发竞争未获胜时，仅清理本请求新建的未引用对象，先由 D1 的命令 guard 与外键证明可删除，再删除 R2。进程崩溃、对象登记失败或清理失败仍可能留下孤儿，已保存的旧草稿版本也保留；本期未实现按年龄自动扫描清理，不能删除在途快照。

## Cloudflare 与本地验证

根 `wrangler.jsonc` 已添加 `"send_email":[{"name":"EMAIL"}]`，不设置 remote:true。本地 Wrangler/Miniflare 使用模拟发送，不向外部邮箱投递。真实发送需在部署者自己的 Cloudflare 账户启用 Email Sending、验证发送域名及相应 DNS；任意收件人发送需要适当账户权限与 Workers Paid。绑定存在只表示代码可调用，不证明域名和投递已经就绪。服务商控制 Date、Message-ID、MIME、DKIM；应用不在 structured headers 中覆盖这些字段。[Worker API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)、[绑定配置](https://developers.cloudflare.com/email-service/configuration/send-bindings/)、[本地模拟](https://developers.cloudflare.com/email-service/observability/local-development/sending/)

保持只读部署时可从根配置移除 EMAIL 再构建；免审批提交返回 sending_not_configured，`GET /v1/mailbox` 的 outboundEmail 显示 false。MCP 已接入同一权限和发送服务，send_message 仍要求显式发送 scope，详见[MCP 接入](mcp.md)。

运行 `pnpm check`、`pnpm build:worker`、`pnpm test` 和 `pnpm test:e2e`。测试使用真实本地 D1/R2、最终单 Worker bundle、签名 Access JWT 和本地 EMAIL 绑定；核心发送替身覆盖并发、撤销、审批失效、配额、超时、未知状态和防止重复发送。没有触发真实邮件或远程部署。

2026-11-14 本轮验证：42项核心测试（其中发送20项）、9项最终 bundle 集成测试、3个完整浏览器流程，以及54项数据库、18项配置检查通过；Svelte 与 Worker 类型检查0错误0警告，构建及 dry-run 成功。额外注入 ACK 发布失败、租约过期后的迟到 ACK、发送边界后的撤销/暂停，以及 R2 快照损坏，均未触发重复发送。

浏览器发送流程为 `http://127.0.0.1:4195/owner/mailboxes/{id}/outbound` → 保存 → 核对 → 审批 → 提交 → 本地 scheduled → accepted → Sent 正文；手机还验证阅读页 → 回复 → 显式创建回复草稿。使用已有 Playwright 工作流和已安装 Chrome，原因是 Browser plugin not available。桌面1488×1056、手机390×844，页面身份、非空内容、框架错误层、控制台、交互结果与截图均通过，无外部浏览器请求或横向溢出。截图保存在工作区外，测试不保留可用生产凭证。
