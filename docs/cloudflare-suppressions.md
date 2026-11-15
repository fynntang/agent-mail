# Cloudflare 服务端抑制同步与管理

Owner 的“抑制名单”页增加独立的 Cloudflare 区域：查看账户范围及指定发信域的记录、同步缓存、解除可修改记录，并可选择同时解除当前邮箱的匹配本地抑制。既有本地名单保持独立，不会因远端记录消失或到期而自动清除永久退信/投诉证据。复用同一个 Worker 的 fetch/scheduled、Owner Access 和 D1；没有额外 Worker、中心服务或新依赖。

## 迁移与安全配置

先应用 `0009_cloudflare_suppressions.sql`（本地 `pnpm db:local`，远端沿用现有部署流程）。新增服务端缓存、同步租约、解除操作日志三表，共 38 张 STRICT 表。已有本地抑制、邮件、草稿、审批和额度保持保留。

在自己的 Cloudflare 账户创建专用 API Token，仅授权目标账户的 **Email Sending: Edit**。Cloudflare 的名单 API 要求此权限；不要复用全局 API Key、账户邮箱密码或一键部署所用的管理凭据。[官方管理接口说明](https://developers.cloudflare.com/email-service/configuration/suppressions/)

在 `wrangler.jsonc` 的现有 vars 中合并下面两项非秘密配置：

```jsonc
"EMAIL_SUPPRESSIONS_ACCOUNT_ID": "实际的32位十六进制账户ID",
"EMAIL_SUPPRESSIONS_DOMAIN": "agent.your-domain.tld"
```

DOMAIN 必须为小写、精确的实际发信域，不能填收件人的域名、通配符或完整 URL。它须与所管理邮箱的发送地址域一致；账户范围记录也会适用于此域。部署工具会核对配置账户与部署目标账户相同。

只使用 Worker Secret 保存 Token：

```sh
pnpm exec wrangler secret put EMAIL_SUPPRESSIONS_API_TOKEN --config wrangler.jsonc
```

在提示处粘贴 Token，不放到命令参数、普通 vars、部署 JSON、D1、R2、源码、Owner 表单、日志或浏览器存储。应用不会提供读取或回显凭据的端点。轮换时用相同命令覆盖 Secret，再手动同步验证新权限。Secret 与部署 Token、邮箱 Token、OAuth 凭据、Webhook 密钥分别管理。

本地测试可在已被 gitignore 排除的 `.dev.vars` 配置同名字段；其中是真实本地明文文件，应由部署者私下保存。`.dev.vars.example` 只有空值占位。缺少三项中的任意一项或格式无效时功能关闭，既有收发与本地抑制仍可工作。部署工具拒绝把 Token 写到普通 vars，并从 check/build/migrate/upload 子进程环境中移除该运行时凭据；输出也有脱敏处理。

## 同步行为与发送联动

页面 GET 只读 D1 缓存，不访问 Cloudflare。Owner 的“同步 Cloudflare 记录”执行完整同步；同一 Worker 的 scheduled 每 15 分钟尝试一次。上游故障不会清空既有缓存或本地名单，不会触发邮件重发。

应用 `0010_cloudflare_suppression_history.sql` 后，同步与解除会保存[执行历史和追加式时间线](cloudflare-suppression-history.md)。Owner 可查看失败原因、只读核对未知结果，并以新的明确意图安全重试；原命令结果及父子关系保留。

只访问固定 `https://api.cloudflare.com/client/v4/accounts/{account}/email/sending/suppressions`，分别查询 `scope_type=account` 和 `scope_type=sending_domain&scope_value={domain}`，跟随 `result_info.next_cursor`。每页100条，每种作用域最多10页，总共最多1000条；超限或游标重复会明确失败，不把部分列表当成完整结果。两类作用域全部取得并验证后，才在 D1 事务中发布完整缓存并将缺失记录标记 absent。批量写入使用绑定 JSON，不构造收件地址 SQL。

HTTP 请求不跟随重定向，Token 只发往固定 Cloudflare API 原点；不转发 Owner JWT、Cookie、Origin 或 Referer。单个请求含正文读取最多10秒，响应最多1MiB，完整读取预算90秒；只接收已知 JSON 字段和合法身份、作用域、布尔 read_only、原因和时间。错误只保留固定诊断码，不保存 Cloudflare 错误原文或完整响应。

发送入队、R2 快照准备后的 D1 事务以及 native EMAIL 提交边界，均检查本地名单和已知的活跃 Cloudflare 缓存记录。To/Cc/Bcc 任一地址命中即阻止整封邮件；服务端缓存命中返回 `cloudflare_recipient_suppressed`。适用域按发送地址判断，已到期或 absent 记录不参与阻止。缓存过期不会自动放弃本地永久抑制。

Agent 现有候选地址 API/MCP 检查也复用缓存；仅对显式请求的地址返回 `provider_suppression` 通用原因，本地 hard_bounce/complaint 优先。不会暴露账户 ID、远端记录 ID、其他地址或凭据，不新增 Agent 管理工具，MCP 仍最多22个工具。查询不会实时调用 Cloudflare，因此“未命中”不是实时服务端放行承诺；新的提供商抑制仍由 native EMAIL 服务执行，实际投递仍依赖提供商和收件服务器。

## Owner 解除与本地联动

Cloudflare 记录只有 `read_only=false` 才可解除，不能根据 reason 推断可修改性。账户范围记录影响整个 Cloudflare 账户的所有发信域，页面要求输入完整收件地址并明确确认账户范围影响；发信域范围记录只对应精确域名。[官方作用域与只读规则](https://developers.cloudflare.com/email-service/concepts/suppressions/)

每次操作包含独立 UUID clientRequestId、页面记录的版本摘要、地址和作用域确认；提交后凭据仍只在 Worker 内使用。Worker 在 DELETE 前重新 GET 指定 ID，验证身份、地址、作用域、版本和最新 read_only。状态变化时要求刷新；不提供修改作用域、任意上游 URL 或按地址批量删除的接口。

默认只删除选中的 Cloudflare 记录，本地记录保留。勾选“同时解除当前邮箱”时，提交页面捕获的 expectedLocalVersion；远端确认成功后只更新该邮箱该地址的原本地记录，并写入解除水位和审计。网络等待中出现新投诉或退信，版本检查会保留新的本地抑制，返回 **远端已删除 / 本地已变化**，不会伪装成整个操作失败或静默清除新风险。其他邮箱、本地址的其他 Cloudflare 作用域记录都不会被批量解除。

远端删除与本地 D1 不能形成一个分布式事务。操作日志在发出 DELETE 前持久化，并按账户/域与同步共享租约。相同 clientRequestId 和相同参数返回已保存结果，不再次 DELETE；参数变化返回冲突。操作结果可能是 deleted、already_absent、unknown、in_progress 或 failed，本地状态分别明确返回 released、changed、pending 或 not_requested。

DELETE 超时、连接中断、无法验证的成功响应或服务端错误，均按未知结果保留本地限制；不会自动重试 DELETE。页面可用同一操作标识查询已记录结果，再通过同步核对：完整快照确认远端已不存在时可结束未知操作，但**同步不会顺带解除本地名单**；仍存在时至少等待两分钟再解除未确定锁，之后需 Owner 新的明确操作。过期 preparing/deleting 租约会恢复为失败或未知；共享租约阻止本实例旧同步覆盖新的解除结果。

即使成功解除选中记录，也可能存在其他账户/域范围抑制、本地新风险或新的服务端策略，不直接宣称“已恢复投递”。Cloudflare API 没有在本接口承诺跨 GET/DELETE 的条件事务；最终可修改性仍由服务端执行。

## Owner API

全部端点只允许 Access Owner；POST 同时要求正确的同源 Origin。邮箱级静态 Token 与 MCP/OAuth Agent 均不能同步、列举或解除服务端名单。

```text
GET  /owner/api/mailboxes/{mailboxId}/cloudflare-suppressions?limit=20&cursor=...
POST /owner/api/mailboxes/{mailboxId}/cloudflare-suppressions/sync
     {}
POST /owner/api/mailboxes/{mailboxId}/cloudflare-suppressions/{remoteId}/release
     {"clientRequestId":"UUID","expectedVersion":"SHA256",
      "confirmationAddress":"recipient@example.net","confirmationScope":"account",
      "releaseLocal":true,"expectedLocalVersion":3}
```

发信域范围的 confirmationScope 填精确域名。未勾选本地联动时省略 expectedLocalVersion。GET 返回 `{configured,suppressions,nextCursor,sync}`，包含匹配当前邮箱的本地记录版本；游标绑定账户、域、邮箱和页大小。同步成功返回 `{synced:true,count,syncedAt}`。解除直接返回 `{operationId,remoteStatus,localStatus,errorCode?}`；unknown/in_progress 为202，已确定结果为200，陈旧确认、只读和并发冲突返回409。使用结果字段判断远端和本地的分别状态，不对202当作已解除。

## 本地验证与实际部署边界

使用 `pnpm check`、`pnpm build:worker`、`pnpm test`、`pnpm test:e2e` 验证。测试只使用最终单 Worker、本地 D1/R2 和固定原点的模拟 Cloudflare API，覆盖完整/失败分页、只读与身份变化、凭据隔离、重复命令、DELETE 未知结果、CAS 联动、缓存发送边界及 Owner 桌面/手机流程，不操作真实 Cloudflare 名单。实际账户 Token 权限、真实同步、解除和邮件投递需部署者配置后验收。
