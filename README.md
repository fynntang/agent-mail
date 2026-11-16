# Agent Mail

为 Agent 提供与你个人邮箱隔离的独立邮箱。你在自己的 Cloudflare 账户部署一个实例，管理多个邮箱，为每个 Agent 签发邮箱级 Token，或通过 OAuth 授权远程 MCP 客户端。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Ffynntang%2Fagent-mail)
[![Deploy Worker with GitHub Actions](https://img.shields.io/badge/Deploy_Worker-GitHub_Actions-2088FF?logo=githubactions&logoColor=white)](https://github.com/fynntang/agent-mail/actions/workflows/deploy.yml)

## 架构

SvelteKit + TypeScript + Cloudflare Workers + D1 + 私有 R2。整个应用只部署一个 Worker，所有入口共用同一份代码、权限和存储。

| 组件 | 职责 |
| --- | --- |
| SvelteKit | Owner 控制台、邮箱 API、MCP/OAuth HTTP 入口 |
| Worker | `fetch`、原生 `email`、`scheduled`，以及可选的投递事件 `queue` |
| D1 | 邮箱、权限、邮件索引、任务、通知与幂等收据 |
| 私有 R2 | 原始邮件、正文、附件及有时限的导出文件 |
| Cloudflare Access | Owner 身份认证；Agent 使用邮箱 Token 或 OAuth |

唯一发布入口是 [`worker/entry.ts`](worker/entry.ts)。SvelteKit adapter 使用生成的配置，不单独发布第二个 Worker。架构、目录和数据关系见[技术方案](docs/architecture.md)、[项目结构](docs/project-structure.md)及[数据库字典](docs/database.md)。

## 部署到自己的账户

准备一个 Cloudflare 账户、已启用的 R2、专用邮件域名和 Owner 登录邮箱。邮件域名、Email Routing、Cloudflare Access 及可选的 Email Sending 需要在你的账户中配置；发送服务的资格和限制以账户控制台为准。

选择一种部署入口：

| 入口 | 使用方式 |
| --- | --- |
| Cloudflare 按钮 | 点击顶部按钮克隆公开仓库，在 Workers Builds 中配置实际变量、D1/R2 和部署命令。详见[按钮部署步骤](docs/deployment.md#部署按钮)。 |
| 本地部署器 | 填写实例配置，预览离线计划，再由一条命令创建资源、构建、迁移并部署。详见下方命令。 |
| GitHub Actions | Fork 后在**自己的仓库**配置变量和 Secret，手动运行 `Deploy personal Agent Mail`。详见[部署说明](docs/deployment.md)。 |

Cloudflare 按钮的独立 Build command 应留空，Deploy command 使用 `pnpm deploy:workers`。该脚本会依次检查、构建、迁移和发布；实际 D1/R2 绑定、`MAIL_DOMAIN`、`OWNER_EMAIL` 和账户 ID 需要正确填写。不要直接使用根配置中的示例资源 ID 发布。

本地部署需要 Node.js 24 和 pnpm 11.25.0：

```sh
pnpm install --frozen-lockfile
```

复制 [`deploy.config.example.json`](deploy.config.example.json) 为被 Git 忽略的 `deploy.config.json`，填写账户、资源名、邮件域名与 Owner 邮箱，再执行：

```sh
pnpm deploy:plan -- --input deploy.config.json
```

检查离线计划后，本机可复用 Wrangler 的登录授权来执行真实部署：

```sh
pnpm exec wrangler login
pnpm deploy:setup -- --input deploy.config.json --use-wrangler-login
```

CI 或专用 API Token 部署可通过秘密注入提供 `CLOUDFLARE_API_TOKEN`，再运行不带 `--use-wrangler-login` 的 `pnpm deploy:setup -- --input deploy.config.json`。登录授权路径需要显式选择；两种凭据都只用于部署控制面，不应写入 JSON、Wrangler `vars` 或运行时 Secret。

部署器会创建缺失的 D1/R2、应用所有待执行迁移并发布一个 Worker。已有资源复用、权限要求、中断恢复和升级方式见[完整部署流程](docs/deployment.md)。

### 首次初始化

1. 打开部署输出的 `/setup` 阅读接入指引。该公开页面只提供说明，不保存实例设置，也不会代为创建 Access 应用。
2. 在 Cloudflare Zero Trust 创建 Access Self-hosted 应用，Allow 策略只允许 Owner 邮箱。将团队 issuer、应用 AUD 和精确的控制台/API origin 写回部署配置并重新部署。
3. 推荐为控制台和 Agent API 配置两个域名，均绑定**同一个 Worker**。若暂时共用一个 origin，Access 只保护 `/owner` 及其子路径，避免拦截 MCP、OAuth 和邮箱 API。
4. 经 Access 登录后进入 `/owner/setup`，核对 D1 迁移、执行 R2 读写探针，并确认邮件域名、路由和适用的发送配置。
5. 创建首个 Agent 邮箱，再完成向导。签发最小权限 Token 或授权 MCP 客户端，并用独立外部邮箱验收实际收发。

向导的 `ready` 表示资源检查和 Owner 确认已完成，不代表外部邮件已经送达。Access、邮件路由、发送及初始化的具体步骤见[部署与初始化](docs/deployment.md)和[Owner 控制台](docs/owner-console.md)。

## 功能与使用文档

| 主题 | 已有能力与文档 |
| --- | --- |
| 邮箱和凭证 | [多邮箱、邮箱级 Token、暂停/撤销、权限和限额](docs/owner-console.md) |
| 邮件阅读 | [列表、分页和已读状态](docs/mail-reader.md)；[HTML 清洗、沙箱、CID 与远程图片许可](docs/html-mail.md)；[附件安全下载](docs/attachments.md) |
| 草稿与发送 | [草稿、回复、Owner 审批和发送记录](docs/mail-sending.md)；[草稿附件](docs/outbound-attachments.md)；[HTML/纯文本双正文及 CID](docs/html-sending.md) |
| Agent 接入 | [API 契约](docs/api-mcp.md)；[MCP 工具、Token 和示例](docs/mcp.md)；[远程客户端 OAuth/PKCE 授权](docs/oauth.md) |
| 事件与抑制 | [HMAC Webhook、签名轮换和重试](docs/webhooks.md)；[服务商投递事件](docs/email-delivery-events.md)；[本地抑制](docs/recipient-suppressions.md)及[Cloudflare 抑制管理](docs/cloudflare-suppressions.md) |
| 运维通知 | [失败/未知结果告警](docs/cloudflare-suppression-alerts.md)；[通知策略与降噪](docs/alert-notification-policy.md)；[决策记录与统计](docs/alert-notification-decisions.md) |
| 导出与任务 | [CSV/JSON 导出](docs/alert-notification-export.md)；[异步导出、取消及安全下载](docs/async-alert-notification-export.md)；[任务完成/失败通知](docs/async-export-notifications.md) |
| 通知重试 | [通知投递追踪](docs/retry-batch-notification-deliveries.md)；[固定预览、批量重试和进度](docs/retry-batch-notification-retry-batches.md)；[取消、未知结果对账和操作历史](docs/retry-batch-notification-retry-controls.md) |

Agent 连接地址为 `https://<API 域名>/mcp`。回复先创建草稿，发送继续执行邮箱权限、配额及 Owner 审批。运维取消和对账只核对原幂等收据，不盲目重发；通知重试任务不会递归生成下一轮通知。

## 本地开发与验证

```sh
pnpm install --frozen-lockfile
pnpm build:worker
pnpm db:local
pnpm local:seed research
pnpm preview
```

访问 `http://127.0.0.1:8787/`。seed 输出测试邮箱的只读 Token；Owner 页面仍要求真实 Access JWT，没有本地认证旁路。本地环境示例见 [`.dev.vars.local.example`](.dev.vars.local.example)，不要将它作为生产 Secret 模板。

验证命令：

```sh
pnpm check
pnpm test
pnpm test:e2e
```

集成和浏览器测试使用最终 Worker bundle、本地 workerd、隔离 D1/R2 及模拟接收端。当前最新迁移为 [`0020_retry_batch_notification_retry_batches.sql`](migrations/0020_retry_batch_notification_retry_batches.sql)，共56张 STRICT 表；升级应按顺序应用全部待执行迁移。验证结果、事件触发方式和限制见[开发记录](docs/development.md)与[验证说明](docs/validation.md)。

## 权限与维护边界

- 每个实例属于一个部署者；Owner 经 Access 登录，邮箱 Token/OAuth 只访问获准的单个邮箱和 scope。
- 收件邮件与 HTML 属于不可信内容。正文使用清洗和沙箱，远程图片默认屏蔽；下载附件另需对应权限。
- 发信权限和审批分开；未知发送或重试结果保留待核对，不自动猜测重发。
- R2 保持私有；部署者负责备份、资源用量、域名、邮件服务和 Cloudflare 权限维护。通用附件预览、旧邮件回填等尚未实现的能力见各功能文档。

已在真实 Cloudflare 账户完成 D1/R2 创建、20项迁移、单 Worker 发布和 R2 读写探针。Access、Owner 向导、完整部署按钮及外部邮件收发的逐项状态见[云端验证记录](docs/cloudflare-live-validation.md)。生产部署前请审阅目标提交或 release；操作步骤见[部署说明](docs/deployment.md)。
