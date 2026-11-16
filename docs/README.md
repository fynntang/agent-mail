# 文档索引

Agent Mail 是个人自部署的多邮箱服务：一个实例属于一个部署者，每个 Agent 的 Token/OAuth 授权绑定单个邮箱。当前实现为 SvelteKit + Cloudflare Workers + D1 + 私有 R2，最终只发布一个含 `fetch`、`email`、`scheduled` 及可选 `queue` 的 Worker。

当前最新迁移为 `0020_retry_batch_notification_retry_batches.sql`，共56张 STRICT 表。部署和升级应按顺序应用全部待执行迁移；功能文档中的历史迁移号描述各功能的引入版本。

## 部署与初始化

| 文档 | 内容 |
| --- | --- |
| [部署与初始化](deployment.md) | Cloudflare 按钮、Wrangler 登录/API Token、本地部署器、Actions、资源创建、升级、中断恢复及服务配置 |
| [Cloudflare 实际部署验证](cloudflare-live-validation.md) | 真实资源、迁移、Worker、Access、Owner及部署按钮的逐阶段结果和待验收边界 |
| [Owner 控制台](owner-console.md) | Access 身份、邮箱及 Token 生命周期、权限与限额 |
| [项目首页](../README.md) | 产品概览、部署入口和本地启动命令 |

公开仓库已提供 Cloudflare 与 GitHub Actions 部署按钮。`/setup` 是公开接入说明；Access 应用及其参数需由部署者配置，认证后再进入 `/owner/setup` 完成资源检查和 Owner 确认。实际云端验证状态统一见[部署验证记录](cloudflare-live-validation.md)，本地构建与回归结果见[开发记录](development.md)。

## 邮箱与 Agent 功能

| 主题 | 文档 |
| --- | --- |
| 阅读邮件 | [列表、分页与已读状态](mail-reader.md)；[HTML 清洗、沙箱、CID 和远程图片许可](html-mail.md) |
| 附件 | [解析、权限与安全下载](attachments.md)；[草稿上传、分块与审批发送](outbound-attachments.md) |
| 编写和发送 | [草稿、回复、审批与发送记录](mail-sending.md)；[HTML/纯文本双正文与 CID 图片](html-sending.md) |
| Agent 接入 | [API 契约](api-mcp.md)；[MCP 工具、连接与权限](mcp.md)；[远程 MCP 的 OAuth/PKCE 授权](oauth.md) |

## 事件与运维

| 主题 | 文档 |
| --- | --- |
| 邮箱事件 | [Webhook、HMAC、密钥轮换及投递重试](webhooks.md)；[Cloudflare 投递事件与去重](email-delivery-events.md) |
| 收件人抑制 | [永久退信与投诉抑制](recipient-suppressions.md)；[Cloudflare 服务端名单](cloudflare-suppressions.md)；[同步/解除历史与对账](cloudflare-suppression-history.md) |
| 告警与降噪 | [失败/未知结果告警](cloudflare-suppression-alerts.md)；[通知策略](alert-notification-policy.md)；[决策记录及统计](alert-notification-decisions.md) |
| 决策导出 | [CSV/JSON 同步导出](alert-notification-export.md)；[后台大批量导出、取消及安全下载](async-alert-notification-export.md) |
| 导出通知 | [完成与失败提醒](async-export-notifications.md)；[通知投递追踪和安全重试](async-export-notification-deliveries.md) |
| 导出通知批量重试 | [固定预览、幂等提交及进度](async-export-notification-retry-batches.md)；[取消、未知结果对账及操作历史](async-export-notification-retry-controls.md) |
| 批量任务通知 | [完成、失败与待对账提醒](retry-batch-notifications.md)；[通知决定、投递结果和手动重试](retry-batch-notification-deliveries.md) |
| 通知失败投递批量重试 | [独立任务、筛选和进度](retry-batch-notification-retry-batches.md)；[停止未执行条目、原收据对账及历史](retry-batch-notification-retry-controls.md) |

运维端点只向 Owner 开放。取消与未知结果对账保留已执行结果，不盲目重新排队；通知失败投递的重试任务使用独立记录，不递归生成自身通知。

## 内部实现与验证

| 文档 | 内容 |
| --- | --- |
| [技术架构](architecture.md) | 单 Worker、认证边界、存储和数据流程 |
| [项目结构](project-structure.md) | SvelteKit 路由、核心模块与原生入口 |
| [数据库字典](database.md) | 逐表字段、索引、约束与关系 |
| [参考 D1 快照](schema.sql)与[增量迁移](../migrations) | 数据结构参考和实际升级文件 |
| [本地开发与验证记录](development.md) | 环境、构建、测试、事件触发和已验收流程 |
| [结构验证与限制](validation.md) | 数据库验证结果及适用范围 |
| [SvelteKit 配置验证](svelte-validation.md) | 原生 Worker 与 adapter 配置一致性 |
