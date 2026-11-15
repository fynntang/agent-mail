# 告警通知策略与降噪

Owner 在邮箱的“抑制名单 → Cloudflare 运行提醒 → 配置通知策略”管理运维 Webhook。策略按邮箱隔离，作用于 `cloudflare.suppression.alert.created`、`cloudflare.suppression.alert.resolved` 以及 `alert_notification.export.succeeded`、`alert_notification.export.failed`。控制台提醒、执行历史和任务结果保持完整，普通收发邮件的 Webhook 不受影响。

可在同页查看抑制操作通知每次准入或跳过的原因、静默/限频命中统计、实际投递结果和尝试；只读查询与固定水位分页见[通知决策记录](alert-notification-decisions.md)。导出终态通知有独立的准入收据及限频状态，详见[导出完成与失败通知](async-export-notifications.md)，不会混入抑制操作统计及其导出。

## 升级与默认值

按顺序应用 `0012_alert_notification_policies.sql`，本地运行 `pnpm db:local`。该迁移新增策略、不可修改的通知决策及限频状态三表，完成后共47张 STRICT 表。后续0014增加异步导出、0015增加终态通知与独立限频状态，当前共51张表。不新增 Worker、绑定、Secret 或依赖；复用既有 cron、HMAC、密钥密文和投递重试。

未保存策略的邮箱使用兼容默认值，GET 不会初始化数据库行：通知开启、恢复通知开启、不限频、静默关闭；预设静默窗口22:00–08:00、时区 UTC。首次保存版本从0变成1，后续保存版本递增。旧告警、在途投递和邮箱级 Token 的权限不会扩大；此前已经被跳过的通知不会因开启或修改策略补发。

| 配置 | 行为 |
| --- | --- |
| 开启告警 Webhook 通知 | 关闭后跳过新抑制告警及导出完成/失败通知，并取消已有未完成的对应投递 |
| 发送恢复通知 | 控制抑制操作实际成功/确认不存在后的恢复通知；关闭不影响故障及导出完成/失败通知，取消未完成的恢复投递 |
| 重复提醒间隔 | 0–604800秒，0表示不限频；例如1800为30分钟 |
| 每日静默时段 | 按 IANA 时区的当地时间判断，支持跨午夜和夏令时 |

静默区间包含开始、不包含结束。22:00–08:00 表示22:00起静默、次日08:00恢复；开启时开始与结束不能相同，不使用相同时间表达全天静默。可用总开关临时停用通知。时区必须是有效名称，例如 `Asia/Shanghai`、`America/New_York` 或 `UTC`；服务端验证并保存规范名称。

## 限频与恢复

限频按“邮箱 + 同一持久告警 + 相同结果和安全错误码”计算。第一次准入后开始计时，区间内的新重复事件仍保留在告警/事件历史，但不创建新的 Webhook 投递；到达边界后的下一次新事件可以通知，不自动生成周期提醒。

同一邮箱多个订阅共享一次判断，不因订阅数量重复占用间隔。结果从失败变为未知、或安全错误码变化，会立即形成新的通知信号。不同告警和不同邮箱相互独立；同一全局定时同步告警在各邮箱按自己的策略决定是否通知。

实际恢复会清除该告警的限频水位，即使恢复通知关闭、静默或没有订阅，下一周期的首次故障仍可通知。恢复通知开关独立判断，可能收到恢复通知而之前的故障通知被静默或关闭。确认“已知悉”不重置限频，也不改变故障/恢复事实。

限频统计的是已准入的邮箱事件，不是 HTTP 成功次数。没有匹配的活动订阅、关闭、静默及已限频事件不会占用新额度。既有投递的网络重试继续使用同一事件、投递 ID、HMAC 和冻结正文，不再次占用间隔。

导出完成/失败复用相同的 `enabled`、静默及 `repeatIntervalSeconds`，按“邮箱 + 文件格式 + 成败结果 + 安全错误码”独立限频。多个订阅共享一次准入，CSV/JSON、成功/失败及不同错误码不共用信号。导出完成不是故障恢复，`recoveryEnabled` 不控制它，也不会清除抑制告警的限频水位。Owner 确认知悉不改变 Webhook 投递或限频状态。

## 新通知与已有队列

| 场景 | 新事件发布 | 已经排队/等待重试的通知 |
| --- | --- | --- |
| 通知关闭 | 跳过 | 取消 |
| 恢复通知关闭 | 仅恢复事件跳过 | 仅恢复投递取消 |
| 静默时段 | 跳过 | 尚未领取的投递暂缓，不消耗 HTTP 尝试预算，离开静默后由 cron 继续 |
| 重复限频 | 跳过同一信号的新通知 | 保留已准入投递的正常重试 |

新事件在发布时按当前策略作出持久决定。被跳过的通知不会在静默结束、开启通知或扩大订阅后补发；下一次新故障变化或新导出终态仍会重新判断。控制台总数、任务结果和“已知悉/已解决”状态不因通知策略隐藏或改写。

策略保存与禁用投递的取消在同一 D1 事务完成；旧 Worker 的迟到响应不能重新激活已取消任务。已经发到网络的 HTTP 请求无法撤回，接收端仍须验证签名并按稳定事件/投递 ID 去重。修改静默配置只唤醒由静默暂缓的队列，不绕过正常 HTTP 失败退避。

## Owner API

```text
GET   /owner/api/mailboxes/{mailboxId}/alert-notification-policy
PATCH /owner/api/mailboxes/{mailboxId}/alert-notification-policy
```

GET 和 PATCH 均返回 `{policy}`。PATCH 提交完整策略及当前版本：

```json
{
  "expectedVersion": 0,
  "enabled": true,
  "recoveryEnabled": true,
  "repeatIntervalSeconds": 1800,
  "quietEnabled": true,
  "quietStartMinute": 1320,
  "quietEndMinute": 480,
  "timeZone": "Asia/Shanghai"
}
```

`quietStartMinute`、`quietEndMinute` 是当地午夜起的分钟数，范围0–1439。返回策略额外包含 `version` 和 `updatedAt`；未保存时两者为0。版本过期返回409 `alert_notification_policy_changed`，无效时区或字段返回400，客户端应重新读取后明确保存，不能自动覆盖其他页面修改。

仅 Owner 可在活动/暂停邮箱中读写策略，写入沿用 Access JWT 和精确 Origin。无需 Cloudflare API Token 在线，也不要求先配置发送域。Agent Token、OAuth 和 MCP 不开放策略管理或内部通知决策/限频状态；原有运维告警隔离继续有效。

## 实现与验证

既有 `events` 仍由告警投影完整写入。Webhook 发布按事件插入顺序处理，在同一 D1 batch 中保存策略版本栅栏、唯一决策、限频状态、订阅投递和发布标记；并发 cron 复用一次准入，遗漏的符合条件订阅由后续有界发布补齐。决策表记录 `allowed`、`disabled`、`quiet_hours`、`repeat_limited`、`recovery_disabled` 或 `no_subscribers`，不能修改或删除。

导出终态在0015的通知表保存独立收据，记录 `allowed`、`disabled`、`quiet_hours`、`repeat_limited` 或 `no_subscribers`；只有绑定真实终态快照的投影事件可以准入。控制台确认版本独立于准入及投影，读取不会生成事件或推进发送。后建或终态同毫秒/之后变更配置的订阅不补发，详情见[导出通知边界](async-export-notifications.md)。

单次仍最多发布20个事件、发送2次 HTTP；领取前扫描最多20条候选，避免静默队列占住普通邮件通知的处理机会。运行时在发送前重查开关、恢复配置和静默状态，策略变化不会触发 Cloudflare 抑制重试或 DELETE。

`pnpm check`、`pnpm build:worker`、`pnpm test`、`pnpm test:e2e` 覆盖策略 CAS/隔离、跨午夜/DST、限频边界、错误变化、恢复重置、并发准入、版本竞争、静默预算、队列取消、迟到 ACK 及真实浏览器保存/冲突提示。所有 Cloudflare 和 Webhook 请求均使用本地模拟器，真实云端部署仍需单独验收。
