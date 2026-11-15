# 异步导出完成与失败通知

异步导出进入 `succeeded` 或最终 `failed` 后，Owner 控制台保留通知、全局待确认提醒及原任务入口；邮箱可订阅同一结果的 Webhook。通知沿用现有 Cloudflare Access、邮箱归属、通知策略、私有签名密钥、Webhook 重试和投递记录，继续使用同一个 Worker、D1 与 R2。

控制台提醒不受 Webhook 开关、静默、限频或是否配置密钥影响。Owner 确认知悉只更新提醒，不改变导出文件、到期时间、任务结果或 Webhook 投递状态。

## 升级

按顺序应用 `0015_async_export_notifications.sql`；本地运行 `pnpm db:local`，远端沿用[部署工具](deployment.md)。新增 `async_export_notifications` 和 `async_export_notification_state` 两张 STRICT 表，总计51张。初始化向导检查必需字段与通知分页/未确认/投影索引；结构约束由迁移与 schema 测试验证。不增加绑定、Worker、Queue、依赖或 Secret。

迁移不会为已经完成、失败、取消或过期的旧任务补造通知。升级前已在排队/运行的任务，升级后真正进入完成或失败时会生成通知。取消、过期、批次重试、租约恢复期间的临时错误和清理操作不生成完成/失败通知。

## 终态一致性和后台投影

数据库触发器在任务从 queued/running 进入 succeeded/failed 的同一事务中写入通知快照。任务提交与通知同时成功或回滚，不依赖任务结束后的临时内存回调。一个任务只有一条通知；终态结果、格式、计数、安全错误码和时间不可修改，文件过期或临时分片清理后仍保留。

同一 `scheduled` 入口先处理既有邮件、发送及 Webhook，再处理有界导出批次，随后最多投影20条通知。投影使用稳定事件 ID 和来源 ID，将 events 写入与通知投影收据放在 D1 原子批次中；并发执行或丢失提交响应不会生成第二个事件。中断后的未投影通知在后续 cron 补账，Owner GET 不推进投影。

新投影的事件由下一次 Webhook 调度发布，具体延迟取决于 cron、事件积压和每轮投递预算。Owner 通知在任务终态提交后即可读取，不必等待 Webhook 发布或成功。

## 事件与安全字段

| 事件 | 含义 |
| --- | --- |
| `alert_notification.export.succeeded` | 完整文件与清单已提交 |
| `alert_notification.export.failed` | 永久错误或连续失败达到上限，任务停止 |

Owner 在“Webhook → 订阅事件”显式选择两个新事件；既有订阅不会自动扩大。载荷沿用 `v:1`、id、mailboxId、type、occurredAt、data 结构，data 示例：

```json
{
  "jobId": "00000000-0000-4000-8000-000000000001",
  "format": "json",
  "state": "succeeded",
  "totalDecisions": 2001,
  "processedDecisions": 2001,
  "processedDeliveries": 20010,
  "bodyBytes": 10300000,
  "completedAt": 1794700900000,
  "expiresAt": 1794787200000
}
```

失败事件可增加白名单 `errorCode`；未知内部错误映射为安全通用码。`bodyBytes` 是明细分片总长度，不含下载外壳。结果是通知生成时的终态快照，不能替代下载时的任务/有效期检查。

事件不包含文件字节、下载能力 URL、R2 key、邮箱地址、邮件内容、收件地址、筛选窗口、原始 payload、租约、claim token、Cloudflare 凭据或签名秘密。接收方得到任务 ID 后，下载仍需有效 Owner 认证；Webhooks 不授予下载权限。

投递直接复用[Webhook HMAC 协议](webhooks.md)，保留事件/投递 ID、尝试次数、密钥版本、冻结载荷和有限退避；接收端按投递 ID 去重。HTTP 重试不重新评估发布准入或再次消耗重复通知预算。Owner 可在原投递页查看结果和执行既有手动重试。

订阅必须在任务终态之前存在并包含相应事件。两类导出事件额外要求端点 `created_at` 和当前配置 `updated_at` 严格早于终态时间，再复用 events 行号围栏。这样不会因延迟投影向新建或新扩展的订阅补发旧结果。同一毫秒创建/更新以及终态后的密钥轮换或配置修改会保守排除尚未生成投递的导出事件；已生成的冻结投递继续沿原机制执行。

## 通知策略

导出 Webhook 读取现有邮箱[告警通知策略](alert-notification-policy.md)，不新增第二套配置：

| 策略 | 对导出结果的影响 |
| --- | --- |
| enabled | 关闭时跳过新通知，并取消已有 pending/running 导出通知投递 |
| quietEnabled / 时区 / 静默窗口 | 静默中跳过新通知；已有待重试投递暂缓，不消耗新的传输尝试 |
| repeatIntervalSeconds | 按邮箱、格式、终态和安全错误码组成指纹，重复结果在间隔内跳过 |
| recoveryEnabled | 仅用于 Cloudflare 抑制告警恢复；导出完成属于独立事件，不受此开关影响 |

发布时记录一次不可变决定：allowed、disabled、quiet_hours、repeat_limited 或 no_subscribers；决定属于整个邮箱事件，多个订阅共享一次准入。只有 allowed 消耗重复预算，HTTP 成功与否不改变这次准入；不同格式、成功/失败或不同安全错误码属于不同指纹。静默时使用 IANA 时区和半开窗口，与现有策略一致。

新通知被跳过后不会在解除静默、开启通知或修改限频时补发。已有投递在领取、发送前检查最新策略与版本；关闭会撤销租约，迟到 HTTP ACK 不能复活投递。解除静默可提前唤醒 quiet deferral，普通网络失败退避继续保留。普通邮件事件通知不受这些策略影响。

这两类事件的准入收据和限频时钟单独存储，不写入 `alert_notification_decisions` 或 `alert_notification_state`，因此不会污染既有 Cloudflare 抑制通知的统计、导出或恢复周期。

## Owner 界面和 API

通知详情现可直接查看原决定与跳过原因、待投影/待发布/已发布状态、各订阅投递汇总和分页明细，再查看最多80次传输尝试及10条手动重试记录。历史读取不依赖当前签名凭据，不出网、不解密、不写入或访问R2；旧审计缺少操作元数据时对应字段返回 null。具体字段、分页与安全重试协议见[投递结果追踪](async-export-notification-deliveries.md)。

Owner 页面显示全局未确认通知数，链接到对应邮箱“导出完成与失败通知”。面板支持待确认/已知悉/全部筛选、每页10条真实分页、详情、确认知悉和定位原任务；可定位不在当前任务页的记录。成功文件到期后仍显示通知，并说明不能继续下载。任务刷新/完成轮询会刷新通知，确认后更新全局计数；不会通过 GET 自动确认。

```text
GET  /owner/api/mailboxes/{mailboxId}/export-notifications
     ?status=unread&limit=20&cursor=...
GET  /owner/api/mailboxes/{mailboxId}/export-notifications/{jobId}
POST /owner/api/mailboxes/{mailboxId}/export-notifications/{jobId}/acknowledge
     {"expectedVersion": 1}
```

列表返回 `{notifications,nextCursor,summary:{unread,succeeded,failed}}`。summary 按整个邮箱计算，不受当前筛选或页码影响；succeeded/failed 包含已确认记录。status 为 unread（默认）、acknowledged、all；limit 默认20、最多100，游标绑定邮箱、状态和每页数量。未知/重复查询参数均拒绝。

详情与确认返回 `{notification}`。公开字段为 id（等于 jobId）、jobId、mailboxId、outcome、format、totalDecisions、processedDecisions、processedDeliveries、bodyBytes、errorCode、completedAt、expiresAt、createdAt、acknowledgedAt、version、notificationDecision、policyVersion、decidedAt。Webhook 尚未发布时决定及策略字段为 null；不暴露内部投影事件 ID 和 claim token。

确认使用独立版本，成功后 acknowledgedAt 设置且 version 增一，并写入既有 Owner 审计。投影、准入和文件清理不改变确认版本。过时版本、已被其他页面确认的请求返回409 `export_notification_changed`，刷新核对后继续；不能把已确认记录恢复成未读。

手动重试与确认独立：只有原决定 allowed 且投递 dead、邮箱和端点活动、当前策略允许、预算小于80且冻结载荷及签名凭据有效时才可提交。POST 携带稳定 `clientRequestId` 和当前 `expectedUpdatedAt`；响应丢失后同标识重试只核对原调度，不再次增加预算。原事件、投递ID、载荷及签名版本保持不变；通用 Webhook 重试入口对导出事件执行相同规则。已跳过、成功、进行中或取消记录不提供重试，重试不重新消耗限频准入、不延长文件有效期。

所有端点要求现有 Access Owner JWT；确认还要求匹配 Origin。仅活动/暂停邮箱可读取和确认，退役邮箱不计入全局提醒。GET 不写入审计、投影、限频、任务或投递，不调用 Cloudflare API、不访问导出文件。静态邮箱 Token、OAuth 和 MCP 不能读取这些 Owner 运维通知；它们的事件、订阅类型、投递列表及详情也过滤这两类事件。

## 数据和验证

`async_export_notifications` 保存任务复合归属、不可变终态快照、独立确认版本、一次性事件投影收据和一次性通知决定。`async_export_notification_state` 保存同邮箱指纹的单调限频时钟。外键、不可变触发器和 CHECK 约束见[数据库字典](database.md)与[schema](schema.sql)。通知与 D1 元数据保留，R2 临时文件仍按[异步导出原流程](async-alert-notification-export.md)过期清理。

0016迁移为既有 audit_events 增加按邮箱/资源/动作/时间查询的索引，完成后保持51张表。0017增加批量重试预览及逐项结果表，完成后共53张表；0018只增加取消标记及约束，0019增加批次通知快照表，当前54张表。批量重排队继续复用单条审计，不重新发布原通知，见[批量重试](async-export-notification-retry-batches.md)。

Owner 可对未结束批次进行[取消、未知结果对账和操作历史查询](async-export-notification-retry-controls.md)。取消不撤回已重新排队的投递；unknown只核对原请求收据，不能借对账重新发送通知，也不改变原决定或文件有效期。

本地测试覆盖终态原子提交/回滚、不补造旧通知、并发/丢 ACK 投影、20条预算、独立确认 CAS、Owner/邮箱隔离、多订阅一次准入、HMAC/失败重试、开关/静默/限频、策略竞争、迟到 ACK、迟到订阅与配置变更、伪造载荷及不混入既有决策统计。浏览器验证真实创建与终态、全局提醒、详情、任务定位、确认冲突、跨邮箱深链接和分页，检查桌面/手机布局。

使用本地 workerd、独立 D1/R2、模拟 Access JWT 和 Webhook 接收端；没有创建云资源、远程部署或发送真实 Webhook。最终构建和测试数量见[开发记录](development.md)。

批次完成、失败和待对账提醒继续仅供Owner，三种通知Webhook沿用邮箱策略、签名与自动重试，详见[批次完成与异常通知](retry-batch-notifications.md)。
