# Cloudflare 抑制执行历史与安全重试

Owner 的“抑制名单”页增加执行历史区域，分别查看同步记录和解除记录，展开状态时间线、失败原因和重试来源。所有读取沿用 Cloudflare Access，写入同时校验同源 Origin。静态邮箱 Token、OAuth 和 MCP Agent 不开放历史或管理操作；仍部署同一个 Worker，复用既有 D1 和专用 Worker Secret。

执行失败或未知结果现在可形成持久提醒，并通过已有 Webhook 通知；确认知悉不修改执行结果，详见[操作告警](cloudflare-suppression-alerts.md)。

## 升级与历史范围

应用 `0010_cloudflare_suppression_history.sql`；本地运行 `pnpm db:local`，远端使用现有有序迁移流程。不新增 secret、队列或 Worker。该迁移增加同步执行、只读对账和追加式事件时间线三表，并给原解除命令增加重试来源及最近验证字段。继续应用0011告警及0012通知策略迁移后共47张 STRICT 表，全部应用至0014异步导出迁移后共49张表。

历史按当前配置账户、精确发信域和邮箱授权范围查询。同步页显示当前邮箱的 Owner 执行及此账户/域的定时执行；解除页显示当前邮箱发起的操作。即使临时移除或轮换 API Token，只要公开账户/域配置仍在，Owner 仍可读取历史；没有可用凭据时对账和重试不可用。读取本身不访问 Cloudflare，不恢复租约，也不写审计。

已有解除操作会保留，并补入 `legacy.snapshot` 状态快照；迁移不会伪造过去未记录的每次同步或状态变化。新操作从开始记录完整执行结果。同步执行包含来源、时间、成功/失败、数量和固定错误码；解除执行包含地址、作用域、远端和本地分别结果、重试来源及安全动作资格。

数据库触发器记录开始、结束、失败、租约恢复和自动同步对账等状态变化。事件时间线只能追加，禁止 UPDATE/DELETE；原失败原因不会因后续对账成功而消失。详情按插入顺序展示最近100条事件，超过时返回 timelineTruncated 并明确提示；不复制邮件正文、API Token、Owner JWT、原始 Cloudflare 响应、SQL 或网络错误原文。

## 同步执行与重试

原有 Owner 同步和 scheduled 同步均写入执行记录。Owner 同步可提供 UUID clientRequestId；缺省时服务端生成一个。相同 ID 与相同意图返回已记录结果，不再次请求 Cloudflare；同 ID 不同参数返回409。

失败同步可由 Owner 明确重试，产生新的执行 ID 并用 retryOf 指向旧记录；旧记录保持失败。运行中且租约仍有效时不能重试，租约过期则先安全恢复为失败。新执行继续使用原有账户/域共享租约、完整分页、响应校验和原子缓存发布，旧 Worker 不能覆盖新执行结果。同步失败始终保留上次完整缓存，不触发邮件重发或解除本地名单。

重复提交本次重试的 clientRequestId 只返回该子执行；再次尝试需要新的明确请求 ID。即使重试成功，也不把父记录改成成功，历史会保留两次执行的事实及关联。

## 未知解除结果的只读对账

界面把“核对未知结果”和“重新确认解除”分开。对账只对记录中绑定的 Cloudflare ID 发起 GET，绝不发出 DELETE，也绝不清除本地退信或投诉证据：

| 核对结果 | 行为 |
| --- | --- |
| 404，记录已不存在 | 确认远端已不存在，本地记录保持保留，不再提供解除重试 |
| 仍存在、身份与作用域匹配 | 更新安全快照；未知结果保留两分钟观察窗口，之后可成为新的明确解除意图候选 |
| 仍存在但 read_only=true | 保留只读限制，不提供解除重试 |
| ID、地址或作用域不匹配 | 拒绝对账更新，保留原记录及失败原因 |
| 超时、网络或响应校验失败 | 记录本次对账失败，原未知结果和本地风险保持保留 |

两分钟从最早未确定结果记录计算，重复只读核对不会把等待窗口无限延长。对账本身使用独立 UUID 幂等键并保存执行结果；重复同一键不再次访问 Cloudflare。过期 preparing/deleting 任务先恢复为失败/未知，再核对，不将进程中断当作“已删除”。定时或手动完整同步对旧未知结果的核对仍会写入状态时间线。

## 解除的安全手动重试

只有服务端 canRetry=true 的记录才显示新的解除确认入口；canReconcile 决定能否只读核对。客户端不能仅靠状态文案推断权限，POST 仍会重新检查。

成功、远端已不存在、未确定或仍在有效执行中的记录不能直接重新 DELETE。失败记录需要当前可修改快照；遇到原只读或版本变化问题，应先核对最新结果。Owner 在新的确认窗口核对地址、账户/域作用域和当前本地版本，并使用新的 clientRequestId；retryOf 固定关联旧操作，不能改为另一地址或远端 ID。

重试仍复用原有 DELETE 前 GET 校验、read_only 判定和账户/域共享锁。账户范围解除需要明确确认会影响所有发信域。可选本地联动必须重新确认当前邮箱的 expectedLocalVersion；在等待网络时出现新退信/投诉，本地版本变化会保留新风险，分别返回远端已删除/本地已变化。对账、重试和同步均不自动重发邮件。

## 失败原因

界面使用固定诊断码和状态说明定位问题。例如：

| 诊断码 | 含义及处理方向 |
| --- | --- |
| cloudflare_api_unavailable | 上游不可用或未返回预期成功状态，核对 API Token 权限和服务状态 |
| cloudflare_api_timeout | 请求或响应正文读取超时；解除可能需要先对账 |
| cloudflare_api_invalid_response / cloudflare_api_scope_mismatch | 响应或作用域未通过安全校验，保留已有缓存 |
| cloudflare_suppression_busy | 本实例另一执行持有租约，稍后刷新 |
| cloudflare_delete_unknown | 删除结果不确定，先只读核对，不能盲目重试 |
| cloudflare_suppression_read_only / cloudflare_suppression_changed | 记录只读或已变化，需要核对后重新判断 |
| operation_lease_expired | 执行中断或租约过期，按同步/解除类型安全恢复 |
| cloudflare_operation_not_retryable | 当前状态不允许重试，不产生新的上游修改 |

这些说明不替代 Cloudflare 控制台诊断；应用不会暴露提供商错误原文来换取更详细的信息。

## Owner API

```text
GET  /owner/api/mailboxes/{mailboxId}/cloudflare-suppressions/history?kind=sync&limit=20&cursor=...
GET  /owner/api/mailboxes/{mailboxId}/cloudflare-suppressions/history/{id}?kind=release
POST /owner/api/mailboxes/{mailboxId}/cloudflare-suppressions/history/{id}/reconcile
     {"clientRequestId":"新的UUID"}
POST /owner/api/mailboxes/{mailboxId}/cloudflare-suppressions/history/{id}/retry
     {"kind":"sync","clientRequestId":"新的UUID"}
POST /owner/api/mailboxes/{mailboxId}/cloudflare-suppressions/history/{id}/retry
     {"kind":"release","clientRequestId":"新的UUID","expectedVersion":"当前SHA256",
      "confirmationAddress":"recipient@example.net","confirmationScope":"account",
      "releaseLocal":true,"expectedLocalVersion":3}
```

kind 为 sync/release，默认 sync；游标绑定账户、域、邮箱、kind 和页大小。列表返回 `{configured,history,nextCursor}`，详情返回 `{item,timeline,timelineTruncated}`。对账返回 `{operation,reconciliationId}`；同步重试返回原同步结果并增加 runId/state，解除重试返回原 operationId/remoteStatus/localStatus 结果。仍在执行或结果未确定的同步/解除命令以202和明确状态返回；只读对账成功返回200，仍需检查 operation 是否已确定。状态冲突返回409。原 `/cloudflare-suppressions/sync` 仍兼容 `{}`，也支持 `{clientRequestId}`。

列表与详情是只读请求。POST 的幂等键、权限、源域、目标身份、父记录、只读标记、当前快照和本地版本均由服务端校验，不能通过更换 URL 中的 mailbox ID 跨上下文操作。

## 验证范围

运行 `pnpm check`、`pnpm build:worker`、`pnpm test` 和 `pnpm test:e2e`。新增测试覆盖执行日志、不可改写时间线、历史分页与权限、凭据暂缺时读取、重试关联和幂等、未知结果只读核对、观察窗口、只读限制、本地 CAS 及中断恢复。浏览器测试使用现有 Playwright/Chrome 验证桌面/手机流程；不操作真实 Cloudflare 名单。云端 API 权限、真实未知结果和实际解除仍需配置后验收。
