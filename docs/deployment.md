# 个人部署与初始化

项目提供本地一条命令部署和手动触发的 GitHub Actions。两者调用同一个部署器：创建或核对 D1、R2，写入实际绑定，构建，执行有序迁移，最后只部署 `worker/entry.ts` 这一个 Worker。SvelteKit、API、MCP、原生 email 和 scheduled 均在其中运行。

部署应用后，还需要在自己的 Cloudflare 账户配置 Access、邮件域名、Email Routing 和可选的 Email Sending。初始化向导区分资源检查、Owner 人工确认和应用观测记录，不把这些步骤视为已自动开通。

## 本地部署

需要 Node.js 24、pnpm 11.25.0、Cloudflare 账户和专用邮件域名。R2 需在账户中开通；发送功能的资格、套餐和收件人限制以账户控制台为准。

```sh
pnpm install --frozen-lockfile
```

复制 `deploy.config.example.json` 为被 Git 忽略的 `deploy.config.json`，替换账户、域名、Owner 和资源名称。PowerShell 使用 `Copy-Item deploy.config.example.json deploy.config.json`；其他 shell 使用 `cp`。

```json
{
  "version": 1,
  "accountId": "你的32位Cloudflare账户ID",
  "workerName": "my-agent-mail",
  "databaseName": "my-agent-mail",
  "bucketName": "my-agent-mail",
  "mailDomain": "agent.你自己的域名",
  "ownerEmail": "你的Owner邮箱",
  "consoleOrigin": "",
  "apiOrigin": "",
  "accessTeamDomain": "",
  "accessAud": "",
  "enableSending": false,
  "cimdAllowedHosts": []
}
```

示意值必须换成实际 ASCII 域名、邮箱和账户 ID。使用示例中的占位符可以预览计划，但执行前会拒绝占位符。资源名只接受明确的字符集；账户 ID 可留空并通过本地 `CLOUDFLARE_ACCOUNT_ID` 提供。

先查看离线计划：

```sh
pnpm deploy:plan -- --input deploy.config.json
```

计划不访问 Cloudflare、不创建资源、不写部署状态、不需要 Token。准备执行时，通过终端或 CI 的秘密注入方式设置 `CLOUDFLARE_API_TOKEN`，然后运行：

```sh
pnpm deploy:setup -- --input deploy.config.json
```

这条命令会实际创建云资源、运行远程迁移并发布。不要将管理 Token 写入 JSON、Wrangler `vars`、`.dev.vars` 或 Worker secret。部署器只在控制面调用、远程迁移和最终发布时使用它；类型检查和打包子进程会移除已知的 Cloudflare 认证环境变量，日志也会遮盖这些凭据。

API Token 限定到目标账户，包含创建/查询 D1、R2、查询/发布 Workers 的权限。一般对应 Account 级 D1 Write、Workers R2 Storage Write、Workers Scripts Edit/Write；使用 workers.dev 回退地址还需要读取账户 Workers 子域的权限（Account Settings Read）。保留自定义 Worker route 的配置时，另需该 zone 的 Workers Routes Write。具体名称以 Cloudflare 当前权限界面和接口要求为准。[Token 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)、[Workers 权限](https://developers.cloudflare.com/workers/authorization/)。部署器不申请或使用 DNS、Access 管理权限。

执行顺序固定为：

1. 校验输入和单 Worker 模板，检查同名 Worker、D1、R2。
2. 创建缺失资源，逐个记录已确认的 ID；不因超时自动重试创建请求。
3. 将真实绑定写入根 `wrangler.jsonc`，同步生成 adapter 专用配置。
4. `pnpm check`、`pnpm build:worker`，验证最终 bundle；此时只做 dry-run。
5. `wrangler d1 migrations apply DB --remote --config wrangler.jsonc`。
6. `wrangler deploy --config wrangler.jsonc`，只上传一个 Worker，并输出初始化地址。

迁移从 `0001_initial.sql` 按文件顺序执行，当前最新为 `0019_retry_batch_notifications.sql`，共54张 STRICT 表。初始化、OAuth、附件、Webhook、投递事件、本地及 Cloudflare 抑制、执行历史、告警、通知策略、查询索引、异步导出、终态通知及批量重试均使用增量迁移；部署工具会应用全部待执行文件。已有数据和旧版排队发送保持兼容；旧凭据不会自动获得收件附件权限，草稿附件沿用 mail:draft。

`wrangler.svelte.jsonc` 由根配置生成，只供 SvelteKit adapter 读取；禁止单独部署。部署工具保留明确配置过的 HTTP routes，但不自动创建域名/DNS、Email Routing 或 Access 策略。带 `addresses`、额外 DB/R2、其他环境或自定义 build 的模板会拒绝，避免在不了解其含义时覆盖复杂部署。

原生部署和 adapter 都必须保留 `nodejs_compat`、`global_fetch_strictly_public`。后者保证远程资源的全局 fetch 按公共 Internet 路由处理，即使目标在自己的 Cloudflare zone 也不会绕过 Worker 或边缘安全设置直达私有源站。部署工具会为旧配置补齐标记并保留其他显式标记；构建配置同步拒绝缺失标记或反向的 `global_fetch_private_origin`。远程图片只使用受约束的全局 fetch，不调用 ASSETS 或服务绑定。[Cloudflare 兼容性标记说明](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)

## 首次进入与 Access

两个 origin 留空时，部署器查询现有的账户 workers.dev 子域，为两者生成相同的 Worker 地址。需要先在 Cloudflare 为账户启用 Workers 子域。没有 Access 参数时仍可部署应用，但所有 Owner 页面和接口保持拒绝访问；没有“首访认领”或未认证初始化写入口。

公开 `/setup` 仅给出通用接入说明，不查询或展示 Owner、域名、数据库 ID、Access AUD、邮件或 Token。它可以在 Owner 尚无法登录时提供引导。

配置 Access：

1. 在 Zero Trust → Access → Applications 创建 Self-hosted 应用，Allow 策略只允许 `ownerEmail`。
2. 将团队 issuer（如 `https://你的团队.cloudflareaccess.com`）和应用 AUD 写入 `accessTeamDomain`、`accessAud`；两项必须一起填写。
3. 推荐使用独立控制台和 API 域名，并将两个域名绑定到**同一个 Worker**。在配置中填入不带路径/尾斜杠的精确 HTTPS origin。
4. Access 保护控制台入口；API 域名的 MCP、OAuth 发现、注册和 token 端点需要公开到客户端，由应用验证相应凭据。若暂时共用一个 origin，Access 应用仅覆盖 `/owner` 及其子路径，不能整站拦截 MCP/OAuth。
5. 再次运行 `deploy:setup` 更新配置，访问 `/owner/setup`。Worker 验证 JWT 签名、issuer、audience、有效期和 Owner 邮箱；仅注入身份头不能登录。

自定义域名的绑定由部署者在 Workers Domains & Routes 中完成，配置中的 URL 不会自动创建 DNS 记录。更新时保持 Worker 和资源名称不变，以便复用本地已确认的资源。

Access 控制台名称和位置可能变化，配置依据[官方 Self-hosted 应用说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

## Owner 初始化向导

`/owner/setup` 复用现有 Access 认证与写请求 Origin 校验。页面分为：

| 步骤 | 应用执行或显示 | Owner 需要确认 |
| --- | --- | --- |
| 资源与迁移 | 检查所有预期表/列、显示结构版本，R2 head；显式按钮进行随机对象 put/get/delete | 缺少迁移时从部署端运行迁移 |
| 邮件域名 | 当前 MAIL_DOMAIN | DNS 托管、专用域用途及现有 MX 的影响 |
| Access | 当前 Owner、issuer、AUD 和两个 origin | 边缘保护范围、Allow 策略、备用域名 |
| Email Routing | 实例来信持久化数量 | 域名接入、DNS、地址规则指向当前 Worker |
| Email Sending | 是否存在 EMAIL 绑定、已被发送服务接受的数量 | 发送域名、DNS、账户资格及限制 |
| Agent 邮箱 | 启用邮箱数、管理入口和 API/MCP URL | 创建邮箱、签发最小权限 Token 或授权 OAuth |
| 完成 | 保存实例名称及确认；重新验证 R2 读写 | 继续做真实收发验收 |

GET 检查不创建实例设置、不写探针、不发邮件、不修改云端配置。读写探针和完成动作必须由 Owner 显式发起；随机探针会在 finally 中尝试清理，清理失败单独报错。

完成条件是部署参数有效、迁移完整、R2 可读写、至少一个启用邮箱，以及所有适用的 Owner 确认；未绑定 EMAIL 时不要求发信确认。`ready` 是向导记录完成状态，不作为外部邮件投递成功的证明，也不会绕过邮箱 Token 或发送审批。

保存使用实例版本和当前部署配置指纹检查。并发旧页面返回 409；域名、Owner、Access、入口地址或发送绑定发生变化时，旧确认失效，旧页面提交也会拒绝。刷新并按新配置重新确认。数据库不可访问或结构缺失时，Owner 向导仍能显示诊断，不在页面中执行迁移。

接口为 `GET/POST /owner/api/setup` 和 `POST /owner/api/setup/probe`；保留只读兼容检查 `/owner/api/setup/checks`。POST 复用 Owner JSON/Origin 验证，错误不包含底层数据库或对象内容。

## 邮件收发配置

在 Cloudflare Email Service 接入专用邮件域名，按控制台提供的验证记录配置 DNS。先确认现有 MX 用途，避免替换已有个人邮箱。参考[域名配置](https://developers.cloudflare.com/email-service/configuration/domains/)。

Email Routing 的地址规则应指向部署输出的 Worker 名称，由该 Worker 的原生 `email` handler 接收；不存在 HTTP 收信 URL。只路由已创建的 Agent 地址，未知/停用地址会拒收。Catch-all 会扩大接收范围；父域规则不等于子域规则。部署器不提交 `addresses: []`，也不会更改已有路由。[收信接入](https://developers.cloudflare.com/email-service/get-started/route-emails/)、[地址规则](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)。

默认 `enableSending:false`，生成配置不包含 EMAIL 绑定，可先接入收信。需要发信时：

1. 在 Cloudflare 开通 Email Sending，接入发送域名；使用官方提供的 SPF/DKIM 等记录，按域名用途配置 DMARC。
2. 确认账户套餐、收件人和事务邮件限制。绑定存在不等于已获准任意收件人发送。
3. 将 `enableSending` 改为 true 并重新部署；返回向导确认新配置。
4. 在已有“草稿与发送”页面显式提交测试邮件，沿用邮箱权限、配额和 Owner 审批。向导不会自动发信。

Email Sending 接受提交与最终送达是两个状态；应用观测计数可能包含本地模拟数据，不能替代从独立外部邮箱收信和实际收件人验收。[发信接入](https://developers.cloudflare.com/email-service/get-started/send-emails/)、[发送绑定](https://developers.cloudflare.com/email-service/configuration/send-bindings/)、[资格与限制](https://developers.cloudflare.com/email-service/reference/faq/)、[价格](https://developers.cloudflare.com/email-service/platform/pricing/)。

## 中断恢复与已有实例

`.agent-mail/deploy-state.json` 保存账户、资源标识和最后完成的阶段，不保存管理 Token；`wrangler.before-deploy.jsonc` 保存第一次修改前的根配置。这些文件与个人部署 JSON 均被 Git 忽略。不要将个人运行配置作为公开产物分享。

相同配置再次执行会核对状态记录中的资源，不重新创建。构建失败不会迁移，迁移失败不会发布；任何阶段失败都保留已确认资源，不自动删除 D1/R2 或尝试倒退迁移。

若存在同名资源但没有本地归属记录，默认在创建任何资源前停止。核对目标账户、资源名和用途后，可显式接入：

```sh
pnpm deploy:setup -- --input deploy.config.json --reuse-existing
```

此选项会更新同名 Worker 并对同名数据库执行迁移，只用于自己确认属于该实例的资源。记录中的 ID 消失或名称变化时会拒绝，不能靠此选项悄悄重建。资源创建请求超时、最终发布响应丢失时，先在 Cloudflare 确认结果；不会自动重试不确定的创建/删除动作。

部署锁 `.agent-mail/deploy.lock` 防止同目录并发操作。正常结束会释放；进程崩溃时先确认没有部署进程，再手动移除这个文件。不要清空资源或状态目录来处理锁。

升级前独立备份 D1、R2 和运行配置。迁移只追加，不修改已发布文件；Worker 回滚不会回滚数据库。D1 Time Travel 不覆盖 R2。不要将旧快照作为已有实例的迁移，也不要在恢复数据库后自动重发已接受或结果未知的邮件。

## GitHub 一键运行

仓库提供 `.github/workflows/deploy.yml`，仅 `workflow_dispatch`，不会因为 push/PR 自动部署。发布或 fork 后，在自己的仓库配置：

- Repository variable `AGENT_MAIL_DEPLOY_CONFIG_JSON`：上述个人 JSON 内容，可以不含 accountId。
- Repository variable `CLOUDFLARE_ACCOUNT_ID`：账户 ID（JSON 中已有时可省略）。
- Repository secret `CLOUDFLARE_API_TOKEN`：目标账户的部署凭据。

在 Actions → Deploy personal Agent Mail → Run workflow 点击运行。初次创建保持 `reuse_existing=false`；GitHub runner 没有上次本地状态，更新或中断后继续时，需要核对名称后显式选择 true。并发组防止同仓库同时发布，凭据仅注入最终部署步骤，既不写仓库也不放入运行时。

GitHub 工作流文件已提供；本地测试不代表已在 GitHub 或真实 Cloudflare 账户运行。当前工作区尚未发布可部署 release，因此 README 不展示指向未发布代码的 Deploy to Cloudflare 按钮。正式 release 需用隔离账户完整安装验收后，再提供指向固定 tag 的按钮；Cloudflare 按钮的预配能力不替代邮件或 Access 接入。[Deploy 按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)。

## 开源发布与卸载

发布时一并提供固定 tag、锁定依赖、迁移、部署 JSON 示例和验收记录。维护者需确定并添加许可证、贡献说明和实际可用的安全报告渠道；不把未实现的导出/恢复能力列为已有功能。默认无中心化账户、强制回连或管理凭据托管。

卸载由部署者在自己的账户中处理：先暂停收发并备份数据，再删除本实例的 Worker、D1、R2，清理自己创建的邮件路由与 Access 应用。部署器不提供自动递归删除，不触碰共享域名或无关资源。
## 可选 Webhook

升级时应用 `0006_webhooks.sql`；部署工具会执行待迁移文件，继续发布同一 Worker。需要通知时，在本地运行 `node scripts/generate-webhook-keyring.mjs` 生成私有包装密钥，并通过 `wrangler secret put WEBHOOK_KEYRING` 配置；不要放入 wrangler vars 或源码。密钥缺失时收发邮件继续可用，Owner Webhook 页面会提示配置。密钥轮换、验证示例和至少一次投递语义见[Webhook 配置](webhooks.md)。

## 可选 Email Sending 投递事件

应用 `0007_email_delivery_events.sql`，为发信域名配置 Event Subscription、专用 Queue 和同一 Worker consumer。配置五项 EMAIL_EVENT 来源 allowlist；自建 HTTP 转发器可另配 HMAC secret。部署工具保留经过验证的专用 consumer，仍只发布一个 Worker；不会自动创建 Queue 或订阅。步骤、签名协议及真实云端验收边界见[投递事件配置](email-delivery-events.md)。

## 退信与投诉抑制

应用 `0008_recipient_suppressions.sql`；不新增绑定或 secret。已校验的 hard 退信和投诉会创建邮箱级名单，所有发送入口在入队及提交前检查。Owner 可查看、分页并按版本解除；Agent 只有已提交候选地址的只读检查。迁移补齐可信历史投诉，旧 bounced 不推断为永久退信。本地解除与 Cloudflare 自身名单独立，操作及升级语义见[抑制名单](recipient-suppressions.md)。

## 可选 Cloudflare 服务端名单管理

应用 `0009_cloudflare_suppressions.sql`。设置 EMAIL_SUPPRESSIONS_ACCOUNT_ID 与 EMAIL_SUPPRESSIONS_DOMAIN 普通 vars，通过 `wrangler secret put EMAIL_SUPPRESSIONS_API_TOKEN` 配置仅目标账户 Email Sending: Edit 的专用 Token。Owner 页查看、同步、解除 read_only=false 的记录，并可选择按版本联动当前邮箱本地记录。scheduled 每15分钟同步，仍只部署同一个 Worker；部署工具不创建管理 Token、不接收或托管该凭据。详见[配置与解除协议](cloudflare-suppressions.md)。

## 执行历史与安全重试

应用 `0010_cloudflare_suppression_history.sql`；不新增绑定或 Secret。Owner 可在同页查看同步/解除执行及原失败原因，对未知删除结果进行只读 GET 核对，再按服务端资格明确提交新重试。重试记录保留父子关系，本地新风险受 CAS 保护；查看历史不要求 API Token 在线。升级会保留原解除快照，未曾记录的旧同步不可重建。详见[执行历史](cloudflare-suppression-history.md)。

## 抑制操作告警

应用 `0011_cloudflare_suppression_alerts.sql`；不新增绑定或 Secret。Owner 控制台提醒失败和未知结果，支持确认已知悉、查看关联历史及实际恢复；升级边界以前的故障不会补发。需要外部通知时在现有邮箱 Webhook 订阅中选择两个告警类型，复用 `WEBHOOK_KEYRING`、HMAC、重试及记录。详见[告警配置与权限](cloudflare-suppression-alerts.md)。

应用 `0012_alert_notification_policies.sql` 可按邮箱设置开关、静默窗口、限频和恢复通知。旧安装默认保持开启/不限频，无新增 Secret；关闭会取消未完成告警投递，静默暂缓已有队列。详见[通知策略](alert-notification-policy.md)。

应用 `0013_alert_notification_decision_indexes.sql` 增加原因分页及事件投递索引，Owner 可查询通知决策、降噪统计和关联投递详情。初始化检查会验证索引归属和列序，并列出缺少/不完整索引；该迁移完成后仍为47张表，无新增绑定或凭据。详见[决策记录与统计](alert-notification-decisions.md)。

同步通知决策 CSV/JSON 导出复用0013结构，仍由同一个 Worker 的 Owner API 提供只读下载，保留原有数量和文件大小上限；数量、权限及文件格式见[导出说明](alert-notification-export.md)。

大批量导出应用 `0014_async_alert_notification_exports.sql`，增加任务与分片清单两表，完成后共49张表。继续复用 `DB`、私有 `MAIL_BLOBS` 和现有 scheduled，无需新增 Worker、公开 R2 下载或外部导出服务。Owner 在通知决策页创建后台 CSV/JSON，查看进度、取消和下载；创建/取消要求 Access 与匹配 Origin，下载逐次校验 Owner、邮箱、任务状态及有效期，过期立即拒绝并由后台清理临时分片。详细容量、时效及故障恢复见[异步导出](async-alert-notification-export.md)。

异步导出的最大规模（10万决策/100万投递/256 MiB）按 Workers Paid 的 D1、内部子请求及 CPU 预算设计。Free 不能保证最大规模生成及单次下载；清单查询已按16片合并，具体预算及官方限制链接见上述异步导出文档。升级代码不会自动变更账户套餐或创建新计费资源。

完成/失败通知应用 `0015_async_export_notifications.sql`，增加终态通知和独立限频状态两表，完成后共51张表。终态快照与任务状态在同一事务保存，不回填升级前已结束的任务；取消和过期不产生完成/失败提醒。控制台提醒与确认不依赖 Webhook 凭据，确认只表示已知悉。外部通知选择 `alert_notification.export.succeeded` / `alert_notification.export.failed`，复用原有 `WEBHOOK_KEYRING`、HMAC、重试和邮箱通知开关/静默/限频；完成不受恢复通知开关控制。

仍由同一个 scheduled 先处理既有 Webhook，再执行导出及每轮最多20条终态事件投影，新事件由下一轮有界发布和投递。订阅必须在终态前创建且最后配置时间严格早于终态时间；同毫秒或终态后更改的订阅保守不补发。通知仅 Owner 可查看及确认，原抑制决策统计及同步/异步文件格式保持原样。详见[导出完成与失败通知](async-export-notifications.md)。

投递结果追踪应用 `0016_export_notification_delivery_history.sql`，仅为既有审计增加 `audit_resource_history` 索引，仍为51张表，无新绑定或凭据。Owner 可查看决定、跳过原因、发布进度、投递状态、最多80次尝试及10条手动重试审计；无凭据仍可只读查询。手动重试要求活动邮箱/端点、当前通知开启且非静默、已准入的dead投递、剩余预算及有效冻结凭据；操作UUID与版本防止重复排队。通用重试入口同样约束导出事件，原跳过决定、限频准入和文件到期时间不改变。详见[导出通知投递追踪](async-export-notification-deliveries.md)。

批量重试应用 `0017_export_notification_retry_batches.sql`，增加持久批次和逐项结果两表，当时共53张表，不新增绑定或发送通道。Owner 按当前邮箱、失败时间半开窗口（最多31天）和安全原因预览最多1000条固定候选；预览10分钟内需明确确认，预览及提交使用不同UUID保持幂等，进行中任务每邮箱最多2个、全实例最多4个。批次从预览创建起24小时截止，已变化、策略阻止或预览不可重试的记录不会被强行排队。

仍由同一个 scheduled 在既有 Webhook 传输之后，每轮最多执行5项安全重新排队，实际HTTP留给后续cron及原签名/重试机制。进度区分重新排队、跳过、失败与未知；unknown不假装完成，只读核对既有单条重试审计，不盲目发送。批次记录可关联原投递和审计，不重评原跳过决定、不延长导出文件有效期。详见[失败通知批量重试](async-export-notification-retry-batches.md)。

批量任务可停止尚未执行的条目、手动核对未知收据并分页查看操作历史，已执行结果保留。应用0018迁移后仍为53张表，复用Owner权限与现有幂等收据，详见[取消与未知结果对账](async-export-notification-retry-controls.md)。

批次完成与异常通知使用0019增量迁移，新增不可变快照及准入收据表，当前54张STRICT表。Owner提醒独立于外部通知策略；三个Owner级Webhook topic沿用原签名、静默、限频与失败退避，不增加绑定或Worker。详见[批次完成与异常通知](retry-batch-notifications.md)。
