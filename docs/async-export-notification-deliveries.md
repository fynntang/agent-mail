# 异步导出通知的投递追踪与手动重试

Owner 在“抑制名单 → 导出完成与失败通知 → 查看通知”内查看原通知决定、跳过原因、事件发布进度、各个 Webhook 订阅的实际结果、传输尝试和手动重试记录。数据来自既有通知、events、webhook_deliveries、webhook_delivery_attempts 和 audit_events；不重新推断或改写当时的通知决定。

## 升级与运行

按顺序应用 `0016_export_notification_delivery_history.sql`，本地运行 `pnpm db:local`。该迁移仅增加 `audit_resource_history(mailbox_id,resource_id,action,occurred_at DESC,id DESC)`，用于按投递读取历史操作，完成后仍为51张 STRICT 表。后续0017增加批量重试批次与逐项结果，0018 增加取消标记及约束，0019增加批次通知快照表后，当前为54张表。旧审计和投递不变，不补造重试或重新发送通知。初始化向导检查必需结构和索引归属/列序，缺失时要求迁移。

单条追踪与重试继续使用 SvelteKit 与同一个 fetch/email/scheduled/queue Worker，沿用 D1、R2、Access 和 Webhook 签名密钥，不额外增加服务、绑定、Secret 或依赖。追踪与重试不读取导出文件，不延长文件有效期；文件过期后通知结果和历史仍可查看。

多条失败记录可在当前邮箱使用[批量重试](async-export-notification-retry-batches.md)：按失败时间与原因生成固定预览，明确确认后后台每轮处理5项，并将结果关联本页原投递与单条审计。原单条规则保持有效，批量不会重评被跳过的通知或另建发送通道。

批量任务还支持Owner[取消、未知结果对账及操作历史](async-export-notification-retry-controls.md)。取消保留原投递和已执行结果，unknown只检查原稳定UUID的审计收据，不重新排队；单条重试与批次控制的记录仍可关联核对。

## 决策、发布与实际投递

原决定与策略版本来自不可变终态通知收据：allowed、disabled、quiet_hours、repeat_limited、no_subscribers。界面分别说明已准入、通知关闭、静默命中、重复限频或无匹配订阅。当前配置变化不重评原决定；被跳过的通知不会补发，也没有手动生成投递的操作。

发布阶段独立显示：

| publication | 含义 |
| --- | --- |
| pending_projection | 终态通知已保存，等待后台生成事件 |
| pending_publication | 事件已生成，等待完成策略准入及订阅发布 |
| published | 事件已完成有界发布，不代表接收端已收到 |

已准入通知可以关联多个订阅投递。汇总列出 total、pending、running、succeeded、dead、cancelled、attempts、quietDeferred；界面每页5条投递，汇总始终覆盖整个通知。列表和汇总在同一 D1 批次快照读取，避免同一次响应的明细和总数处于不同状态。

`succeeded` 表示接收端返回2xx；`dead` 表示自动传输已经停止，可能是不可重试HTTP响应、签名/载荷错误或耗尽预算。attempts 是领取的传输尝试次数，不等于接收端实际收到的 HTTP 次数；`quietDeferred` 仅计当前 pending 且因静默暂缓的投递。availableAt 对 pending 表示最早可领取时间，不承诺准确发送时刻。

详情最多显示80条既有传输尝试，包含序号、outcome、HTTP 状态、安全错误码、开始和结束时间；另显示最多10条 Owner 手动排队记录，包含操作 ID、请求 UUID、原版本时间与预算变化。传输尝试和排队操作分别展示，手动排队成功不等于已经执行 HTTP。

## 安全重试

只有满足全部条件的原投递可重新排队：

- 仅当前经过 Access 验证的 Owner，可操作活动邮箱。
- 通知原决定为 allowed，投递精确关联同一邮箱、任务及投影事件。
- 当前投递为 dead，Owner 提交的 expectedUpdatedAt 与当前版本一致。
- 当前订阅端点启用，当前通知策略 enabled 且不处于静默时段。
- 累计 attemptBudget 小于80，原冻结载荷、目标地址、签名版本和加密秘密仍可校验。

pending、running、succeeded、cancelled 均不能通过此操作重新排队；暂停邮箱可读历史，不能提交新的排队。完成通知仍不受 Cloudflare 告警 recoveryEnabled 开关影响。重试原有 allowed 投递不会再次消耗重复通知准入预算，但实际发送前继续检查最新策略和权限。

重新排队保留原事件 ID、投递 ID、冻结目标、载荷、签名密钥版本和已尝试次数。只增加8次预算（总预算最多80）、设置 pending/新的可领取时间并清除本次终态错误。请求本身不调用接收端，后续 scheduled 沿原[Webhook HMAC、有限重试及租约](webhooks.md)执行；接收端仍按同一投递 ID 去重。

端点暂停、通知关闭、静默、预算耗尽、签名配置缺失、冻结数据异常等会显示阻止原因。GET 给出的可重试状态是只读提示，不解密历史密钥；POST 会进一步验证密文认证，并在原子提交时再次检查版本、策略版本、活动端点和通知收据。政策或记录在核对后变化时，拒绝旧请求，需刷新后重新决定。

## 幂等与操作历史

每次新的 Owner 决定生成 UUID `clientRequestId`，同时固定 deliveryId 和 expectedUpdatedAt。D1 原子批次将既有 `webhook.delivery_retried` 审计收据与投递更新一起提交；审计 ID 由邮箱和请求 UUID 稳定派生。请求响应丢失或数据库 ACK 不明确时，通过不可变收据核对结果。

相同 UUID 和相同条件只返回原收据及投递当前状态，不重复增加预算或重新排队。即使第一次重试已经再次失败，重放旧请求也不会触发第二次传输。相同 UUID 换任务、投递或原版本会冲突；不同 UUID 竞争同一版本时只有一个能提交。

暂停邮箱、关闭通知或暂时移除签名配置后，Owner 仍可沿相同请求核对已提交的收据；该重放只读，不授予新的发送预算。

界面在不确定结果后保留原标识，提供“沿用标识核对”；普通刷新不提交操作。放弃核对标识不会撤销可能已排队的投递，Owner 应先刷新核对状态，再决定是否进行新的操作。

新的审计 metadata 仅保存 jobId、clientRequestId、expectedUpdatedAt、previousAttemptBudget、attemptBudget，API 只重建白名单字段。旧版通用 Webhook 排队审计仍可查看，缺少元数据的字段为 null，不补造请求 UUID。旧通用重试端点对两种导出事件也使用相同校验和幂等协议，不能绕过策略。

## Owner API

```text
GET  /owner/api/mailboxes/{mailboxId}/export-notifications/{jobId}/delivery-results
     ?limit=20&cursor=...
GET  /owner/api/mailboxes/{mailboxId}/export-notifications/{jobId}/deliveries/{deliveryId}
POST /owner/api/mailboxes/{mailboxId}/export-notifications/{jobId}/deliveries/{deliveryId}/retry
```

列表返回：

```text
{
  notification: 原安全通知DTO,
  publication: pending_projection | pending_publication | published,
  deliverySummary: {total,pending,running,succeeded,dead,cancelled,attempts,quietDeferred},
  deliveries: [{...WebhookDelivery,retry:{available,reason}}],
  nextCursor
}
```

limit 默认20、最多100，游标绑定 mailboxId、jobId、事件、每页数量和创建时间/投递 ID 排序。详情返回 `{notification,publication,delivery,attempts,manualRetries,currentPolicy:{enabled,quiet,version}}`。任务、投递或邮箱归属不符返回404，非法或不匹配游标返回400；未知和重复查询参数均拒绝。

POST 请求体：

```json
{
  "clientRequestId": "00000000-0000-4000-8000-000000000001",
  "expectedUpdatedAt": 1794700900000
}
```

返回 `{delivery,manualRetry,replayed}`；`delivery` 是当前投递状态，`manualRetry` 是这次原子排队操作的安全收据。replayed=true 表示核对已有操作，不表示再次发送。请求只接受这两个字段，不接受查询参数或修改目标/载荷。

常见错误为409 `export_notification_retry_unavailable`（当前条件不允许）、`export_notification_retry_changed`（版本变化）、`export_notification_retry_conflict`（请求标识对应不同条件）。通用 `POST /owner/api/mailboxes/{mailboxId}/webhook-deliveries/{deliveryId}/retry` 遇到导出通知也要求同样请求体；普通邮件及 Cloudflare 告警的原协议保持兼容。

retry.reason 为 null 或 not_dead、not_admitted、mailbox_inactive、endpoint_inactive、budget_exhausted、notifications_disabled、quiet_hours、not_configured、payload_unavailable、signing_key_unavailable、invalid_target。资格提示不代替 POST 中的最终授权和完整性验证。

## 权限与只读边界

所有端点要求现有 Owner Access JWT，POST 还要求匹配 Origin。静态邮箱 Token、OAuth 和 MCP 不获得导出通知运维能力；原事件和投递接口继续隔离这些事件。Owner 在暂停邮箱仍可读取，退役邮箱不可访问。

GET 不写审计、评估新的准入、推进投影/发布、修改重试预算，不访问 R2、不解密历史签名秘密，也不请求接收端或 Cloudflare API。缺少 Webhook 凭据不妨碍查看历史；只影响当前重试资格。返回值不包含目标 URL、冻结 payload、密文/明文密钥、租约、claim token、原始审计 metadata、Cloudflare 凭据或邮件内容。

## 验证

本地单元和最终 Worker 集成覆盖一致快照、分页与游标绑定、决策/跳过原因、80条尝试和旧审计安全投影、无凭据只读、跨邮箱/任务/Owner 隔离、当前策略、版本竞争、同标识重放、丢 ACK、冻结载荷及签名、预算上限、通用入口一致性。浏览器实际执行失败详情 → 明确排队 → 丢响应后幂等核对 → 同 ID/载荷/密钥版本的成功投递，并验证静默/关闭阻止、跳过通知无重试、分页与桌面/手机布局。

验证使用本地 workerd、独立 D1/R2、模拟 Access JWT 和接收端，不创建云资源、不远程部署或发送真实 Webhook。实际执行记录见[开发文档](development.md)。

批次完成、失败和待对账提醒继续仅供Owner，三种通知Webhook沿用邮箱策略、签名与自动重试，详见[批次完成与异常通知](retry-batch-notifications.md)。
