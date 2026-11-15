# Cloudflare 抑制操作告警

同步、解除和未知结果对账的失败复用现有追加式执行历史，在 D1 中形成持久告警。Owner 控制台显示待确认数量，抑制名单页支持筛选、分页、详情、关联历史和“确认已知悉”。仍部署同一个 Worker，不新增绑定、凭据或外部服务。

## 升级与配置

按顺序应用 `0011_cloudflare_suppression_alerts.sql`，本地运行 `pnpm db:local`。该迁移增加告警、追加式变化时间线及投影水位三张表，迁移后共44张 STRICT 表。升级时保存旧执行历史的边界，保留历史读取能力，但不会把旧故障批量补发成新通知。

沿用 `EMAIL_SUPPRESSIONS_ACCOUNT_ID`、`EMAIL_SUPPRESSIONS_DOMAIN` 和 Worker Secret `EMAIL_SUPPRESSIONS_API_TOKEN`。Owner 读取和确认只要求有效 Access 身份及公开账户/域配置，API Token 暂缺仍可查看。没有配置时返回空列表和 `configured:false`。确认写请求同时要求匹配的 Origin。未升级数据库会在初始化诊断中提示迁移缺失。

Webhook 需已有 `WEBHOOK_KEYRING` 和活动的邮箱订阅。到 Owner“事件通知”页选择 `cloudflare.suppression.alert.created` / `cloudflare.suppression.alert.resolved`；原有邮件订阅不会自动增加这两个类型。不配置 Webhook 时控制台告警照常工作。

后续应用 `0012_alert_notification_policies.sql` 可在同页按邮箱配置通知开关、静默时段、重复限频和恢复通知。策略仅影响告警 Webhook，不隐藏控制台记录；配置与队列语义见[通知策略与降噪](alert-notification-policy.md)。应用至0012后共47张表，全部应用至0014异步导出迁移后共49张表。

## 状态与范围

| 状态 | 含义 |
| --- | --- |
| open | 新的明确失败或未知结果，等待 Owner 确认 |
| acknowledged | Owner 已知悉；故障可能仍在，不执行任何 Cloudflare 请求 |
| resolved | 后续执行实际成功，或只读对账确认远端已不存在 |

`outcome` 单独区分 `failed`、`unknown`、`resolved`。确认不会重试、对账、删除、解除抑制或改写原执行结果。源执行的 `errorCode` 只使用固定安全诊断码，告警不复制原始网络或提供商错误。

Owner 同步及解除按重试父子链归并；同一账户/精确发信域的定时同步共用一条全局告警，Owner 对定时执行的显式重试仍归入这条全局告警。同一历史记录重放、或连续相同的源执行/结果/错误码不会新建变化或重复通知。新的执行失败会增加次数并重新打开已确认的告警；已解决后再次失败开启下一周期。仅“仍存在”的成功核对不表示解除成功，不会关闭未知结果告警。

定时同步告警在当前精确发信域的活动/暂停邮箱内可见，控制台总数只统计一次；其他 Owner 操作按发起邮箱隔离。关联历史保留实际源执行，跨邮箱的 Owner 重试可跳转到发起邮箱。暂停邮箱可查看及确认告警，但不会为它产生新的告警 Webhook；全局事件只分发给相应告警变化发生时已经存在、且投影时仍活动并拥有匹配主地址的邮箱。

## 处理与通知

Owner 源操作结束后尝试处理历史水位；告警接口及 scheduled 继续补账，每次最多消费50条历史。告警、变化记录、应用事件和水位在同一 D1 事务中提交，CAS 和唯一约束防止并发重复。通知投影失败不会把已完成的 Cloudflare 操作改成失败或再次执行 DELETE；下次定时处理会继续补账。

scheduled 在现有 Cloudflare 同步后处理告警，再调用既有 Webhook 发布和投递任务。通知沿用签名、密钥密文、冻结快照、退避重试及投递记录；不新增即时推送通道。积压由后续 cron 分批处理。Webhook 投递失败本身不再产生抑制操作告警，避免通知循环。接收端仍须按事件 ID / 投递 ID 去重。

```json
{"v":1,"id":"事件UUID","mailboxId":"邮箱UUID","type":"cloudflare.suppression.alert.created","occurredAt":1794700800000,"data":{"alertId":"告警UUID","kind":"release","status":"open","outcome":"unknown","errorCode":"cloudflare_delete_unknown"}}
```

恢复事件的 `data.status` 和 `outcome` 均为 `resolved`，不带旧错误码。`data` 只含稳定告警 ID、类型、结果和允许的错误码，不包含账户、发信域、收件地址、Cloudflare ID、执行历史 ID、凭据或邮件内容。签名验证与安全人工重试见 [Webhook 文档](webhooks.md)。

## Owner API 与权限

```text
GET  /owner/api/mailboxes/{mailboxId}/cloudflare-suppression-alerts
     ?status=open&kind=sync&limit=20&cursor=...
GET  /owner/api/mailboxes/{mailboxId}/cloudflare-suppression-alerts/{alertId}
POST /owner/api/mailboxes/{mailboxId}/cloudflare-suppression-alerts/{alertId}/acknowledge
     {"expectedVersion":1}
```

列表返回 `{configured,alerts,nextCursor,summary:{open,acknowledged,resolved}}`。`status` 支持 open/acknowledged/resolved/all，默认 open；`kind` 支持 sync/release/all，默认 all。页大小1–100，游标绑定账户、域、邮箱、筛选和页大小。汇总受 kind 筛选影响，覆盖各状态全部记录。详情返回 `{alert,timeline,timelineTruncated}`，最多展示最近100条变化；确认返回 `{alert}`，版本过期或状态已变化返回409。

操作仅限 Owner。静态邮箱 Token、OAuth 和 MCP 不提供告警管理能力；邮箱读取权限也无法通过通用事件、Webhook 订阅类型、投递列表或详情枚举运维告警。Owner 的事件及投递界面保留完整通知记录。

## 本地验证

运行 `pnpm check`、`pnpm build:worker`、`pnpm test` 和 `pnpm test:e2e`。真实 D1 测试覆盖迁移边界、50条消费预算、并发去重、确认 CAS、重试重开、恢复、只读对账和安全字段；最终 bundle 测试校验 HMAC、通知失败重试及 Token/OAuth/MCP 隔离。浏览器验证桌面和手机上的提醒、分页、详情、关联历史和确认操作。Cloudflare 及 Webhook 均使用本地模拟上游，不操作真实名单或发送外部通知。
