# 批量重试任务的取消与未知结果对账

Owner 可在当前邮箱的批量重试面板取消尚未结束的任务、手动核对未知结果，并分页查看预览、确认、取消和对账历史。操作继续使用 Cloudflare Access Owner 认证和 D1，不增加 Worker、绑定、队列或依赖。

## 升级

按顺序应用 `0018_export_notification_retry_controls.sql`，本地执行 `pnpm db:local`。此迁移只给批次增加 `cancelled_at` 和不可改写触发器，仍为53张 STRICT 表。已有批次、逐项结果、投递和审计保持原样，不重新排队。初始化向导会检查该字段，未应用时报告0017和待迁移状态。

数据库保留原来的批次状态约束，API 在取消标记存在时显示 `state: cancelled`，并返回 `cancelledAt`、`canCancel` 和 `canCommit: false`。取消标记不能清除或改写，关闭面板或再次确认原提交都不能恢复执行。

## 取消语义

活动或暂停邮箱的 Owner 可取消尚未过期的 preview、queued、running 批次。界面先展示确认说明，提交携带当前批次版本和新的操作 UUID。取消与执行使用同一 D1 事务边界和版本围栏：

| 原条目状态 | 取消后的处理 |
| --- | --- |
| pending | skipped，原因 batch_cancelled，不再执行 |
| running | unknown，撤销执行租约，等待原收据核对 |
| requeued / skipped / failed | 保留全部结果、时间和收据 |
| unknown | 保留，允许继续核对 |

后台领取和单条重试的原子准入都检查取消标记、条目租约及版本。取消先提交时，旧执行器不能再增加投递预算；重试先提交时，已有收据可恢复条目结果。取消操作不撤回已经重新排队的 Webhook，接收端仍可能随后收到这些通知。`requeued` 只代表原重新排队已确认，不代表 HTTP 成功。

取消会释放预览和活动任务配额，但保留记录。已过期任务不再执行新工作，仍可核对 unknown。完成、过期或已取消批次不能另发一次新的取消操作；相同 UUID 可继续核对原取消收据。

## 手动对账

Owner 可核对一个 unknown 条目，或每次最多20个；其余条目继续显示待核对。核对读取该条目原稳定 UUID 对应的不可变 `webhook.delivery_retried` 审计，并验证邮箱、导出任务、投递、原版本及预算关系：

| 证据 | 记录结果 |
| --- | --- |
| 有完整匹配的原重试收据 | requeued，并关联 manualRetryId |
| 已撤销执行租约，且原收据确实不存在 | skipped，原因 not_submitted |
| 原收据存在但内容冲突 | 保持 unknown，原因 receipt_conflict |
| 数据库或查询失败 | 返回错误，保留原未知结果 |

核对不调用重新排队函数，不增加尝试预算，也不执行 HTTP。未知条目已经失去原执行租约；最终事务再次验证批次和条目版本，以及收据存在或不存在的证据，避免预读与并发执行之间的竞争。出现版本冲突时，刷新当前结果后再发起新的操作；响应不明时沿原 UUID 核对，不能以新 UUID 猜测重试。

后台仍有界核对原收据；没有收据时继续保留 unknown，由 Owner 显式确认未提交的结果。已取消或过期的批次也可手动对账。每次对账保存所选条目的证据结论，不改变已完成的其他条目。

## API 与操作历史

```text
POST /owner/api/mailboxes/{mailboxId}/export-notification-retry-batches/{batchId}/cancel
POST /owner/api/mailboxes/{mailboxId}/export-notification-retry-batches/{batchId}/reconcile
GET  /owner/api/mailboxes/{mailboxId}/export-notification-retry-batches/{batchId}/operations?limit=20&cursor=...
```

取消请求：

```json
{"clientRequestId":"00000000-0000-4000-8000-000000000003","expectedVersion":7}
```

对账请求使用相同字段，可额外指定 `deliveryId`；省略时选择最多20个 unknown。两种 POST 成功均为200，返回 `{batch,replayed,operation}`。相同操作 UUID、批次、版本和选项只返回原操作收据及当前批次状态；复用 UUID 改成其他操作或条件返回409。

历史返回 `{operations,nextCursor}`，默认20、最多100条。游标绑定邮箱、批次和每页数量，按操作时间及 ID 倒序分页。记录包括 action、clientRequestId、expectedVersion、occurredAt、安全汇总和至多20项对账结论。取消汇总显示停止、待核对和保留数量；对账汇总显示发现收据、确认未提交和冲突未解数量。

历史复用 `audit_events` 及 `audit_resource_history` 索引。旧预览和提交通过原批次关联展示；取消和对账具有稳定审计 ID。GET 不推进任务、不写审计、不解密秘密、不访问 R2 或通知接收端。输出不包含签名密钥、目标 URL、完整载荷、租约或内部逐条重试 UUID。

写操作要求同源 Origin。静态邮箱 Token、OAuth 和 MCP 没有 Owner 运维权限，不能调用这些端点。常见错误为400 `batch_control_invalid`，409 `batch_control_changed`、`batch_control_conflict`、`batch_control_unavailable`；跨邮箱批次返回404。

## 验证与运行边界

真实本地 D1 测试覆盖取消与旧执行器竞争、保留已执行结果、收据存在/缺失/冲突、原子回滚、丢 ACK 后幂等核对、历史分页、暂停邮箱和权限。最终 Worker 与浏览器验证控制台确认、未知结果核对、操作历史、响应丢失恢复及桌面/手机布局。实际执行数量见[开发记录](development.md)。

本地使用 workerd、D1/R2 和模拟 Access/接收端，不部署远端，不发送真实邮件或 Webhook。其他批量筛选、配额、截止时间和发送流程见[批量重试](async-export-notification-retry-batches.md)。

后续0019为完成、执行失败及待对账结果增加[Owner提醒与Webhook通知](retry-batch-notifications.md)，当前共54张表。取消后未知结果仍会告警；对账不改写原告警快照，当前状态会反映已核对。
