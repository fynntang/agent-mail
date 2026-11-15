# MCP OAuth 授权

已实现面向远程 MCP 的 OAuth Authorization Code + PKCE S256。一个实例仍只有一位 Owner，客户端每次授权绑定一个邮箱。OAuth 不创建平台用户，也不增加 Worker、KV 或签名密钥；使用现有 D1、R2 和 Cloudflare Access。静态邮箱 Token 保持可用。

[导出通知投递追踪与手动重试](async-export-notification-deliveries.md)继续属于 Owner 运维能力，OAuth 不获得通知决定、跳过原因、投递/尝试或手动重试审计的读取与写入权限。读取历史不依赖签名凭据，不意味着开放给邮箱读取 scope；通用重试端点仍要求 Owner 和正确 Origin。

[失败导出通知批量重试](async-export-notification-retry-batches.md)同样仅供Owner预览、确认、查询进度与结果。OAuth和静态邮箱Token不能创建或提交批次，后台执行也不扩大Agent的发送或运维权限。

批量任务的[取消、未知结果对账和操作历史](async-export-notification-retry-controls.md)也仅供Owner使用。OAuth、静态邮箱Token和MCP不能调用这些控制端点；unknown只核对原重试收据，不重新排队。

## 部署与迁移

新增 [0002_oauth.sql](../migrations/0002_oauth.sql)，在原有22张表之上增加7张 OAuth 表。已有实例按顺序应用新迁移，不重新执行初始快照，不覆盖邮件、邮箱或 Token。

当前还需按序应用后续迁移，最新为 [0019_retry_batch_notifications.sql](../migrations/0019_retry_batch_notifications.sql)，当前为54张表。0017新增批量重试两表，0018只增加取消标记及约束，不新增表。收件附件授权 `attachments:read` 必须同时有 `mail:read`，Owner 明确同意后才能读取字节。自己的草稿文件沿用 mail:draft，可分块上传并随已审批草稿发送，详见[草稿附件](outbound-attachments.md)。旧授权不自动扩大；刷新可以缩减范围且不能重新扩大。OAuth AT 仍只用于 `/mcp`，通过工具直接读写字节，见[附件说明](attachments.md)。抑制操作告警、通知策略、决策记录与统计以及[导出完成/失败通知](async-export-notifications.md)属于 Owner 运维信息，不开放给 OAuth 客户端；两个导出 Webhook 类型、事件及投递记录也保持隔离。

```sh
pnpm install --frozen-lockfile
pnpm db:local
pnpm check
pnpm build:worker
pnpm test
pnpm test:e2e
```

部署到自己的 Cloudflare 账户时，先按既有部署流程备份并执行远程 D1 migration，再发布兼容代码。本轮没有远程迁移或部署。配置仍由根 wrangler.jsonc 统一生成 adapter 配置；不单独部署 SvelteKit 输出。

- `API_ORIGIN`：OAuth issuer 的规范 origin，例如 `https://api.example.com`，不带末尾斜杠；MCP resource 固定为 `${API_ORIGIN}/mcp`。
- `CONSOLE_ORIGIN`：Owner 控制台的 origin，授权页面位于这里。两域名仍绑定同一个 Worker。
- `OWNER_EMAIL`、`ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`：继续验证唯一 Owner。Access 保护整个 console 域名和 Owner 页面。
- `OAUTH_CIMD_ALLOWED_HOSTS`：可选的受信客户端元数据主机，逗号分隔、精确匹配，不带协议、路径、端口或通配符。空值关闭 CIMD 远程获取；动态客户端注册仍可用。

API 域名的发现、注册、token、revoke 和 MCP 端点不能被交互式 Access 登录拦住；浏览器只在跳转到 console 域名的授权页时通过 Access。不要在这些公开 OAuth 端点上配置 Owner Cookie 认证。它们自身依赖 PKCE、凭据摘要、受众绑定及授权记录。

## 发现与端点

| 路径 | 作用 |
| --- | --- |
| GET /.well-known/oauth-protected-resource/mcp | RFC9728，MCP resource、AS issuer、scope、Bearer header 方法 |
| GET /.well-known/oauth-protected-resource | 同一资源元数据的兼容入口 |
| GET /.well-known/oauth-authorization-server | RFC8414，授权、token、注册及撤销端点，S256 和实际支持的认证方式 |
| POST /oauth/register | JSON 动态客户端注册，返回 public client_id；无 client_secret |
| GET/POST `${CONSOLE_ORIGIN}/owner/oauth/authorize` | Owner 通过 Access 后核对客户端、邮箱、权限并明确同意或拒绝 |
| POST /oauth/token | application/x-www-form-urlencoded，authorization_code 或 refresh_token |
| POST /oauth/revoke | application/x-www-form-urlencoded，client_id、token、可选 token_type_hint |
| GET/POST /owner/oauth/grants | Owner 查看和撤销访问授权；页面表单由 Access 和 Origin 保护 |

MCP 未认证时返回401，WWW-Authenticate 指向规范 resource_metadata 地址，并提示默认 mail:read 范围。元数据地址来自部署配置，不相信请求 Host 或 X-Forwarded-*。客户端从 metadata 获取 issuer 和各端点；支持 public `token_endpoint_auth_method=none`、code、query response mode，不提供 implicit、password、client_credentials、OIDC 登录或 confidential client secret/private_key_jwt。

公开 OAuth 协议端点由同一个 native fetch wrapper 在进入 SvelteKit 前处理，避免 SvelteKit 3 的浏览器表单 CSRF 门禁拒绝无 Cookie 的标准 token form POST；Vite 开发时复用 hooks 中相同处理器。Owner 页面和审批仍进入 SvelteKit 与原有 Access/Origin 检查，没有关闭框架 CSRF。完整 OAuth 测试和 native 事件使用 build:worker 后的本地 Worker。

## 客户端与 Owner 同意

支持标准 OAuth 的远程 MCP 客户端通常只需填入 API 域名的 `/mcp`。客户端保存 verifier、state、发现到的 issuer 及凭据，并通过浏览器打开授权页。

1. 动态注册提交 redirect_uris、可选 client_name、scope 和 public none 认证方式。只接受 code 和 refresh_token，未知可选展示字段不会触发网络获取；不加载客户端 logo。
2. 授权请求含 client_id、response_type=code、redirect_uri、resource、code_challenge、code_challenge_method=S256，可带 scope 和 state。未提供 scope 时默认为 mail:read。
3. Owner 通过现有 Access 登录，看到客户端名称、完整 client_id、回调主机和完整 URI；名称由客户端提供，不代表可信身份。HTTP loopback 回调会额外提醒核对本机应用及端口。
4. Owner 选择**一个启用中的邮箱**及请求权限的子集。mail:send 要求同时授予 mail:draft。默认仍需逐封审批；只有 Owner 明确勾选免审批发送才关闭该要求。
5. 同意后才原子创建授权、邮箱权限主体和短期授权码，返回 code、原 state 和 issuer `iss`；拒绝返回 access_denied、state、iss，不签发权限。GET 访问授权页不会直接授权。
6. 客户端向 token 端点发送 code、client_id、精确 redirect_uri、code_verifier 和相同 resource，获得 Bearer AT、轮换 RT、expires_in 及实际 scope。

回调 URI 注册后严格匹配，不接受通配符、任意后缀、userinfo、片段或非 HTTP(S) 自定义 scheme；HTTPS 可用于远程客户端，HTTP 仅限 localhost/127.0.0.1/[::1]。按原生应用规范，IP 字面量 loopback 端口可变化，主机、路径、查询仍须匹配；换码时必须使用本次批准的精确 URI。无效 client/redirect 不重定向；已验证回调的协议错误才安全返回 OAuth 错误和原 state、iss。

Owner 表单使用同站 Origin、Access JWT、一次性请求 handle 与 CSRF nonce，不能从客户端 POST 指定跳转目标、其他 Owner 或越权 scope。授权请求10分钟有效，nonce 同时提交只会有一个成功结果。授权页使用 same-origin Referrer-Policy，支持安全原生 POST；跨域回调不携带 Referer，重定向响应仍为 no-referrer。

## 邮箱权限、审批与撤销

每个 OAuth grant 创建一个独立 mailbox_tokens principal，随机内部 secret 不向客户端暴露。访问令牌和刷新令牌只存 SHA-256 摘要；OAuth 授权码也不存明文。Actor 仍是绑定邮箱的 token 身份，因此工具、草稿归属、幂等、额度和发送队列继续复用现有服务。

刷新不会改变 principal，客户端原来的草稿和发送幂等记录仍可访问；不同 OAuth grant、不同静态 Token 之间的草稿继续隔离。每次请求校验当前 grant、client、principal、邮箱状态和权限，并与 AT 的范围取交集。OAuth AT 只接受在规范 `/mcp`，不能作为 `/v1` 的通用邮箱 Token；静态 am_ Token 的原有行为保持不变。

授权访问邮箱不等于批准发送邮件。send_message 默认返回 approval_required，Owner 仍在原“草稿与发送”页面核对版本、内容摘要和所有 To/Cc/Bcc。客户端无 OAuth scope 可以代替 Owner 审批，也不能通过刷新扩大权限。详见[MCP 工具](mcp.md)和[邮件发送](mail-sending.md)。

| 凭据 | 生命周期与约束 |
| --- | --- |
| 授权请求 | 10分钟，一次性 Owner nonce |
| 授权码 | 2分钟，单次使用，绑定 client/redirect/resource/S256/已同意主体 |
| AT | 最多10分钟，不超过 grant 或 principal 的剩余有效期 |
| RT / 授权 | 30天绝对上限，不因刷新延长；每次刷新轮换 RT |

刷新 resource 必须仍是相同 MCP resource；scope 只能保持或缩小。使用过的有效 RT 再次出现，会撤销整族授权及 principal，包括新 RT 和 AT；并发刷新同一 RT 也只有一方能发行新凭据，重放检测随后撤销该族。错误 secret、错误 client_id 不能利用已知 UUID 撤销他人授权。已使用授权码的有效重放也触发撤销；客户端应串行刷新，结果丢失时不要盲目重试旧 RT，应重新授权。

Owner 从侧栏“MCP 授权”撤销，或通过原 Token 列表撤销对应 OAuth principal，下一请求和刷新立即失败。RFC7009 revoke 校验客户端及凭据摘要后撤销整个 grant；未知凭据返回同样的200，避免枚举。撤销 principal 也会阻止尚未越过提交边界的排队邮件；已开始的外部发送无法靠撤销保证取消，unknown 仍不会自动重发。

## CIMD 信任策略与 CORS

默认只启用动态注册，CIMD metadata discovery 为 false。配置至少一个有效受信 hostname 后才声明 client_id_metadata_document_supported=true。URL client_id 必须 HTTPS、非根路径、无 userinfo、片段、查询、端口或点路径段；JSON 中 client_id 必须与原 URL 完全相同，并提供 client_name 与 redirect_uris。仅支持 public none，不接受 metadata 中的共享 client_secret。

只向配置的精确主机发起一次 HTTPS 获取，拒绝所有重定向、IP/localhost 标识、超时和非 JSON；响应最多5 KiB，5秒超时，成功结果缓存5分钟。只读 metadata，不请求 logo_uri、jwks_uri 或其他任意 URL；刷新和 AT 鉴权不重新获取网络元数据。信任列表是部署者对该域名及 DNS 运营方的信任，不能仅靠私网主机名黑名单代替它。不要加入不受信域名；无需 CIMD 的实例保持空配置即可。

公开发现、注册、token 和 revoke 提供无 Cookie CORS。MCP 的 OAuth 浏览器请求允许 API origin 或本次批准的 callback origin，并支持无认证的 POST preflight；非法 Origin 被拒绝。静态 Token 继续只允许原配置的 API origin，Owner 写入继续只允许 console origin，不接受 Origin:null。原生非浏览器客户端可以省略 Origin。

动态注册有实例级每分钟30次限制。未实现客户端管理删除和历史凭据自动清理；公开注册可产生持久元数据，生产部署仍应结合自身 Cloudflare 入口策略限制流量。禁用已泄露的授权，不通过清理邮件对象来处理 OAuth 凭据。备份恢复后应在重新开放访问前核对并撤销旧授权，避免数据库回退重新激活旧状态。

## 验证范围

本地测试使用真实 workerd、D1/R2、全部顺序迁移、官方 MCP OAuth SDK、签名测试 Access JWT 和模拟 EMAIL，包含完整发现→注册→浏览器同意→PKCE→MCP→刷新→审批发送→撤销。还覆盖代码/RT 重放、并发单次消费、权限缩小、受众、回调、CSRF、过期、暂停、CIMD 与浏览器 CORS。没有远程部署、DNS 修改或真实邮件发送；真实 Access 登录和目标远程客户端需部署后验收。

2026-11-14，Windows / Node.js24.22.1 / pnpm11.25.0：check 为0错误0警告，SvelteKit 构建和单 Worker dry-run 成功。74个核心测试（OAuth15个）、16个 bundle 集成测试（OAuth4组）、4个完整浏览器流程，以及66项数据库和18项配置检查通过；本地 D1 已从0001追加0002成功。OAuth 页面在1488×1056与390×844验证，包含实际表单、回调和撤销，未出现空白页、错误层、控制台错误或横向溢出。Browser 插件不可用，使用现有 Playwright + Chrome；截图位于工作区外的 oauth 目录，没有凭据截图。

依据：[MCP OAuth](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/index.mdx)、[客户端注册/CIMD](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/client-registration.mdx)、[刷新凭证防重放](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14)。

批次完成、失败和待对账提醒继续仅供Owner，三种通知Webhook沿用邮箱策略、签名与自动重试，详见[批次完成与异常通知](retry-batch-notifications.md)。

批量任务通知支持Owner查看原决定/跳过原因、投递状态、传输尝试和手动重试收据。重新排队复用原冻结身份、当前策略及UUID/版本幂等，专用和通用Webhook入口采用相同校验；无新迁移或绑定，仍54张表。详见[批次通知投递追踪](retry-batch-notification-deliveries.md)。
