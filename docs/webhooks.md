# 邮箱事件与 Webhook 通知

Webhook 复用现有邮件事件表、邮箱权限和同一 Worker 的 scheduled 入口。Owner 管理回调地址和密钥；Agent 通过 mail:read 查询脱敏订阅、事件及投递记录。正文和附件仍在私有 R2，不复制到通知中。

## 升级与配置

按顺序应用 `0006_webhooks.sql`：在已有事件、订阅和投递表增加发布标记与冻结快照，并增加 `webhook_delivery_attempts`。后续迁移增加投递事件、本地及服务端抑制、执行历史、操作告警、通知策略、查询索引、异步导出、终态通知及批量重试；当前最新为 `0019_retry_batch_notifications.sql`，共54张 STRICT 表。0017增加批量重试两表，0018只为批次增加取消标记及约束。已有邮件、草稿和审批保持不变。升级前的事件标记为已发布；旧占位投递因没有可靠快照转为 cancelled，不向新订阅补发历史数据。

```sh
pnpm db:local
node scripts/generate-webhook-keyring.mjs
```

第二条命令只在本地生成并输出新的 AES-256 包装密钥，不连接 Cloudflare。输出是敏感配置，保存到私有备份；不要提交源码、写入普通 wrangler vars、日志或 Owner 表单。生成格式为：

```json
{"activeKid":"primary","keys":{"primary":"32随机字节的Base64URL编码，无填充"}}
```

本地把完整 JSON 作为字符串放入未跟踪的 `.dev.vars`：`WEBHOOK_KEYRING='{"activeKid":"primary","keys":{"primary":"实际生成值"}}'`。部署时通过 Wrangler secret 设置 `WEBHOOK_KEYRING`，命令为 `pnpm exec wrangler secret put WEBHOOK_KEYRING --config wrangler.jsonc`；粘贴完整 JSON。空值或格式错误时只关闭 Webhook 创建、激活、轮换和重试，不影响收发邮件；Owner 页面提供配置说明。初始化诊断检查新的表和字段。

包装密钥最多 8 把，activeKid 决定新密文使用哪把。轮换包装密钥时先增加新 key 并修改 activeKid，保留旧 key，直到依赖它的投递及可重放历史不再需要。应用不会把包装密钥返回浏览器。

仍只部署 `worker/entry.ts` 一个 Worker。scheduled 顺序执行解析、邮件发送、既有事件发布和 Webhook 投递，随后处理异步导出及每轮最多20条终态通知投影；新投影事件留待下一轮发布和投递。不需要第二个 Worker、外部队列或公开定时接口。当前 cron 为每分钟一次，单次最多发布20个事件、尝试2次投递，不保证即时通知。大量积压会分批处理。

## 事件内容与订阅

支持应用事件及已认证的提供商投递事件：

| 类型 | 资源数据 |
| --- | --- |
| message.received | messageId，邮件解析并索引成功后产生 |
| outbound.accepted | outboundId、status=accepted，提供商已接受，不能视为送达 |
| outbound.failed | outboundId、status=failed |
| outbound.unknown | outboundId、status=unknown，可能已发出，不应自动重发邮件 |
| outbound.delivered | outboundId、status=delivered，收件服务器已接收，不表示已读 |
| outbound.deferred | outboundId、status=deferred，提供商仍在重试 |
| outbound.bounced | outboundId、status=bounced |
| outbound.rejected | outboundId、status=rejected |
| outbound.complained | outboundId、status=complained，独立投诉标记 |
| cloudflare.suppression.alert.created | alertId、kind、status=open、outcome=failed/unknown、可选固定 errorCode；仅 Owner 可查询及订阅 |
| cloudflare.suppression.alert.resolved | alertId、kind、status/outcome=resolved；仅 Owner 可查询及订阅 |
| alert_notification.export.succeeded | jobId、format、state=succeeded、决策/投递数量、bodyBytes、completedAt、expiresAt；仅 Owner 可查询及订阅 |
| alert_notification.export.failed | jobId、format、state=failed、已处理数量、bodyBytes、安全 errorCode、completedAt、expiresAt；仅 Owner 可查询及订阅 |

运维告警按执行历史持久去重，沿用本页的签名、失败重试和投递记录。它们不出现在邮箱 Token/OAuth/MCP 的事件、订阅类型或投递结果中。配置及状态语义见[抑制操作告警](cloudflare-suppression-alerts.md)。

应用0012迁移后，可在 Owner 抑制名单页配置[邮箱告警通知策略](alert-notification-policy.md)。总开关、静默及重复间隔还作用于0015新增的两个导出通知类型，普通邮件 Webhook 保持原样；关闭取消未完成运维通知投递，静默期间已有队列暂缓，新跳过的通知不补发。恢复通知开关仅控制抑制故障恢复，导出完成是独立结果。

导出完成或最终失败的终态快照与任务状态原子保存，不回填升级前已结束任务；取消和过期不产生新完成/失败事件。控制台提醒与 Owner 确认独立于 Webhook，文件内容、R2 key、下载 URL 和签名凭据不进入通知。准入与限频单独记录，不混入抑制操作的决策统计或同步/异步导出。配置与负载详见[导出终态通知](async-export-notifications.md)。

导出通知详情提供决定/跳过原因、发布状态、投递汇总和分页，以及最多80次HTTP尝试与10条安全手动重试审计。读取只访问D1且不解密，无当前密钥仍可查看历史；旧审计元数据缺失时字段为null。手动重试仅对原allowed且当前dead投递开放，校验活动邮箱/端点、enabled/非静默策略、预算和原冻结凭据，使用 `clientRequestId` 与 `expectedUpdatedAt` 防止重复调度。通用 Webhook 重试对导出事件执行同一规则；不重新发布跳过事件、不重复消耗限频准入、不更换原事件/载荷/签名版本或延长文件TTL。详见[导出通知投递追踪与重试](async-export-notification-deliveries.md)。

失败导出通知支持[按邮箱批量重试](async-export-notification-retry-batches.md)：失败时间半开窗口最多31天、安全原因筛选、最多1000条固定候选、10分钟预览及明确确认。两次UUID保证预览/提交幂等，后台每轮最多5项仍调用原安全重新排队，关联同一投递和单条审计；实际HTTP在后续cron执行。批次区分重新排队、跳过、失败及未知结果，unknown只读核对收据而不盲目发送。任务每邮箱最多2个、全实例4个，创建后24小时截止；不增加HMAC或HTTP通道，不改变原通知决定或文件有效期。

Owner 可[取消批量任务、核对未知结果并查看操作历史](async-export-notification-retry-controls.md)。取消阻止尚未提交的重新排队，保留已有结果，不能撤回已重新排队的Webhook；unknown手动读取原稳定请求的审计收据，不调用发送或重新排队。取消和对账复用版本校验、操作UUID及Owner权限，不扩大Token/OAuth/MCP能力。

Owner 同页可查看[通知决策与降噪统计](alert-notification-decisions.md)：通知准入和跳过按邮箱事件计数，实际成功/失败/重试按订阅投递计数；分页详情复用已有投递尝试，不产生新通知。

通知正文为 UTF-8 JSON：

```json
{"v":1,"id":"稳定事件UUID","mailboxId":"邮箱UUID","type":"message.received","occurredAt":1794614400000,"data":{"messageId":"邮件UUID"}}
```

只从已支持事件提取明确允许的字段，丢弃事件表内其他 payload 属性。通知、Agent 事件接口和投递记录不包含主题、正文、地址、Bcc、附件内容、签名密钥或 R2 地址。Cloudflare 投递通知需先配置[投递事件接入](email-delivery-events.md)；`outbound.failed` 可由提交失败或提供商投递失败产生。事件 status 表示该次更新，邮件最终汇总和逐收件人结果由 `list_outbound` 查询。

每个邮箱最多 10 个 active/paused 订阅、100 个含 disabled 的历史订阅。URL 创建后不可改写；换地址时禁用旧订阅并创建新订阅。订阅筛选可修改，只有 Owner 有权管理。

创建、恢复活动状态和修改筛选时，在同一 D1 事务记录已存在事件的内部边界，因此只匹配之后的新事件，包含同毫秒竞争的情况。暂停期间产生但尚未发布的事件不会在恢复后补发。已生成的投递快照不随筛选修改改变；暂停/禁用会取消 pending/running 投递，但不能撤回已发出的 HTTP 请求。禁用是终态，需新建订阅。

导出事件可能晚于终态投影，另要求端点 `created_at` 和 `updated_at` 均严格早于终态时间。终态同毫秒创建/配置的端点保守排除；终态之后、投影之前增加订阅类型、恢复或轮换等配置变化也不补发该任务通知。应在创建导出任务前完成订阅配置。

## 签名与接收端验证

创建或轮换订阅时，Owner 只得到一次 `whsec_...` 签名 secret。数据库只保存 AES-GCM 密文，附带包装 key ID 和随机 nonce；认证数据绑定邮箱、endpoint ID 与 secretVersion。签名 secret 和邮箱 Token 分开管理。

请求头：

```text
Content-Type: application/json
X-Agent-Mail-Event: message.received
X-Agent-Mail-Delivery: 稳定投递UUID
X-Agent-Mail-Attempt: 1
X-Agent-Mail-Secret-Version: 1
X-Agent-Mail-Signature: t=秒级Unix时间,v1=HMAC-SHA256十六进制摘要
```

HMAC key 是整个 `whsec_...` 字符串的 UTF-8 字节。被签名内容严格为 `timestamp + "." + deliveryId + "." + 原始请求正文`。不要先解析 JSON 再序列化验证。Node 接收端的核心验证示例：

```js
import {createHmac, timingSafeEqual} from 'node:crypto';
const header = request.headers.get('x-agent-mail-signature') ?? '';
const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
const deliveryId = request.headers.get('x-agent-mail-delivery');
if (!match || !deliveryId || Math.abs(Date.now()/1000 - Number(match[1])) > 300) throw new Error('invalid signature');
const rawBody = Buffer.from(await request.arrayBuffer()); // 保留原始字节，不先解析或解码
const expected = createHmac('sha256', signingSecret).update(`${match[1]}.${deliveryId}.`).update(rawBody).digest();
if (!timingSafeEqual(expected, Buffer.from(match[2], 'hex'))) throw new Error('invalid signature');
```

接收端验证时间窗口、签名及正文后，以 event.id 或 delivery ID 持久去重，再把处理任务入自己的队列并快速返回 2xx。时间戳每次尝试重新生成；事件 ID、投递 ID 和正文在重试中保持一致。Webhook 为至少一次投递，HTTP 超时后可能出现重复请求。

订阅 secret 轮换只影响后续创建的投递。已经生成的投递冻结旧密文、secretVersion、URL 和正文，仍使用旧 secret；接收端在旧通知处理完之前需要保留对应版本。Owner 人工重试也保留原身份和签名版本。

## 重试、记录与网络边界

2xx 记为 succeeded。网络失败、超时、408、429 和 5xx 自动重试；其他状态（包含 3xx）进入 dead，不跟随重定向。HTTP 请求最多 10 秒；响应正文立即取消，不记录上游错误原文。

初始最多 8 次，退避依次为 1 分钟、5 分钟、15 分钟、1 小时、4 小时、12 小时、24 小时；Retry-After 可延长等待，最多 24 小时。cron 频率和积压可能使实际投递更晚。Owner 可对 active 订阅的 dead 记录人工重试，沿用同一快照并增加 8 次预算，总预算最多 80 次。尝试号单调递增，保留每次 started、succeeded、retry、dead、expired 或 cancelled 的时间、HTTP 状态和稳定错误码。

领取和历史写入使用原子 D1 batch，120 秒租约与条件更新阻止过期 Worker 覆盖新结果。租约过期按剩余预算恢复；已经发出的请求无法回滚，接收端仍须去重。邮箱暂停时不领取新投递，恢复邮箱后现有队列可继续；订阅本身的暂停会取消其队列。

目标只允许公共 HTTPS 域名，拒绝 IP、本地域、凭据、自定义端口、fragment 和本实例入口。只使用新建请求头，不携带 Owner Cookie、Access JWT、Authorization、Origin 或 Referer，不接受上游 Set-Cookie。公网隔离依赖既有 `global_fetch_strictly_public` 和 Cloudflare 全局 fetch，不使用 ASSETS、服务或 VPC 绑定；不能把独立 DNS 预检查当作地址固定。[Cloudflare 公网路由标志](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)。把代码移植到普通 Node 服务器时须另行实现私网及 DNS 重绑定防护。

## 控制台与接口

Owner 页面为 `/owner/mailboxes/{id}/webhooks`，支持创建、筛选、暂停/恢复、禁用、轮换、一次性复制 secret、分页记录、尝试详情和 dead 人工重试。所有 Owner 写入继续要求 Access JWT 与精确 Origin。

| 路径 | 方法与权限 |
| --- | --- |
| /owner/api/mailboxes/{id}/webhooks | GET 列表；POST `{url,eventTypes}` 创建并仅返回一次 secret |
| .../webhooks/{endpointId} | PATCH `{expectedUpdatedAt,status?,eventTypes?}`，乐观锁 |
| .../webhooks/{endpointId}/rotate | POST `{expectedUpdatedAt}`，返回一次新 secret |
| .../webhook-deliveries | GET endpointId?/limit?/cursor? |
| .../webhook-deliveries/{deliveryId} | GET 投递与尝试详情 |
| .../webhook-deliveries/{deliveryId}/retry | POST `{}`，仅 dead 人工重试 |
| .../events | GET 脱敏事件分页 |
| /v1/events、/v1/webhooks、/v1/webhook-deliveries、/v1/webhook-deliveries/{id} | GET，Token mail:read；无管理写入能力 |

Agent 的 endpoint.url 固定为 null，不泄露 URL 中可能存在的 query 密钥。OAuth AT 的受众仍限定 MCP，不能调用 REST。MCP 包含 list_mail_events、list_webhook_subscriptions、list_webhook_deliveries 三个只读工具；增加抑制检查后共最多 22 个工具。不新增 scope，不向 Agent 开放回调地址、secret 管理或重放能力。每次调用重新检查当前授权和邮箱状态。

分页默认 20 条、最多 100 条，返回 nextCursor；游标绑定邮箱、资源类别及 endpoint 筛选。密文、包装密钥、租约、请求头及响应正文均不进入公共 DTO。

## 本地验证

运行 `pnpm check`、`pnpm build:worker`、`pnpm test`、`pnpm test:e2e`。测试验证独立 HMAC 计算、AES-GCM 绑定、轮换、并发扇出/领取、暂停的延迟事件、重试与过期租约、迟到响应、跨邮箱及权限、数据最小化、实际原生收发事件和本地 HTTP 替身。浏览器复用现有 Playwright/Chrome，当前没有 Browser 插件；桌面与手机验证 Owner 配置、一次性 secret、记录和重试。没有真实外部 HTTP 投递或远程部署验收。

批次完成、失败和待对账提醒继续仅供Owner，三种通知Webhook沿用邮箱策略、签名与自动重试，详见[批次完成与异常通知](retry-batch-notifications.md)。
