# 批量任务通知的投递追踪与手动重试

Owner 在批次通知详情查看原通知决策、跳过原因、事件发布进度、各订阅的 Webhook 状态、传输尝试与手动重试收据。通用 Webhook 页面采用相同的安全重试协议。全部操作保持单 Worker，复用 D1 和现有通知策略、加密签名及传输器。

## 数据与权限

沿用0019的通知快照、events、webhook_deliveries、webhook_delivery_attempts 和 audit_events，使用0016已有 `audit_resource_history` 索引；无需新增迁移、表、绑定、Secret 或依赖，当前仍为54张 STRICT 表。

GET 需要现有 Cloudflare Access Owner 身份，活动和暂停邮箱可读；静态邮箱 Token、OAuth 和 MCP 不开放通知运维数据。查询不写任务、审计、事件或限频状态，不解密签名密文，不访问 R2 或接收端。Webhook 密钥暂不可用时仍可查看历史，但新重试不可用。

输出只含安全状态、UUID、计数、HTTP 状态、白名单错误代码、时间和版本，不返回冻结 URL、邮件数据、签名密钥/密文、端点配置快照、租约或原始载荷。当前资格提示会检查公开配置和冻结数据结构；POST 还会验证真实密文并重复校验当前状态。

## 决策、发布与结果

原准入决定保持不可变：allowed、disabled、quiet_hours、repeat_limited 或 no_subscribers。Owner 可查看策略版本及决定时间；当前开关或静默状态另行显示，不覆盖原决定。

| 发布状态 | 含义 |
| --- | --- |
| pending_projection | 通知事实已保存，等待后台生成稳定事件 |
| pending_publication | 事件已生成，等待通知策略评估及订阅分发 |
| published | 发布处理已记录，包括按策略跳过、无匹配订阅和实际分发 |

published 与 allowed 都不等于 HTTP 成功。投递摘要覆盖该通知的全部订阅，不随当前页截断：total、pending、running、succeeded、dead、cancelled、累计 attempts，以及因实时静默而暂缓的 quietDeferred。单条详情最多展示80次传输尝试与最近10条手动重试审计，旧版缺少元数据的字段为 null。

原通知未准入时，不创建新投递或补发通知。取消任务、确认通知、读取结果与手动重试均不会重新评估限频准入、重建订阅集合或递归生成批量任务。

## 安全手动重试

仅对已有的、原通知 allowed 且最终 dead 的投递开放。每次新操作要求：

- 当前邮箱及端点为 active，当前通知开启且非静默。
- 原投递版本匹配，累计尝试预算尚未达到80。
- 通知与真实事件、来源标识、全部快照计数及时间完全匹配；冻结正文与规范事件一致。
- 原端点属于通知产生时的配置快照，原冻结目标可用，原签名版本的密文可以认证解密。

请求包含新的 UUID `clientRequestId` 和读取时的 `expectedUpdatedAt`。D1 事务原子写入稳定 `webhook.delivery_retried` 收据并重新排队，预算增加8、上限80。相同标识、同一邮箱/通知/批次/投递/原版本只能核对原收据，不重复增加预算；改变任一条件返回409。

响应不明时保留原 UUID 和版本继续核对。即使投递后来再次失败，重放原 UUID 也只表示原操作的结果，不能触发下一轮发送。新操作必须读取最新状态、使用新 UUID 并再次通过校验。暂停邮箱仍可读取原已提交收据，不允许新重新排队。

重试保留事件 ID、投递 ID、冻结目标、正文及签名版本。端点后来修改或轮换签名不会用新配置改写旧投递，发送仍使用原冻结凭据。当前策略还会在实际传输前再次检查；HTTP 由后续 scheduled 和既有传输器执行，POST 成功只表示重新排队已提交。

通用 Webhook 重试入口优先根据真实通知收据与实际事件类型路由到相同校验，不信任载荷声明的类型。没有匹配收据、错误通知或伪造载荷都不能退回通用宽松路径。其他邮件 Webhook 和原导出通知重试保持原语义。

## Owner API

```text
GET  /owner/api/mailboxes/{mailboxId}/retry-batch-notifications/{notificationId}/delivery-results?limit=20&cursor=...
GET  /owner/api/mailboxes/{mailboxId}/retry-batch-notifications/{notificationId}/deliveries/{deliveryId}
POST /owner/api/mailboxes/{mailboxId}/retry-batch-notifications/{notificationId}/deliveries/{deliveryId}/retry
POST /owner/api/mailboxes/{mailboxId}/webhook-deliveries/{deliveryId}/retry
```

列表返回 `{notification,publication,deliverySummary,deliveries,nextCursor}`。limit 默认20、最多100；游标绑定邮箱、通知、事件和页大小。详情返回 `{notification,publication,delivery,attempts,manualRetries,currentPolicy}`，currentPolicy 包含 enabled、quiet、version。投递增加 `retry:{available,reason}` 提示。

两种重试入口的新类型都接受：

```json
{"clientRequestId":"00000000-0000-4000-8000-000000000001","expectedUpdatedAt":1794700800000}
```

成功200，返回 `{delivery,manualRetry,replayed}`。POST 要求正确 Origin。400用于无效输入/查询；404用于跨邮箱、错误通知或不存在的投递；409 `retry_batch_notification_retry_changed`、`retry_batch_notification_retry_conflict`、`retry_batch_notification_retry_unavailable` 分别表示旧版本、原收据条件冲突或当前无法重试。

## 本地验证

真实 D1 与最终 Worker 测试覆盖只读追踪、发布阶段、完整分页、策略跳过、UUID 幂等、并发版本竞争、丢 ACK、暂停邮箱、预算上限、无凭据读取、冻结签名及专用/通用入口隔离。浏览器验证6订阅分页、HTTP400失败、明确重新排队并丢响应核对、后续HMAC204、尝试/收据展示、策略开关/静默和桌面/手机布局。

执行数量及验收记录见[开发记录](development.md)。本地使用模拟 Access 和接收端，不代表真实 Cloudflare 部署或投递已验收。通知事实与端点快照语义见[完成与异常通知](retry-batch-notifications.md)。
