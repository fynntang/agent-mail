# 通知失败投递批量重试任务的取消与未知结果对账

Owner 可停止当前邮箱通知重试任务尚未执行的条目、核对未知结果，并分页查看预览、提交、取消和对账历史。复用既有 Access Owner 权限、D1 和幂等审计，不增加 Worker、队列、绑定或依赖。

## 存储与升级

`0020_retry_batch_notification_retry_batches.sql` 已预留 `cancelled_at`、不可清除/改写触发器、执行租约及历史索引。本轮直接复用，不增加迁移；当前仍为56张 STRICT 表。已有任务及逐项结果无需回填或重新执行。尚未升级0020的实例仍需按部署流程应用已有迁移。

内部状态保持原约束；API 在取消标记存在时返回 `state: cancelled`、`cancelledAt`、`canCancel: false` 和 `canCommit: false`。取消标记不可撤销；再次提交原确认请求只能核对原提交，不会恢复执行。

## 停止未执行条目

活动或暂停邮箱的 Owner 可取消未过期的 preview、queued、running 任务。先在界面确认停止范围，再以当前批次 `expectedVersion` 和新的 `clientRequestId` 提交。

| 原条目状态 | 取消后的处理 |
| --- | --- |
| pending | skipped，原因 batch_cancelled，不再执行 |
| running | unknown，清除执行租约，等待原操作收据核对 |
| requeued / skipped / failed | 逐项结果、时间及收据全部保留 |
| unknown | 保留未知结果，可继续核对 |

取消在同一 D1 事务校验批次/条目版本、写入稳定审计收据、更新标记、停止条目并汇总进度。领取、过期清理与单条重试原子准入均检查取消标记及条目租约。取消先完成时，旧执行器不能增加重试预算；重新排队先完成时，其原收据可恢复为 requeued。

已重新排队的 Webhook 继续按原投递记录执行，取消不会撤回它们。requeued 代表已核实原重新排队操作，并不代表接收端已收到。取消释放本类任务/预览配额，保留全部历史；已完成、过期或取消的任务不接受另一次新取消，相同操作 UUID 可核对原收据。

## 核对未知结果

Owner 可指定一个 unknown 的 `deliveryId`，或省略以核对至多20项。系统读取条目原稳定 UUID 的 `webhook.delivery_retried` 收据，精确验证邮箱、通知、来源批次、投递、原版本和预算关系。

| 原操作证据 | 核对结果 |
| --- | --- |
| 完整匹配的原收据 | requeued，关联 manualRetryId |
| 原租约已撤销且收据不存在 | skipped，原因 not_submitted |
| 收据存在但字段冲突 | 保持 unknown，原因 receipt_conflict |
| 数据库/查询失败 | 操作失败，保留未知结果 |

最终事务再次核对批次和条目版本，以及收据存在/不存在的证据。核对不调用重新排队函数、不增加尝试预算、不执行 HTTP。已取消或过期的任务仍可核对 unknown；其余已完成条目不变。后台继续有界读取原收据，没有收据时保留未知，交由 Owner 明确核对；冲突证据推进下次读取时间，避免阻塞其他未知条目。

## API 与操作历史

```text
POST /owner/api/mailboxes/{mailboxId}/retry-batch-notification-retry-batches/{batchId}/cancel
POST /owner/api/mailboxes/{mailboxId}/retry-batch-notification-retry-batches/{batchId}/reconcile
GET  /owner/api/mailboxes/{mailboxId}/retry-batch-notification-retry-batches/{batchId}/operations?limit=20&cursor=...
```

POST 请求包含 `{"clientRequestId":"UUID","expectedVersion":7}`。reconcile 可额外包含 `deliveryId`。两种操作成功均返回200及 `{batch,replayed,operation}`。UUID 绑定邮箱、批次、动作、原版本和选项；响应丢失时沿用同一 UUID 和原条件核对，不能用新 UUID 猜测重做。改变原操作条件返回409。

两个相同操作并发时，即使后一个在首次查询收据后才读到已经变化的批次快照，也会再次核对原收据并返回同一操作。不同 UUID 的旧版本请求仍返回状态变化；同 UUID 改动作、版本或核对条目仍返回冲突。此保护也适用于原导出通知批量任务的取消与对账。

历史返回 `{operations,nextCursor}`，默认20项、最多100项，按时间和 ID 倒序；游标绑定邮箱、批次与页大小。界面每页3条。记录返回安全动作、操作 UUID、原版本、时间、停止/保留/未知数量，或至多20项核对结论。预览和确认关联原记录，取消和核对复用 `audit_events` 与 `audit_resource_history` 索引。

读取历史不推进任务、不写审计、不解密密钥、不访问 R2 或接收端。输出不包含目标 URL、载荷、签名秘密、租约或内部逐项重试 UUID。所有接口只允许 Access Owner；POST 要求正确 Origin。静态邮箱 Token、OAuth 和 MCP 不具有这些运维权限。跨邮箱批次返回404，无效输入400 `notice_batch_control_invalid`，状态/版本变化、操作冲突或暂不可用分别为409 `notice_batch_control_changed` / `notice_batch_control_conflict` / `notice_batch_control_unavailable`。

## 防止递归与验证

取消和对账仅修改本类两张执行表及 Owner 审计，不创建源导出重试批次、events 或批次通知。本类无完成/异常通知触发器，不会因取消、未知或核对再次生成通知重试任务。原通知策略、HMAC、传输重试和每轮 HTTP 预算继续复用原链路。

真实本地 D1 测试覆盖取消/领取/准入/检查点竞争、保留已执行结果、20+1核对上限、收据存在/缺失/冲突、原子回滚、丢 ACK 幂等恢复、历史分页及权限。最终 Worker 和浏览器验证暂停邮箱停止、单条与批量核对、原操作标识恢复、预算及源通知数量不变。命令、结果和桌面/手机验证记录见[开发验证](development.md)。本地验收使用模拟 Access/接收端，不代表远端 Cloudflare 或真实邮件已验收。
