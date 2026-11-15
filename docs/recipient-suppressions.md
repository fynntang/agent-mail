# 退信与投诉抑制名单

抑制名单存放在本实例 D1，按 Agent 邮箱隔离。已验证且已关联本邮箱出站邮件的永久退信或投诉，会自动阻止该邮箱继续向相同地址发信。Owner 可分页查看和解除；Agent 通过 API/MCP 检查自己明确提供的候选地址。仍使用同一个 Worker、Access、邮箱 Token/OAuth、D1 和既有投递事件入口，无新依赖或额外 Worker。

## 升级与触发条件

运行 `pnpm db:local` 为本地数据库追加 `0008_recipient_suppressions.sql`；远端沿用现有部署流程有序迁移。当前共 35 张 STRICT 表。没有新增 secret 或必需绑定；自动记录仍依赖现有 [Email Sending 投递事件配置](email-delivery-events.md)。

只有以下已校验事件产生抑制：

- `cf.email.sending.message.bounced` 且 `payload.bounce.type === "hard"`，原因 `hard_bounce`。
- `cf.email.sending.message.complained`，原因 `complaint`。

Cloudflare 的 bounced 也包括临时失败重试耗尽，因此不能把每个 bounced 当作永久退信。[官方事件说明](https://developers.cloudflare.com/email-service/reference/event-subscriptions/)中的 hard/soft 类型是本功能的证据依据。soft、缺失/未知类型、deferred、failed、rejected 和 delivered 不新增本地抑制；不从自由文本、SMTP response 或 subject 推断永久性。

事件必须先通过现有 Queue 来源 allowlist 或自建桥接 HMAC，再通过精确 provider message ID、sender 和原出站收件人匹配；不接受事件自报的 mailbox ID。关联前的事件只能等待补账，不可凭地址猜测邮箱。To/Cc/Bcc 收件人均适用。仅进行现有邮箱地址规范化（大小写和输入校验），不去掉加号后缀、不合并供应商别名、不做整个域名或通配符抑制。

0008 为事件收件箱新增 bounce_type、evidence_version 和 suppression_applied_at。新证据进入规范化去重摘要，不能重放同一 event ID 来篡改 hard/soft。0007 的历史摘要保持兼容，旧永久性未知的 bounced 不能在重放时升级为 hard。迁移会为已可信关联的历史投诉建立抑制，保留原有邮件、草稿、审批及出站状态。

## 发送校验

Owner、REST 和 MCP 的发送共用以下校验：

1. 提交发送或申请审批时，先检查完整 To/Cc/Bcc 集合。任一地址处于 active，返回 `recipient_suppressed`（409），不新增发送命令、幂等键或额度预留；草稿内容和审批不因此改变。
2. 冻结快照到 R2 后，D1 入队事务再次检查名单，防止快照准备期间新增抑制穿透。
3. 已排队的邮件在 native EMAIL 调用前做预检及原子提交资格检查。新抑制使整封邮件进入 failed，错误码 recipient_suppressed，释放完整预留，不调用发送提供商、不自动重试，也不只发送给剩余收件人。

早于 ACK 的回执在 ACK 写入后立即按 provider ID 补账，每次最多 50 条；补账有剩余或存储失败时停止本批后续发送，不把已记录的 accepted 改成 unknown。下次发送批次先有界处理已知 provider ID 的待决 hard/投诉证据，仍有此类积压则继续等待。scheduled 也在发送前后补账，避免同批第二封邮件穿透刚到达的风险事件。

已完成命令的相同幂等键仍返回原结果，不创建第二封邮件。入队前返回409的草稿在解除后可明确重新提交；已经入队并预检失败的命令保留冻结记录，需要新建草稿、按现有权限审批并提交。已失败命令不会自动恢复。已经开始的外部发送无法撤回，抑制不是跨 Cloudflare 和 D1 的分布式事务。

## 事件去重、乱序与解除

风险证据和投递结果分别处理：一个事件即使比最新 delivered 更旧而不再改变投递显示，可信的 hard 退信或投诉仍能创建抑制。投递状态不能因名单解除而改写。

recipient_suppressions 按 `(mailbox_id,address)` 唯一，保留 active/released、原因、版本、最新风险事件和解除水位；不硬删除记录。首次抑制、更新和解除均递增 version，Owner 解除使用 expectedVersion 比较更新，旧页面不能默默解除新风险。投诉原因不会被后续退信降级。

解除水位包含解除时间及已见事件时间，已消费标记与抑制更新处于同一 D1 事务。旧事件、重复事件和解除前的延迟事件不能重新激活；解除之后的新风险事件可以再次抑制。解除和新事件并发时由 D1 事务及版本检查决定顺序，Owner 需刷新并重新核对。名单无自动到期，历史记录保留供 Owner 核查。

## Owner、API 与 MCP

Owner 入口：`/owner/mailboxes/{mailboxId}/suppressions`。支持 active（默认）/released/all、分页、刷新和确认解除。活动或暂停的邮箱均可管理，退役邮箱不可解除。读取沿用 Access JWT，写入同时检查同源 Origin；Token 和 OAuth Agent 没有完整名单读取和解除权限。

```text
GET  /owner/api/mailboxes/{mailboxId}/suppressions?status=active&limit=20&cursor=...
POST /owner/api/mailboxes/{mailboxId}/suppressions/{suppressionId}/release
     {"expectedVersion":1}

POST /v1/recipient-suppressions/check
     {"addresses":["recipient@example.net"]}
```

Owner 列表返回 `{suppressions,nextCursor}`，解除返回 `{suppression}`。游标绑定邮箱、过滤状态和页大小，条件改变需回到第一页；时间戳为 Unix 毫秒。列表仅返回地址、固定原因、状态、版本及安全时间/事件标识，不返回 provider 原始描述或邮件内容。

Agent 检查要求当前 `mail:send` 权限（实际提交发送仍需 mail:draft + mail:send），一次 1–50 个地址。只返回调用者明确提交、经规范化去重的地址：

```json
{"recipients":[{"address":"recipient@example.net","suppressed":true,"reason":"hard_bounce"}]}
```

启用服务端同步后也检查适用发信域的活跃缓存；仅命中服务端缓存时 reason=provider_suppression，本地 hard_bounce/complaint 优先。未命中任一名单时 suppressed=false、reason=null；不列举其他地址、来源出站 ID、Bcc 历史或管理版本。静态 Token 固定当前邮箱；OAuth AT 继续只能用于 MCP，不能访问 REST。MCP `check_recipient_suppressions` 为只读工具，接受相同 addresses、逐次重查 live scope/撤销/邮箱状态；完整授权最多 22 个工具，不提供 Agent 解除工具。

## Cloudflare 自身名单

本节的本地解除端点只更改本实例 D1。应用 `0009_cloudflare_suppressions.sql` 并配置专用 Worker Secret 后，Owner 可使用独立[服务端管理区域](cloudflare-suppressions.md)同步、解除可修改记录，并明确选择联动当前邮箱本地记录。单独本地解除不会删除 Cloudflare 记录；Cloudflare 仍可能以 E_RECIPIENT_SUPPRESSED 拒绝发送。Cloudflare 的规则、作用域和期限见[官方抑制说明](https://developers.cloudflare.com/email-service/concepts/suppressions/)，它们与本实例的邮箱级策略独立。

## 验证

运行 `pnpm check`、`pnpm build:worker`、`pnpm test` 和 `pnpm test:e2e`。测试使用真实本地 D1/R2、最终 Worker 和模拟 EMAIL/Queue，覆盖 hard/soft/投诉、历史迁移与摘要兼容、重复与乱序、Owner CAS/Origin、Token/OAuth 权限、候选地址非枚举、To/Cc/Bcc 整封阻止、快照及提交边界并发、额度释放与 Owner 桌面/手机操作。没有发送真实邮件或更改真实 Cloudflare 名单，云端 Event Subscription、实际投递与提供商侧抑制需部署后验收。
