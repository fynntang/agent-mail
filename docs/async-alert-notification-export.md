# 告警通知决策异步导出

Owner 在“抑制名单 → 通知决策与降噪 → 后台大批量导出”创建 CSV/JSON 任务，查看进度、取消生成和下载结果。任务复用当前已应用的时间、决策原因和通知类型，支持超过[同步导出](alert-notification-export.md)1000条决策、5000条投递和8 MiB的文件。

同一个 Worker 的 `scheduled` 分批查询 D1、序列化并把不可变分片写入现有私有 `MAIL_BLOBS` R2；Owner API 从分片拼接流式响应。不增加 Worker、Queue、外部导出服务、公共桶或下载凭据。已有邮件解析、发送和 Webhook 任务先执行，异步导出使用独立的有限批次预算。

## 升级与使用

按顺序应用 `0014_async_alert_notification_exports.sql`，本地执行 `pnpm db:local`；部署工具会执行待应用的迁移。该迁移新增任务与分片清单两张 STRICT 表，完成后共49张表；后续0015增加完成/失败通知及独立限频状态，0016增加投递重试历史索引，0017增加批量重试预览及结果，0018 增加批次取消标记及约束，0019增加批次通知快照表后，当前为54张表。初始化检查包含必需表、字段及索引，状态及不可变约束由迁移建立并由 schema 测试验证。继续使用原有 D1、R2 和 cron，无需新增 Secret 或绑定。

先应用查询，再点击“创建后台 CSV”或“创建后台 JSON”。未应用的自定义时间不能创建任务。列表显示筛选、范围、已处理决策/总数、投递数、生成字节数、统计、创建/过期时间和投递结果读取时段；任务每页10条，可翻页和手动刷新。有进行中任务时每5秒查询当前页，页面隐藏或卸载时停止轮询。

创建请求使用 UUID `clientRequestId`。响应丢失时，“重试创建并核对”复用同一标识和原条件，返回原任务；同一标识改动条件返回409。放弃重试标识不会取消已经创建的任务，可以先刷新列表核对。任务关闭页面后仍由 cron 继续处理。

仅 `queued` / `running` 可以取消。取消携带当前 `expectedVersion`，与进度竞争时返回409，刷新后再核对；取消成功立即撤销租约并禁用下载，随后清理临时对象。已完成任务保留至到期，已下载到本地的文件不受任务状态影响。

任务首次完成或最终失败会产生独立的 Owner 提醒，可以查看详情并确认知悉；导出过期后通知仍保留，确认不会改变任务、延长下载有效期或触发重试。通知与终态原子保存，不回填升级前已结束的任务，取消/过期不产生新完成或失败通知。

通知失败投递的批量重试另有[Owner取消、未知结果对账和操作历史](async-export-notification-retry-controls.md)。这些控制针对通知重新排队批次，不改变本页导出生成任务及文件有效期；unknown核对原收据，不重新发送Webhook。

邮箱 Webhook 可订阅 `alert_notification.export.succeeded` / `alert_notification.export.failed`，复用通知开关、静默、重复限频、HMAC 和失败重试；完成不属于故障恢复。现有 scheduled 先处理 Webhook，再运行导出并最多投影20条终态通知，生成的新事件由下一轮处理。订阅必须在终态前创建且最后配置时间严格早于终态时间，同毫秒或终态后更改配置的订阅保守不补发。详情见[完成与失败通知](async-export-notifications.md)。

## 范围、一致性与格式

筛选沿用[决策查询](alert-notification-decisions.md)：默认最近7天，最多31天，起点包含、终点不包含；原因支持 all、allowed、disabled、quiet_hours、repeat_limited、recovery_disabled、no_subscribers，通知类型支持 all、created、resolved。

创建时固定实际起止时间、筛选条件、决策行号水位和匹配总数。后续新增或回填的决策不进入该任务。决策记录不可修改，按 `decided_at DESC,event_id DESC` 使用游标逐批读取；如果源记录数量与固定范围不一致，任务失败，不生成截断的成功文件。

Webhook 投递状态会继续变化，因此每批在同一个 D1 读取事务中取得该批决策和对应投递，并按实际写入文件的明细累计统计。文件表示各批读取时观察到的结果，不是整个任务某一个瞬间的全局投递快照。`observedFrom` / `observedTo` 记录第一次读取开始到最后一次读取结束的区间；后续投递成功或重试不会改写已生成的分片。统计的事件/订阅口径与同步导出相同。

JSON 保持同步导出的 `version: 1`、window、filters、snapshot、summary、decisions 等字段，并增加：

```json
{
  "processing": {
    "startedAt": 1794700800000,
    "completedAt": 1794700920000,
    "observedFrom": 1794700800001,
    "observedTo": 1794700920000,
    "deliverySnapshot": "per_batch"
  }
}
```

所有 JSON 时间为 Unix 毫秒，`generatedAt` 是完成时间。CSV 复用同步导出的列和四种 `row_type`，只有一个 UTF-8 BOM 和表头，元数据及最终统计在文件开头；增加 `processing.startedAt`、`processing.completedAt`、`processing.observedFrom`、`processing.observedTo`（Unix 毫秒）和 `processing.deliverySnapshot` 元数据。其余 `*_utc` 列仍为 UTC ISO8601。文本继续进行公式前缀中和及 RFC4180 转义。空结果生成有效空明细文件。

## 预算与执行

| 限制 | 当前值 |
| --- | --- |
| 单任务决策 | 最多100000条，创建时超限返回413 |
| 单任务订阅投递 | 最多1000000条 |
| 单文件 | 最多256 MiB，预留64 KiB元数据空间 |
| 每批读取 | 最多50条决策及这些决策的5000条完整投递 |
| 每个分片 | 最多8 MiB |
| 每次 cron | 最多10个处理批次，按可执行时间和最近更新时间公平领取 |
| 进行中任务 | 每邮箱最多2个，全实例最多4个 |
| 有效期 | 从创建时起24小时，包括等待和生成时间 |
| 租约与重试 | 120秒租约；存储失败退避重试，连续5次失败终止 |

如果某批的完整投递数或序列化大小超过批次预算，或累计文件/投递超限，任务明确失败，不提供部分文件。每批成功后清除连续失败计数。中断租约可以恢复并从已提交游标继续；超过连续失败预算进入 failed。实际完成时间受 cron 频率、排队和数据量影响。

分片 key 包含任务和本次租约 UUID，写入后不会覆盖其他尝试。D1 原子批次提交清单及进度，使用版本、租约、到期时间和状态阻止迟到执行者发布。R2 已写但 D1 回应丢失时先核对提交收据，避免误删已提交分片。未提交的迟到对象由任务前缀清理回收。

上述最大规模按 Workers Paid 预算设计。最多2000个分片的下载每16片合并一次 D1 状态/清单查询，共约128次 D1调用与2000次 R2读取；符合 Paid 的1000次 D1调用和默认10000次子请求预算。Free 的 D1、内部子请求及 CPU 预算更低，不能保证最大规模完成；免费额度内的小文件仍可使用同步导出。参见 Cloudflare [D1限制](https://developers.cloudflare.com/d1/platform/limits/)及[Workers限制](https://developers.cloudflare.com/workers/platform/limits/)。本地模拟器不替代云端配额和 CPU 验收。

## 状态与数据表

| 状态 | 含义与操作 |
| --- | --- |
| queued | 等待首批、下一批或退避，可取消 |
| running | 当前批次持有租约，可取消 |
| succeeded | 完整清单和最终统计已提交，有效期内可下载 |
| failed | 永久错误或连续失败达到上限，不可下载；可重新创建任务 |
| cancelled | Owner 取消或邮箱退役导致停止，不可下载 |
| expired | 有效期已过，不可下载 |

`async_alert_notification_exports` 保存邮箱归属、幂等请求 hash、固定筛选/水位、总数、游标、累计统计、进度、状态、版本、租约/重试、观察区间及清理时间。身份、筛选和有效期不可修改；进度只增，状态转换受数据库触发器约束。

`async_alert_notification_export_chunks` 保存 `(job_id,sequence)`、邮箱归属、私有对象 key、长度和 SHA-256。序号从1开始，分片清单不可修改。任务、分片元数据保留作为进度、重试及清理依据，不随 R2 文件删除；Owner DTO 不暴露对象 key、租约、请求 hash 或内部恢复字段。具体约束见[数据库文档](database.md)和[完整 schema](schema.sql)。

## Owner API

```text
POST /owner/api/mailboxes/{mailboxId}/alert-notification-exports
GET  /owner/api/mailboxes/{mailboxId}/alert-notification-exports?limit=20&cursor=...
GET  /owner/api/mailboxes/{mailboxId}/alert-notification-exports/{jobId}
POST /owner/api/mailboxes/{mailboxId}/alert-notification-exports/{jobId}/cancel
GET  /owner/api/mailboxes/{mailboxId}/alert-notification-exports/{jobId}/download
HEAD /owner/api/mailboxes/{mailboxId}/alert-notification-exports/{jobId}/download
```

创建请求体示例（成功返回202）：

```json
{
  "clientRequestId": "2d14b878-1108-45f8-bf3b-2c28748eef50",
  "format": "json",
  "decision": "all",
  "eventType": "all",
  "from": 1794096000000,
  "to": 1794700800000
}
```

`format` 和 `clientRequestId` 必填；其他字段可省略。创建/详情/取消返回 `{job}`，列表返回 `{jobs,nextCursor}`；取消体为 `{"expectedVersion": 3}`。列表默认20、最多100条，游标绑定邮箱和每页数量。未知/重复查询参数、创建和取消的额外字段均拒绝。

公开任务字段包括 id、mailboxId、format、state、version、window、filters、snapshot、totalDecisions、processedDecisions、processedDeliveries、chunkCount、bodyBytes、summary、createdAt、updatedAt、startedAt、completedAt、expiresAt、observedFrom、observedTo、errorCode、canCancel、downloadAvailable。`bodyBytes` 是已提交明细分片的总字节数，不包括下载时添加的表头、元数据和 JSON 外壳；完成后 `summary` 与文件相同。

常见错误：创建配额409 `async_export_quota_exceeded`；同标识不同条件409 `async_export_idempotency_conflict`；取消版本冲突409 `async_export_changed`；不能取消409 `async_export_not_cancellable`；未完成下载409 `async_export_not_ready`；过期下载410 `async_export_expired`。任务中记录安全错误码，例如 `async_export_batch_too_large`、`async_export_limit_exceeded`、`async_export_storage_unavailable`、`async_export_source_changed`，不返回 SQL 或上游自由文本。

所有端点均要求现有 Cloudflare Access Owner JWT，创建/取消还要求正确 Origin；仅活动/暂停邮箱可以访问。静态邮箱 Token、OAuth 和 MCP 不获得这些运维导出能力。创建、取消写入既有 Owner 审计；GET/HEAD 不推进任务、不写通知或审计、不访问 Cloudflare API、不发送 Webhook。

## 私有下载与到期清理

下载由同源 Owner API 验证实时身份和邮箱归属，不提供公共或预签名 R2 URL。固定文件名为 `alert-notification-decisions-{mailboxId}-{jobId}.{format}`；响应设置 attachment、private/no-store、nosniff 及对应 CSV/JSON MIME。浏览器使用原生下载流，不把大文件转为页面 Blob。

下载前检查清单连续性、总长度和统计；传输时按需分页读取清单，每次读取一个至多8 MiB分片，校验长度与 SHA-256，再发送给客户端。文件通过前缀/分片/后缀组合，不在 Worker 内拼接完整文件。使用 Workers `FixedLengthStream` 让运行时获取流长度；压缩协商可能改变 HTTP 传输长度，解码后的文件内容保持不变，见 Cloudflare [Response 文档](https://developers.cloudflare.com/workers/runtime-apis/response/)。缺片或校验错误终止下载流，不返回伪造的完整成功文件。

24小时从创建时计算，等待时间也占用有效期。即使 cron 尚未把状态持久化为 expired，读取立即显示过期，下载立即返回410；流式下载每次读取时及取得分片后检查到期，过期后停止继续发送。邮箱状态与每16条清单分页在同一 D1 批次检查，正在传输的下载会在下一个清单分页边界检测邮箱退役并停止；新下载始终重新校验邮箱状态。

每次 cron 最多清理2个 failed/cancelled/expired 任务，每任务删除本任务前缀下最多32个对象；还有对象时一分钟后继续，否则一小时后再次检查。清理异常保留待办并重试，不影响其他对象。已无对象的终态任务仍定期复查，以回收取消/到期之后才完成写入的迟到对象。清理积压可能延迟物理删除，但不会延长下载有效期；D1 元数据保留，任务不会重新启用。

## 本地验证

`pnpm check`、`pnpm build:worker`、`pnpm test`、`pnpm test:e2e` 验证 schema/状态约束、幂等及并发配额、固定水位与分批统计、租约恢复、未知提交结果、取消/清理竞争、迟到对象重扫、到期拒绝、损坏分片拒绝及 Owner/邮箱隔离。大文件集成用2001条决策和20010条投递生成超过8 MiB的有效 JSON，核对 CSV/JSON 全量内容、统计、流长度和分页；浏览器真实创建任务、读取进度、下载并独立解析 CSV/JSON、取消和验证过期清理，检查桌面与手机布局。

全部验证使用本地 workerd、内存 D1/R2、模拟 Access JWT 和拦截的外部服务，不创建云资源或触发真实邮件/Webhook；真实部署仍需现有 Access、R2 和 cron 配置。最终执行记录见[开发文档](development.md)。

批次完成、失败和待对账提醒继续仅供Owner，三种通知Webhook沿用邮箱策略、签名与自动重试，详见[批次完成与异常通知](retry-batch-notifications.md)。
