# 批量任务通知失败投递的批量重试

Owner 在当前邮箱的批次通知面板旁，按失败时间和安全原因保存固定预览，核对后明确确认后台批量重试，并查看进度与逐项结果。重试复用[单条安全重试](retry-batch-notification-deliveries.md)，不新增发送通道。

## 升级与递归隔离

按顺序应用 `0020_retry_batch_notification_retry_batches.sql`，本地运行 `pnpm db:local`。增加 `retry_batch_notification_retry_batches` 和 `retry_batch_notification_retry_items`，当前共56张 STRICT 表。源通知复合索引/外键绑定邮箱、通知及来源批次，升级保留全部旧通知和执行记录，不回填历史任务。

新任务使用独立的两张表，不写入原导出通知批次，不创建 events 或新批次通知。0019的通知触发器只监听原批次，原导出批量重试也不选择这些新任务。因此本任务完成、失败、过期或出现 unknown 时仅保留执行历史，不再产生自身完成/异常 Webhook，避免通知重试不断生成下一轮通知。Owner 仍能在面板中查看异常与进度。

继续只部署一个 SvelteKit Worker，使用现有 D1、R2、Owner Access 与 Webhook 加密配置，没有新服务、绑定或依赖。

## 筛选与固定预览

邮箱范围由当前 Owner 导航和路径决定，不接受请求体扩大范围。只选择三种原批次通知（completed、failed、needs_reconciliation）真实关联的 dead 投递；原 disabled、quiet_hours、repeat_limited 或 no_subscribers 通知没有投递时，不通过此入口补发。

时间使用 `COALESCE(completed_at,updated_at)`，起点包含、终点不包含。默认最近7天，单次最多31天；reason 支持 all、other 及既有安全 Webhook 代码，例如 http_rejected、http_retry、network_error、delivery_timeout、signing_key_unavailable。other 包含空或未知诊断，输出不包含原始私有文本。

最多保存1000条完整候选，1001条返回413，不截断。预览固定通知ID、来源批次ID、投递ID、原投递版本、失败原因和时间、当时是否可重试及阻止原因。后续新增或再次失败的投递不加入；预览时被阻止的候选不在配置放开后自动变为可执行。

预览只读取公开资格提示，不解密密文、不访问 R2 或接收端；保存预览会写入新任务和 Owner 审计，不重新排队。未确认前，scheduled 不处理这些候选。修改界面筛选后，旧预览不能直接确认，需要重新生成或恢复原条件。

## 确认、执行与收据

预览和确认使用不同的 UUID `clientRequestId`。确认接受批次ID、原 expectedVersion 和确认UUID，不重新查询候选。同UUID与同一条件只核对原结果；换筛选、版本或批次会冲突。响应丢失时沿原UUID核对，不创建第二个任务。

| 限制 | 当前值 |
| --- | --- |
| 候选 | 最多1000条 |
| 时间范围 | 默认7天，最多31天 |
| 预览可确认时间 | 创建后10分钟 |
| 新执行截止 | 创建预览后24小时 |
| 未过期预览 | 本类每邮箱最多10个 |
| 活动任务 | 本类每邮箱2个、全实例4个，与原导出重试配额分别计算 |
| scheduled执行 | 本类每轮最多5项，包括恢复和未知结果核对 |
| 条目租约 | 120秒 |
| 单投递预算 | 每次增加8，累计最多80 |

旧导出重试与本类各自有5项执行预算；实际HTTP仍共用原传输器每轮2条预算。scheduled 先执行 Webhook 传输，再执行两类批量重新排队；本轮排队通常在后续cron执行HTTP。

条目调用现有单条安全重试，使用由本任务和投递派生的稳定内部UUID，保留原事件、投递、正文、URL和签名版本。执行时重复检查原版本、原通知 allowed、活动邮箱/端点、当前 enabled/非静默、冻结载荷/签名及剩余预算，不重新评估原限频准入。

原子审计准入还验证新任务的确认状态、条目通知/来源批次/投递/UUID、租约、版本和真实数据库截止时间。旧执行器或过期任务不能继续增加预算；审计和重新排队在同一D1事务完成，以 RETURNING 判断直接提交结果。

结果为 pending、running、requeued、skipped、failed 或 unknown。processedItems 等于 requeued/skipped/failed/unknown 之和；completed 要求全部处理且 unknown 为0。requeued 只表示重新排队已核实，不代表接收端已经收到通知。

版本变化、当前策略阻止、预览已阻止或到期会记录跳过原因；明确的密钥/载荷错误保留失败结果。丢ACK或租约恢复优先读取原单条重试收据，有收据则恢复 requeued；无证据时保留 unknown，仅做后续有界只读核对，不盲目重复提交，也不假报完成。本轮提供预览、确认和结果查看，未增加取消或人工修改未知结果接口。

## Owner API

```text
POST /owner/api/mailboxes/{mailboxId}/retry-batch-notification-retry-batches/preview
GET  /owner/api/mailboxes/{mailboxId}/retry-batch-notification-retry-batches?limit=20&cursor=...
GET  /owner/api/mailboxes/{mailboxId}/retry-batch-notification-retry-batches/{batchId}?limit=20&cursor=...
POST /owner/api/mailboxes/{mailboxId}/retry-batch-notification-retry-batches/{batchId}/commit
```

预览请求为 `{clientRequestId,from?,to?,reason?}`，成功201返回 `{batch,items,nextCursor,replayed}`。时间为Unix毫秒整数。确认请求为 `{clientRequestId,expectedVersion}`，成功202返回 `{batch,replayed}`。列表为 `{batches,nextCursor}`，详情为 `{batch,items,nextCursor}`；默认每页20、最多100，游标绑定邮箱、分页类型、任务和页大小。

batch 返回固定筛选、状态、版本、各类计数、创建/更新/确认/完成及截止时间和 canCommit；item 返回 notificationId、sourceBatchId、deliveryId、expectedUpdatedAt、原失败信息、previewEligible/previewReason、结果/原因、manualRetryId及时间/版本。内部逐项UUID、租约、请求hash、签名密文、目标和载荷不返回。

所有接口需要 Access Owner；POST 另需正确 Origin。活动/暂停邮箱可读取和预览，只有活动邮箱能新确认；原已提交UUID仍可只读核对。静态 Token、OAuth、MCP 不开放该运维权限。400 `batch_retry_invalid`，413 `batch_retry_too_large`，410 `batch_retry_expired`，409 `batch_retry_changed` / `batch_retry_conflict` / `batch_retry_quota`；未知/重复查询参数及额外请求字段拒绝。

## 验证

真实D1、最终Worker与浏览器覆盖1000/1001、半开筛选、默认窗口幂等、配额竞争、5+1执行、晚失败隔离、版本/策略跳过、租约替换/丢ACK/跨SQL截止、未知只读核对、权限和迁移。另明确检查新任务执行前后原批次、通知和events数量不变，签名重发保留原身份。执行记录见[开发验证](development.md)。
