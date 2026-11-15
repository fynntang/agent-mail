# 告警通知决策导出

Owner 在“抑制名单 → 通知决策与降噪”展开记录后，可同步下载 CSV 或 JSON。导出复用当前已应用的时间范围、决策原因和通知类型，包含全部匹配记录、降噪统计及每个订阅的 Webhook 投递结果，不受当前页大小或页码限制。本文描述同步接口；大批量数据可在同页创建[异步导出任务](async-alert-notification-export.md)，查看进度、取消及下载。

同步导出保留既有语义，复用0013索引，不创建后台任务，仅查询 D1，不写入审计或限频、不推进通知发布、不访问 Cloudflare、不重新发送 Webhook。当前完整应用最新迁移为 `0019_retry_batch_notifications.sql`、共54张表；0017新增批量重试两表，0018只增加取消标记及约束。异步任务及其成败通知使用同一 Worker 的 scheduled 和私有 R2，不改变本文同步格式及上限。通知批次的[取消与未知结果对账](async-export-notification-retry-controls.md)也不改写导出内容或延长文件有效期。

## 范围与一致性

沿用现有查询规则：默认最近7天，每次最多31天；起点包含、终点不包含，按决策时间筛选。通知类型为故障 created、恢复 resolved 或 all；原因支持 all 及 allowed/disabled/quiet_hours/repeat_limited/recovery_disabled/no_subscribers。

导出重新建立决策行号水位，并在同一 D1 读取事务中取得决策、统计及当前投递结果。文件记录 `generatedAt`、筛选条件和 `snapshot.decisionWatermark`，代表导出时的快照，不复用列表的旧分页游标。Webhook 后续成功、重试或取消不会改写已下载文件。

统计沿用[决策记录口径](alert-notification-decisions.md)：准入/跳过按邮箱事件计数，实际投递按订阅计数；一次准入可以对应多个投递。静默/限频命中是发布时跳过的记录，`quietDeferred` 是当前已有队列的静默暂缓数。尝试次数不等于已发出的 HTTP 请求数，投递成功指接收端返回2xx。

同步导出每次最多1000条决策、5000条订阅投递，序列化文件最多8 MiB。超限返回413 `alert_notification_export_too_large`，不截断、不生成部分文件；可缩小时间范围、增加筛选，或改用[后台大批量导出](async-alert-notification-export.md)。每条决策的订阅结果在此预算内完整导出，不使用详情页100条上限。

## Owner 控制台

先查询并应用需要的范围和筛选，再点击“导出 CSV”或“导出 JSON”。修改了自定义时间却尚未查询时，导出按钮会禁用，避免下载旧范围。下载期间可以取消；超限和网络错误显示在导出按钮附近，不把错误响应保存成文件。

浏览器只向当前 Owner 源请求，沿用 Cloudflare Access 登录。收到登录页面、重定向、无效 MIME、错误状态或超过8 MiB的响应时不生成下载。文件名由邮箱 UUID、实际起止毫秒及固定后缀构成，不采用邮箱名称、地址或响应中的自由文本。

## JSON 文件

Content-Type 为 `application/json; charset=utf-8`，UTF-8编码，无 BOM。顶层格式为：

```text
{
  version: 1,
  generatedAt,
  mailboxId,
  window: {from,to},
  filters: {decision,eventType},
  snapshot: {decisionWatermark},
  summary: {total,allowed,skipped,byDecision,delivery},
  decisions: [{...现有安全决策字段,deliveries: [安全WebhookDelivery]}]
}
```

时间保留 Unix 毫秒整数。`summary.delivery` 和每条决策的 `delivery` 包含 total/pending/running/succeeded/dead/cancelled/attempts/quietDeferred。`deliveries` 包含投递及端点 ID、状态、尝试及预算、HTTP 状态、安全错误码、签名版本和时间；不包含 URL 或签名密钥。

## CSV 文件

Content-Type 为 `text/csv; charset=utf-8`，UTF-8 BOM 便于 Excel 识别，使用 RFC4180 双引号转义和 CRLF 行结束。只有一个表头，所有行的列数一致；通过 `row_type` 筛选不同记录：

| row_type | 内容 |
| --- | --- |
| metadata | metric/value 保存格式版本、生成时间、邮箱 UUID、范围、筛选及水位 |
| summary | metric/value 保存 total/allowed/skipped、by_decision.原因 及 delivery.计数 |
| decision | 一条邮箱事件决策及其投递汇总 |
| delivery | 一条订阅投递，event_id/alert_id 关联决策 |

决策行包含 `event_id,alert_id,decision,policy_version,decided_at_utc,event_available,event_type,kind,outcome,error_code,occurred_at_utc` 及 `delivery_*` 汇总列。投递行包含 `delivery_id,endpoint_id,delivery_state,attempts,attempt_budget,available_at_utc,last_http_status,last_error_code,secret_version,created_at_utc,updated_at_utc,completed_at_utc`。

CSV 时间为 UTC ISO8601 字符串，空值为空单元格。文本单元格以 `=,+,-,@` 开头或存在会掩盖这些前缀的空白/控制字符时，会加单引号前缀；引号、逗号和换行另按 CSV 结构转义，避免表格软件把内容执行为公式。JSON保留原始安全数据值。

空结果仍返回有效文件：JSON包含空 decisions 和零统计；CSV包含表头、元数据和零统计，不伪造明细行。损坏的关联事件仍保留原决策，事件字段使用现有 null/不可用语义，不从原始 payload 恢复私有内容。

## Owner API 与权限

```text
GET /owner/api/mailboxes/{mailboxId}/alert-notification-decisions/export
    ?format=csv&decision=quiet_hours&eventType=created&from=1794096000000&to=1794700800000
GET /owner/api/mailboxes/{mailboxId}/alert-notification-decisions/export?format=json
```

`format` 必填，仅 csv/json；其他筛选沿用现有接口。`cursor`、`limit`、未知或重复参数均返回400。文件响应设置 attachment、private/no-store 和 nosniff；错误返回普通 JSON，未附下载头。固定文件名格式为 `alert-notification-decisions-{mailboxId}-{from}-{to}.{format}`。

仅 Owner 可导出活动/暂停邮箱，写入权限和 Cloudflare API Token 均非必要。静态邮箱 Token、OAuth 和 MCP 不获得导出能力；其他邮箱 UUID 不能绕过邮箱归属。文件不含决策 claim token、原始事件 JSON、Webhook URL、签名密文/明文、API凭据、邮件内容或收件地址。

## 验证

`pnpm check`、`pnpm build:worker`、`pnpm test`、`pnpm test:e2e` 覆盖完整范围与列表分页的区别、精确筛选边界、同一读取快照、六类统计、Webhook结果、公式中和、CSV Unicode/引号/换行、空文件、1000/5000恰好上限及超限413、8 MiB序列化上限、Owner及Agent隔离和只读性。浏览器实际下载并解析两种文件，验证错误/登录页面/取消均不产生文件，检查桌面和手机布局。所有外部服务使用本地模拟上游。
