# 异步导出通知失败投递的批量重试

Owner 在当前邮箱的“导出通知失败投递批量重试”面板，按失败时间范围和安全原因筛选，保存预览并明确确认。后台分批重新排队，Owner 可查看进度、逐条排队/跳过/失败/待核对结果和关联的原重试审计。批量操作复用[单条安全重试](async-export-notification-deliveries.md)，没有第二条发送通道。

## 升级与入口

按顺序应用至 `0018_export_notification_retry_controls.sql`，本地运行 `pnpm db:local`；部署工具会应用全部待执行迁移。0017新增 `async_export_notification_retry_batches` 和 `async_export_notification_retry_items`，0018增加取消标记，仍为53张 STRICT 表。初始化向导检查必需字段和批次/条目分页与领取索引；原通知、投递和审计保留，不补造历史批次。

继续只部署一个 SvelteKit Worker，复用 D1、既有 R2 和 Access/Webhook 配置，无新增依赖、绑定、Secret、队列或外部服务。每个批次属于当前路径中的单个邮箱；切换邮箱后分别查询及操作，不能通过参数扩大为跨邮箱任务。

同一 scheduled 先执行既有 Webhook 传输，再处理批量重新排队，随后执行原导出与通知投影。因此本轮排队的投递通常在后续 cron 才执行 HTTP，进度中的“已重新排队”不代表接收端已经收到通知。

## 筛选与固定预览

默认最近7天，单次最多31天，时间窗口起点包含、终点不包含。按 dead 投递的 `COALESCE(completed_at,updated_at)` 筛选，即该投递最近结束自动重试时的时间；不是导出创建时间或通知决定时间。

reason 支持 all、other 及既有安全 Webhook 错误码，例如 http_rejected、http_retry、network_error、delivery_timeout、signing_key_unavailable、payload_unavailable、invalid_target、lease_expired 等。other 包含空或未识别的错误，API 不返回原始私有诊断文本。

只选取精确关联当前邮箱异步导出通知事件的 dead 投递。普通邮件/Cloudflare 抑制通知、已经成功、等待中、运行中和已取消的投递不进入候选。原通知被关闭、静默、限频或无订阅而跳过时，没有投递，批量重试不会重新生成。

预览最多保存1000个完整候选；超过1000返回413，不截断。候选保存通知任务 ID、投递 ID、原投递版本、原失败原因/时间、当时是否可重试及阻止原因。所有候选的总数与可重试数一同保存，不只保存界面当前页。

预览读取同一 D1 批次快照并使用现有资格提示，不解密历史秘密、不访问 R2 或接收端。资格提示不是最终执行保证：后续仍会校验真实密文及最新策略。预览可包含被策略、暂停邮箱、停用端点或预算阻止的候选，这些条目会保存原因且不会在后续配置放开后自动变为可执行。

保存预览会写入 D1 批次、固定条目及 Owner 审计，但不会重新排队或发送 HTTP。预览在创建后10分钟内可确认；时间范围、原因或固定候选不能改写。界面修改筛选后禁用旧预览的确认，需重新预览或明确恢复原条件。

## 确认与幂等

预览和确认分别使用 UUID `clientRequestId`。预览同一标识与相同筛选返回原预览，即使默认时间窗口已经向后移动；同标识换条件返回409。确认只接受批次 ID、原 `expectedVersion` 和确认 UUID，不重新查询候选、不接受投递 ID 或目标地址列表。

确认将批次和 Owner 审计原子提交。相同确认 UUID、相同预览版本可以核对原操作，状态已推进甚至已完成时也不重复提交；换标识或换条件会冲突。并发请求不能让同一批次执行两次。响应丢失或数据库提交 ACK 不明确时，界面保留原意图并沿同一标识核对；刷新 GET 不提交任务。

确认后新增、回填或再次失败的投递不进入该批次。执行只检查固定的原版本；如果投递在预览后已被单条操作或其他批次改变，会记录 changed 并跳过，而不是自动接受新版本。

## 执行预算与记录

| 限制 | 当前值 |
| --- | --- |
| 单批候选 | 最多1000条，包含预览时被阻止的条目 |
| 时间范围 | 默认7天，最多31天 |
| 确认预览 | 创建后10分钟内 |
| 执行截止 | 创建预览后24小时，不从确认时重新计时 |
| 待确认预览 | 每邮箱最多10个未过期预览 |
| 已确认活动批次 | 每邮箱最多2个，全实例最多4个 |
| 每轮 scheduled | 最多处理/恢复/核对5个条目，共享同一预算 |
| 条目租约 | 120秒 |
| HTTP 尝试预算 | 沿用单投递每次增加8、累计最多80 |

每条使用由批次和投递稳定派生的请求 UUID 调用单条重试。单条审计继续使用 `webhook.delivery_retried`，记录可在原投递详情查看；批量条目保存对应的安全审计 ID，不隐藏或重置旧传输尝试。

执行前重新检查 Owner 已确认批次、条目租约及版本、批次截止时间、活动邮箱/端点、原通知 allowed、dead 状态、原投递版本、当前通知 enabled/非静默、剩余预算、冻结载荷、目标地址及签名密文。已有 allowed 投递不再次消耗重复通知准入预算，也不受 Cloudflare 恢复通知开关影响。

单条提交还在 D1 原子写入中检查批次与条目围栏。迟到 Worker 失去租约、批次过期或状态变化后不能继续增加预算。准入时的实时截止检查与审计/投递更新使用同一原子操作，避免跨时钟边界产生只有审计、没有排队的假成功。

每条结果：

| state | 含义 |
| --- | --- |
| pending | 已选定，尚未处理；未确认预览也保持此状态 |
| running | 当前持有租约，正在校验或执行原子重新排队 |
| requeued | 已核实原单条重试收据，投递曾被重新排队 |
| skipped | 原版本变化、策略/状态阻止、预览已阻止或任务截止等，未进行新排队 |
| failed | 明确的安全校验/执行失败，保留白名单原因 |
| unknown | 无法确定是否越过提交边界，等待只读收据核对 |

批次显示 totalItems、eligibleItems、processedItems、requeuedItems、skippedItems、failedItems、unknownItems；processedItems 等于四类结果之和，unknown 也计入已检查数量。进度从持久化条目汇总，在同一事务中更新，不因重复回调累加两次。

批次 state 为 preview、queued、running、completed、expired、cancelled。completed 要求全部条目已处理且没有 unknown；仍有未知结果时明确显示待核对，不宣告全部完成。完成可能包含跳过或失败，不能解释为所有 Webhook 成功。

## 中断、未知结果与到期

如果单条排队已提交但批量检查点回应丢失，后台使用相同稳定请求 UUID 查找既有不可变审计，恢复为 requeued，不重新增加预算。即使原投递已再次 dead，原收据仍只代表第一次排队，不能用重放触发下一轮发送。

租约恢复或结果不明确时优先只读核对收据；没有可确认的收据会保留 unknown，后续有界核对，不盲目再次提交。已启动条目的核对可以在批次过期后继续，但不延长执行截止，也不创建新的单条重试。

24小时后，不再为未启动条目创建新排队；已确认条目分批记录过期/跳过。预览10分钟后即不能确认，不依赖 cron 已完成状态持久化。预览及结果元数据保留在 D1 作为历史，不在本轮删除。此功能不清理或延长原导出文件，R2 文件仍按原24小时规则处理。

## Owner API

Owner 可取消尚未执行的工作、手动核对 unknown 并分页查看操作历史；已重新排队的投递保持原结果和预算。取消及对账有独立的幂等收据，详见[取消与未知结果对账](async-export-notification-retry-controls.md)。

```text
POST /owner/api/mailboxes/{mailboxId}/export-notification-retry-batches/preview
GET  /owner/api/mailboxes/{mailboxId}/export-notification-retry-batches?limit=20&cursor=...
GET  /owner/api/mailboxes/{mailboxId}/export-notification-retry-batches/{batchId}?limit=20&cursor=...
POST /owner/api/mailboxes/{mailboxId}/export-notification-retry-batches/{batchId}/commit
```

预览请求（成功201）：

```json
{
  "clientRequestId": "00000000-0000-4000-8000-000000000001",
  "from": 1794096000000,
  "to": 1794700800000,
  "reason": "http_rejected"
}
```

返回 `{batch,items,nextCursor,replayed}`；from/to/reason 可省略，时间为 Unix 毫秒整数。确认请求（成功202）：

```json
{
  "clientRequestId": "00000000-0000-4000-8000-000000000002",
  "expectedVersion": 1
}
```

确认返回 `{batch,replayed}`，只表示任务已确认/核对，不表示已经发送。列表返回 `{batches,nextCursor}`，详情返回 `{batch,items,nextCursor}`。GET 默认每页20、最多100；游标绑定邮箱、分页种类、批次与每页数量。未知/重复查询参数、请求体额外字段均拒绝。

批次公开字段包含 id、mailboxId、window、filters.reason、state、version、各类计数、创建/更新时间、previewExpiresAt、expiresAt、committedAt、completedAt、canCommit。条目公开 deliveryId、jobId、expectedUpdatedAt、failureReason、failedAt、previewEligible、previewReason、state、reason、manualRetryId、时间和版本。返回值不含稳定内部重试 UUID、租约、请求 hash、签名秘密、目标 URL、原始载荷或收件数据。

常见错误：400 batch_retry_invalid，413 batch_retry_too_large，410 batch_retry_expired，409 batch_retry_changed / batch_retry_conflict / batch_retry_quota。quota 也用于当前邮箱暂停或预览/活动任务配额已满的情况；界面会显示当前不可提交并提示核对。

所有端点使用现有 Access Owner 认证，POST 还要求匹配 Origin。活动/暂停邮箱可预览及读取，只有活动邮箱可新确认；重复确认仅核对已提交意图。静态邮箱 Token、OAuth 和 MCP 不开放批量运维权限。GET 不修改审计、任务、预算、策略或投递，也不推进后台处理。

## 验证

单元和最终 Worker 测试覆盖精确时间/原因筛选、1000/1001边界、固定候选与默认窗口幂等、明确确认、配额竞争、分页/邮箱隔离、5条预算、策略与版本变化、崩溃恢复、租约替换、过期围栏、未知结果及原收据对账。浏览器实际验证6条候选、预览后新增失败不混入、双阶段丢响应核对、5+1进度与逐条结果、签名投递及桌面/手机布局。

验证使用本地 workerd、独立 D1/R2、模拟 Access JWT 和 Webhook 接收端，不部署远端或发送真实 Webhook。最新执行数量见[开发记录](development.md)。
