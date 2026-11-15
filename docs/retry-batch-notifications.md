# 批量重试任务的完成与异常通知

Owner 在当前邮箱的“批量任务完成与异常通知”面板查看任务完成、执行失败和待对账提醒，按类型及确认状态分页查询，并定位原批次。全局提醒显示未确认数量和仍需处理的异常数量。通知确认表示 Owner 已知悉，不改变批次、未知条目、Webhook 投递或重试预算。

## 迁移与通知事实

按顺序应用 `0019_retry_batch_notifications.sql`，本地运行 `pnpm db:local`。新增 `async_export_retry_batch_notifications`，当前共54张 STRICT 表。只记录迁移后新发生的结果变化，不回填旧完成、失败或未知批次，不重复执行任务。初始化检查通知表的字段和三个分页/投影索引。

批次结果更新的 AFTER 触发器在同一个 D1 事务中保存通知快照。原事务失败时，通知一起回滚。快照包含批次 ID、来源版本、状态、发生时间、总数、预览可执行数、已处理数、重新排队数、跳过数、失败数及待对账数；后续对账不改写历史事实。

| 通知类型 | 捕获条件 |
| --- | --- |
| completed | 已确认且未取消的批次首次进入 completed |
| failed / execution_failed | 已确认批次的失败数从0变为正数 |
| failed / expired | 已确认且未取消的批次首次进入 expired |
| needs_reconciliation | 已确认批次的未知数从0变为正数，包括取消撤销运行租约后的未知结果 |

重复汇总、GET 读取、重复取消和幂等对账重放不会重复生成通知。未知结果全部核对后再次出现新未知结果时，形成新的告警事实。正常取消、未确认预览过期不生成完成/失败通知，但取消后仍有未知结果会产生待对账告警。

completed 表示批量任务已经完成逐项处理，可能包含跳过或失败；它不代表接收端已经收到 Webhook。某批次既发生失败又最终完成时，会分别保留失败和完成事实，通知的计数与原批次相对应。

## 历史与当前状态

Owner 详情同时展示通知快照与当前批次结果。unknown 后来被核对后，原通知仍保留原始未知数量，但 `currentAttention` 更新为 false；Owner 可确认并保留历史。执行失败和截止异常仍在对应失败记录中展示。确认与投影、Webhook 准入各自独立，Webhook 配置缺失、关闭或静默不会隐藏 Owner 提醒。

未确认数量涵盖三种历史事实。仍需处理数量只计算未确认、当前仍异常的失败或待对账通知，完成通知不重复计入告警数。分页统计为当前邮箱总览，不随当前页或类型筛选截断。

## Webhook 与通知策略

Owner 可在既有邮箱级订阅中选择：

```text
alert_notification.retry_batch.completed
alert_notification.retry_batch.failed
alert_notification.retry_batch.needs_reconciliation
```

事件只包含通知/批次 ID、类型、原因、来源版本、批次状态、汇总计数和发生时间，不包含邮箱地址、目标 URL、签名密文、内部操作 UUID、租约或邮件内容。事件和投递身份稳定；Webhook 可能重复或乱序，接收端应按 notificationId（或稳定 event/delivery ID）去重，并在同一 batchId 内用 sourceVersion 判断新旧。待对账通知记录当时事实，不能把晚到的历史快照当作当前状态。

同一个 scheduled 在既有 Webhook 传输和批量任务执行后，有界投影最多20条通知为应用事件；后续 cron 通过原发布器和传输器投递。已有 HMAC 签名、冻结目标和签名版本、URL 校验、超时与失败退避重试保持有效，每轮 HTTP 预算仍为2条。

Webhook 沿用邮箱通知 enabled、静默时段和重复限频；完成通知有独立语义，不受 Cloudflare 抑制恢复通知开关控制。限频指纹为 `['retry_batch',kind,reason]`，与原导出通知和 Cloudflare 抑制告警隔离，复用既有 D1 限频状态，不写入原抑制决策导出记录。

准入结果保存为 allowed、disabled、quiet_hours、repeat_limited 或 no_subscribers，并保存策略版本和决定时间。发布时验证完整不可变通知快照与事件关联，伪造或不匹配事件不投递。通知产生时，同一事务还冻结当时匹配订阅的端点 ID、密钥版本和配置版本时间；该内部快照不进入公开 DTO 或事件载荷。发布要求当前配置与该快照一致，且订阅创建和最后修改严格早于通知事实，即使批次逻辑时间略晚于时钟，迟到订阅或之后修改也不会补发。关闭策略会阻止新的外部投递，静默中的已入队通知沿用原等待行为。

自动失败重试继续有效。Owner 另可查看投递决策、状态和尝试记录，并通过原版本及稳定 UUID 收据安全重新排队已有 allowed/dead 投递；专用及通用入口使用同一校验，不绕过原准入。通知确认和批量任务取消/对账不会重新发送通知，详见[投递追踪与手动重试](retry-batch-notification-deliveries.md)。

三类批次通知也不进入原异步导出通知的批量重试候选，避免通知自身形成递归任务。

## Owner API

```text
GET  /owner/api/mailboxes/{mailboxId}/retry-batch-notifications?status=unread&kind=all&limit=20&cursor=...
GET  /owner/api/mailboxes/{mailboxId}/retry-batch-notifications/{notificationId}
POST /owner/api/mailboxes/{mailboxId}/retry-batch-notifications/{notificationId}/acknowledge
```

status 支持 unread（默认）、acknowledged、all；kind 支持 all（默认）、completed、failed、needs_reconciliation。limit 默认20、最多100，游标绑定邮箱、类型、确认状态和页大小。未知参数、重复参数和额外请求字段均拒绝。

列表返回 `{notifications,nextCursor,summary}`，summary 包含 unread、attention、completed、failed、needsReconciliation。详情与确认返回 `{notification}`。确认请求为 `{"expectedVersion":1}`，旧版本或已确认返回409 `retry_batch_notification_changed`；并发只有一个成功确认和一条审计。

通知 DTO 返回不可变快照、acknowledgedAt/version、notificationDecision/policyVersion/decidedAt，以及 currentBatch 和 currentAttention。GET 只读，不生成事实、不投影、不解密秘密、不访问 R2 或接收端。

全部端点需要现有 Cloudflare Access Owner 认证，确认操作还要求正确 Origin。活动和暂停邮箱可读及确认；跨邮箱记录不可读取。静态 Token、OAuth 和 MCP 不获得这些运维信息，三个事件及相关订阅和投递数据也遵循 Owner 隔离。

## 验证

本地真实 D1、最终 Worker 和浏览器验证覆盖原子快照、无回填、重复/多次异常、取消后待对账、对账后的当前状态、确认 CAS、分页隔离、通知策略、HMAC/失败重试和 Agent 权限。桌面和手机验证详情、确认、全局计数及原批次定位，执行数量见[开发记录](development.md)。

继续使用单 SvelteKit Worker、D1、现有 R2 和通知签名配置，无新增绑定、服务或依赖。本地验收不代表真实 Cloudflare 账户、DNS 或邮件服务已部署。相关任务控制见[取消与未知结果对账](async-export-notification-retry-controls.md)。
