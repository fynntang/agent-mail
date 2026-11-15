# 告警通知决策记录与降噪统计

Owner 在“抑制名单 → Cloudflare 运行提醒 → 查看通知决策”查看通知是否准入、跳过原因，以及对应 Webhook 的实际投递状态。记录复用0012中的不可修改决策和已有告警、事件、投递、尝试表；不增加发送任务，也不改变通知策略。

同一筛选可同步下载 CSV/JSON，包含完整匹配范围的降噪统计及订阅结果；导出不受列表分页影响，格式和数量边界见[导出说明](alert-notification-export.md)。超过同步上限时可创建[异步导出](async-alert-notification-export.md)，查看后台进度、取消及下载临时文件。

## 升级与权限

按顺序应用 `0013_alert_notification_decision_indexes.sql`，本地运行 `pnpm db:local`。该迁移只增加决策原因分页索引及事件投递查询索引，完成后仍为47张 STRICT 表。后续0014增加后台任务与分片清单，0015增加独立的导出成败通知，0017增加批量重试两表，0018 只增加取消标记及约束，0019增加批次通知快照表后，当前为54张表。导出通知准入、重排队及批次[取消/未知结果对账](async-export-notification-retry-controls.md)不写入本文决策记录。初始化检查会列出缺少的索引、表或列；无需新绑定、Secret 或 Worker。

记录从0012策略功能启用后持续积累。更早的 Webhook 没有通知决策行，仍可查看原投递记录；本次升级不从发送结果反推或补造历史跳过原因。

仅 Owner 可查询当前活动/暂停邮箱的记录，不要求 Cloudflare API Token 在线，也不依赖当前账户/域名配置。静态邮箱 Token、OAuth 和 MCP 不开放通知决策或统计；其他邮箱的事件 ID、游标和投递详情不能跨邮箱访问。GET 仅查询 D1，不写入审计、推进发布、修改限频、触发 Cloudflare 请求或重新发送 Webhook。

## 决策与发送结果

| 决策 | 含义 |
| --- | --- |
| allowed | 通知已准入；是否送达回调端，另看 Webhook 投递状态 |
| disabled | 发布时邮箱告警通知关闭，本次跳过 |
| quiet_hours | 发布时命中静默时段，本次跳过 |
| repeat_limited | 发布时命中同一告警信号的重复间隔，本次跳过 |
| recovery_disabled | 发布时恢复通知关闭，本次恢复通知跳过 |
| no_subscribers | 发布时没有符合订阅类型、活动状态和事件边界的订阅 |

以上决策保留当时的策略版本和时间，不会因为当前设置、告警恢复或 Webhook 重试改变。跳过的通知不补发。旧决策只保存版本号，不推断该版本具体静默时段、时区或间隔；当前策略表单也不代表历史配置快照。

一条已准入事件可以对应多个订阅投递。因此，“已准入1次、投递2条、成功1条、等待重试1条”是有效状态。成功指 Webhook 接收端返回2xx，不代表邮件送达或接收端业务处理完成。投递尝试计数包括已领取后发生签名或预检失败的尝试，不等于已经发出的 HTTP 请求数。

## 统计口径

总数、已准入、已跳过及六种原因按邮箱事件计数，每个决策只计一次；`总数 = 已准入 + 已跳过`。静默命中和限频命中是发布时跳过的历史次数，不按订阅数量放大。

投递统计另按订阅投递计数，包含 pending/running/succeeded/dead/cancelled、尝试次数和当前静默暂缓数量。`quietDeferred` 是当前 pending 且标记 `alert_quiet_hours` 的已有队列，不是历史静默跳过次数。已停止重试、取消、准入后暂缓及网络重试都不会新增一条准入决策。

汇总覆盖所选时间范围和全部筛选条件，包含所有匹配记录，不只统计当前一页。时间按 `decidedAt` 判断，起点包含、终点不包含；事件的 `occurredAt` 单独展示，不混作决策时间。

决策分页使用固定行号水位及“决策时间 + 事件 ID”排序。第一页之后的新记录，即使时间被回填到窗口内，也不会混入后续页面；刷新后开始新的快照。投递结果会继续变化，列表和汇总中的投递计数在同一只读事务中查询，代表该次查询时的状态；详情亦可读取最新状态。

## Owner 控制台

默认查询最近7天，提供24小时、7天、30天快捷范围；自定义时间使用浏览器本地时间，可以查询更早的历史，每次最多31天。支持按六种决策原因、故障/恢复通知和每页数量筛选，前后翻页保持同一窗口。

详情显示原决策、策略版本、告警结果和关联订阅投递。可打开已有告警详情，或读取单次投递的尝试、HTTP 状态及固定错误码。决策页不提供重试、确认知悉或解除操作。源事件异常时仍保留决策和统计，相关事件字段显示不可用，不显示原始 payload。

## Owner API

```text
GET /owner/api/mailboxes/{mailboxId}/alert-notification-decisions
    ?decision=all&eventType=all&from=1794096000000&to=1794700800000&limit=20&cursor=...
GET /owner/api/mailboxes/{mailboxId}/alert-notification-decisions/{eventId}
```

`decision` 支持 all 或上述六个值；`eventType` 为 all/created/resolved。`from`、`to` 为非负整数 Unix 毫秒，范围上限31天；缺省结束时间为当前时刻、开始时间为此前7天。`limit` 为1–100，默认20。重复或未知参数、无效范围及跨上下文游标返回400。

列表返回：

```text
{
  decisions: [{eventId,alertId,decision,policyVersion,decidedAt,eventAvailable,
    eventType,kind,outcome,errorCode,occurredAt,delivery}],
  nextCursor,
  window: {from,to},
  summary: {total,allowed,skipped,byDecision,delivery}
}
```

`delivery` 包含 `{total,pending,running,succeeded,dead,cancelled,attempts,quietDeferred}`。`eventType` 为 created/resolved，`kind` 为 sync/release；不可用的事件字段为 null。游标绑定邮箱、原因、事件类型、时间范围、页大小及水位；后续请求省略 `from/to` 时可恢复原窗口，其余筛选及页大小需保持一致。

详情返回 `{decision,deliveries,deliveriesTruncated}`，最多100条安全投递元数据。尝试详情复用已有 `/owner/api/mailboxes/{id}/webhook-deliveries/{deliveryId}`。响应不返回决策 claim token、原始事件 JSON、Webhook URL、签名密钥、API 凭据、邮件或收件地址；错误码使用固定允许列表。

## 验证

运行 `pnpm check`、`pnpm build:worker`、`pnpm test` 和 `pnpm test:e2e`。测试覆盖六种决策、静默/限频命中、单事件多订阅口径、投递变化、筛选和边界、固定水位分页、权限、只读副作用、异常源元数据及查询索引诊断。浏览器使用最终 Worker 验证统计、分页、自定义历史范围、告警和投递尝试关联、桌面及手机布局；Cloudflare 与 Webhook 使用本地模拟器。

批次完成、失败和待对账提醒继续仅供Owner，三种通知Webhook沿用邮箱策略、签名与自动重试，详见[批次完成与异常通知](retry-batch-notifications.md)。
