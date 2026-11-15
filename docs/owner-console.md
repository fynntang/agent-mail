# Owner 控制台

入口为 `/owner/mailboxes`。邮箱页面、管理 API 和原有 fetch/email/scheduled 始终在同一个 Worker。邮箱和邮件功能保留初始22张表；[MCP OAuth](oauth.md) 使用0002追加的7张表，侧栏“MCP 授权”可撤销客户端访问。

## 已实现的操作

- 创建多个 Agent 邮箱：设置名称与地址前缀，域名固定为实例的 MAIL_DOMAIN。地址忽略大小写并统一规范化，创建后不可更改。
- 修改名称与邮件大小上限（1 KiB–10 MiB）；暂停和恢复邮箱。暂停后新的收信、Token 请求和凭证签发被拒绝，恢复后未过期、未撤销的 Token 可继续使用。
- 为每个邮箱签发独立 Token，选择 7 / 30 / 90 天或永不过期。支持 mail:read、attachments:read、mail:draft、mail:send；附件内容需同时授予邮件读取，发送需同时授予草稿权限。默认要求 Owner 审批；只有 Owner 可明确授予免审批发送。旧 Token 不自动获得附件权限，Owner scopes 不对 Agent 开放。
- 管理每日收件人数与精确收件人白名单，并在“草稿与发送”中编辑、丢弃、审批、提交及取消排队发送。阅读页可创建回复，详见[邮件发送](mail-sending.md)。
- 查看 Token 名称、权限、有效期和状态；撤销后下一次请求立即失效。撤销必须同时匹配邮箱 ID 和 Token ID，重复撤销保留第一次的时间。
- 按邮箱阅读邮件、筛选与分页、标记已读/未读，详见[邮件阅读](mail-reader.md)。侧栏默认进入邮件页，“邮箱设置”可返回管理界面。
- 退役邮箱：输入完整地址确认后，保留原始邮件与地址墓碑、撤销全部 Token、取消未完成的解析任务。存在 queued/submitting/unknown 发送时拒绝退役。地址不能被重新分配，退役不能通过普通修改接口撤回。这不是物理删除邮件或释放存储空间。

完整 Token 使用 32 随机字节，形如 `am_<UUID>_<base64url-secret>`。D1 只保存完整 Token 的 SHA-256 摘要。明文只在签发响应与当前对话框中存在，不进入页面加载数据、URL、浏览器持久存储或审计日志；关闭后只能撤销并重新签发。网络中断导致签发结果不确定时，应检查列表并撤销多余凭证，客户端不会自动重复签发。

Token 列表中的日期按 UTC 显示，API 使用 UTC Unix 毫秒。邮箱设置修改采用 `expectedUpdatedAt` 乐观并发检查，冲突返回 409。成功操作与审计记录在同一 D1 batch 中提交；每次变更用唯一操作 ID 守卫副作用，不能仅凭同一毫秒的时间戳认定操作成功。阅读状态使用独立的显式布尔写入接口，不改变设置版本。

## Cloudflare Access 配置

1. 为控制台的真实域名创建 Access Self-hosted 应用，策略只允许 Owner 邮箱。应用应覆盖控制台页面、`/owner/api/*` 以及页面加载请求；按整个 console hostname 保护最简单。
2. 在根 `wrangler.jsonc` 配置 `OWNER_EMAIL`、`ACCESS_TEAM_DOMAIN`（`https://<team>.cloudflareaccess.com`）、`ACCESS_AUD`（应用 AUD）、`CONSOLE_ORIGIN` 与 `API_ORIGIN`。不要修改生成的 `wrangler.svelte.jsonc`。
3. 将 console / api 域名绑定到同一个 Worker。Agent Bearer API 可使用独立 api hostname，不需要交互式 Access 登录。
4. 浏览器经 Access 登录后，Worker 验证 `Cf-Access-Jwt-Assertion` 的 RS256 签名、issuer、audience、exp、nbf 与 Owner email，而不是相信身份提示头。直接访问 workers.dev 的 Owner 路径也不会跳过验证。

应用只从配置的固定 Access issuer 获取 JWKS，不接受客户端提供 JWKS URL、Owner 身份或公钥。浏览器脚本不保存 Access JWT、不复制 Access Cookie，API 请求使用同站会话；Access 登录跳转或会话失效会显示重新登录提示。[Cloudflare 官方 JWT 校验说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

Owner 管理写请求额外要求 `Origin` 严格等于 CONSOLE_ORIGIN，缺失、null 或相似域名均拒绝；正确 Origin 不能代替有效 JWT。管理响应与页面均为 private/no-store，页面禁止被 iframe 嵌入。未配置认证时显示诊断页面/API 503，不提供公开注册、首访者认领或生产认证旁路。

## 管理 API

| 方法与路径 | 当前行为 |
| --- | --- |
| GET /owner/api/mailboxes | 列出未退役邮箱 |
| POST /owner/api/mailboxes | `{name, localPart, maxMessageBytes?}` 创建邮箱 |
| GET /owner/api/mailboxes/{id} | 获取邮箱设置和版本 |
| PATCH /owner/api/mailboxes/{id} | `{name?, status?, maxMessageBytes?, expectedUpdatedAt}`，status 仅 active/paused |
| DELETE /owner/api/mailboxes/{id} | `{confirmAddress, expectedUpdatedAt}` 退役邮箱 |
| GET /owner/api/mailboxes/{id}/tokens | 列出安全 Token 元数据，无明文或摘要 |
| POST /owner/api/mailboxes/{id}/tokens | `{name, scopes:["mail:read"], expiresAt?}`，201 响应含一次性 secret |
| DELETE /owner/api/mailboxes/{id}/tokens/{tokenId} | 撤销对应邮箱的 Token |

所有写入主体都必须是 Owner。邮箱 Token 无论权限多少，都不能调用管理接口。写入 JSON 上限 16 KiB，不接受未知字段，所有查询使用参数绑定。`expiresAt` 为 null/缺失时永不过期，否则必须在将来且不超过 366 天。

## 本地验证

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build:worker
pnpm test
pnpm test:e2e
```

E2E 在 `http://127.0.0.1:4193` 启动临时本地 workerd，生成独立 RSA 密钥并签发 JWT，只在测试网络适配器中为固定 Access issuer 提供 JWKS。生产验证代码、根配置和 bundle 不包含测试公钥、测试身份或 bypass。所有邮箱、Token、D1/R2 均是隔离的内存测试数据，不读取 `.wrangler/state`。

Windows 测试自动使用已安装的 Chrome，缺失时使用 Edge。其他环境可执行 `pnpm exec playwright install chromium`，或用 PLAYWRIGHT_CHANNEL 选择浏览器。端口占用时通过 OWNER_E2E_PORT 设置其他端口；OWNER_QA_DIR 可指定截图目录，默认在操作系统临时目录，不写入仓库。

`pnpm preview` 继续使用真实认证规则与本地持久 D1/R2。可参考 `.dev.vars.local.example` 配置真实 Access 参数；浏览器直接访问未经 Access 处理的 localhost，不会自动获得有效身份。自动化浏览器验证通过测试请求上下文提供签名 JWT，不把测试身份注入生产应用。

本轮已验证桌面 1488×1056、手机 390×844：创建三邮箱、设置持久化、一次性 Token、撤销、暂停/恢复、退役与会话失效；没有相关 console/page 错误。真实 Cloudflare Access 登录、云端资源、域名、DNS 和远程部署仍需部署者配置后验收。
