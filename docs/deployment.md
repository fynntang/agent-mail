# 个人部署与初始化

Agent Mail 在你的 Cloudflare 账户中运行一个实例。Cloudflare 按钮、本地部署器和 GitHub Actions 最终都只发布 `worker/entry.ts` 这一个 Worker；SvelteKit、API/MCP、原生 email、scheduled 及可选 queue 共用 D1 和私有 R2。

部署应用、配置 Access、完成 Owner 向导和验证外部邮件收发是不同阶段。本文按实际操作顺序说明；功能使用文档见[文档索引](README.md)，实际完成的云端项目见本文末尾的[验证范围](#验证范围)。

## 部署前准备

准备 Cloudflare 账户、专用邮件域名及 Owner 登录邮箱。账户需启用 R2；使用 workers.dev 回退地址时，先完成账户 Workers 子域的启用。Email Sending 是可选能力，其资格、套餐和收件人限制以账户控制台为准。

### 实例参数

本地部署复制 [`deploy.config.example.json`](../deploy.config.example.json) 为被 Git 忽略的 `deploy.config.json`。PowerShell 使用 `Copy-Item deploy.config.example.json deploy.config.json`，其他 shell 使用 `cp`。填写实际值，不将示例域名或全零账户/数据库 ID 用于执行。

| 本地配置 | Workers Builds 对应项 | 填写要求 |
| --- | --- | --- |
| `accountId` | `CLOUDFLARE_ACCOUNT_ID` 或 Wrangler `account_id` | 目标账户的32位 ID；本地 JSON 留空时可由同名环境变量提供 |
| `workerName` / `databaseName` / `bucketName` | Worker 名称及 D1/R2 配置 | 本实例的明确名称；更新时保持不变。绑定名必须是 `DB` 和 `MAIL_BLOBS` |
| `mailDomain` | `MAIL_DOMAIN` | 实际 ASCII 邮件域名；推荐专用子域，保留原个人邮箱用途 |
| `ownerEmail` | `OWNER_EMAIL` | Access Allow 策略允许的 Owner 登录邮箱 |
| `consoleOrigin` / `apiOrigin` | `CONSOLE_ORIGIN` / `API_ORIGIN` | 不带路径或尾斜杠的精确 HTTPS origin；留空时推导为同一 workers.dev 地址 |
| `accessTeamDomain` / `accessAud` | `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | 团队 issuer 与应用 AUD，必须成对填写；初次可同时留空，Owner 入口保持拒绝 |
| `enableSending` | 构建环境 `AGENT_MAIL_ENABLE_SENDING=1` | 默认 false；确认服务资格及域名后再启用 |
| `cimdAllowedHosts` | `OAUTH_CIMD_ALLOWED_HOSTS` | 按需允许的 OAuth Client ID Metadata 主机；默认空列表，见[OAuth](oauth.md) |

部署器生成真实的根 `wrangler.jsonc`，再同步 adapter 专用 `wrangler.svelte.jsonc`。不要直接发布仓库里的占位配置，也不要单独部署 adapter 输出。公共运行变量和管理凭据应分别配置。

### 凭据与权限

| 用途 | 凭据和范围 |
| --- | --- |
| 本机部署 | 显式选择 Wrangler OAuth 登录，或提供限定目标账户的 `CLOUDFLARE_API_TOKEN` |
| CI、Actions、Workers Builds | 通过秘密注入提供 `CLOUDFLARE_API_TOKEN`；不能使用本机登录参数 |
| 创建/更新 Worker、D1、R2 | 一般需要账户级 D1 Write、Workers R2 Storage Write、Workers Scripts Edit/Write；workers.dev 回退还需 Account Settings Read；已有自定义 route 另需目标 zone 的 Workers Routes Write |
| 配置 Access | 单独使用控制台，或目标账户的 `Access: Apps and Policies` Edit（API称 Write）和 `Access: Organizations, Identity Providers, and Groups` Read |
| 启用邮件子域 DNS | 目标 zone 的 `Zone Settings Write`；读取现有记录另需 `DNS Read` |
| 创建邮件地址规则 | 目标 zone 的 `Email Routing Rules Write` |

权限名称以 Cloudflare 当前界面和接口为准。[Token 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)、[Workers 权限](https://developers.cloudflare.com/workers/authorization/)、[Access 应用权限](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/)、[读取 Zero Trust 组织](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/list/)。

Wrangler OAuth 的部署授权不包含 Access 应用管理。Access 专用 Token 和部署凭据分别管理；不要用仅有 Access 权限的 Token 替换部署凭据。管理 Token 不写入部署 JSON、Wrangler `vars`、`.dev.vars`、部署状态或 Worker Secret；运行时所需 Webhook 等 Secret 另按功能配置。

## 部署按钮

点击[README中的Cloudflare按钮](../README.md)。按钮会克隆公开仓库并建立 Workers Builds，按 Wrangler 绑定配置 D1/R2。[官方按钮与资源说明](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

1. 选择目标账户及 Worker、数据库、桶名称，保留 `DB` / `MAIL_BLOBS` 绑定名。账户需要已启用 R2。
2. 填写实际 `MAIL_DOMAIN`、`OWNER_EMAIL` 和 `CLOUDFLARE_ACCOUNT_ID`；核对按钮回写的 D1 ID 和 R2 名称。标准按钮预配资源，部署脚本只使用这些资源，不再创建第二份数据库或桶。
3. 使用 Node.js 24 和锁定的 pnpm 11.25.0。独立 **Build command 留空**；若界面要求非空，可填 `node --version`。**Deploy command** 填 `pnpm deploy:workers`，或明确调用 package 脚本的 `pnpm run deploy`。
4. 核对构建 API Token 具有 D1 迁移、Worker 发布和所需账户查询权限。脚本内部会移除管理凭据再执行检查和构建，避免自动预填的外层 `pnpm build` 先继承构建 Token。
5. 部署入口只在 `WORKERS_CI=1` 选择按钮路径，依次检查、构建、执行远端迁移、发布。迁移失败不上传 Worker；普通 `CI=true` 不会将本地离线计划变成部署。[Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
6. 默认关闭发送绑定。账户已开通相应服务时，再设置构建变量 `AGENT_MAIL_ENABLE_SENDING=1`。`WEBHOOK_KEYRING` 等运行时 Secret 按需配置。
7. 打开输出的 `/setup`，继续配置 Access 和 Owner 向导。按钮会为克隆仓库启用后续构建/部署，请审阅 Workers Builds 的生产分支与自动部署设置。

直接将普通 Git 仓库接入 Workers Builds 时，需要先配置实际 D1/R2 绑定；没有预配资源可使用下方本地部署器创建。`.dev.vars.example` 会被按钮识别为 Secret 模板，因此仅保留注释；完整本地示例位于 `.dev.vars.local.example`，避免 localhost、Owner 等示例值覆盖生产变量。

### 按钮提示无法获取存储库内容

先区分导入仓库失败与构建失败。若配置表单尚未出现、没有构建记录，则检查仓库读取请求，不要先修改应用代码、迁移或 D1/R2。

仓库网页能打开，不代表导入页面的 GitHub REST 请求也成功。本次真实排查中，带认证请求可以读取公开仓库与 `wrangler.jsonc`，系统网络的匿名仓库/文件列表请求却返回403，且 `X-RateLimit-Remaining: 0`。用户随后提供该失败请求的响应，明确为 `API rate limit exceeded`，确认此次导入被 GitHub API 限流阻止。其他实例应核对自己的失败请求，不仅凭页面文字认定仓库私有、源码错误或同一限流原因。

| 失败请求的结果 | 处理方式 |
| --- | --- |
| GitHub 403/429，剩余额度为0 | 按 `X-RateLimit-Reset` 或 `Retry-After` 等待后再试，停止反复刷新。匿名 REST 配额按来源 IP 计算；登录 Cloudflare 或打开 GitHub 网页不一定让导入请求携带 GitHub API 认证。 |
| 仓库或内容接口404 | 核对按钮中的公开源仓库 URL、默认分支和路径；已有 Git 连接还需核对 Cloudflare GitHub App 的仓库访问范围。 |
| 网络失败、Cloudflare 安全验证或登录页面 | 先完成正常浏览器登录及页面要求的人工验证；保存不含凭据的失败端点、状态和错误文字，区分网络与应用构建问题。 |
| 已有构建记录且执行命令失败 | 查看对应构建日志，再按失败的命令、绑定或变量排查；这时才属于构建/部署阶段。 |

不要在页面、URL 或截图中填入 GitHub/Cloudflare Token。官方说明见[GitHub REST 配额与等待规则](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)和[Cloudflare GitHub 集成](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)。需要先使用实例时，可以采用已验证的本地部署器；这不能替代官方按钮的完整验收。

## 本地部署

需要 Node.js 24、pnpm 11.25.0，以及填写好的 `deploy.config.json`：

```sh
pnpm install --frozen-lockfile
pnpm deploy:plan -- --input deploy.config.json
```

离线计划不访问 Cloudflare、不创建资源、不写部署状态，也不要求凭据。检查目标账户、名称和参数后，选择本机登录部署：

```sh
pnpm exec wrangler login
pnpm deploy:setup -- --input deploy.config.json --use-wrangler-login
```

部署器通过受支持的 Wrangler CLI 获取登录凭据，只保存在控制面进程内存中，不解析凭据文件、不输出 Token。`--use-wrangler-login` 需要显式选择，CI 和 Workers Builds 会拒绝它；已有 `CLOUDFLARE_API_TOKEN` 环境变量时优先使用该 Token。

使用专用 API Token 时，先通过本地终端的秘密注入方式设置 `CLOUDFLARE_API_TOKEN`，再运行：

```sh
pnpm deploy:setup -- --input deploy.config.json
```

两种执行方式都会实际创建云资源、迁移并发布。类型检查和打包子进程移除已知 Cloudflare 认证环境变量；只有控制面调用、远程迁移和最终发布使用部署认证，日志会遮盖凭据。

执行顺序为：校验配置及同名资源 → 创建/核对 D1、R2并记录 ID → 写入实际绑定 → `pnpm check` 和 `pnpm build:worker` → `wrangler d1 migrations apply DB --remote --config wrangler.jsonc` → 发布一个 Worker并输出初始化地址。

## GitHub Actions

Fork 后在**自己的仓库**配置下列值，而不是在上游仓库运行个人部署：

| 设置 | 内容 |
| --- | --- |
| Repository variable `AGENT_MAIL_DEPLOY_CONFIG_JSON` | 完整实例 JSON，可不含 accountId |
| Repository variable `CLOUDFLARE_ACCOUNT_ID` | JSON 未提供时的目标账户 ID |
| Repository secret `CLOUDFLARE_API_TOKEN` | 目标账户的部署凭据 |

进入 Actions → `Deploy personal Agent Mail` → Run workflow。初次创建保留 `reuse_existing=false`；更新或中断后重跑时，核对资源名称后显式选择 true，因为新的 GitHub runner 没有之前的本地归属状态。

工作流 `.github/workflows/deploy.yml` 仅手动 `workflow_dispatch` 触发，push/PR 不自动部署。并发组防止同仓库同时发布，凭据只注入最终部署步骤，不写仓库或运行时。Cloudflare 按钮建立的 Workers Builds 自动部署与此工作流分别管理。

## 首次进入与 Access

两个 origin 留空时，部署器查询账户 Workers 子域，为控制台和 API 使用同一 workers.dev 地址。没有有效 Access 参数时可以先发布应用，但所有 Owner 页面和 API 仍拒绝访问，没有“首访认领”或匿名初始化写入口。

公开 `/setup` 只提供静态接入说明，不创建 Access 应用、不写部署变量或实例设置，也不展示当前 Owner、邮件域名、数据库 ID、AUD 或 Token。已经完成资源创建和发布的实例直接继续配置 Access，复用已有 Worker、D1 和 R2。

### 选择保护范围

在 Zero Trust → Access → Applications 创建 **Self-hosted** 应用，Allow 策略只允许部署参数中的 Owner 邮箱。不要直接选 Workers 面板的 **Protect this Worker**：Worker 级 Access 会保护该 Worker 的所有入口和域名，包括 Agent 所需的公开协议入口。

| 入口方式 | Access 覆盖范围 | 部署参数 |
| --- | --- | --- |
| 同一个 workers.dev origin | 应用域名填写 `<worker>.<account-subdomain>.workers.dev/owner` | 两个 origin 都填该主机的精确 HTTPS 地址 |
| 两个自定义域名 | 仅覆盖控制台主机名 | 分别填写控制台/API origin，两个主机均绑定同一 Worker |

父路径 `/owner` 的子路径继承策略，包括 Owner API 和 OAuth 同意页。`/owner/*` 不覆盖父路径 `/owner`，因此这里使用不带通配符的父路径。`/v1`、`/mcp`、OAuth 发现、注册和 token 端点由应用验证邮箱凭据，不应跳转到 Access 交互登录。还需核对账户中已有的 Worker级/账户级 Access 规则是否覆盖本实例，保留无关 Worker 的策略。[Workers Access 范围](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)、[路径继承规则](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)。

### 保存参数并重新部署

1. 记录团队 issuer `https://<team>.cloudflareaccess.com` 和应用 Audience（AUD）。边缘 Allow 策略不能替代 Worker 内的 JWT 校验。
2. 本地部署将 `accessTeamDomain`、`accessAud` 成对写入私有 `deploy.config.json`，核对 Owner 及两个 origin；使用原认证方式重新运行 `deploy:setup`。保持账户、Worker、D1、R2 名称不变，复用已确认资源。
3. Workers Builds 部署将 `ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`、`OWNER_EMAIL`、`CONSOLE_ORIGIN`、`API_ORIGIN` 保存到克隆仓库实际 Wrangler 配置，再重新发布。仅改控制台运行变量可能被下一次源码部署覆盖，应保持部署来源一致。
4. 自定义域名需在 Workers Domains & Routes 绑定；填写 origin 本身不会创建域名或 DNS。
5. 通过 Access 登录 `/owner/setup`。Worker 检查真实 JWT 签名、issuer、audience、有效期及 Owner 邮箱；邮箱 Token/OAuth Agent 授权不能进入向导。

验证时，未登录的 Owner 页面应被 Access 拦截，已登录页面正常加载，跨 Origin 写入被拒绝。无邮箱凭据的 `/mcp` 应返回应用自己的401和 OAuth challenge，而非 Access 登录页。入口配置依据[官方 Self-hosted 说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

## Owner 初始化向导

`/owner/setup` 显示当前部署参数，保存实例名称和 Owner 确认。修改 Access、域名或 origin 仍需更新部署配置并重新发布。

| 步骤 | 应用检查或显示 | Owner 确认 |
| --- | --- | --- |
| 资源与迁移 | 最新结构、表/列/索引、R2 head；显式按钮执行随机对象 put/get/delete | 缺少迁移时从部署端执行 |
| 邮件域名 | 当前 MAIL_DOMAIN | 专用域用途、DNS托管及现有 MX影响 |
| Access | Owner、issuer、AUD 和两个 origin | Allow策略、边缘范围和备用域名 |
| Email Routing | 实例来信持久化数量 | 域名、DNS、地址规则指向同一 Worker |
| Email Sending | EMAIL绑定及被服务接受的数量 | 域名、DNS、账户资格及限制 |
| Agent 邮箱 | 启用邮箱数量和 API/MCP入口 | 创建首个邮箱，签发最小权限凭据 |
| 完成 | 保存确认并重新检查 R2读写 | 独立外部收发仍需实际验收 |

GET检查不创建设置、不写探针、不发邮件或修改云端配置。R2探针和完成动作由 Owner 显式发起；随机探针会尝试清理，清理失败单独报错。完成需要有效部署参数、完整迁移、R2可读写、至少一个活动邮箱及所有适用确认；未绑定 EMAIL 时不要求发信确认。

`ready` 是向导记录完成状态，不等于外部邮件已送达。配置指纹和实例版本保护保存操作：Owner、域名、Access、origin或发送绑定变化会使旧确认失效，旧页面返回409，刷新后重新核对。数据库不可用时页面显示诊断，不在向导内执行迁移。

接口为 `GET/POST /owner/api/setup`、`POST /owner/api/setup/probe`，保留只读 `/owner/api/setup/checks`。写请求继续要求 Owner JWT和精确Origin；底层对象或数据库错误不会原样输出。

## 邮件域名与收发

按 Cloudflare Email Service 为专用邮件域名提供的记录配置 DNS。操作前核对现有 MX用途，保留原个人邮箱；向导不会替代DNS、路由或服务开通。[域名配置](https://developers.cloudflare.com/email-service/configuration/domains/)

Email Routing规则的 action 指向已发布的 Worker名称，由同一 Worker的原生 `email` handler接收，没有HTTP收信URL。未知或停用邮箱会拒收；部署器不提交 `addresses: []`，也不修改已有邮件路由。[收信接入](https://developers.cloudflare.com/email-service/get-started/route-emails/)、[地址规则](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/)。

### 专用邮件子域

例如让 `agent.example.com` 收信并保留 `example.com` 原邮箱服务，先在 Email Routing → Settings → Subdomains 添加子域。操作前后核对父域 MX，不启用或更改父域 catch-all。

API使用父域的 zone ID，但DNS启用请求必须显式指定邮件子域全名：

```text
POST /zones/{zone_id}/email/routing/dns
Content-Type: application/json

{"name":"agent.example.com"}
```

不要省略 `name` 或发送空请求体，否则该端点针对父域启用 Email Routing。按实际返回记录核对子域 MX/SPF，不替换父域记录。该端点需要目标zone的 `Zone Settings Write`；读取原记录另需 `DNS Read`。`GET /email/routing/dns` 的 `subdomain` 参数已废弃，携带时返回结构不同，不能按默认数组解析。[子域接入](https://developers.cloudflare.com/email-service/configuration/subdomains/)、[DNS启用API](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/create/)、[DNS查询API](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/methods/get/)。

子域不支持 catch-all；为每个已创建的 Agent地址分别建立 literal规则：

```text
POST /zones/{zone_id}/email/routing/rules
```

```json
{
  "enabled": true,
  "source": "api",
  "matchers": [{"type": "literal", "field": "to", "value": "assistant@agent.example.com"}],
  "actions": [{"type": "worker", "value": ["my-agent-mail"]}]
}
```

替换成实际邮箱与同一 Worker名称。创建前核对该地址已有规则，增加邮箱时同步增加对应规则；需要 `Email Routing Rules Write`。这里使用 Worker action，接收邮箱独立于 Owner个人邮箱。[规则API](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/methods/create/)。

### 可选发送

默认 `enableSending:false`，生成配置不含 EMAIL绑定，可先完成收信接入。发信时先开通 Email Sending、接入发送域名并配置官方 SPF/DKIM等记录，按用途设置 DMARC；确认套餐及收件人限制后，改 `enableSending:true` 并重新部署，再回向导核对新配置。

实际测试邮件从“草稿与发送”显式提交，沿用邮箱权限、配额及 Owner审批，向导不会自动发信。服务接受提交与最终送达是两个状态，观测计数不能替代独立收件人验收。[发信接入](https://developers.cloudflare.com/email-service/get-started/send-emails/)、[发送绑定](https://developers.cloudflare.com/email-service/configuration/send-bindings/)、[资格限制](https://developers.cloudflare.com/email-service/reference/faq/)、[价格](https://developers.cloudflare.com/email-service/platform/pricing/)。

### 可选集成

| 能力 | 额外配置 |
| --- | --- |
| Webhook | 本地生成私有包装密钥，用 `wrangler secret put WEBHOOK_KEYRING` 配置；密钥轮换和至少一次投递见[Webhook](webhooks.md) |
| 投递事件 | 发信域的 Event Subscription、专用 Queue、来源 allowlist和同一 Worker consumer；HTTP桥接可另配HMAC。部署器保留已验证consumer，不创建Queue/订阅，见[投递事件](email-delivery-events.md) |
| Cloudflare抑制管理 | 普通变量 `EMAIL_SUPPRESSIONS_ACCOUNT_ID` / `EMAIL_SUPPRESSIONS_DOMAIN`，专用 `EMAIL_SUPPRESSIONS_API_TOKEN` Secret限定目标账户的 Email Sending Edit，见[抑制配置](cloudflare-suppressions.md) |

本地退信/投诉抑制、告警、异步导出和通知重试均复用既有 D1/R2。按序迁移后即可使用相应功能，不需再按每篇历史功能说明重复建表；容量及套餐边界见各功能文档。

## 升级、中断恢复与卸载

迁移从0001顺序执行至当前 `0020_retry_batch_notification_retry_batches.sql`，共56张 STRICT表。部署器只应用待执行文件，保留原数据；不要修改已发布迁移或将参考快照用于已有实例。升级前独立备份 D1、R2及运行配置；Worker回滚不会回滚数据库，D1 Time Travel也不覆盖R2。

`.agent-mail/deploy-state.json` 保存账户、资源标识和最后确认阶段；`.agent-mail/wrangler.before-deploy.jsonc` 保存首次修改前的根配置，均不保存Token且被Git忽略。相同配置重跑会核对已记录资源。构建失败不迁移，迁移失败不发布，失败不会自动删除资源或倒退数据库。

同名资源没有本地归属记录时，部署器会在创建任何资源前停止。核对账户、名称、用途后，可显式接入已有实例：

```sh
pnpm deploy:setup -- --input deploy.config.json --reuse-existing --use-wrangler-login
```

使用API Token时省略登录参数。此操作会更新同名Worker并迁移同名数据库；记录中的ID消失或名称变化会拒绝，不能用该选项悄悄重建。创建请求超时或发布响应丢失时，先在Cloudflare核对结果，不盲目重复创建。

部署锁 `.agent-mail/deploy.lock` 防止同目录并发。崩溃后先确认部署进程已停止，再只移除该锁文件，不清空状态目录或资源。原生及adapter配置必须保留 `nodejs_compat`、`global_fetch_strictly_public`；远程图片继续经过公共Internet安全边界。[兼容性标记](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)

部署器保留明确配置的HTTP routes，但不自动创建自定义域名/DNS、邮件路由或Access策略。额外DB/R2、其他环境、自定义build或无法识别的复杂模板会被拒绝，以免覆盖无关部署。恢复后不要自动重发已接受或结果未知的邮件。

发布版本应包含许可证、锁文件、迁移、部署示例和验收记录。卸载由部署者在自己的账户处理：暂停收发、备份后清理本实例Worker/D1/R2及自己创建的路由和Access应用，保留共享域名及无关资源；部署器不提供自动递归删除。

## 验证范围

| 项目 | 验收范围与证据 |
| --- | --- |
| 部署工具与失败恢复 | 已有本地模拟与回归覆盖；命令和结果见[开发记录](development.md) |
| 本地部署器实际云端路径 | 已创建D1/R2、完成20个远端迁移、发布单Worker，并完成R2读写探针 |
| Cloudflare按钮/Workers Builds完整安装 | 真实按钮入口与构建结果分别记录，不能用本地部署成功替代 |
| Access及Owner向导 | 实际Access授权、JWT/Origin检查和Owner完成流程单独验收，不能仅以资源已部署判定通过 |
| 邮件域名及外部收发 | DNS、地址规则、服务接受和外部送达分别验收；向导ready不代替收发结果 |

逐阶段云端结果及待验收项目统一见[实际部署验证](cloudflare-live-validation.md)。公开记录不包含真实账户、Owner邮箱、资源ID或凭据，不将模拟验证记作实际安装成功。
