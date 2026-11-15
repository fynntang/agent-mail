# 本地开发与验证

当前实现 SvelteKit 3 + 单 Worker、D1/R2、邮件阅读搜索、草稿/回复、审批发送、MCP、OAuth 和 Owner 初始化向导。部署工具与一键 GitHub 流程见[部署与初始化](deployment.md)。无需 Rust 或独立邮件服务器。

## 环境

使用 Node.js 24 和 `package.json` 指定的 pnpm。依赖版本由 `pnpm-lock.yaml` 锁定。根 `wrangler.jsonc` 中的 D1 ID 是本地开发占位符，远程部署前必须替换；不要将当前配置直接部署到生产。

```sh
pnpm install --frozen-lockfile
pnpm build:worker
pnpm check
pnpm test
pnpm test:e2e
```

`build:worker` 先构建 SvelteKit，再使用根配置执行 Wrangler dry-run，生成 `dist/worker/entry.js`。整个过程不发布 Worker。集成测试使用这个最终 bundle，而非另外一套测试实现；因此独立运行 `test:integration` 前必须先构建。

## 启动本地实例

```sh
pnpm db:local
pnpm local:seed research
pnpm preview
```

`db:local`、`local:seed` 和 `preview` 统一使用 `.wrangler/state`。seed 只操作本地 D1，创建一个 `research@agent.example.com` 邮箱及只读 Token；重复创建同名地址会失败，可用 `pnpm local:seed assistant` 创建另一个邮箱。Token 仅显示一次，数据库只保存摘要。不要把 Token 提交到版本控制。

默认访问 `http://127.0.0.1:8787/`。首页仅展示公开的开发状态，不含邮件数据。`/healthz` 只检查 HTTP 入口，不表示 D1/R2 或真实 SMTP 已就绪。

```sh
curl http://127.0.0.1:8787/healthz
curl -H "Authorization: Bearer <local-token>" http://127.0.0.1:8787/v1/mailbox
curl -H "Authorization: Bearer <local-token>" http://127.0.0.1:8787/v1/messages
```

可用 `pnpm dev` 开发 SvelteKit 页面；验证三个原生事件时应使用 `pnpm preview` 启动最终 wrapper。不要用 `vite preview` 代替 Workers 运行时。

## 触发收信和定时任务

Wrangler 提供本地专用的事件触发路径，这些路径不在应用路由中实现，也不部署到生产。

```sh
curl -X POST --data-binary @tests/fixtures/inbound.eml "http://127.0.0.1:8787/cdn-cgi/local/email?from=sender%40example.net&to=research%40agent.example.com&format=json"
curl "http://127.0.0.1:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"
```

PowerShell 环境可使用 `curl.exe`。来信先保存 R2 原始 EML 与 D1 receipt，再创建 `parse_email` 任务。scheduled 每次最多补账 10 条 pending receipt、处理 5 条解析任务，使用 60 秒租约、有限退避和最多 8 次尝试。未知/停用邮箱、超过邮箱限额或 10 MiB 应用上限的邮件会拒绝。

来信提取文本、HTML、基础头部和附件，原始 EML 同时完整保留。正文 v3 私有保存 HTML，Owner 展示前校验并清洗；HTML-only 生成纯文本。附件单独保存在私有 R2，D1 记录关联与未扫描状态。每封独立投递创建独立 receipt，不根据 Message-ID 错误去重；派生对象使用版本化且不可覆盖的 key。详见[HTML 阅读](html-mail.md)和[附件说明](attachments.md)。

R2 保存成功但最终 D1 batch 失败时，30 秒后的定时对账可以校验原文并恢复任务；24 小时后仍缺原文的 pending receipt 标记失败。没有原文不能自动恢复，也不假定 Cloudflare 一定重新投递。

## 权限与接口边界

- `/v1/mailbox`、`/v1/messages`、`/v1/messages/{id}`：需要有效邮箱 Token，只能访问绑定的邮箱；支持筛选、游标分页和文本正文，默认20条、最多100条。这些阅读接口保持只读，不允许修改已读状态。
- `/owner/api/setup/checks`：需要经过签名、issuer、audience、有效期和 Owner email 校验的 Access JWT，再只读检查 D1/R2。无本地认证旁路；未配置 Owner 返回 503，身份头不能代替 JWT。
- `/owner/mailboxes` 与 `/owner/api/mailboxes/*`：Owner 控制台及管理 API；创建、更新、暂停/恢复、退役、签发与撤销均复用上述 JWT 校验，管理写请求必须包含匹配的 Origin。
- `/mcp`：官方 SDK Streamable HTTP，最多22个工具按静态 Token 或 OAuth 授权的邮箱权限注册，查询/附件/草稿/发送/事件与投递/抑制检查复用 core。POST 调用，GET/DELETE 返回405，浏览器 OPTIONS 支持 CORS preflight；STDIO 桥接尚未实现。
- `/.well-known/oauth-*`、`/oauth/register|token|revoke`：公开 OAuth 发现和 PKCE 协议端点；同一 native fetch 入口在 Kit CSRF 前处理。Owner 同意/撤销页面仍受 Access、Origin 和一次性 nonce 保护。
- `/owner/mailboxes/{id}/messages`：邮件阅读界面，复用 Owner 认证；对应管理 API 支持显式、幂等的已读状态写入。
- `/v1/drafts/*` 与 `/v1/outbound`：复用邮箱 Token，要求 mail:draft；发送还要求 mail:send，默认等待 Owner 审批。Owner 的草稿/发送页为 `/owner/mailboxes/{id}/outbound`，详见[发送 API](mail-sending.md)。
- `/setup`：公开通用引导；`/owner/setup` 和 `/owner/api/setup`：受 Access 保护的检查与初始化记录，写入还需正确 Origin。
- `/v1/messages/{id}/attachments` 需要 mail:read；`.../{attachmentId}/download` 另需 attachments:read，固定邮箱归属、校验后强制下载。Owner 在阅读页面可查看和下载。
- `/v1/drafts/{id}/attachments` 和分块会话复用 mail:draft 及草稿私有归属；完成或移除文件会更新版本及审批，发送使用冻结清单。
- Owner `.../messages/{id}/html-info` / `html`：服务端清洗及空权限沙箱，GET 可从当前邮件附件显示已校验 CID 图片，远程图片需正确 Origin 的 POST 许可；不改变普通 API/MCP 的文本输出。
- Owner POST 图片许可由同一 Worker 代取经过校验的公网栅格图片，以 data URI 返回沙箱，不要求图片站点支持 CORS；详见[图片边界和预算](html-mail.md)。
- Owner 草稿支持 HTML/文本双正文和 CID 图片，版本/hash 绑定的安全预览仅供 Owner；发送和 API/MCP 共用权限、审批及冻结快照，详见[HTML 发送](html-sending.md)。
- Owner `.../cloudflare-suppression-alerts` 提供失败/未知结果告警、分页、详情及版本确认；沿用 Access/Origin，Token/OAuth/MCP 不开放。源操作结束、告警读取及 scheduled 分批补账，再通过既有 Webhook 投递。详见[告警说明](cloudflare-suppression-alerts.md)。
- Owner `.../alert-notification-policy` 的 GET/PATCH 管理邮箱告警通知开关、时区静默、重复限频及恢复通知。D1 原子准入与既有队列共用一个 scheduled 入口，普通邮件通知不受策略影响。详见[通知策略](alert-notification-policy.md)。
- Owner `.../alert-notification-decisions` 提供按原因/通知类型/时间窗口的决策统计和固定水位分页，详情关联既有投递尝试与告警；仅查询 D1，不推进发布或调用 Cloudflare。详见[决策记录](alert-notification-decisions.md)。
- Owner `.../alert-notification-decisions/export?format=csv|json` 按相同范围和筛选只读导出全部记录、降噪统计及订阅投递结果；单次最多1000条决策/5000条投递/8 MiB，超限413且不生成部分文件。详见[导出格式](alert-notification-export.md)。
- Owner `.../alert-notification-exports` 创建、分页查询和取消异步 CSV/JSON 任务；同一 scheduled 每次至多10批×50条决策，私有 R2 分片由经过 Owner 认证的下载端点流式拼接。任务24小时过期并分批清理，最大规模需要 Workers Paid。详见[异步导出](async-alert-notification-export.md)。
- Owner `.../export-notifications` 提供异步导出成败通知、未确认统计、分页、详情和版本确认。终态快照与任务原子提交，同一 scheduled 有界投影后复用下轮 Webhook 发布；共享通知开关、静默与重复限频，Agent 不获得访问权限。详见[完成与失败通知](async-export-notifications.md)。
- Owner `.../export-notifications/{jobId}/delivery-results` 与 `.../deliveries/{deliveryId}` 查询原通知决定、发布/投递状态和尝试/手动操作记录；`.../retry` 只按明确UUID与当前版本重新排队已准入的dead投递。通用Webhook页的导出重试也复用相同策略，GET不写入、不解密或出网。详见[投递追踪与安全重试](async-export-notification-deliveries.md)。
- Owner `.../export-notification-retry-batches/preview` 按当前邮箱/失败时间/安全原因固定最多1000候选，10分钟内明确 `.../{batchId}/commit` 后，每轮scheduled最多重新排队5项。预览和确认分别使用幂等UUID，进度/逐项结果复用D1和原单条审计；24小时截止，未知结果只读核对。详见[批量重试](async-export-notification-retry-batches.md)。
- Owner `.../{batchId}/cancel` 停止未执行条目、撤销运行租约并保留已执行结果；`.../reconcile` 核对原重试收据，`.../operations` 分页读取操作历史。取消和对账各自使用 UUID+版本幂等收据，未知结果核对不增加预算。详见[取消与未知结果对账](async-export-notification-retry-controls.md)。
- Owner `.../retry-batch-notifications` 查看完成、失败及待对账提醒，支持确认状态/类型筛选、分页和版本确认；通知快照与当前状态分别展示，可直接定位原批次。三个新Webhook类型沿用邮箱通知策略、HMAC和自动失败重试，详见[批次完成与异常通知](retry-batch-notifications.md)。
- 其他未实现的路径返回 404/405；通用附件预览尚未实现。

根配置含 EMAIL 绑定，本地使用模拟发送。scheduled 还会处理最多2个 send_email 任务；提交外部调用后的未知结果不会重发。真实收信需要在 Cloudflare 启用 Email Routing 并将邮件路由到**同一个 Worker**；真实 cron 由根配置的 `triggers.crons` 设置。真实发信需单独开通 Email Sending 并验证域名。

## 生成配置与单 Worker

`pnpm config:sync` 从根 `wrangler.jsonc` 自动生成 `wrangler.svelte.jsonc`。adapter 只能读取生成配置，其 main 指向 `.svelte-kit/cloudflare/_worker.js`；根 main 始终是 `worker/entry.ts`。不要单独部署生成配置，也不要让 adapter 直接读取根配置，否则可能覆盖 wrapper 源文件。

集成测试使用内存 D1/R2 和本地 workerd，执行真实 SQLite 迁移并触发 native handlers；不会读取或修改 `.wrangler/state`，不会发送邮件或连接生产数据库。本地验证不替代真实 Access、Email Routing、DNS、邮件投递及 Cloudflare 部署验收。

## 本轮验证记录

2026-11-15（Asia/Shanghai），Windows / Node.js 24.22.1 / pnpm 11.25.0。最终代码已通过：

| 验证 | 结果 |
| --- | --- |
| 依赖 | 复用既有安装与锁文件，本轮未引入新依赖 |
| pnpm check | Svelte 检查 0 错误、0 警告；原生 Worker tsc 通过 |
| pnpm build:worker | SvelteKit 构建和根配置 dry-run 成功，含 Owner 页面和 API，保持单 Worker |
| 构建配置 | 原生入口与 adapter 保留严格公网 fetch；产物2781.74 KiB / gzip580.14 KiB，仍为单 Worker，导出 fetch/email/scheduled/queue |
| 数据库 / 配置脚本 | 54张表，224项 / 21项检查通过；0019新增不可变通知快照、端点配置围栏及无回填升级检查，schema快照与字典已更新 |
| 核心与持久化测试 | 425个通过；本轮新增28个原子事实/多次异常/取消/到期、并发投影/确认、策略/签名重试、未来逻辑时间订阅围栏、Agent隔离及初始化检查用例 |
| 部署工具测试 | 66个通过，复用既有部署恢复、账户匹配、凭据隔离及输出脱敏检查 |
| Worker 集成测试 | 100个通过；本轮新增3个最终Worker流程验证完成与HMAC503→204、取消后unknown历史与当前状态、真实失败+完成双事实、策略关闭/分页及Owner/Origin/Agent隔离 |
| 浏览器 E2E | 最终bundle26个完整流程通过；本轮新增8条通知筛选/分页、CAS409、批次定位和全局深链接、对账后历史保留、disabled策略及7份通知HMAC投递+1次自动重试；Chrome，桌面1488×1056、手机390×844 |
| 部署入口 | 离线 deploy:plan 与实际 Windows pnpm 子进程检查通过；GitHub 手动工作流未在远程运行 |
| 本地升级 | pnpm db:local 已应用0019（8条迁移命令）；54张表，旧批次/逐项结果/投递/审计保留，不回填旧通知或重新排队，无需重建数据库 |
| 持久本地流程 | 既有 db:local → local:seed → preview → email → scheduled → API 已验证；本轮复用独立内存 D1/R2 完整集成与浏览器测试 |
| Vite 开发模式 | 既有 dev 首页与 healthz 200 验证保留；本轮针对最终 Worker bundle 验证 |

集成测试会故意注入 D1 错误并拒绝未知邮箱，相关错误日志属于预期断言；以测试退出码和通过状态判断结果。本轮未创建真实云资源、部署远程 Worker 或触发真实邮件投递；DNS、Access 策略与邮件服务开通仍需云端验收。测试使用独立内存资源，开发服务器已停止。

此前完整集成回归中，两个既有 MCP 测试文件在断言通过后未退出。检查后在测试层统一传递 Request.signal、先关闭客户端再销毁 Miniflare，保留全部断言与超时。本轮沿用该清理机制，完整 `pnpm test:integration` 的100项集成测试正常退出并全部通过。

附件界面验收使用既有 Playwright/Chrome（当前没有 Browser 插件）：`http://127.0.0.1:4198/owner/mailboxes/{id}/messages` → 查看元数据 → 下载 Unicode 文本与 SVG → 校验字节。页面身份、非空内容、无框架错误覆盖层、无相关 console error/warn、桌面/手机布局及实际操作均通过。下载保留未读状态，附件内脚本和远程图片均未加载；Token/OAuth 选择验证附件范围依赖邮件读取。浏览器仅在本地运行，不代表真实 Access 登录或 Cloudflare 收信已验收。

草稿附件验收为 `http://127.0.0.1:4199/owner/mailboxes/{id}/outbound` → 实际选择两份文件 → 上传/核对 → 编辑和移除使审批失效 → 重新审批 → 原生模拟发送 → Sent 下载校验。桌面/手机截图已检查；未保存文本时文件操作禁用，正文保存保留清单，无页面空白、框架错误层、相关控制台问题、外部请求或横向溢出。升级及协议见[草稿附件说明](outbound-attachments.md)。

HTML 验收为 `http://127.0.0.1:4200/owner/mailboxes/{id}/messages` → 纯文本/HTML 切换 → CID PNG 自动显示 → 核对清洗 DOM 与不透明沙箱 → 下载原附件 → 取消/确认远程图片加载 → 恢复屏蔽后 CID 仍显示 → 切换邮件。缺失、SVG 和非法 CID 保持占位；读取或发送 Token 均不能使用 Owner HTML 端点，附件下载继续要求独立权限。显式加载后没有 CORS 头的远程 PNG 以 data URI 实际显示，上游不含 Cookie、Referer、Origin、Authorization 或 Owner JWT，浏览器无外部请求；未读状态不变。测试使用最终 Worker 的上游适配器与独立 D1/R2，Chrome 阻止全部外部 DNS，未禁用 TLS 验证。当前没有 Browser 插件，复用现有 Playwright/Chrome；本轮没有新增数据库迁移。

HTML 发送验收为 `http://127.0.0.1:4201/owner/mailboxes/{id}/outbound` → 保存双正文 → 上传 PNG → 绑定并插入 CID → 保存 → 核对源码和空沙箱预览 → 修改使审批失效 → 再次核对审批 → 提交与 scheduled → accepted → 解析本地 EML 并阅读 Sent HTML/CID、下载图片校验。原始 HTML 不进入主 DOM，未保存修改隐藏旧预览，远程图始终不在草稿预览中加载。桌面与手机截图、控制台、页面身份、非空内容、框架错误层、实际交互及无横向溢出均通过。

投递事件验收为 `http://127.0.0.1:4203/owner/mailboxes/{id}/outbound` → 已审批的双正文邮件由原生 EMAIL 接受 → 同一 Worker native Queue 分别接收 delivered/deferred/bounced/failed/rejected → 无效桥接签名不写入 → 有效 HMAC 投诉回调增加独立标记 → 重复事件不增加发送次数 → 六份客户 Webhook 验签与脱敏核对 → Owner/API/MCP 状态一致。桌面和手机截图已检查，逐收件人结果、投诉时间与服务事件最新时间分开显示，无外部请求、页面错误或横向溢出。另有真实 D1 并发用例在 sender 返回 ACK 之前写入回执，验证后续补账不重发、不重复扣额度。原生事件来源和可选自建桥接的配置见[投递事件说明](email-delivery-events.md)。

抑制名单验收为 `http://127.0.0.1:4204/owner/mailboxes/{id}/suppressions` → native Queue产生hard退信/投诉和soft对照 → Owner筛选与真实分页 → 发送被整封阻止且额度不变 → 新风险使旧解除版本返回409 → 刷新核对后确认解除 → 旧事件重放保持解除 → 新建审批草稿允许发送 → 新hard事件再次抑制。既有 Playwright/Chrome 完成桌面1488×1056和手机390×844检查，当前没有 Browser 插件；页面身份、非空内容、实际交互、截图、无框架错误、无相关控制台问题、无外部请求和无横向溢出均通过。截图保存在源码目录之外。本地迁移、候选地址 API/MCP 与发送边界说明见[抑制名单](recipient-suppressions.md)。

Cloudflare名单验收为 `http://127.0.0.1:4205/owner/mailboxes/{id}/suppressions` → 未配置时本地名单仍工作 → 缓存GET不访问上游 → 私有两作用域分页同步 → 相同原因按read_only决定动作 → 账户范围输入完整地址并确认影响 → 丢失浏览器响应用相同UUID查询、不重复删除 → 明确选择联动当前邮箱 → DELETE期间新本地风险保持保留 → 未知删除只同步核对、不会重发DELETE或自动解除本地 → 分页失败保留完整缓存。真实Chrome桌面/手机和账户确认弹窗截图均检查，无溢出、遮挡、空白或框架错误；只有刻意注入的网络中断/502资源错误，未解释的控制台错误为零。浏览器没有Cloudflare请求或凭据泄漏。测试使用固定Cloudflare原点的本地上游模拟器，不管理真实账户；配置与边界见[Cloudflare服务端抑制](cloudflare-suppressions.md)。

执行历史验收为 `http://127.0.0.1:4206/owner/mailboxes/{id}/suppressions` → 11次失败同步的真实分页 → 移除API Token仍能读取记录和详情 → 恢复凭据、明确重试生成关联的新执行 → 未知解除详情只读 → 对账API失败提示在打开的弹窗内可见且无DELETE → 再次只读核对更新快照 → 使用当前版本、地址/账户范围及本地CAS确认新的解除 → 成功和只读记录不提供重试。桌面、手机列表/详情/确认弹窗截图均检查，无横向溢出、遮挡、空白或框架错误。浏览器只允许刻意注入的一次对账502资源错误，其余相关控制台错误为零；详情与历史GET不访问Cloudflare。当前没有Browser插件，沿用现有Playwright/Chrome；截图保存在源码目录之外。见[执行历史与重试](cloudflare-suppression-history.md)。

告警验收为 `http://127.0.0.1:4207/owner/mailboxes/{id}/suppressions` → 同步失败显示全局提醒 → 旧确认版本遇到新失败返回409并在弹窗提示刷新 → 确认知悉不调用Cloudflare且全局待确认数消失 → 新失败重开 → 实际成功解决 → 11条真实分页。未知解除流程验证提醒详情、确认不清除本地抑制、关联历史跳转与深链接、仅GET核对远端不存在后解决；没有第二次DELETE。六张桌面/手机截图已检查，无溢出、框架错误或外部请求；仅预期409资源错误被明确记录。最终bundle的通知测试另验证签名、最小字段、重试、全局精确域/活动范围、升级边界及Agent隔离。沿用既有Playwright/Chrome；截图保存在源码目录之外。见[操作告警](cloudflare-suppression-alerts.md)。

通知策略验收为 `http://127.0.0.1:4208/owner/mailboxes/{id}/suppressions` → 读取未保存默认值 → 配置开关/恢复/1800秒/Asia/Shanghai/22:00–08:00 → 保存并重载持久化 → 另一邮箱仍保留默认值 → 外部修改后旧表单409，提示实际进入视口且保存禁用 → 重新读取后明确保存 → 无效IANA时区400及同一静默起止时间本地拒绝。修改策略不调用Cloudflare、不改变已有告警/历史。四张桌面/手机及冲突截图已检查，无溢出、框架错误或外部请求，仅预期400/409资源错误。真实D1及最终bundle另验证同一信号限频、恢复重置、批内/并发准入、策略版本竞争、静默不消耗预算、关闭取消及迟到ACK不能复活任务。当前没有Browser插件，复用既有Playwright/Chrome，截图保存于源码目录之外。见[通知策略与降噪](alert-notification-policy.md)。

通知决策验收为 `http://127.0.0.1:4209/owner/mailboxes/{id}/suppressions` → native cron积累六类决策和两份签名投递 → 14条事件统计区分1次准入/13次跳过及2条成功投递 → 10+4真实分页 → 静默/限频/恢复类型筛选 → 决策详情 → 关联告警 → 单次投递HTTP204尝试 → 自定义过去时间窗口查询为空。读取前后通知、投递、审计及上游调用数保持不变。六张桌面/手机列表、静默详情、两订阅详情及尝试截图已检查，无溢出、框架错误、外部请求或未解释控制台问题。收起面板仍显示具体时间与筛选口径。API及D1另验证时间半开边界、回填记录不混入旧分页、投递状态同一读取快照、101条详情截断、无凭据/暂停读取和Token/OAuth/MCP隔离。沿用既有Playwright/Chrome；截图保存于源码目录之外。见[决策记录与降噪统计](alert-notification-decisions.md)。

导出验收为 `http://127.0.0.1:4210/owner/mailboxes/{id}/suppressions` → 当前页10条时下载全部14条CSV/JSON → 独立解析UTF-8 BOM/CSV记录及JSON六类统计和两份投递 → 静默/恢复筛选 → 未应用自定义范围禁用导出 → 413提示、HTML登录页面拒绝及取消请求均不产生文件。API参数没有cursor/limit，文件名固定绑定邮箱UUID及实际范围；读取前后D1统计和外部调用数保持不变。三个桌面/手机及超限截图已检查，无溢出、框架错误或异常外部请求；仅刻意模拟的413资源错误。服务端另验证公式单元格中和、Unicode/逗号/引号/换行、完整一致快照、恰好1000/5000允许及超过一条拒绝、不输出私有字段。当前没有Browser插件，沿用既有Playwright/Chrome；截图保存在源码目录之外。见[CSV/JSON导出](alert-notification-export.md)。

异步导出验收为 `http://127.0.0.1:4211/owner/mailboxes/{id}/suppressions` → 创建1001条CSV时刻意丢失响应 → 同一UUID重试返回同一任务 → cron分批显示500/1001 → 完成后原生Chrome下载CSV与JSON并逐字节比对同源文件、独立解析明细和统计 → CAS取消与R2清理 → 到期410及后台删除 → 10+2任务分页。未登录及非Owner401、恶意Origin403、未应用筛选禁用、读取不写通知/审计均通过。三张桌面/手机截图已检查，无溢出、框架错误、外部请求或未解释控制台错误；仅预期创建请求中断。使用现有Playwright/Chrome，截图保存在源码目录之外。

异步集成测试读取2001条决策、20010条投递，完整JSON为10309852字节，验证超过同步8 MiB上限及统计与明细相符；单元测试另验证2000片下载只需126次D1调用（Owner查找增加固定开销），每片校验及本地TTL不受查询合并影响。下载前及每16片重新检查邮箱状态；邮箱退役在下个清单分页中止。最大规模按Workers Paid预算设计，不能以本地workerd结果推断Free或真实云端CPU配额已验收。详见[异步导出设计、API和清理](async-alert-notification-export.md)。

导出通知验收为 `http://127.0.0.1:4212/owner/mailboxes/{id}/suppressions` → 实际订阅完成/失败两事件 → 创建1条决策的CSV任务并执行真实cron → 校验通知1/1及完整R2文件 → 完整性错误使另一任务最终失败 → 下轮收到两份HMAC验证的204投递 → 通知详情和原任务定位 → 另一窗口先确认后旧版本409 → 刷新确认使全局数量更新 → 跨邮箱深链接 → 11条通知真实分页 → 文件过期后通知保留且任务无下载。三张桌面/手机及冲突截图已检查，无溢出、空白、框架错误、外部请求或未解释控制台问题，仅预期409；读操作不写事件/审计/投递。Browser插件不可用，沿用现有Playwright/Chrome，截图在源码目录之外。

上一轮新增的终态AFTER UPDATE触发器会让D1 `meta.changes`包含通知插入。原引擎以变更数等于1判断检查点时可能误删合法分片，现已使用 `UPDATE ... RETURNING id` 的直接返回行判断提交，并修正失败/完成计数。两个真实D1用例验证空/非空成功、分片保留、失败和租约耗尽各只计一次；本轮最终bundle的大文件下载、通知集成及浏览器非空下载继续覆盖该回归。配置与协议见[导出通知](async-export-notifications.md)。

通知投递追踪验收为 `http://127.0.0.1:4213/owner/mailboxes/{id}/suppressions` → 打开通知详情 → 查看原决定与6个订阅的完整计数及5+1真实分页 → HTTP400投递及尝试日志 → 明确重新排队时丢失浏览器响应 → 沿同一UUID/原版本核对，预算8→16只增加一次 → 原事件/投递ID/载荷/签名版本的204投递 → 读取2次尝试与1条Owner重试审计 → 另一记录被更新后旧版本409 → 通用Webhook页发送相同新协议 → 关闭策略拒绝新排队、disabled通知无投递及重试操作。三张桌面/手机/冲突截图已目检，无横向溢出、重叠、框架错误或外部请求；仅预期一次POST网络中断和一次409严格计数。读取前后事件、审计、尝试数及外部请求数不变，不向DOM输出地址、密文或冻结payload。Browser插件不可用，复用现有Playwright/Chrome，截图保存在源码目录之外。

接口另验证pending_projection/pending_publication/published、跨邮箱/任务/游标拒绝、相同UUID在再次失败后只核对不重新排队、不同UUID同版本只有一个CAS赢家、通用入口不可绕过关闭/静默；单元用例覆盖丢D1ACK、密文认证失败、预算80上限及暂停邮箱只读核对。旧手动审计缺元数据返回nullable字段，GET不依赖签名凭据且不解密/访问R2。详见[投递追踪与手动重试](async-export-notification-deliveries.md)。

批量重试验收为 `http://127.0.0.1:4214/owner/mailboxes/{id}/suppressions` → 按当前邮箱/接收端拒绝/7天范围预览6条失败 → 丢失预览回应并沿同一UUID核对固定集合 → 修改筛选禁用旧确认 → 生成late导出的6条新失败不混入 → 一条原投递版本变化 → 明确提交时丢回应并核对原UUID/版本 → 原生cron先处理5/6，再完成6/6 → 5项排队/1项changed跳过 → 后续收到5份保留原事件/投递ID、载荷及密钥版本的HMAC204。另验证预览到期只读、Owner/Origin/跨邮箱隔离、无额外HTTP发送及无原始字段泄漏。三张进度/完成桌面及手机截图已目检，无溢出、重叠或错误覆盖，只有预期2次网络中断被计数；其他console/pageerror及外部请求为零。

浏览器循环修正了筛选控件辅助名称和内部刷新清除action错误提示的问题，响应不明时提示与原操作标识保持可见。最终bundle完成完整24项浏览器回归；API逻辑保持同一版本，378项单元/66项部署/94项完整集成通过，最终UI修正后4项批量接口另行复跑通过。

批量runner每轮5项，与既有Webhook传输共用scheduled；新增单条helper内部批次租约/版本/截止围栏。实时DB时钟只在原子审计准入处评估一次，避免跨SQL截止边界出现审计成功但投递未排队的假收据；真实D1延迟回归覆盖该边界。丢ACK、旧租约及过期只读收据恢复不重复发放预算，unknown不会假报completed。容量、状态及API见[失败投递批量重试](async-export-notification-retry-batches.md)。

批量取消与对账验收为 `http://127.0.0.1:4215/owner/mailboxes/{id}/suppressions` → 9条真实失败候选、5条已执行、模拟崩溃后2条running（1条有真实收据、1条无收据）及2条pending → 暂停邮箱后Owner确认停止 → 丢响应沿原UUID核对、只写1条取消收据 → 单条确认未提交并丢响应核对 → 批量恢复已有收据结果 → 5条操作历史按3+2分页 → 恢复邮箱后只有6条原已排队Webhook继续HMAC成功。5项旧结果逐字段不变，取消和对账前后投递预算不变；权限、原意图版本和Origin检查继续生效。桌面1488×1056及390×844手机截图已目检，无溢出、框架错误、非预期console或外部请求；仅刻意中断的2次POST。沿用Playwright/Chrome，截图保存在源码目录之外。

真实D1测试覆盖取消与迟到执行器竞争、claim和父版本原子更新、取消标记不可清除、预览取消不被过期清理复活、20+1有界对账、精确收据存在/缺失/冲突、最终事务前收据或版本变化、回滚及丢ACK重放。21项对账fixture和8项执行fixture在并行验证时超过默认5秒，已为这两个重型用例分别设置30秒时限，全部断言保持；完整 `pnpm test` 已通过397项单元、66项部署和97项集成，`pnpm test:e2e` 的25项也全部通过。0018本地升级执行3条命令，仍53张表，无新资源或发送通道。协议见[取消与未知结果对账](async-export-notification-retry-controls.md)。

批次通知验收为 `http://127.0.0.1:4216/owner/mailboxes/{id}/suppressions` → 订阅三个新topic → 实际批量重新排队并显示完成事实 → 接收端503后同ID/载荷的HMAC204自动重试 → 暂缺历史kid触发真实执行失败与completed双事实 → 取消运行条目生成unknown提醒 → 定位原批次并核对无收据条目 → 原未知快照保留、当前待对账归零 → CAS确认、另一窗口旧版本409 → 8条通知按未确认5+1、全部5+3分页 → 最后一条策略disabled仍Owner可见 → 全局提醒hash展开父面板并定位通知。最终仅7份独立通知投递及1次自动重试，不递归触发新批量任务。确认不改变结果或预算，原事件/投递身份保持稳定。

桌面1488×1056、手机390×844及冲突状态截图已目检，无横向溢出、框架错误或异常遮挡。pageerror和非预期外部请求为零，console只有刻意制造的1次409。Browser插件不可用，按 frontend-testing-debugging 工作流沿用Playwright/Chrome，截图保存在源码目录之外。浏览器循环发现并修复全局新hash未展开父级通知面板的问题；最终bundle完成全部26项浏览器回归。

新增快照在结果事务内保存，不回填旧终态；同一通知按稳定ID投影，重复cron、确认和读取均不重发。端点配置快照精确匹配id/密钥版本/配置更新时间，真实D1用例覆盖source逻辑时间晚于wallclock时，晚创建与后编辑端点仍被排除。限频复用已有状态表但加独立命名空间；Owner提醒、确认和currentAttention与Webhook准入分开。最终 `pnpm check` 0错误0警告，build:worker成功；test:unit 425、test:deploy 66、test:integration 100、test:e2e 26全部通过，数据库/配置224/21项通过。具体协议、类型和边界见[批次完成与异常通知](retry-batch-notifications.md)。
