# Cloudflare Email Sending 投递事件

原生接入使用 [Email Sending Event Subscriptions](https://developers.cloudflare.com/email-service/reference/event-subscriptions/) → Cloudflare Queue → **现有 `worker/entry.ts` 的 `queue` 入口**。这是 Cloudflare 平台认证的 Queue 调用。官方没有在此接口定义直接 HTTP 回调或 HMAC 签名；下面的 HTTP HMAC 是可选的、自建转发器协议，不冒充官方协议。仍只发布一个 Worker，D1 保存状态与去重记录，邮件内容和附件继续使用现有私有 R2。

## 配置原生 Queue

1. 先应用 `0007_email_delivery_events.sql`，本地运行 `pnpm db:local`；远端沿用部署工具的有序迁移。
2. 在自己的账户创建专用 Queue，例如 `pnpm exec wrangler queues create agent-mail-email-events`。另建死信队列 `agent-mail-email-events-dead`。不要让其他生产者向此队列写入。
3. 按官方文档，在已启用 Email Sending 的发信域名创建 Event Subscription，目标指向上述 Queue，订阅 `cf.email.sending.message.delivered`、`deferred`、`bounced`、`failed`、`rejected`、`complained` 六类。保存返回的 subscription ID。接收邮件的 Email Routing 规则不能替代此订阅。
4. 将下面配置合并进唯一的 `wrangler.jsonc`，替换所有示例值；使用实际发信域名（可以不同于收信域名）。所有 allowlist 配置都必须提供。然后构建、迁移并发布同一个 Worker。`pnpm deploy:setup` 会保留此专用 consumer 配置，并检查 event account 与部署账户一致；不会替你创建 Queue、死信队列或域名订阅。

```jsonc
{
  "queues": {"consumers": [{
    "queue": "agent-mail-email-events",
    "max_batch_size": 10,
    "max_batch_timeout": 5,
    "max_retries": 8,
    "dead_letter_queue": "agent-mail-email-events-dead"
  }]},
  "vars": {
    // 合并原有 vars，不要删掉 DB/R2、域名、Access 和 Owner 配置。
    "EMAIL_EVENT_QUEUE": "agent-mail-email-events",
    "EMAIL_EVENT_ACCOUNT_ID": "实际的32位十六进制account ID",
    "EMAIL_EVENT_ZONE_ID": "实际的32位十六进制zone ID",
    "EMAIL_EVENT_SUBSCRIPTION_ID": "实际的event subscription ID",
    "EMAIL_EVENT_DOMAIN": "send.your-domain.tld"
  }
}
```

adapter 生成配置会剥离 consumer；最终部署配置保留 consumer 并导出 `fetch/email/scheduled/queue`。Queue 不是第二个 Worker。队列名称或配置不符时重试，不把未验证来源写入 D1；已配置来源下的畸形或越界事件会拒收并 ack，避免无限重试。D1 暂时失败会重试。监控死信队列及 Worker 的脱敏错误码，并从 Queue 重放；不要重新提交原邮件来修复状态。

## 状态、幂等与权限

使用官方 envelope 的 `metadata.accountId/eventSubscriptionId/eventSchemaVersion/eventTimestamp`、`source.type/zoneId/domain` 和 `payload.eventId/messageId/sender/recipient/terminal/delivery.status`。只接受已配置的账户、zone、subscription、域名和已知类型。额外的 subject、SMTP response、原始 failure/rejection/complaint 描述不保存、不返回，也不写日志。

只按 native `EMAIL.send()` 返回的 provider message ID 定位出站邮件，再校验 sender 与该邮件的实际收件人；不接受外部传入 mailbox ID。事件若早于发送 ACK 持久化，进入 D1 待关联收件箱；记录 ACK 后按 provider ID 立即有界补账，再处理同批下一封邮件。每分钟 scheduled 也会在发送任务前后、客户 Webhook 发布前补账。未匹配记录最多等待 7 天，随后标记忽略。若 ACK 丢失且没有 provider ID，则不能凭地址、时间推断关联，原邮件保持 `unknown`，不会自动重发或变更发送额度。

按 account/event ID 去重，规范化内容的 hash 检测同 ID 冲突；重复、旧事件和无效状态跳转不重复通知。收件人状态使用事件时间、确定性同时间优先规则和终态保护；`deferred` 不把已经终结的状态回退。新的终态可以更正先前终态。投诉使用独立 `complainedAt`，不能据此推断 delivered，也不清除已有投递结果。

| 提供商事件 | 收件人及汇总行为 |
| --- | --- |
| delivered | 收件服务器已接收；不表示进入收件箱或用户已读 |
| deferred | 仍由提供商重试；不触发应用重发 |
| bounced | 退信 |
| failed / rejected | 失败，保留安全的固定诊断码 |
| complained | 独立投诉标记，保留实际投递状态 |

汇总沿用 accepted/partial/delivered/bounced/failed；逐收件人结果可以不同。Owner 发送记录、`GET /v1/outbound` 和 MCP `list_outbound` 返回收件人 status、lastProviderEventAt、deliveryEventType、complainedAt、diagnosticCode 及邮件级 lastProviderEventAt。deliveryEventType 表示最近一次投递结果事件（不含投诉）；lastProviderEventAt 表示任意已应用服务事件的最新时间，可能来自投诉，不能作为 deliveryEventType 的发生时间。沿用 Owner Access 和 Token 自己的发送记录权限，不扩大邮箱或 Token 的访问范围。

同步成功后在同一 D1 事务写入脱敏事件 `outbound.delivered/deferred/bounced/failed/rejected/complained`。Owner 可按邮箱订阅现有 Webhook；`/v1/events` 和 MCP `list_mail_events` 也可读取。通知只带 outboundId、状态、时间与稳定 ID，不包含收件人/Bcc、subject、原始 provider payload 或 secret。通知的 status 是事件类型对应状态，邮件汇总状态应通过 list_outbound 查询。客户通知复用现有 HMAC、重试和投递记录；去重保证状态事件一次写入，通知本身仍是至少一次交付。

应用 `0008_recipient_suppressions.sql` 后，明确 `bounce.type=hard` 的退信和投诉还会自动建立[邮箱级抑制](recipient-suppressions.md)，阻止后续发送。软退信或永久性未知的 bounced 不推断为 hard；旧0007摘要保持兼容。名单解除不会修改投递结果。

## 可选自建 HTTP HMAC 桥接

原生 Queue 推荐直接调用上面的 queue 入口。仅当部署者已有可信转发器时才启用 `POST /callbacks/cloudflare-email`。将独立随机 secret（32–256 UTF-8 字节）保存到转发器及 `pnpm exec wrangler secret put EMAIL_EVENT_BRIDGE_SECRET --config wrangler.jsonc`，不要放入普通 vars、源码或 Owner 页面。此密钥与客户 Webhook secret、Access JWT、Cloudflare API token 均无关。

请求必须是 `application/json`，无 query，原始 UTF-8 body 为单个官方事件 envelope，最大 64KiB：

- `X-Agent-Mail-Timestamp`: Unix 秒整数字符串，允许前后 300 秒时钟偏差。
- `X-Agent-Mail-Signature`: `v1=` + 小写十六进制 HMAC-SHA256。
- 待签名原文：`timestamp + "." + rawBody`，原始 bytes 不得重新序列化。

转发器示例（只展示构造方式，不会创建资源或发送邮件）：

```js
import {createHmac} from 'node:crypto';
const rawBody = JSON.stringify(event);
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', process.env.EMAIL_EVENT_BRIDGE_SECRET)
  .update(timestamp + '.').update(rawBody).digest('hex');
await fetch(process.env.AGENT_MAIL_ORIGIN + '/callbacks/cloudflare-email', {
  method: 'POST',
  headers: {'Content-Type':'application/json', 'X-Agent-Mail-Timestamp':timestamp,
    'X-Agent-Mail-Signature':'v1=' + signature},
  body: rawBody, redirect: 'error'
});
```

Worker 先对原始 bytes 验签，再解析和校验来源。未启用返回404；验签失败401；同 ID 内容冲突409；存储暂时不可用503；有效事件返回200和安全 outcome（applied/duplicate/pending/ignored）。重试要重新生成时间戳和签名，保留原 event ID。有效签名不是关联邮箱的依据，仍必须通过完整来源 allowlist 与 provider ID 校验。不要给此路径配置 Cloudflare Access 登录挑战；其余 Owner 路径继续要求 Access，不放开整个域名。

## 本地验证与边界

`pnpm check`、`pnpm build:worker`、`pnpm test`、`pnpm test:e2e` 覆盖实际最终 Worker 的 native Queue dispatch、HMAC 篡改/超时、去重、乱序、多收件人、ACK 前事件、来源隔离、API/MCP、客户 Webhook 和 Owner 界面。测试使用本地 D1/R2/EMAIL，不发真实邮件或访问真实客户回调。实际账户上的订阅、DNS/发信域验证、Queue/DLQ 权限及真实投递仍需部署后验收。该功能不提供 open/click 追踪。
